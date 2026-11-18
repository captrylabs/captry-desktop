// The page's side of the relay at api.captry.app (worker/feedback/src/relay.js).
//
// Every body sent is a capture already sealed with the phone's content key;
// the token only names the mailbox. The page's Content-Security-Policy allows
// this one host and nothing else.

const PRODUCTION = "https://api.captry.app/relay/v1";

/**
 * Where the relay is. A local copy of the page can point at a local worker
 * with ?relay=http://localhost:8787, and only a local copy: the live page
 * always talks to api.captry.app.
 */
function base() {
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const override = new URLSearchParams(location.search).get("relay");
  return local && override ? override.replace(/\/$/, "") + "/relay/v1" : PRODUCTION;
}

export class RelayError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// The relay caps how many bytes one network may send in a day. Its refusal is
// a 429 like any other, with {"code": "budget"} in the body, and waiting a
// minute does not lift it, so it gets its own words and is never retried. A
// relay from before that says nothing of the kind, and its 429 is the usual one.
// The relay as a whole can be full too, {"code": "full"}: nothing to do with
// this network, and another network would not help, so the same goes for it.
const LIMITS = {
  budget: "This network has sent too much for now. Try again later.",
  full: "Captry's relay is full right now. Try again later.",
};
const BUSY = "Too many at once. Try again in a minute.";

/** The words for [response] when it is one of the relay's lasting limits, else null. */
export async function overLimit(response) {
  if (response.status !== 429) return null;
  try {
    const code = (await response.clone().json())?.code;
    return Object.hasOwn(LIMITS, code) ? LIMITS[code] : null;
  } catch (e) {
    return null;
  }
}

// A request that never ends would hold whatever waits on it for the life of
// the tab: a look at the feed, above all, which no later look can start
// past. So the relay has a time to answer in and a time any one pause in a
// body may last, not a time for the whole of it, which on a slow line is
// minutes for a picture and is fine while bytes keep coming.

/**
 * How long the relay has to answer once a request is sent: half a minute.
 * It answers from its own storage in well under a second; this is room for
 * a slow or busy line, and is the longest a hung look holds the next one back.
 */
export const RELAY_ANSWER_MS = 30_000;

/** How long a body may go without a byte arriving before it counts as stalled. As long, for the same reasons. */
export const RELAY_STALL_MS = 30_000;

/**
 * The slowest upload a request body is allowed for: 32 KiB a second, 256
 * kbit/s, the far end of a weak mobile connection. fetch cannot say how much
 * of a body has gone, so a body's time to answer starts only once it could
 * have gone at that rate: a 20 MiB picture gets about 11 minutes.
 */
export const RELAY_SLOW_UPLOAD = 32 * 1024;

/** The time the relay has to answer a request carrying [bytes] of body. */
export function relayAnswerMs(bytes = 0) {
  return RELAY_ANSWER_MS + Math.ceil(bytes / RELAY_SLOW_UPLOAD) * 1000;
}

/**
 * [url] fetched with [init], and its whole body: { response, bytes }. Throws
 * when there is no answer within [answerMs] or the body stops for [stallMs],
 * and the request is dropped. [request] is fetch, or a stand-in for tests.
 */
export async function fetchWithin(url, init, { answerMs, stallMs }, request = (...args) => fetch(...args)) {
  const controller = new AbortController();
  // Each wait is raced against its own timer, so a stalled stream ends it
  // whether or not the stream itself notices the abort.
  const within = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timed out"));
    }, ms);
    promise.then((v) => {
      clearTimeout(timer);
      resolve(v);
    }, (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  const response = await within(request(url, { ...init, signal: controller.signal }), answerMs);
  if (!response.body) return { response, bytes: new Uint8Array(await within(response.arrayBuffer(), stallMs)) };
  const reader = response.body.getReader();
  const pieces = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await within(reader.read(), stallMs);
      if (done) break;
      pieces.push(value);
      length += value.length;
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const piece of pieces) {
    bytes.set(piece, at);
    at += piece.length;
  }
  return { response, bytes };
}

