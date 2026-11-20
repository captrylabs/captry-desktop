// What a paired computer keeps in the browser, in IndexedDB:
//   place    the pairing: the phone's name, the content key as a
//            non-extractable CryptoKey, and the relay token; for a pairing
//            with its own key, `computer` too (cid, g and its keys, each
//            non-extractable), and `oldKey` while a move is being finished
//   sent     captures sent from here that the library does not show yet,
//            each sealed with that key (viewer.js saveSent)
//   library  the library, sealed with that key, so a reload shows it at once
//   images   pictures already looked at, sealed the same way
//
// Never the recovery code, and nothing decrypted: what is cached can only be
// read with the remembered key, which no script can take out of the browser.
// Every call is wrapped: a private window or blocked storage means the page
// forgets, not that it breaks.

import { keepsNewer } from "./pair.js?v=88";

const DB = "captry-desktop";
// 3 since computer keys: a tab still running the page from before cannot
// open a database at a newer version, so it can neither read a pairing it
// does not understand nor wipe it. Nothing in the stores changed.
const VERSION = 3;
const PLACE = "place";
const SENT = "sent";
const LIBRARY = "library";
const IMAGES = "images";
const MAX_IMAGES = 400;

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PLACE)) db.createObjectStore(PLACE);
      if (!db.objectStoreNames.contains(SENT)) db.createObjectStore(SENT, { keyPath: "id" });
      if (!db.objectStoreNames.contains(LIBRARY)) db.createObjectStore(LIBRARY);
      if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES, { keyPath: "name" }).createIndex("savedAt", "savedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Counts forget()s. A write asked for before one does not land after it: it
// is dropped if forget() came while the database was opening, and is ordered
// before the clearing if it was already under way.
let generation = 0;

async function run(store, mode, work, asked = generation) {
  const db = await open();
  try {
    if (mode === "readwrite" && asked !== generation) return undefined;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      // Several stores: the work gets the transaction itself.
      const result = work(Array.isArray(store) ? tx : tx.objectStore(store));
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function safely(work, fallback) {
  try {
    return await work();
  } catch (e) {
    console.warn("Captry: browser storage is not available", e);
    return fallback;
  }
}

/**
 * Keeps the pairing: `place` is { kind: "paired", name }, with the key and
 * token, and for a pairing with its own key [more].computer (its cid, g and
 * keys, all non-extractable). Never over a newer generation of the same
 * computer (keepsNewer), which another tab may have written.
 */
export function remember(place, key, relayToken = null, more = {}) {
  const record = { ...place, ...more, key, relayToken, savedAt: Date.now() };
  return updatePlace((kept) => (keepsNewer(kept, record) ? null : record));
}

/**
 * Replaces the pairing kept with what [change] makes of it (null when there
 * is none), or leaves it when [change] answers null. Read and written in one
 * transaction, so nothing lands in between. With [library] (as saveLibrary
 * takes it), that is written in the same transaction, and only with the
 * pairing: a move keeps the new key and the library at the new mailbox
 * together or neither. True when it wrote.
 */
export function updatePlace(change, library = null) {
  return safely(() => run(library ? [PLACE, LIBRARY] : PLACE, "readwrite", (t) => {
    const s = library ? t.objectStore(PLACE) : t;
    const out = { result: false };
    const get = s.get("current");
    get.onsuccess = () => {
      const next = change(get.result ?? null);
      if (!next) return;
      s.put(next, "current");
      if (library) t.objectStore(LIBRARY).put(library, "current");
      out.result = true;
    };
    return out;
  }), false);
}

export function recall() {
  return safely(() => run(PLACE, "readonly", (s) => s.get("current")), null);
}

/** Drops every write asked for so far that has not started. */
export function dropWrites() {
  generation++;
}

/** Forgets everything: the place, the key, the cache, and anything waiting. */
export async function forget() {
  dropWrites();
  for (const store of [PLACE, SENT, LIBRARY, IMAGES]) {
    await safely(() => run(store, "readwrite", (s) => s.clear()), null);
  }
}

/** A capture sent from here, kept so it can be shown until the library has it. */
export function addSent(item) {
  return safely(() => run(SENT, "readwrite", (s) => s.put(item)), null);
}

export function sent() {
  return safely(() => run(SENT, "readonly", (s) => s.getAll()), []);
}

export function removeSent(ids) {
  return safely(() => run(SENT, "readwrite", (s) => ids.forEach((id) => s.delete(id))), null);
}

/** The sealed library: { name, placeKind, sealed, savedAt }. */
export function saveLibrary(record) {
  return safely(async () => {
    const out = { result: false };
    await run(LIBRARY, "readwrite", (s) => {
      s.put(record, "current").onsuccess = () => (out.result = true);
      return out;
    });
    return out.result;
  }, false);
}

export function loadLibrary() {
  return safely(() => run(LIBRARY, "readonly", (s) => s.get("current")), null);
}

/** New capture's draft, sealed like everything else here; null clears it. */
export function saveDraft(sealed) {
  return safely(() => run(LIBRARY, "readwrite", (s) => (sealed ? s.put(sealed, "draft") : s.delete("draft"))), null);
}

export function loadDraft() {
  return safely(() => run(LIBRARY, "readonly", (s) => s.get("draft")), null);
}

export function loadImage(name) {
  return safely(() => run(IMAGES, "readonly", (s) => s.get(name)), null).then((r) => r?.sealed ?? null);
}

// --- sealed again under a new key ---------------------------------------------------------
//
// When the phone moves this computer to a new key, everything kept is sealed
// again under it, one record at a time (sync.js keepMoved). The library is
// written whole by the page, so it is not among these.

/** Where every sealed record other than the library is: [{ store, id }]. */
export async function sealedRefs() {
  const refs = [];
  for (const [store, list] of [[SENT, (s) => s.getAllKeys()], [IMAGES, (s) => s.getAllKeys()], [LIBRARY, (s) => s.getAllKeys()]]) {
    const ids = (await safely(() => run(store, "readonly", list), [])) ?? [];
    for (const id of ids) if (store !== LIBRARY || id === "draft") refs.push({ store, id });
  }
  return refs;
}

const sealedOf = (store, record) => (store === LIBRARY ? record : record?.sealed ?? null);

/** The sealed bytes at [ref], or null. */
export async function getSealed(ref) {
  const record = await safely(() => run(ref.store, "readonly", (s) => s.get(ref.id)), null);
  return sealedOf(ref.store, record);
}

/**
 * Puts [after] at [ref] in place of [before], and only if [before] is still
 * what is there: a write that landed meanwhile is newer, and stays.
 */
export function swapSealed(ref, before, after) {
  return safely(() => run(ref.store, "readwrite", (s) => {
    const out = { result: false };
    const get = s.get(ref.id);
    get.onsuccess = () => {
      const record = get.result;
      const now = sealedOf(ref.store, record);
      if (!now || now.length !== before.length || !now.every((b, i) => b === before[i])) return;
      if (ref.store === LIBRARY) s.put(after, ref.id);
      else s.put({ ...record, sealed: after });
      out.result = true;
    };
    return out;
  }), false);
}

/** Keeps a sealed picture, and lets the oldest go past MAX_IMAGES. */
export async function saveImage(name, sealed) {
  await safely(() => run(IMAGES, "readwrite", (s) => s.put({ name, sealed, savedAt: Date.now() })), null);
  await safely(async () => {
    const count = await run(IMAGES, "readonly", (s) => s.count());
    if (count <= MAX_IMAGES) return;
    await run(IMAGES, "readwrite", (s) => {
      let extra = count - MAX_IMAGES + 50;
      s.index("savedAt").openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || extra-- <= 0) return;
        cursor.delete();
        cursor.continue();
      };
    });
  }, null);
}
