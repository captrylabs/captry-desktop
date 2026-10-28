// What a paired computer keeps in the browser, in IndexedDB:
//   place    the pairing: the phone's name, the content key as a
//            non-extractable CryptoKey, and the relay token
//   sent     captures sent from here that the library does not show yet,
//            each sealed with that key (viewer.js saveSent)
//   library  the library, sealed with that key, so a reload shows it at once
//   images   pictures already looked at, sealed the same way
//
// Never the recovery code, and nothing decrypted: what is cached can only be
// read with the remembered key, which no script can take out of the browser.
// Every call is wrapped: a private window or blocked storage means the page
// forgets, not that it breaks.

const DB = "captry-desktop";
const VERSION = 2;
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

async function run(store, mode, work) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const result = work(tx.objectStore(store));
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

/** Keeps the pairing: `place` is { kind: "paired", name }, with the key and token. */
export function remember(place, key, relayToken = null) {
  return safely(() => run(PLACE, "readwrite", (s) => s.put({ ...place, key, relayToken, savedAt: Date.now() }, "current")), false);
}

export function recall() {
  return safely(() => run(PLACE, "readonly", (s) => s.get("current")), null);
}

/** Forgets everything: the place, the key, the cache, and anything waiting. */
export async function forget() {
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
  return safely(() => run(LIBRARY, "readwrite", (s) => s.put(record, "current")), null);
}

export function loadLibrary() {
  return safely(() => run(LIBRARY, "readonly", (s) => s.get("current")), null);
}

export function loadImage(name) {
  return safely(() => run(IMAGES, "readonly", (s) => s.get(name)), null).then((r) => r?.sealed ?? null);
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