/**
 * One request to the mailbox: the body of the answer, or a RelayError. A
 * request that timed out is "could not be reached", as one that never left;
 * nothing here asks again, so a capture is never sent twice on its own.
 */
async function call(token, path, init = {}) {
  let response;
  let bytes;
  try {
    ({ response, bytes } = await fetchWithin(base() + path, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }, { answerMs: relayAnswerMs(init.body?.length ?? 0), stallMs: RELAY_STALL_MS }));
  } catch (e) {
    throw new RelayError("Captry's server could not be reached.", 0);
  }
  if (!response.ok) {
    const limit = response.status === 429 ? await overLimit(new Response(bytes, { status: 429 })) : null;
    const reason = limit
      ?? (response.status === 507
        ? "Too much is waiting for your phone. Open Captry on the phone first."
        : response.status === 413
          ? "That capture is too large to send."
          : response.status === 429
            ? BUSY
            : "Captry's server did not accept it.");
    throw new RelayError(reason, response.status);
  }
  return bytes;
}

/** The relay's json answer in [bytes]; one that is not json is a server not accepting it. */
function json(bytes) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new RelayError("Captry's server did not accept it.", 0);
  }
}

/** Sends one sealed capture. Returns the relay's id for it. */
export async function send(token, sealed) {
  const bytes = await call(token, "/items", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: sealed,
  });
  return json(bytes).id;
}

/** How many entries the relay puts in one page of the feed (FEED_PAGE in worker/feedback/src/relay.js). */
export const FEED_PAGE = 500;

/**
 * Pages read in one look at the feed. The relay keeps at most 2,000 entries,
 * four pages, so twice that never stops a real catch-up; past it, the next
 * look carries on.
 */
export const FEED_PAGES_PER_LOOK = 8;

/**
 * Whether to ask for another page after the [pages]th of this look: only a
 * full page that moved the place on, [before] to [after], and not past the
 * cap. A relay that keeps serving full pages of nothing new is not followed.
 */
export function moreFeedPages(entries, before, after, pages) {
  return entries >= FEED_PAGE && after > before && pages < FEED_PAGES_PER_LOOK;
}

/**
 * Whether a look that read [pages] pages stopped at the cap with more to
 * read: its last page full and moving the place on, [before] to [after].
 * Such a look did not reach the end, so it may not say "Up to date".
 */
export function feedPagesCapped(entries, before, after, pages) {
  return entries >= FEED_PAGE && after > before && pages >= FEED_PAGES_PER_LOOK;
}

/**
 * How long a look at the feed may run before the page stops saying "Up to
 * date": two minutes. A look is a page of the list, answered within
 * RELAY_ANSWER_MS, and the entries after it; the largest entry the relay
 * takes, 21 MiB, comes in in under 90 s at 2 Mbit/s. A look still going past this is on a
 * line slower than that or being fed a trickle, which RELAY_STALL_MS does not
 * cut off, and what it brings may be anything.
 */
export const FEED_LOOK_FRESH_MS = 2 * 60_000;

/**
 * Whether the page may say "Up to date": the last look that ended reached
 * the end ([short] false), and any look [running] since [startedAt] has not
 * gone on past FEED_LOOK_FRESH_MS by [now]. A look under way does not count
 * until it ends, so a routine one leaves the pill as it was.
 */
export function feedUpToDate(short, running, startedAt, now) {
  return !short && (!running || now - startedAt < FEED_LOOK_FRESH_MS);
}

/** Feed entries after `after`: { entries: [{seq, createdAt, size}], latest, trimmedThrough }. */
export async function feedSince(token, after) {
  return json(await call(token, `/feed?after=${after}`));
}

export async function feedEntry(token, seq) {
  return call(token, `/feed/${seq}`);
}

/**
 * What a look does when one entry could not be fetched, given the relay's
 * [status] (0 or none when it was not reached, or the body broke off):
 * "skip" one the relay no longer has (404, trimmed or expired: asking again
 * cannot bring it back), else "stop" with the place unmoved, so the next look
 * asks for it again. A 429 is the mailbox's reads for the day, a 5xx a relay
 * having trouble; neither may cost a change for good.
 */
