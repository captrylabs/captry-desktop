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

async function call(token, path, init = {}) {
  let response;
  try {
    response = await fetch(base() + path, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (e) {
    throw new RelayError("Captry's server could not be reached.", 0);
  }
  if (!response.ok) {
    const reason = await overLimit(response)
      ?? (response.status === 507
        ? "Too much is waiting for your phone. Open Captry on the phone first."
        : response.status === 413
          ? "That capture is too large to send."
          : response.status === 429
            ? BUSY
            : "Captry's server did not accept it.");
    throw new RelayError(reason, response.status);
  }
  return response;
}

/** Sends one sealed capture. Returns the relay's id for it. */
export async function send(token, sealed) {
  const response = await call(token, "/items", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: sealed,
  });
  return (await response.json()).id;
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

/** Feed entries after `after`: { entries: [{seq, createdAt, size}], latest, trimmedThrough }. */
export async function feedSince(token, after) {
  const response = await call(token, `/feed?after=${after}`);
  return response.json();
}

export async function feedEntry(token, seq) {
  const response = await call(token, `/feed/${seq}`);
  return new Uint8Array(await response.arrayBuffer());
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
      // Keeps the connection from being dropped as idle; answered by the
      // relay without waking anything up.
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
  const response = await call(token, "/items");
  return new Set((await response.json()).items.map((i) => i.id));
}
