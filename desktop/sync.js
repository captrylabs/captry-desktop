// The page's side of keeping in step with the phone: reading its feed,
// applying its changes to the library, and the captures sent from here until
// the phone has them.
//
// No DOM, no timers, no network or storage of its own: the page hands in the
// relay's calls, the browser's storage, the sealing, a clock, and what only
// it can do (draw, say, keep the library), and keeps the timers and listeners
// that start a look. So all of this runs under node, as library.js does.

import {
  decodeCapture, feedCounterAfter, feedSeqAfter, feedPlaceBack, snapshotSaysTook, toBase64,
  openMoveEnvelope, relayTokenFrom, importContentKey, sealInbox, sealChange,
} from "./library-format.js?v=88";
import * as relay from "./relay.js?v=88";

/** The feed as a library with no place in it yet starts. */
const FEED_NONE = () => ({ seq: 0, since: 0, n: null, applied: 0, missing: false, short: true });

/**
 * What a new pairing starts with, from the parts of the library the phone
 * sent ([parts], from snapshotPartFits) and when it was made ([at]).
 */
export function pairedStart(parts, at) {
  return {
    // Said in the library itself, so a relay holding back the phone's word
    // cannot keep a new pairing taking the relay's.
    phoneSaysTook: snapshotSaysTook(parts),
    // Entries the library already holds are not applied again.
    feed: { seq: 0, since: at, n: parts.n ?? null, applied: 0, missing: false, short: true },
  };
}

/** Where a library kept in this browser carries on in the feed, from what was kept ([kept], its `feed`). */
export function cachedFeed(kept, { beforeMove = false } = {}) {
  const n = kept?.n;
  const feed = { seq: feedSeqAfter(kept?.seq, 0) ?? 0, since: kept?.since ?? 0, n: Number.isSafeInteger(n) ? n : null, applied: 0, missing: false, short: true };
  if (Number.isFinite(kept?.refusedFrom)) feed.refusedFrom = kept.refusedFrom;
  if (Number.isFinite(kept?.heardAt)) feed.heardAt = kept.heardAt;
  // A library only the old key opens, after a move a reload cut short: read
  // from the new mailbox's start. It may have been written by a tab that had
  // not moved, at a counter short of the note, and what the phone said in
  // between is not read again: said, with pair again.
  if (beforeMove) {
    feed.seq = 0;
    feed.missing = true;
    feed.pairAgain = true;
  }
  return feed;
}

/**
 * How long a pairing with its own key may go without a signed entry from the
 * phone before it counts as stale: 21 days. The phone posts a signed "claim"
 * after 10 quiet days, so silence this long means the phone is not at this
 * mailbox any more (a move missed while the relay dropped the note).
 */
export const SILENT_STALE_MS = 21 * 24 * 60 * 60_000;

/** How long a pairing with its own key may be refused every look before it counts as stale: a day. */
export const REFUSED_STALE_MS = 24 * 60 * 60_000;

/** Whether what this computer keeps ([saved]) is the pairing with [relayToken]. */
export function storedIsThis(saved, relayToken) {
  return !!saved && (saved.relayToken ?? null) === relayToken;
}

// --- moved: the phone removed another computer ---------------------------------------------
//
// The phone moves to a new desktop key and says so as the last entry of the
// old feed: {"op":"moved","g":g_new,"to":[{"c":cid,"k":envelope}, ...]}, then
// {"op":"unpaired"} for computers without a key of their own. This computer
// follows when its envelope opens; one left out was the one removed.

/**
 * What a "moved" change [moved] means for a pairing with [computer] (null
 * for one without a key of its own): { g, k } to move to generation g with
 * envelope k, "removed" when the phone named other computers and not this
 * one, else "unpaired": the old key is never kept after a move.
 */
export function movedVerdict(computer, moved) {
  if (!computer || !Array.isArray(moved?.to)) return "unpaired";
  const mine = moved.to.find((t) => t?.c === computer.cid);
  if (!mine) return "removed";
  if (!Number.isSafeInteger(moved.g) || moved.g <= computer.g || moved.g > 0xffffffff || typeof mine.k !== "string") return "unpaired";
  return { g: moved.g, k: mine.k };
}

/**
 * The pairing to keep after a move to [next] ({ key, relayToken, computer,
 * oldKey }), given what is kept now ([kept]), or null to leave it: only over
 * this computer's own pairing, as it was before the move (the token
 * [oldToken]) or already at the new key. Another pairing kept since, none
 * (forgotten in another tab), or a newer generation is left alone. With
 * [next].oldKey the old key is kept beside the new one until everything
 * sealed with it is sealed again (keepMoved).
 */
export function placeAfterMove(kept, oldToken, next, savedAt) {
  if (kept?.kind !== "paired" || kept.computer?.cid !== next.computer.cid) return null;
  const before = oldToken !== null && kept.relayToken === oldToken && kept.computer.g < next.computer.g;
  const already = kept.relayToken === next.relayToken && kept.computer.g === next.computer.g;
  if (!before && !already) return null;
  const place = { kind: kept.kind, name: kept.name, key: next.key, relayToken: next.relayToken, computer: next.computer, savedAt };
  if (next.oldKey) place.oldKey = next.oldKey;
  return place;
}