export function afterFeedEntryFailed(status) {
  return status === 404 ? "skip" : "stop";
}

/**
 * How long a live connection has to stay open before the wait to reconnect
 * starts again from a second: half a minute, longer than any normal
 * handshake and well under the 45 s between pings, so a relay that accepts
 * and drops at once is retried ever more slowly, up to a minute apart.
 */
export const LIVE_STEADY_MS = 30_000;
const LIVE_FIRST_MS = 1000;

/** The wait before reconnecting, given the current one and how long the socket was open (0 if it never opened). */
export function liveDelayAfter(delay, openFor) {
  return openFor >= LIVE_STEADY_MS ? LIVE_FIRST_MS : delay;
}

/**
 * A live connection: the relay says "feed" or "items" the moment something
 * changes, and the page then asks over the ordinary routes. The token goes as
 * a WebSocket subprotocol, never in the URL. Reconnects on its own, more and
 * more slowly, until stop() is called.
 */
export function live(token, onMessage, onState = () => {}) {
  let socket = null;
  let stopped = false;
  let delay = LIVE_FIRST_MS;
  let openedAt = 0;
  let ping = 0;
  let retry = 0;
  const connect = () => {
    if (stopped) return;
    try {
      socket = new WebSocket(base().replace(/^http/, "ws") + "/live", ["captry.v1", token]);
    } catch (e) {
      schedule();
      return;
    }
    socket.addEventListener("open", () => {
      // The wait is not reset here but on closing, once the socket has stayed up.
      openedAt = Date.now();
      onState(true);
      // Keeps the connection from being dropped as idle. Each one wakes the
      // relay for a moment to be counted; more than four a minute closes the
      // socket, and one every 45 s stays well under that.
      ping = setInterval(() => socket?.readyState === 1 && socket.send("ping"), 45_000);
    });
    socket.addEventListener("message", (event) => {
      if (event.data === "pong") return;
      try {
        onMessage(JSON.parse(event.data));
      } catch (e) {}
    });
    socket.addEventListener("close", () => {
      clearInterval(ping);
      delay = liveDelayAfter(delay, openedAt ? Date.now() - openedAt : 0);
      openedAt = 0;
      onState(false);
      schedule();
    });
  };
  const schedule = () => {
    if (stopped) return;
    clearTimeout(retry);
    retry = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 60_000);
  };
  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ping);
      try { socket?.close(1000, "done"); } catch (e) {}
    },
  };
}

// --- pairing: no token yet, only the code --------------------------------------------

/** A random 32-byte token, base64url: the page's proof that a slot is its own. */
export function newPairToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * How long to wait after the relay's [attempt]th "too many" in a row while
 * pairing, or null to give up. The relay counts requests a minute for each
 * network, and a phone on the same Wi-Fi sending its library counts there
 * too, so the waits add up to more than a minute: about 1 min 45 s in all.
 */
export function pairRetryDelay(attempt) {
  const waits = [3_000, 6_000, 12_000, 24_000, 30_000, 30_000];
  return attempt >= 0 && attempt < waits.length ? waits[attempt] : null;
}

/**
 * One request about a pairing. A 429 is waited out and asked again, unless
 * it is the network's daily limit, the relay is full, or [stopped] says the
 * pairing was cancelled; the DELETE at the end is never asked twice.
 */
async function pairCall(code, path, init = {}, stopped = null) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(`${base()}/pair/${code}${path}`, { ...init, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    } catch (e) {
      throw new RelayError("Captry's server could not be reached.", 0);
    }
    if (r.status === 413) throw new RelayError("That is more than Captry's server takes. Start again.", 413);
    if (r.status !== 429) return r;
    const limit = await overLimit(r);
    if (limit) throw new RelayError(limit, 429);
    const wait = stopped ? pairRetryDelay(attempt) : null;
    if (wait === null || stopped()) throw new RelayError(BUSY, 429);
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (stopped()) throw new RelayError(BUSY, 429);
  }
}

const never = () => false;

