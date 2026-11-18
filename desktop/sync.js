// The page's side of keeping in step with the phone: reading its feed,
// applying its changes to the library, and the captures sent from here until
// the phone has them.
//
// No DOM, no timers, no network or storage of its own: the page hands in the
// relay's calls, the browser's storage, the sealing, a clock, and what only
// it can do (draw, say, keep the library), and keeps the timers and listeners
// that start a look. So all of this runs under node, as library.js does.

import { decodeCapture, feedCounterAfter, feedSeqAfter, feedPlaceBack, snapshotSaysTook, toBase64 } from "./library-format.js?v=87";
import * as relay from "./relay.js?v=87";

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
export function cachedFeed(kept) {
  const n = kept?.n;
  return { seq: feedSeqAfter(kept?.seq, 0) ?? 0, since: kept?.since ?? 0, n: Number.isSafeInteger(n) ? n : null, applied: 0, missing: false, short: true };
}

/** Whether what this computer keeps ([saved]) is the pairing with [relayToken]. */
export function storedIsThis(saved, relayToken) {
  return !!saved && (saved.relayToken ?? null) === relayToken;
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
    return saveSent(record);
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
        for (const entry of page.entries) {
          // Only a number past the last: the place is kept, and one set
          // anywhere else would stop updates until pairing again.
          const seq = feedSeqAfter(entry?.seq, feed.seq);
          if (seq === null) continue;
          // The place moves past an entry only once it is dealt with for good:
          // applied, passed over on purpose, or gone from the relay.
          // Written well before the library was made: already in it.
          if (entry.createdAt < feed.since - 5 * 60_000) {
            feed.seq = seq;
            continue;
          }
          let sealed;
          try {
            sealed = await net.feedEntry(target.relayToken, entry.seq);
          } catch (e) {
            // Refused for now or not reached: stop here, and the next look
            // asks for this one again.
            if (relay.afterFeedEntryFailed(e?.status) === "stop") break pages;
            // Trimmed between the list and the fetch: a change was lost.
            feed.missing = true;
            feed.seq = seq;
            continue;
          }
          if (opened() !== target) return;
          const body = await openFeed(target.key, sealed);
          if (!body || body.at < feed.since) {
            feed.seq = seq;
            continue;
          }
          // Served again by the relay, or not numbered as the phone numbers them.
          const count = feedCounterAfter(body, feed.n);
          if (!count.apply) {
            feed.seq = seq;
            continue;
          }
          if (feed.n !== count.highest) {
            feed.n = count.highest;
            counted = true;
          }
          // When the phone last changed anything is its own word, sealed in
          // an entry that opened and was counted, not the relay's listing,
          // which could say any time; and never later than now.
          if (Number.isFinite(body.at)) lastPhoneAt = Math.max(lastPhoneAt, Math.min(body.at, now()));
          // The phone reset its key: this computer's copy is no longer kept up
          // to date, and nothing it sends would be read. Forget it here.
          if (body.changes?.some((c) => c.op === "unpaired")) {
            await host.unpaired(target.relayToken);
            return;
          }
          changed += applyChanges(body.changes);
          feed.seq = seq;
        }
        if (!relay.moreFeedPages(page.entries.length, before, feed.seq, pages)) {
          // Stopped at the cap with more to read, the next look carries on.
          short = wentBack || relay.feedPagesCapped(page.entries.length, before, feed.seq, pages);
          break;
        }
      }
      feed.short = short;
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
        host.changesLost();
      }
    } catch (e) {
      // Offline for a moment, or the relay is busy: the next look tries again.
      if (opened() === target) {
        feed.short = true;
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
          const target = opened();
          if (!target.ephemeral) sealCache(target.key, bytes).then((sealed) => opened() === target && store.saveImage(f.file, sealed));
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
            if (!target.ephemeral) mine.arrayBuffer().then((b) => sealCache(target.key, new Uint8Array(b))).then((sealed) => opened() === target && store.saveImage(f.file, sealed));
            continue;
          }
          const bytes = fromBase64(f.data);
          feedFiles.set(f.file, new Blob([bytes], { type: safeMime(mime) }));
          if (f.thumb) thumbOnly.add(f.file);
          else thumbOnly.delete(f.file);
          const target = opened();
          if (!target.ephemeral) sealCache(target.key, bytes).then((sealed) => opened() === target && store.saveImage(f.file, sealed));
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
      if (opened()?.key !== key || !(await keptHere(target))) return;
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

  async function loadSent(key) {
    const records = (await store.sent()) ?? [];
    const items = [];
    const stale = [];
    for (const record of records) {
      const bytes = key && record?.sealed ? await openCache(key, record.sealed) : null;
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
    if (stale.length) await store.removeSent(stale);
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
    keptHere,
    closed,
  };
}