/**
 * Whether the relay dropped entries this computer had not read: its
 * [trimmedThrough] past the place kept, [seq]. A "moved" note may be among
 * them, so for a pairing with its own key this is lost changes.
 */
export function trimmedPast(seq, trimmedThrough) {
  return seq > 0 && Number.isSafeInteger(trimmedThrough) && trimmedThrough > seq;
}

/** Whether [a] and [b] are the same kept pairing at the same key: token and generation. */
export function samePlace(a, b) {
  return !!a && !!b && (a.relayToken ?? null) === (b.relayToken ?? null) && (a.computer?.g ?? null) === (b.computer?.g ?? null);
}

/** The type a blob may carry: a picture's or a sound's, else plain bytes. */
export function safeMime(mime) {
  const m = String(mime ?? "").toLowerCase().split(";")[0].trim();
  return /^(image\/(jpeg|png|gif|webp|heic|heif|avif|bmp)|audio\/[a-z0-9.+-]+)$/.test(m) ? m : "application/octet-stream";
}

export function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The sync for one page. [host] gives:
 *  - opened(): the library open now, or null (the page's `opened`);
 *  - net: the relay's feedSince, feedEntry and waiting;
 *  - store: recall, addSent, sent, removeSent and saveImage;
 *  - openFeed, sealCache, openCache and sha256Hex;
 *  - now(): the clock;
 *  - feedFiles and thumbOnly: the page's pictures as the phone sent them, and
 *    those known only as a small copy;
 *  - what only the page does, each at the moment the page did it: updateSync,
 *    persistLibrary, redrawFeed (after a look changed something), redrawSent
 *    (after the delivery watch settled a sent capture), savedToPhone(count),
 *    pausedChanged(paused), changesLost, unpaired(relayToken),
 *    settleEdit(result), editsOver(capture), editsCollected(stillWaiting),
 *    forgetPictureUrl(name) and pictureArrived(name).
 *
 * For a pairing with its own key (opened().computer) also:
 *  - net.send, and store's updatePlace, dropWrites, sealedRefs, getSealed
 *    and swapSealed;
 *  - unansweredEdits(): the page's edits the phone has not answered, each
 *    { id, captureId, ops, at, g, relayId, collected }, to be changed in place;
 *  - libraryRecord(target): the library as saveLibrary keeps it, sealed with
 *    target's key now, or null;
 *  - staleChanged(stale), when the phone may have moved on without this computer;
 *  - exclusive(work): runs work with no other tab of this page in its own;
 *  - moved(oldRelayToken), once this page has moved to the new key, and
 *    removed(relayToken), when the phone removed this computer.
 */
export function createSync(host) {
  const { opened, net, store, openFeed, sealCache, openCache, sha256Hex, now, feedFiles, thumbOnly } = host;

  /** Captures sent from this page that the library does not show yet. */
  let sentItems = [];

  /** Ids the phone said it took before a capture sent from here was kept (relay.keepUnmatched). */
  const tookUnmatched = new Set();

  /**
   * The phone's changes since pairing, through the relay's feed.
   *
   * On opening, every kept entry newer than the library is applied in order;
   * after that, only new ones, every half minute while the page is in view.
   * An upsert replaces or adds a capture, with any new pictures; a delete
   * removes one.
   *
   * `short` is true until a look reaches the last entry, and only then may the
   * page say "Up to date": a library just opened has not looked yet.
   */
  let feed = FEED_NONE();
  // What each upsert applied in the look being made showed that a sent capture
  // is matched on (settleSent), kept until the look ends: a later change in the
  // same look may delete the copy before the look gets to settle. Kept beside
  // the feed, so closing the library drops it with the rest and a look still
  // running for that library cannot settle another's sent captures with it.
  let lookArrived = [];
  let feedRunning = false;
  let feedAgain = false;
  let lastFeedLook = 0;
  let lastPhoneAt = 0;

  /**
   * Whether [target], the library open here, may write to what this computer
   * keeps: remembered, and still the pairing kept. A tab left open on another
   * pairing would otherwise write its library, draft or sent captures over the
   * one kept now. Once it is not, it never is again for this library, and the
   * tab goes on as it is, writing nothing.
   */
  async function keptHere(target) {
    // While moving to a new key the kept pairing is not yet the new one:
    // nothing is written, and nothing decided for good.
    if (target?.moving) return false;
    if (!target || target.ephemeral || target.notKept) return false;
    if (storedIsThis(await store.recall(), target.relayToken ?? null)) return true;
    target.notKept = true;
    return false;
  }

  /**
   * Keeps [record], a capture the relay has just taken from here, with the
   * captures sent; written after every write asked for before (saveSent).
   */
  function keepSent(record) {
    sentItems.push(record);
    // The phone's word may have come while the send was being answered.
    if (relay.tookEarly(tookUnmatched, record)) record.delivered = true;
    const saved = saveSent(record);
    // Sealed for the key before a move that came while it was being sent.
    if (Number.isSafeInteger(record.g) && record.g < (opened()?.computer?.g ?? 0)) saved.then(resendStale);
    return saved;
  }

  /**
   * Drops sent captures the library already has.
   *
   * The phone gives an imported capture its own id, so it is matched by its
   * words or its picture's fingerprint, either newer than the send
   * (relay.arrivedFrom). A copy the look being made applied counts too, though
   * a later change in the same look deleted it: it did reach the phone.
   */
  async function settleSent() {
    if (!sentItems.length || !opened()) return;
    for (const item of sentItems) {
      if (!item.imageHash && item.image) item.imageHash = await sha256Hex(new Uint8Array(await item.image.arrayBuffer()));
    }
    const arrived = relay.arrivedFrom(sentItems, [...opened().manifest.captures, ...lookArrived]);
    if (!arrived.length) return;
    const ids = arrived.map((i) => i.id);
    sentItems = sentItems.filter((i) => !ids.includes(i.id));
    await removeSent(ids);
  }

  /**
   * One look at the relay by the delivery watch, which the page runs every few
   * seconds while anything sent through it is still out. Throws when the
   * relay could not be asked, or another library opened meanwhile.
   */
  async function deliveryLook() {
    const target = opened();
    // Anything still sealed for the key before a move goes to the new mailbox first.
    await resendStale();
    if (opened() !== target) throw new Error("closed");
    const still = await net.waiting(target.relayToken);
    // Another pairing opened meanwhile: this mailbox says nothing of its captures.
    if (opened() !== target) throw new Error("closed");
    host.editsCollected(still);
    // Gone from the relay is on the phone only for a phone that has never
    // said what it took; one that has is waited for (relay.afterDeliveryLook).
    const at = now();
    const givesWord = !!opened().phoneSaysTook;
    const collected = [];
    let givenUp = 0;
    let lookWanted = false;
    for (const item of sentItems) {
      // Sent under a key before a move: its mailbox is not this one, and it
      // waits to be sent again (resendStale), never given up here.
      if (Number.isSafeInteger(item.g) && item.g < (target.computer?.g ?? 0)) continue;
      const next = relay.afterDeliveryLook(item, still.has(item.relayId), givesWord, at, feed.endLookFrom ?? null);
      if (!next) continue;
      if (next === "overdue") {
        // Not decided until a look at the feed started since has reached
        // its end: asked for now, not left to a poll that a quietly dead
        // live socket can hold off for five minutes.
        if (relay.feedLookWanted(item, lastFeedLook, at)) lookWanted = true;
        continue;
      }
      if (next === "delivered") {
        item.delivered = true;
        collected.push(item);
      } else if (next === "unlisted") {
        item.unlistedAt = at;
      } else if (next === "relisted") {
        delete item.unlistedAt;
      } else {
        item.unconfirmed = true;
        givenUp++;
      }
      await saveSent(item);
    }
    if (lookWanted) syncFeed();
    if (collected.length || givenUp) host.redrawSent();
    if (collected.length) host.savedToPhone(collected.length);
    host.updateSync();
  }

  async function syncFeed() {
    if (!opened()?.relayToken || !opened().key) return;
    // Told again while looking: look once more straight after, not in 5 minutes.
    if (feedRunning) {
      feedAgain = true;
      return;
    }
    const startedAt = now();
    lastFeedLook = startedAt;
    feedRunning = true;
    const target = opened();
    // Whether the look stopped before the last entry; only one that gets there
    // may say "Up to date". feed.short is left as the last look left it until
    // this one ends, so a routine look does not turn the pill to "Connecting";
    // one that runs on past FEED_LOOK_FRESH_MS does (feedUpToDate).
    let short = true;
    // Whether this look went back to read the feed again (feedPlaceBack).
    let wentBack = false;
    // Whether the relay refused this look for the mailbox's reads (429).
    let refusedLook = false;
    try {
      let changed = 0;
      let counted = false;
      pages: for (let pages = 1; ; pages++) {
        const before = feed.seq;
        const page = await net.feedSince(target.relayToken, feed.seq);
        if (opened() !== target) return;
        // The place is past the relay's last entry, which no honest answer
        // leads to: read what it holds again, from where it says it starts.
        // Once a look, so a relay that does it again cannot keep a look going;
        // such a look is not at the end, whatever it reads after.
        const back = feedPlaceBack(feed.seq, page.latest, page.trimmedThrough);
        if (back !== null) {
          if (wentBack) break;
          wentBack = true;
          feed.seq = back;
          continue;
        }
        // Entries were dropped for age or room after this library was made,
        // so something in between may be missing.
        if (feed.seq === 0 && page.trimmedThrough > 0 && page.entries[0] && page.entries[0].createdAt > feed.since) {
          feed.missing = true;
        }
        // Dropped past the place kept: for a pairing with its own key, a move
        // may have been among them. With entries after it the phone is still
        // at this mailbox, and only what was dropped is lost; with none, the
        // phone may have moved on without this computer, which then sends
        // nothing until it is paired again (stale, kept with the library).
        if (target.computer && trimmedPast(feed.seq, page.trimmedThrough)) {
          if (page.entries.some((e) => feedSeqAfter(e?.seq, feed.seq) !== null)) {
            feed.missing = true;
            feed.pairAgain = true;
          } else if (!target.stale) {
            target.stale = true;
            counted = true;
            host.staleChanged?.(true);
          }
        }
        for (const entry of page.entries) {
          // Only a number past the last: the place is kept, and one set
          // anywhere else would stop updates until pairing again.
          const seq = feedSeqAfter(entry?.seq, feed.seq);
          if (seq === null) continue;
          // The place moves past an entry only once it is dealt with for good:
          // applied, passed over on purpose, or gone from the relay.
          // Written well before the library was made: already in it. With
          // computer keys only a day before: the relay's clock and the
          // phone's may disagree, and the counter refuses what the library
          // holds, so a move is never passed over on the clock's word.
          if (entry.createdAt < feed.since - (target.computer ? 24 * 60 * 60_000 : 5 * 60_000)) {
            feed.seq = seq;
            continue;
          }
          let sealed;
          try {
            sealed = await net.feedEntry(target.relayToken, entry.seq);
          } catch (e) {
            // Refused for now or not reached: stop here, and the next look
            // asks for this one again.
            if (relay.afterFeedEntryFailed(e?.status) === "stop") {
              if (e?.status === 429) refusedLook = true;
              break pages;
            }
            // Trimmed between the list and the fetch: a change was lost. With
            // computer keys it may have been a move, so nothing is sent until
            // the phone's next word comes (stale).
            feed.missing = true;
            if (target.computer) {
              feed.pairAgain = true;
              if (!target.stale) {
                target.stale = true;
                counted = true;
                host.staleChanged?.(true);
              }
            }
            feed.seq = seq;
            continue;
          }
          if (opened() !== target) return;
          // A pairing with its own key takes only what the phone signed; one
          // that is not is passed over like an entry served again.
          const refused = {};
          const body = await openFeed(target.key, sealed, target.computer ?? null, refused);
          if (!body) {
            // Sealed with K and naming this generation or a later one, yet not
            // signed as the phone signs: the phone's word may be lost (a later
            // generation is a move this computer missed). Said, and passed over.
            if (target.computer && Number.isSafeInteger(refused.g) && refused.g >= target.computer.g) {
              feed.missing = true;
              feed.pairAgain = true;
            }
            feed.seq = seq;
            continue;
          }
          if (!target.computer && body.at < feed.since) {
            feed.seq = seq;
            continue;
          }
          // Served again by the relay, or not numbered as the phone numbers them.
          // The counter is raised only once the entry is dealt with: one that
          // fails part-way is read again, a move above all.
          const count = feedCounterAfter(body, feed.n);
          if (!count.apply) {
            feed.seq = seq;
            continue;
          }
          // When the phone last changed anything is its own word, sealed in
          // an entry that opened and was counted, not the relay's listing,
          // which could say any time; and never later than now.
          if (Number.isFinite(body.at)) lastPhoneAt = Math.max(lastPhoneAt, Math.min(body.at, now()));
          // The phone removed a computer and moved to a new key: this one
          // follows when it is still paired, and is forgotten when it is not.
          // Looked for before "unpaired", which comes with it for computers
          // that cannot follow.
          const moved = body.changes.find((c) => c?.op === "moved");
          if (moved) {
            const verdict = movedVerdict(target.computer ?? null, moved);
            if (verdict === "removed") {
              await host.removed(target.relayToken);
              return;
            }
            const raw = verdict === "unpaired" ? null : await openMoveEnvelope(target.computer.ek, target.computer.cid, verdict.g, verdict.k);
            if (opened() !== target) return;
            if (!raw) {
              await host.unpaired(target.relayToken);
              return;
            }
            // The switch is first; the counter moves with it. Not made while
            // an earlier move cannot be finished: the note is read again.
            if (!(await moveTo(target, raw, verdict.g, count.highest))) break pages;
            // Nothing after the note is read here: the next look is at the new mailbox.
            feedAgain = true;
            // What this look applied before the note is shown; the library
            // was kept as the move wrote it.
            if (changed && opened() === target) {
              feed.applied += changed;
              await settleSent();
              host.redrawFeed();
            }
            return;
          }
          // The phone reset its key: this computer's copy is no longer kept up
          // to date, and nothing it sends would be read. Forget it here.
          if (body.changes?.some((c) => c?.op === "unpaired")) {
            await host.unpaired(target.relayToken);
            return;
          }
          // An entry the page cannot apply (a change it does not read) is
          // passed over, said as lost, and never fetched again: read again
          // it would fail again, and hold back everything behind it.
          try {
            changed += applyChanges(body.changes);
          } catch (e) {
            console.warn("Captry: a change from the phone could not be applied", e);
            feed.missing = true;
            changed++;
          }
          if (feed.n !== count.highest) {
            feed.n = count.highest;
            counted = true;
          }
          // The phone's word, checked: this computer is still at its mailbox.
          // A "claim" (its keep-alive) changes nothing else, and counts here.
          if (target.computer) feed.heardAt = now();
          if (target.stale) {
            target.stale = false;
            counted = true;
            host.staleChanged?.(false);
          }
          feed.seq = seq;
        }
        if (!relay.moreFeedPages(page.entries.length, before, feed.seq, pages)) {
          // Stopped at the cap with more to read, the next look carries on.
          short = wentBack || relay.feedPagesCapped(page.entries.length, before, feed.seq, pages);
          break;
        }
      }
      feed.short = short;
      afterLook(target, !short, refusedLook);
      // Every word the phone had posted when this look started has been read:
      // what the delivery watch waits for before giving one up (relay.afterDeliveryLook).
      if (!short) feed.endLookFrom = startedAt;
      host.updateSync();
      // The counter is kept with the library even when nothing shown changed,
      // and so is a place that went back, or the next visit goes back again.
      if ((counted || wentBack) && !changed) host.persistLibrary();
      if (changed) {
        host.persistLibrary();
        feed.applied += changed;
        await settleSent();
        host.redrawFeed();
      }
      if (feed.missing && !feed.warned) {
        feed.warned = true;
        host.changesLost(feed.pairAgain ? "trimmed" : "old");
      }
    } catch (e) {
      // Offline for a moment, or the relay is busy: the next look tries again.
      if (opened() === target) {
        feed.short = true;
        afterLook(target, false, refusedLook || e?.status === 429);
        host.updateSync();
        // The next look starts past what this one applied, so a copy it saw
        // and then saw deleted is settled now or never.
        if (lookArrived.length) await settleSent().catch(() => {});
      }
    } finally {
      lookArrived = [];
      feedRunning = false;
      if (feedAgain && opened()) {
        feedAgain = false;
        syncFeed();
      }
    }
  }

  /**
   * For a pairing with its own key: a computer the phone removed can use up
   * the old mailbox's reads for the day, so the note is never read. Refused
   * every look for REFUSED_STALE_MS, with none reaching the end, it counts as
   * stale and sends nothing; a look that reaches the end ends that.
   */
  function afterLook(target, reachedEnd, refused) {
    if (!target.computer || opened() !== target) return;
    // Counted from pairing, or a library from before this, from now.
    if (!Number.isFinite(feed.heardAt)) {
      feed.heardAt = now();
      host.persistLibrary();
    } else if (now() - feed.heardAt >= SILENT_STALE_MS && !target.stale) {
      // Checked after the look, so a keep-alive waiting in the feed is read first.
      target.stale = true;
      host.staleChanged?.(true);
      host.persistLibrary();
    }
    if (reachedEnd) {
      let kept = false;
      if (feed.refusedFrom !== undefined) {
        delete feed.refusedFrom;
        kept = true;
      }
      if (target.stale === "refused") {
        target.stale = false;
        kept = true;
        host.staleChanged?.(false);
      }
      if (kept) host.persistLibrary();
      return;
    }
    if (!refused) return;
    if (!Number.isFinite(feed.refusedFrom)) {
      feed.refusedFrom = now();
      host.persistLibrary();
    } else if (now() - feed.refusedFrom >= REFUSED_STALE_MS && !target.stale) {
      target.stale = "refused";
      host.staleChanged?.(true);
      host.persistLibrary();
    }
  }

  // --- paused ------------------------------------------------------------------------
  //
  // Pro ended on the phone: it says so through the feed, collects what was
  // already waiting and then sends and takes nothing more. The library here
  // stays readable; captures and edits from here stop, since nothing would
  // collect them. Its word that Pro is back, or any change after it, starts
  // things again.

  /** True when it changed. */
  function setPaused(paused) {
    if (!opened() || !!opened().paused === paused) return false;
    opened().paused = paused;
    host.pausedChanged(paused);
    return true;
  }

  /**
   * A change from a phone last heard to be paused: its word that Pro was back
   * was dropped for age, and other changes may have gone with it.
   */
  function changedWhilePaused() {
    if (!opened().paused) return;
    setPaused(false);
    feed.missing = true;
  }

  /**
   * The phone's word that it took captures sent from here: [ids] are the ids
   * sealed inside them. From its first word on, gone from the relay no longer
   * means on the phone (relay.afterDeliveryLook); that is kept with the library,
   * so a reload remembers it, and a new pairing starts with what its library
   * says (snapshotSaysTook). Counted, so the library is kept and the list drawn
   * again. Ids that match nothing sent from here yet are held for a capture
   * still being kept (relay.keepUnmatched).
   */
  function tookHere(ids) {
    let n = 0;
    if (!opened().phoneSaysTook) {
      opened().phoneSaysTook = true;
      n++;
    }
    relay.keepUnmatched(tookUnmatched, sentItems, ids);
    const took = relay.tookFrom(sentItems, ids);
    for (const item of took) {
      item.delivered = true;
      item.unconfirmed = false;
      // Not awaited: saves are written in the order they are asked for (saveSent).
      saveSent(item).catch(() => {});
    }
    if (took.length) host.savedToPhone(took.length);
    return n + took.length;
  }

  function applyChanges(changes) {
    let n = 0;
    for (const change of changes) {
      if (change.op === "paused" || change.op === "resumed") {
        // Counted, so it is kept with the library and the page is drawn again.
        n += setPaused(change.op === "paused") ? 1 : 0;
        // Back: what waited to go to a new mailbox goes now.
        if (change.op === "resumed") resendStale().catch(() => {});
      } else if (change.op === "result" && change.id) {
        n += host.settleEdit(change) ? 1 : 0;
      } else if (change.op === "took" && Array.isArray(change.ids)) {
        n += tookHere(change.ids);
      } else if (change.op === "files" && Array.isArray(change.files)) {
        for (const f of change.files) {
          if (!f.file || !f.data) continue;
          const bytes = fromBase64(f.data);
          const known = opened().manifest.captures.find((c) => c.id === change.capture)?.files.find((x) => x.file === f.file);
          feedFiles.set(f.file, new Blob([bytes], { type: safeMime(known?.mimeType) }));
          thumbOnly.delete(f.file);
          host.forgetPictureUrl(f.file);
          cacheImage(opened(), f.file, bytes);
          host.pictureArrived(f.file);
          n++;
        }
      } else if (change.op === "delete" && change.id) {
        changedWhilePaused();
        const before = opened().manifest.captures.length;
        opened().manifest.captures = opened().manifest.captures.filter((c) => c.id !== change.id);
        n += before - opened().manifest.captures.length;
      } else if (change.op === "upsert" && change.capture) {
        const capture = decodeCapture(change.capture);
        if (!capture?.id) continue;
        changedWhilePaused();
        // On the phone now, whatever a later change in this look does to it.
        lookArrived.push({
          text: capture.text?.trim(),
          capturedAt: capture.capturedAt,
          files: (capture.files ?? []).filter((f) => f.hash).map((f) => ({ hash: f.hash.toLowerCase() })),
        });
        for (const f of change.files ?? []) {
          if (!f.file || !f.data) continue;
          const mime = capture.files.find((x) => x.file === f.file)?.mimeType ?? "";
          // A picture comes as a small copy; opening it asks for the full one.
          // One this computer sent is here in full already, so that is kept.
          const hash = capture.files.find((x) => x.file === f.file)?.hash?.toLowerCase();
          const mine = f.thumb && hash ? sentItems.find((i) => i.image && i.imageHash === hash)?.image : null;
          if (mine) {
            feedFiles.set(f.file, mine);
            thumbOnly.delete(f.file);
            const target = opened();
            if (!target.ephemeral) mine.arrayBuffer().then((b) => cacheImage(target, f.file, new Uint8Array(b)));
            continue;
          }
          const bytes = fromBase64(f.data);
          feedFiles.set(f.file, new Blob([bytes], { type: safeMime(mime) }));
          if (f.thumb) thumbOnly.add(f.file);
          else thumbOnly.delete(f.file);
          cacheImage(opened(), f.file, bytes);
        }
        // Held back by the page: waiting out its Undo in Trash, or shown with
        // the page's edits the phone has not answered yet on top (editsOver).
        if (host.editsOver(capture)) continue;
        opened().manifest.captures = opened().manifest.captures.filter((c) => c.id !== capture.id);
        opened().manifest.captures.push(capture);
        n++;
      }
    }
    return n;
  }

  /**
   * Keeps a picture sealed with [target]'s key. Sealed again when the key
   * moved while it was being sealed, so nothing lands that only the old key opens.
   */
  async function cacheImage(target, name, bytes) {
    if (!target || target.ephemeral) return;
    for (let tries = 0; tries < 3; tries++) {
      const key = target.key;
      const sealed = await sealCache(key, bytes);
      if (opened() !== target) return;
      if (target.key === key) {
        await store.saveImage(name, sealed);
        return;
      }
    }
  }

  // --- moving to a new key ----------------------------------------------------------------------
  //
  // The page switches at once: from the moment the note is read nothing goes to
  // the old mailbox, and nothing is sealed with the old key. What this browser
  // keeps follows in an order that opens at every step with what the kept
  // pairing holds:
  //   1. the pairing, with the new key and token, and the old key beside them
  //   2. the library, sealed with the new key, at the start of the new mailbox
  //   3. every other sealed record, sealed again under the new key
  //   4. the pairing without the old key
  // A reload part-way finds the old key still kept and finishes (finishMove);
  // a library that only the old key opens is still at the old mailbox's place,
  // so the page reads the new one from its start. Then what the phone had not
  // confirmed by the note is sent again (resendNow).

  async function moveTo(target, raw, g, n) {
    // The key before the last move still held: what only it opens is sealed
    // again first, or it would be lost under a second old key.
    if (target.oldKey) {
      let holdOld = true;
      try {
        holdOld = await host.exclusive(() => keepMoved(target, null));
      } catch (e) {
        // Left held: tried again on the next look.
      }
      if (holdOld) {
        raw.fill(0);
        return false;
      }
      delete target.oldKey;
    }
    const oldToken = target.relayToken;
    let relayToken;
    let key;
    try {
      relayToken = await relayTokenFrom(raw);
      key = await importContentKey(raw);
    } finally {
      raw.fill(0);
    }
    if (opened() !== target) return true;
    if (!target.ephemeral) {
      target.moving = true;
      // Writes asked for before, sealed with the old key, do not land after the move.
      store.dropWrites();
    }
    target.oldKey = target.key;
    target.key = key;
    target.relayToken = relayToken;
    target.computer = { ...target.computer, g };
    // A new mailbox: its numbers start again, the phone's counter does not,
    // and it counts the note now, with the switch and not before.
    feed.seq = 0;
    feed.n = n;
    feed.short = true;
    feed.warned = false;
    // The note was the phone's signed word.
    feed.heardAt = now();
    delete feed.endLookFrom;
    let holdOld = true;
    try {
      // The page's own follow-up (live socket, other tabs): a failure there
      // does not keep what is kept here on the old key.
      try {
        host.moved(oldToken);
      } catch (e) {
        console.warn("Captry: after the move", e);
      }
      await host.exclusive(async () => {
        if (opened() !== target) return;
        holdOld = await keepMoved(target, oldToken);
        await resendNow();
      });
    } finally {
      target.moving = false;
      // Kept while what only the old key opens is still kept: finishMove ends it.
      if (!holdOld) delete target.oldKey;
    }
    return true;
  }

  /**
   * Steps 1 to 4 for [target], kept here; [oldToken] is null when finishing
   * after a reload. True while the old key is still needed.
   */
  async function keepMoved(target, oldToken) {
    if (target.ephemeral) return false;
    const next = { key: target.key, relayToken: target.relayToken, computer: target.computer, oldKey: target.oldKey ?? null };
    // The pairing and the library at the new mailbox's start, in one write:
    // a reload never finds the new token beside a library at the old place.
    const library = (await host.libraryRecord?.(target)) ?? null;
    const wrote = await store.updatePlace((kept) => placeAfterMove(kept, oldToken, next, now()), library);
    target.moving = false;
    if (!wrote) {
      // Not this pairing that is kept here (forgotten, another one, or a
      // newer key already): this tab goes on writing nothing.
      target.notKept = true;
      return false;
    }
    // Kept here again, though a look at storage during the move said not.
    delete target.notKept;
    if (next.oldKey) await resealKept(next.oldKey, next.key);
    // What this tab holds, again under the new key: a save dropped at the
    // switch is not lost. Sent again by another tab first: taken as it is.
    await adoptKept(target);
    await Promise.all(sentItems.map((item) => saveSent(item)));
    // The old key goes only once the library is written under the new one and
    // nothing it opens is left.
    if (!library || (next.oldKey && (await oldKeyOpens(next.oldKey)))) return !!next.oldKey;
    await store.updatePlace((kept) => placeAfterMove(kept, null, { ...next, oldKey: null }, now()));
    return false;
  }

  /** Whether any record kept here (but the library) still opens only with [oldKey]. */
  async function oldKeyOpens(oldKey) {
    for (const ref of await store.sealedRefs()) {
      const sealed = await store.getSealed(ref);
      const plain = sealed ? await openCache(oldKey, sealed) : null;
      if (plain) {
        plain.fill(0);
        return true;
      }
    }
    return false;
  }

  /** Seals every record the old key opens again under the new one, twice over for any that landed meanwhile. */
  async function resealKept(oldKey, newKey) {
    for (let pass = 0; pass < 2; pass++) {
      let found = 0;
      for (const ref of await store.sealedRefs()) {
        const before = await store.getSealed(ref);
        const plain = before ? await openCache(oldKey, before) : null;
        if (!plain) continue;
        found++;
        const after = await sealCache(newKey, plain);
        plain.fill(0);
        await store.swapSealed(ref, before, after);
      }
      if (!found) return;
    }
  }

  /** Finishes a move a reload cut short: [target].oldKey is the key kept beside the new one. */
  function finishMove() {
    const target = opened();
    if (!target?.oldKey || !target.computer) return Promise.resolve();
    return host.exclusive(async () => {
      let holdOld = true;
      try {
        if (opened() === target) holdOld = await keepMoved(target, null);
        if (opened() === target) await resendNow();
      } finally {
        if (!holdOld) delete target.oldKey;
      }
    });
  }

  /**
   * Takes from what this browser keeps the captures another tab of this
   * pairing already sent again under the key now held, so none goes twice.
   */
  async function adoptKept(target) {
    const g = target.computer?.g;
    if (!(await keptHere(target))) return;
    const kept = new Map((await readSent([target.key])).items.map((i) => [i.id, i]));
    for (const item of sentItems) {
      const copy = kept.get(item.id);
      if (item.g === g || copy?.g !== g || !copy.relayId) continue;
      item.relayId = copy.relayId;
      item.g = g;
      item.delivered = item.delivered || !!copy.delivered;
      item.unconfirmed = !item.delivered && !!copy.unconfirmed;
      delete item.unlistedAt;
    }
  }

  let resending = null;

  /**
   * Sends again, to the mailbox of the key now held, what was sent under an
   * earlier one and not confirmed: captures the phone has not said it took or
   * shown, and edits it has not answered. Once at a time, and with no other
   * tab doing the same.
   */
  function resendStale() {
    if (!opened()?.computer) return Promise.resolve();
    if (!resending) resending = host.exclusive(resendNow).finally(() => (resending = null));
    return resending;
  }

  async function resendNow() {
    const target = opened();
    const computer = target?.computer;
    // Paused or stale: the page sends nothing until the phone takes things again.
    if (!computer || target.paused || target.stale) return;
    // Only what carries an earlier generation: a capture kept from before this
    // pairing had a key of its own went to the same mailbox, and the phone takes it there.
    const stale = (g) => Number.isSafeInteger(g) && g < computer.g;
    if (sentItems.some((i) => i.relayId && !i.delivered && stale(i.g))) await adoptKept(target);
    const items = sentItems.filter((i) => i.relayId && !i.delivered && stale(i.g));
    const edits = (host.unansweredEdits?.() ?? []).filter((e) => stale(e.g));
    if (!items.length && !edits.length) return;
    try {
      for (const item of items) {
        if (opened() !== target || target.computer !== computer) return;
        const image = item.image ? { mimeType: item.mimeType ?? item.image.type, bytes: new Uint8Array(await item.image.arrayBuffer()) } : null;
        const again = {
          id: item.id, createdAt: item.createdAt, text: item.text, image, title: item.title, note: item.note, collections: item.collections ?? [],
          remind: item.remind, pinned: item.pinned, pinIn: item.pinIn, private: item.private,
        };
        const relayId = await net.send(target.relayToken, await sealInbox(target.key, again, undefined, computer));
        if (opened() !== target || target.computer !== computer) return;
        item.relayId = relayId;
        item.g = computer.g;
        item.unconfirmed = false;
        delete item.unlistedAt;
        await saveSent(item);
      }
      for (const edit of edits) {
        if (opened() !== target || target.computer !== computer) return;
        // The same change, under the same id, so its answer settles it.
        const change = { format: 1, id: edit.id, at: edit.at, capture: edit.captureId, ops: edit.ops };
        const relayId = await net.send(target.relayToken, await sealChange(target.key, change, undefined, computer));
        if (opened() !== target || target.computer !== computer) return;
        edit.relayId = relayId;
        edit.g = computer.g;
        edit.collected = false;
      }
    } catch (e) {
      // Not reached, or refused for now: the delivery watch tries again.
    }
    host.updateSync();
  }

  // --- what was sent from here, kept sealed ------------------------------------------------
  //
  // A capture made on this page waits in IndexedDB until the phone's feed shows
  // it back, which can be a while if the phone stays in a pocket. It is sealed
  // with the same key as the library cache, so nothing typed or pasted here sits
  // readable in the browser's storage either.

  // Writes to the kept sent captures, saves and removals alike, one after
  // another in the order asked for: a save still sealing would otherwise land
  // after a later one, or after its capture was removed and bring it back.
  let sentWrites = Promise.resolve();

  function inSentOrder(work) {
    const done = sentWrites.then(work);
    sentWrites = done.catch(() => {});
    return done;
  }

  /** Keeps [item] as it is now; written after every write asked for before. */
  function saveSent(item) {
    const target = opened();
    const key = target?.key;
    if (!key || target.ephemeral) return Promise.resolve();
    const kept = { ...item };
    return inSentOrder(async () => {
      // Removed since: not brought back.
      if (!sentItems.some((i) => i.id === kept.id)) return;
      const image = kept.image ? new Uint8Array(await kept.image.arrayBuffer()) : null;
      const plain = { ...kept, image: image ? toBase64(image) : null };
      const sealed = await sealCache(key, new TextEncoder().encode(JSON.stringify(plain)));
      // The key is looked at last, right before writing: a move while this
      // was asked about would leave a record only the old key opens.
      if (!(await keptHere(target)) || opened()?.key !== key) return;
      await store.addSent({ id: kept.id, sealed, savedAt: kept.createdAt ?? now() });
    });
  }

  /** Removes the kept captures with [ids], after every write asked for before. */
  function removeSent(ids) {
    const target = opened();
    return inSentOrder(async () => {
      if (await keptHere(target)) await store.removeSent(ids);
    });
  }

  /** The kept sent captures [keys] open, and the ids of those none does. */
  async function readSent(keys) {
    const records = (await store.sent()) ?? [];
    const items = [];
    const stale = [];
    for (const record of records) {
      let bytes = null;
      for (const key of keys) {
        if (!bytes && key && record?.sealed) bytes = await openCache(key, record.sealed);
      }
      if (!bytes) {
        // Kept readable by an earlier version of this page, or under another
        // key: not shown, and not kept.
        if (record?.id) stale.push(record.id);
        continue;
      }
      try {
        const item = JSON.parse(new TextDecoder().decode(bytes));
        item.image = item.image ? new Blob([fromBase64(item.image)], { type: safeMime(item.mimeType) }) : null;
        items.push(item);
      } catch (e) {
        if (record?.id) stale.push(record.id);
      }
    }
    return { items, stale };
  }

  /**
   * The sent captures kept here that [key] opens, or [oldKey] while a move
   * is being finished; the rest are dropped. With [from], the pairing [key]
   * was read from, only while that is still the one kept: another tab may
   * have moved it to a new key meanwhile, and its records are not stale.
   */
  async function loadSent(key, oldKey = null, from = null) {
    const { items, stale } = await readSent([key, oldKey]);
    if (stale.length && (!from || samePlace(await store.recall(), from))) await store.removeSent(stale);
    return items;
  }

  /** What the feed and the phone's word held for the library being closed goes with it. */
  function closed() {
    lastPhoneAt = 0;
    tookUnmatched.clear();
    feed = FEED_NONE();
    lookArrived = [];
  }

  return {
    get sentItems() { return sentItems; },
    set sentItems(items) { sentItems = items; },
    get feed() { return feed; },
    set feed(next) { feed = next; },
    get feedRunning() { return feedRunning; },
    get lastFeedLook() { return lastFeedLook; },
    get lastPhoneAt() { return lastPhoneAt; },
    syncFeed,
    deliveryLook,
    applyChanges,
    keepSent,
    settleSent,
    saveSent,
    removeSent,
    loadSent,
    resendStale,
    finishMove,
    keptHere,
    closed,
  };
}