/** Opens a slot under the code. False when the code happens to be taken. */
export async function pairOffer(code, pageKey, label, pageToken, stopped = never) {
  const r = await pairCall(code, "/offer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageKey, label, pageToken }) }, stopped);
  if (r.status === 409) return false;
  if (!r.ok) throw new RelayError("Pairing could not start.", r.status);
  return true;
}

/** { phoneKey, sealedKey, label }, each null until the phone has sent it. */
export async function pairAnswer(code, stopped = never) {
  const r = await pairCall(code, "/answer", {}, stopped);
  if (!r.ok) throw new RelayError("Pairing stopped.", r.status);
  return r.json();
}

// A part read as often as the relay allows, or dropped once every part went
// out, is 410: no wait brings it back, only pairing again.
const PART_GONE = "Part of your library did not arrive. Pair again.";

export async function pairSnapshot(code, stopped = never) {
  const r = await pairCall(code, "/snapshot", {}, stopped);
  if (r.status === 410) throw new RelayError(PART_GONE, 410);
  if (!r.ok) throw new RelayError("Pairing stopped.", r.status);
  return r.json();
}

export async function pairSnapshotPart(code, n, stopped = never) {
  const r = await pairCall(code, `/snapshot/${n}`, {}, stopped);
  if (r.status === 410) throw new RelayError(PART_GONE, 410);
  if (!r.ok) throw new RelayError("Part of your library did not arrive.", r.status);
  return new Uint8Array(await r.arrayBuffer());
}

export async function pairDone(code, pageToken) {
  try {
    await pairCall(code, "", { method: "DELETE", headers: pageToken ? { authorization: `Bearer ${pageToken}` } : {} });
  } catch (e) {}
}

/** The ids still waiting for the phone. */
export async function waiting(token) {
  return new Set(json(await call(token, "/items")).items.map((i) => i.id));
}

/**
 * How long a capture may be gone from the relay before the phone's word that
 * it took it is given up on: two minutes. The phone deletes it from the relay
 * while it looks and posts its word to the feed at the end of that same look,
 * so the word follows within seconds; this is room for a slow look. It is
 * given up on only after a look at the feed that started this long after
 * (afterDeliveryLook), not on the clock alone.
 */
export const UNCONFIRMED_AFTER_MS = 2 * 60_000;

/**
 * Whether a capture sent from here is still out: sent through the relay, and
 * neither on the phone nor given up on. Only these count as waiting, and only
 * these does the delivery watch ask the relay about.
 */
export function sentOut(item) {
  return !!item.relayId && !item.delivered && !item.unconfirmed;
}

/**
 * Whether Unlink loses [item] for good: still out, or given up on without the
 * phone's word, so the phone may not have it either.
 */
export function lostOnUnlink(item) {
  return sentOut(item) || (!!item.unconfirmed && !item.delivered);
}

/**
 * What one look at the relay means for a sent [item], given whether the relay
 * still [listed] it, whether this phone has ever said in its feed which
 * captures it took ([givesWord]), and when the last look at the feed that
 * reached its end started ([endLookFrom], null when none has since the
 * library opened). Only that word, sealed in the feed, says the phone has a
 * capture: a relay that dropped one (after 14 days) or was told to by someone
 * holding its token would otherwise pass for the phone. A phone that has
 * never given it may be an older build that never will, and then the relay is
 * all there is to go on.
 *
 * Time alone never gives up on the word: the phone's look may be slow, the
 * computer may wake from sleep before the page has read the feed, or a live
 * socket may be quietly dead. So the word is given up on only when a look
 * that started UNCONFIRMED_AFTER_MS or more after the capture left the relay
 * read the feed to its end without it. A clock that went back past unlistedAt,
 * or past that look, counts as no time passed.
 *
 * "delivered" (no word to wait for), "unlisted" (start waiting for the word,
 * or start again after the clock went back: keep [now] as unlistedAt),
 * "relisted" (on the relay again: the wait is over, drop unlistedAt),
 * "unconfirmed" (such a look brought nothing), "overdue" (the time is up and
 * no such look has been made: one is wanted, feedLookWanted), or null for no
 * change.
 */
export function afterDeliveryLook(item, listed, givesWord, now, endLookFrom = null) {
  if (!sentOut(item)) return null;
  const waiting = Number.isFinite(item.unlistedAt);
  if (listed) return waiting ? "relisted" : null;
  if (!givesWord) return "delivered";
  if (!waiting || now < item.unlistedAt) return "unlisted";
  const due = item.unlistedAt + UNCONFIRMED_AFTER_MS;
  if (Number.isFinite(endLookFrom) && endLookFrom >= due && endLookFrom <= now) return "unconfirmed";
  return now >= due ? "overdue" : null;
}

/**
 * Whether an "overdue" [item] should ask for a look at the feed now rather
 * than wait for the next poll, given when the last look started
 * ([lastLookFrom], whether or not it reached the end): only while no look has
 * started since its time was up. The look asked for starts then, so each wait
 * asks at most once; one that does not reach the end is carried on by the
 * page's poll, which runs every half minute while the last look fell short.
 */
export function feedLookWanted(item, lastLookFrom, now) {
  const due = item.unlistedAt + UNCONFIRMED_AFTER_MS;
  return !(lastLookFrom >= due && lastLookFrom <= now);
}

/** The sent [items] the phone's "took" with [ids] puts on it: those named and not on it already. */
export function tookFrom(items, ids) {
  const named = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  return items.filter((i) => named.has(i.id) && !i.delivered);
}

/**
 * How much older than a send the phone's copy may say it is and still be that
 * send's: the phone dates an imported capture by its own clock, which may run
 * a little behind this computer's.
 */
export const SENT_MATCH_SLACK_MS = 60_000;

/**
 * The sent [items] the phone's copies in [captures] show have arrived: one
 * with the same words, or a picture with the same fingerprint, dated no more
 * than SENT_MATCH_SLACK_MS before the send. The phone gives an imported
 * capture its own id, so nothing else ties the two. [captures] are the
 * library's and the copies a look applied that may since have gone; an item's
 * imageHash is worked out before this is asked.
 */
export function arrivedFrom(items, captures) {
  const texts = new Map();
  const hashes = new Map();
  const later = (map, key, at) => map.set(key, Math.max(map.get(key) ?? 0, at ?? 0));
  for (const c of captures) {
    if (c.sent) continue;
    if (c.text) later(texts, c.text.trim(), c.capturedAt);
    for (const f of c.files ?? []) if (f.hash) later(hashes, f.hash.toLowerCase(), c.capturedAt);
  }
  return items.filter((item) => {
    const byText = item.text && (texts.get(item.text.trim()) ?? -1) >= item.createdAt - SENT_MATCH_SLACK_MS;
    const byImage = item.imageHash && (hashes.get(item.imageHash) ?? -1) >= item.createdAt - SENT_MATCH_SLACK_MS;
    return byText || byImage;
  });
}

/**
 * Ids the phone named in a "took" that matched no capture sent from here,
 * kept at most: 500, the most one "took" holds (MAX_TOOK_IDS in
 * DesktopFeed.kt), so one entry naming another computer's captures cannot
 * push out the newest. The word for a capture can come before the page has
 * kept it (the relay took it and the phone read it while the answer to the
 * send was still on its way), and is held here until then.
 */
export const UNMATCHED_TOOK_MAX = 500;

/**
 * Keeps in [kept], a Set, the [ids] of a "took" that match none of the sent
 * [items], newest last, letting the oldest go past UNMATCHED_TOOK_MAX.
 */
export function keepUnmatched(kept, items, ids) {
  if (!Array.isArray(ids)) return kept;
  const known = new Set(items.map((i) => i.id));
  for (const id of ids) {
    if (typeof id !== "string" || known.has(id)) continue;
    kept.delete(id);
    kept.add(id);
  }
  for (const id of kept) {
    if (kept.size <= UNMATCHED_TOOK_MAX) break;
    kept.delete(id);
  }
  return kept;
}

/** Whether the phone named [item] before it was kept here; it is then taken out of [kept]. */
export function tookEarly(kept, item) {
  return kept.delete(item.id);
}
