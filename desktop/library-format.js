// The formats the desktop page shares with the phone, with nothing but WebCrypto.
//
//   inbox   a capture made here, for the phone        CPTRYIN (DesktopInboxFormat.kt)
//   feed    the phone's changes, and its library       CPTRYFD (DesktopFeed.kt)
//   change  an edit made here, for the phone          CPTRYCH (DesktopChanges.kt)
//   cache   what this browser keeps between visits    CPTRYCA (this page only)
//
// Each is "magic | 12-byte nonce | AES-GCM(content key, json, aad = magic)".
// The content key arrives through pairing (pair.js) and never leaves this tab
// in usable form. A capture in the library is the same json shape the phone's
// CaptureArchive writes, read by decodeManifest. No DOM here, so node can test it.

const NONCE_BYTES = 12;
const TAG_BITS = 128;

// --- size padding ---------------------------------------------------------------
//
// What goes to the relay is padded before it is sealed, inside the encryption,
// so the relay sees sizes in coarse steps instead of exact lengths. The steps
// are Padmé's (Nikitin et al., 2019): a length rounds up until only its top few
// bits are left, which adds at most about 12% and shows only O(log log n) bits
// of the true size. Anything under PAD_MIN becomes PAD_MIN, so every edit looks
// alike. The padding is spaces after the json, which every reader skips
// already, phone and page alike. Nothing is padded past what the relay takes.
// paddedLength in DesktopFeed.kt is the same function; the shared test vector
// holds the two to the same numbers.

export const PAD_MIN = 1024;
const PAD_MAX = 25 * 1024 * 1024;

export function paddedLength(n) {
  const len = Math.max(n, PAD_MIN);
  if (len >= PAD_MAX) return len;
  const e = 31 - Math.clz32(len);
  const s = 32 - Math.clz32(e);
  const step = 2 ** Math.max(0, e - s);
  return Math.min(Math.ceil(len / step) * step, PAD_MAX);
}

/** [plain] with spaces after it, out to its padded length. */
export function padded(plain) {
  const target = paddedLength(plain.length);
  if (target === plain.length) return plain;
  const out = new Uint8Array(target).fill(0x20);
  out.set(plain);
  return out;
}

function base64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The content key as a WebCrypto key that cannot be read back out.
 *
 * Non-extractable: the page can encrypt and decrypt with it, and can keep it
 * in IndexedDB when the person asks to be remembered, but no script can turn
 * it back into bytes. The raw copy is cleared as soon as it is imported.
 */
export async function importContentKey(raw) {
  try {
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

/**
 * The relay token: HMAC-SHA256(content key, "captry relay v1"), base64url.
 *
 * What the page and the phone both show the relay at api.captry.app to reach
 * the same mailbox. Worked out from the key they already share, so there is
 * no pairing; the relay keeps only a hash of it, and it opens nothing on its
 * own, since every capture is sealed with the key itself. DesktopRelay.kt
 * works it out the same way, and the test vector holds the two together.
 */
export async function relayTokenFrom(raw) {
  const mac = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode("captry relay v1")));
  return toBase64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- the inbox ---------------------------------------------------------------
//
// A capture made on this page, on its way to the phone through the relay;
// the phone adds it when it next looks (DesktopRelay.kt).
//
//   "CPTRYIN" 0x01 | 12-byte nonce | AES-GCM(content key, nonce, json, aad = the first 8 bytes)
//
// Sealed with the same content key the phone encrypts everything with, so
// the relay only ever holds ciphertext, and only someone holding the key can
// put a capture in front of the phone.

export const INBOX_MAGIC = new Uint8Array([0x43, 0x50, 0x54, 0x52, 0x59, 0x49, 0x4e, 1]); // CPTRYIN\1
export const INBOX_FORMAT = 1;
export const INBOX_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Seals one item. `nonce` is for the test vector only; anything real gets a
 * fresh random one, which AES-GCM cannot do without.
 */
export async function sealInbox(key, item, nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES)), computer = null) {
  const body = { format: INBOX_FORMAT, id: item.id, createdAt: item.createdAt };
  if (item.text) body.text = item.text;
  if (item.image) body.image = { mimeType: item.image.mimeType, data: toBase64(item.image.bytes) };
  // What New capture's options asked for; each is left out when not set.
  if (item.title) body.title = item.title;
  if (item.note) body.note = item.note;
  if (item.collections?.length) body.collections = item.collections.map((c) => (c.checklist ? { name: c.name, checklist: true } : { name: c.name }));
  if (item.remind) body.remind = item.remind.repeat ? { at: item.remind.at, repeat: item.remind.repeat } : { at: item.remind.at };
  if (item.pinned) body.pinned = true;
  if (item.pinIn) body.pinIn = item.pinIn;
  if (item.private) body.private = true;
  const legacy = padded(new TextEncoder().encode(JSON.stringify(body)));
  // A computer paired with its own key seals it again with that key (sealInner).
  const plain = computer ? await sealInner(computer, INNER_INBOX, legacy) : legacy;
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: INBOX_MAGIC, tagLength: TAG_BITS }, key, plain),
  );
  const out = new Uint8Array(INBOX_MAGIC.length + NONCE_BYTES + sealed.length);
  out.set(INBOX_MAGIC, 0);
  out.set(nonce, INBOX_MAGIC.length);
  out.set(sealed, INBOX_MAGIC.length + NONCE_BYTES);
  return out;
}

/** Opens a sealed item, or returns null when it is not one or the key does not fit. */
export async function openInbox(key, bytes) {
  if (bytes.length < INBOX_MAGIC.length + NONCE_BYTES + 16) return null;
  if (!INBOX_MAGIC.every((b, i) => bytes[i] === b)) return null;
  const nonce = bytes.subarray(INBOX_MAGIC.length, INBOX_MAGIC.length + NONCE_BYTES);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: INBOX_MAGIC, tagLength: TAG_BITS },
      key,
      bytes.subarray(INBOX_MAGIC.length + NONCE_BYTES),
    );
    const body = JSON.parse(new TextDecoder().decode(plain));
    return {
      id: body.id,
      createdAt: body.createdAt,
      text: body.text ?? null,
      image: body.image ? { mimeType: body.image.mimeType, bytes: base64(body.image.data) } : null,
      title: body.title ?? null,
      note: body.note ?? null,
      collections: (body.collections ?? []).map((c) => ({ name: c.name, checklist: !!c.checklist })),
      remind: body.remind ? { at: body.remind.at, repeat: body.remind.repeat ?? null } : null,
      pinned: !!body.pinned,
      pinIn: body.pinIn ?? null,
      private: !!body.private,
    };
  } catch (e) {
    return null;
  }
}

// --- the phone's changes ---------------------------------------------------------
//
// The other direction: the phone's changes, so the page shows a deletion or an
// edit within seconds. Pairing sends the whole library in the same format.
//
//   "CPTRYFD" 0x01 | 12-byte nonce | AES-GCM(content key, nonce, json, aad = the first 8 bytes)
//
// json is {format: 1, at, changes: [{op: "upsert", capture, files: [{file, data}]} | {op: "delete", id}]}.
// Written by DesktopFeed.kt; the test vector holds the two to the same bytes.

export const FEED_MAGIC = new Uint8Array([0x43, 0x50, 0x54, 0x52, 0x59, 0x46, 0x44, 1]); // CPTRYFD\1

export async function sealFeed(key, plain, nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))) {
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: FEED_MAGIC, tagLength: TAG_BITS }, key, padded(plain)),
  );
  const out = new Uint8Array(FEED_MAGIC.length + NONCE_BYTES + sealed.length);
  out.set(FEED_MAGIC, 0);
  out.set(nonce, FEED_MAGIC.length);
  out.set(sealed, FEED_MAGIC.length + NONCE_BYTES);
  return out;
}

async function openFeedPlain(key, bytes) {
  if (!bytes || bytes.length < FEED_MAGIC.length + NONCE_BYTES + 16) return null;
  if (!FEED_MAGIC.every((b, i) => bytes[i] === b)) return null;
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(FEED_MAGIC.length, FEED_MAGIC.length + NONCE_BYTES), additionalData: FEED_MAGIC, tagLength: TAG_BITS },
      key,
      bytes.subarray(FEED_MAGIC.length + NONCE_BYTES),
    ));
  } catch (e) {
    return null;
  }
}

/**
 * The batch of changes in an entry, or null when it is not one or the key
 * does not fit. With [computer] (a pairing with its own key, computerKeys),
 * only an entry the phone signed for this generation opens (openSignedFeed),
 * and one that opened with the key but was not taken leaves the generation it
 * named in [refused].g; without, any entry sealed with the key does, as before.
 */
export async function openFeed(key, bytes, computer = null, refused = {}) {
  const plain = await openFeedPlain(key, bytes);
  if (!plain) return null;
  if (computer) return openSignedFeed(plain, computer, refused);
  try {
    const body = JSON.parse(new TextDecoder().decode(plain));
    if (body.format !== 1 || !Array.isArray(body.changes)) return null;
    return body;
  } catch (e) {
    return null;
  }
}

// --- signed by the phone ----------------------------------------------------------------
//
// Every computer holds the desktop key, so any of them could seal an entry or
// a library part. For a pairing with its own key the phone signs each one
// (ECDSA P-256, the private half in its Keystore), over the fields the page
// uses and the exact bytes of the changes:
//
//   {"format":1,"at":A,"n":N,"g":G,"sig":"S","changes":<CHANGES>}
//   feed:  "captry feed v1\n" G "\n" N "\n" A "\n" | CHANGES
//   part:  "captry part v1\n" G "\n" P "\n" I "\n" T "\n" N "\n" A "\n" | CHANGES
//
// N is "" when the entry has none. "changes" is always last, and the page
// splits there and parses the two halves apart, so what was checked is what
// is used: a parse of the whole could take a second "changes" the signature
// never covered.

const SPLIT = new TextEncoder().encode(',"changes":');

/**
 * [plain], a signed entry or part, as { head, changes, changesBytes }, or
 * null: the padding off, ending in "}", head the text up to the first
 * ,"changes": with "}" after it, and CHANGES what is between that and the end.
 */
export function splitSigned(plain) {
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0x20) end--;
  if (end < 2 || plain[end - 1] !== 0x7d) return null;
  let at = -1;
  search: for (let i = 0; i + SPLIT.length <= end - 1; i++) {
    for (let j = 0; j < SPLIT.length; j++) if (plain[i + j] !== SPLIT[j]) continue search;
    at = i;
    break;
  }
  if (at < 0) return null;
  const headBytes = new Uint8Array(at + 1);
  headBytes.set(plain.subarray(0, at));
  headBytes[at] = 0x7d;
  const changesBytes = plain.slice(at + SPLIT.length, end - 1);
  let head;
  let changes;
  try {
    // Bytes that are not UTF-8 are refused, not mended: the signature is over the bytes.
    const strict = new TextDecoder("utf-8", { fatal: true });
    head = JSON.parse(strict.decode(headBytes));
    changes = JSON.parse(strict.decode(changesBytes));
  } catch (e) {
    return null;
  }
  if (!head || typeof head !== "object" || Array.isArray(head) || !Array.isArray(changes)) return null;
  return { head, changes, changesBytes };
}

async function signedBy(verify, prefix, changesBytes, sig) {
  // 64 bytes, r | s, as WebCrypto checks it.
  if (typeof sig !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(sig)) return false;
  const head = new TextEncoder().encode(prefix);
  const message = new Uint8Array(head.length + changesBytes.length);
  message.set(head, 0);
  message.set(changesBytes, head.length);
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verify, base64(sig), message);
  } catch (e) {
    return false;
  }
}

/** A feed entry the phone signed for [computer]'s generation, as openFeed returns it, or null. */
export async function openSignedFeed(plain, computer, refused = {}) {
  const split = splitSigned(plain);
  if (!split) return null;
  const { head, changes } = split;
  const n = head.n;
  // Opened with K and not taken: what generation it says it is for, so the
  // page can tell the phone's word it cannot check from another computer's.
  refused.g = Number.isSafeInteger(head.g) ? head.g : null;
  if (head.format !== 1 || head.g !== computer.g || !Number.isSafeInteger(head.at) || (n !== undefined && !counter(n))) return null;
  if (!(await signedBy(computer.verify, `captry feed v1\n${head.g}\n${n ?? ""}\n${head.at}\n`, split.changesBytes, head.sig))) return null;
  delete refused.g;
  // Built from the checked fields alone.
  const body = { format: 1, at: head.at, changes };
  if (n !== undefined) body.n = n;
  return body;
}

/**
 * A part of the library sent at pairing: as openFeed for a phone without
 * computer keys ([computer] null), else only one the phone signed for this
 * pairing (`pair`) and generation.
 */
export async function openSnapshotPart(key, bytes, computer = null) {
  if (!computer) return openFeed(key, bytes);
  const plain = await openFeedPlain(key, bytes);
  const split = plain && splitSigned(plain);
  if (!split) return null;
  const { head, changes } = split;
  const n = head.n;
  if (head.format !== 1 || head.g !== computer.g || !Number.isSafeInteger(head.at) || typeof head.pair !== "string" ||
    !counter(head.part) || !counter(head.parts) || (n !== undefined && !counter(n))) return null;
  const prefix = `captry part v1\n${head.g}\n${head.pair}\n${head.part}\n${head.parts}\n${n ?? ""}\n${head.at}\n`;
  if (!(await signedBy(computer.verify, prefix, split.changesBytes, head.sig))) return null;
  const body = { format: 1, at: head.at, part: head.part, parts: head.parts, pair: head.pair, changes };
  if (n !== undefined) body.n = n;
  // `took` is not signed, so it is not read: every phone with computer keys
  // names what it takes, and a computer holding K could otherwise turn it off.
  body.took = true;
  return body;
}

// --- this computer's own key ------------------------------------------------------------
//
// CK, from the key message (pair.js keyMessage), is never kept as bytes:
//   EK = HMAC-SHA256(CK, "captry computer envelope v1")   opens the new key when the phone moves
//   SK = HMAC-SHA256(CK, "captry computer send v1")       seals what this computer sends
// each a non-extractable WebCrypto key that can do only that one thing.

/**
 * { cid, g, ek, sk, verify } for a pairing with its own key, from the key
 * message's { ck, g, cid, spki }. CK and every derived byte are zeroed.
 */
export async function computerKeys({ ck, g, cid, spki }) {
  let ek = null;
  let sk = null;
  try {
    const mac = await crypto.subtle.importKey("raw", ck, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    ek = new Uint8Array(await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode("captry computer envelope v1")));
    sk = new Uint8Array(await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode("captry computer send v1")));
    return {
      cid,
      g,
      ek: await crypto.subtle.importKey("raw", ek, "AES-GCM", false, ["decrypt"]),
      sk: await crypto.subtle.importKey("raw", sk, "AES-GCM", false, ["encrypt"]),
      verify: await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    };
  } finally {
    ck.fill(0);
    ek?.fill(0);
    sk?.fill(0);
  }
}

// What a computer with its own key sends is sealed twice: inside the usual
// sealing with K, which every computer holds, the legacy plaintext is sealed
// with SK, which only this computer and the phone can make. So no other
// computer, a removed one included, can read it or pass for this one:
//
//   INNER = 0x02 | cid (16) | g (4, big-endian) | nonce (12) | AES-GCM(SK, plaintext, aad)
//   aad   = "CPTRYIT2" | kind | cid | g (4, big-endian), kind 'i' for a capture, 'c' for an edit
//
// INNER is not padded again: the plaintext inside already is.

export const INNER_INBOX = 0x69;
export const INNER_CHANGE = 0x63;
const INNER_MAGIC = new TextEncoder().encode("CPTRYIT2");

function innerHead(prefix, kind, cid, g) {
  const id = new TextEncoder().encode(cid);
  const out = new Uint8Array(prefix.length + (kind === null ? 0 : 1) + id.length + 4);
  out.set(prefix, 0);
  let at = prefix.length;
  if (kind !== null) out[at++] = kind;
  out.set(id, at);
  new DataView(out.buffer).setUint32(at + id.length, g);
  return out;
}

/** [plain], the legacy plaintext (padded), as INNER for [computer]; [kind] is INNER_INBOX or INNER_CHANGE. */
export async function sealInner(computer, kind, plain, nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))) {
  const aad = innerHead(INNER_MAGIC, kind, computer.cid, computer.g);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: TAG_BITS }, computer.sk, plain));
  const head = innerHead(new Uint8Array([2]), null, computer.cid, computer.g);
  const out = new Uint8Array(head.length + NONCE_BYTES + sealed.length);
  out.set(head, 0);
  out.set(nonce, head.length);
  out.set(sealed, head.length + NONCE_BYTES);
  return out;
}

const MOVE_MAGIC = new TextEncoder().encode("CPTRYMV1");

/** The additional data a move's envelope for [cid] at [g] is sealed with: "CPTRYMV1" | cid | g, 4 bytes big-endian. */
export function moveAad(cid, g) {
  const id = new TextEncoder().encode(cid);
  const out = new Uint8Array(MOVE_MAGIC.length + id.length + 4);
  out.set(MOVE_MAGIC, 0);
  out.set(id, MOVE_MAGIC.length);
  new DataView(out.buffer).setUint32(MOVE_MAGIC.length + id.length, g);
  return out;
}

/**
 * The new desktop key in a "moved" note's envelope for this computer, [k]
 * (base64 of nonce | AES-GCM(EK, K_new, moveAad)), as 32 bytes, or null.
 */
export async function openMoveEnvelope(ek, cid, g, k) {
  if (typeof k !== "string" || !Number.isSafeInteger(g) || g < 1 || g > 0xffffffff) return null;
  let bytes;
  try {
    bytes = base64(k);
  } catch (e) {
    return null;
  }
  if (bytes.length !== NONCE_BYTES + 32 + 16) return null;
  try {
    const raw = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, NONCE_BYTES), additionalData: moveAad(cid, g), tagLength: TAG_BITS },
      ek,
      bytes.subarray(NONCE_BYTES),
    ));
    if (raw.length === 32) return raw;
    raw.fill(0);
    return null;
  } catch (e) {
    return null;
  }
}

// The relay can keep a sealed entry and serve it again, or serve fewer parts
// of a library than the phone sent. It cannot change what is inside one, so
// the phone numbers them there: every entry carries `n`, a counter that only
// goes up, and every part of the library sent at pairing carries `part`,
// `parts` and the `n` it was made at. A phone from before this sends none of
// them, and its entries and parts are taken as they always were, until the
// first numbered one: after that, an entry with no `n` can only be an old one
// served again, so it is refused.

const counter = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Whether to apply [body], and the highest `n` once it is. An entry at or
 * below [highest] was applied already, and one whose `n` is not a counter is
 * not the phone's. [highest] is null until a numbered entry or library
 * arrives; once it is not, an entry with no `n` is from before and is refused.
 */
export function feedCounterAfter(body, highest) {
  if (body.n === undefined || body.n === null) return { apply: highest === null, highest };
  if (!counter(body.n) || (highest !== null && body.n <= highest)) return { apply: false, highest };
  return { apply: true, highest: body.n };
}

/**
 * [seq] as the page's next place in the feed, or null when it is not one: a
 * whole number above [last]. The relay hands out the numbers, so one that is
 * not would set the place anywhere, and it is kept. A mailbox emptied and
 * written again starts from the clock, far above any count, which passes.
 */
export function feedSeqAfter(seq, last) {
  return Number.isSafeInteger(seq) && seq > last ? seq : null;
}

/**
 * Where to read the feed from again when the place kept, [seq], is past its
 * end, or null when it is not. The relay hands out the numbers, and the
 * place moves on its word, so a number it made up can set the place past
 * every real one; the counter `n` sealed in each entry is what keeps an
 * entry from being applied twice, so going back costs reads and nothing else.
 *
 * Past the end is past [latest], the highest number the relay still holds,
 * when it holds any: numbers only go up, and the newest entry is dropped
 * last, so a relay that holds entries never holds them all below a place it
 * handed out. One that holds none (0) proves nothing: entries expire after
 * two weeks, and an unknown mailbox answers the same, so the place stays and
 * the next entry the phone writes says. Back to [trimmedThrough], the last
 * number the relay no longer has (for a reader with a place: the one before a
 * wiped feed's restart, if higher), so the whole of what it holds is read
 * again; to 0 when that is not a number below [latest].
 */
export function feedPlaceBack(seq, latest, trimmedThrough) {
  if (!Number.isSafeInteger(latest) || latest <= 0 || seq <= latest) return null;
  return Number.isSafeInteger(trimmedThrough) && trimmedThrough >= 0 && trimmedThrough < latest ? trimmedThrough : 0;
}

/** The most parts a library comes in (MAX_PARTS in worker/feedback/src/pairing.js and DesktopPairing.kt). */
export const SNAPSHOT_MAX_PARTS = 40;

/**
 * The relay's word on the library being sent at pairing, as { total, have,
 * done }, or null when it is not one the phone could have caused: `total`
 * from 1 to SNAPSHOT_MAX_PARTS and `have` the part numbers stored. Null is
 * also the answer before the first part is in (`total` 0), so the page waits
 * on either, within its time limit; `done` once every part is there.
 */
export function snapshotStatus(raw) {
  const total = raw?.total;
  const have = raw?.have;
  if (!Number.isInteger(total) || total < 1 || total > SNAPSHOT_MAX_PARTS) return null;
  if (!Array.isArray(have) || have.length > SNAPSHOT_MAX_PARTS || !have.every((i) => Number.isInteger(i))) return null;
  const got = new Set(have.filter((i) => i >= 0 && i < total)).size;
  return { total, have: got, done: got === total };
}

/**
 * Whether part [index] of a library, out of the [total] the relay says there
 * are, is where the phone put it. [seen] starts as {} and is passed from
 * part to part; once every part has fitted, seen.n is the counter the library
 * was made at, or null. Numbered parts are taken only all of them, each once,
 * in its place, from the same library. seen.snapshot says whether the first
 * part opened with the library's `snapshot` change, as every phone's does.
 *
 * Each part also names the pairing it was sent for, `pair`: the proof this
 * pairing's phone answered with ([proof], from pair.js), which no other
 * pairing shares. A relay that kept the parts of an earlier pairing cannot
 * serve them at this one, as their `pair` is that pairing's. A phone from
 * before this sends none, and its parts are taken, but only all of them
 * without it: some with and some without is not one library.
 */
export function snapshotPartFits(body, index, total, seen, proof) {
  const numbered = body.parts !== undefined && body.parts !== null;
  const paired = body.pair !== undefined && body.pair !== null;
  if (paired && (typeof proof !== "string" || body.pair !== proof)) return false;
  if (index === 0) {
    seen.numbered = numbered;
    seen.paired = paired;
    seen.n = null;
    seen.snapshot = body.changes.some((c) => c?.op === "snapshot");
  } else if (numbered !== seen.numbered || paired !== seen.paired) {
    return false;
  }
  // Read by snapshotSaysTook: only a part that says so counts, so one without
  // it leaves the library as a phone from before.
  seen.took = (index === 0 || seen.took === true) && body.took === true;
  if (!numbered) return true;
  if (!counter(body.parts) || body.parts !== total || body.part !== index) return false;
  const n = body.n ?? null;
  if (n !== null && !counter(n)) return false;
  if (index === 0) seen.n = n;
  else if (n !== seen.n) return false;
  return true;
}

/**
 * Whether the parts that fitted ([seen], from snapshotPartFits) are a library
 * the phone sent: a first part was there and it held the `snapshot` change.
 * Phones since 10 November number their parts; one from before numbers none,
 * and its parts are still taken, but never without that change, so neither
 * kind opens as an empty library on the relay's word alone.
 */
export function snapshotArrived(seen) {
  return seen.snapshot === true && typeof seen.numbered === "boolean";
}

/**
 * Whether the phone that sent the library names in its feed the captures it
 * takes from this computer: every part that fitted ([seen], from
 * snapshotPartFits) carries `took: true`, next to `pair`. Sealed in the
 * parts, so the relay can neither add it nor take it away; known from the
 * moment of pairing, a capture gone from the relay is never on the phone by
 * the relay's word alone. A phone from before sends none, and some with and
 * some without is not taken as saying it.
 */
export function snapshotSaysTook(seen) {
  return seen.took === true;
}

// --- edits for the phone ------------------------------------------------------------
//
//   "CPTRYCH" 0x01 | 12-byte nonce | AES-GCM(content key, nonce, json, aad = the first 8 bytes)
//
// json is {format: 1, id, at, capture: uid, ops: [...]}; DesktopChanges.kt
// applies it, with a title or note changed only if it is still `from`.

export const CHANGE_MAGIC = new Uint8Array([0x43, 0x50, 0x54, 0x52, 0x59, 0x43, 0x48, 1]); // CPTRYCH\1

export async function sealChange(key, change, nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES)), computer = null) {
  const legacy = padded(new TextEncoder().encode(typeof change === "string" ? change : JSON.stringify(change)));
  const plain = computer ? await sealInner(computer, INNER_CHANGE, legacy) : legacy;
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: CHANGE_MAGIC, tagLength: TAG_BITS }, key, plain),
  );
  const out = new Uint8Array(CHANGE_MAGIC.length + NONCE_BYTES + sealed.length);
  out.set(CHANGE_MAGIC, 0);
  out.set(nonce, CHANGE_MAGIC.length);
  out.set(sealed, CHANGE_MAGIC.length + NONCE_BYTES);
  return out;
}

// --- the browser's own cache -----------------------------------------------------------
//
// What this browser keeps between visits, sealed with the same
// non-extractable key: "CPTRYCA" 0x01 | nonce | AES-GCM(key, bytes, aad = magic).

const CACHE_MAGIC = new Uint8Array([0x43, 0x50, 0x54, 0x52, 0x59, 0x43, 0x41, 1]); // CPTRYCA\1

export async function sealCache(key, plain) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: CACHE_MAGIC, tagLength: TAG_BITS }, key, plain),
  );
  const out = new Uint8Array(CACHE_MAGIC.length + NONCE_BYTES + sealed.length);
  out.set(CACHE_MAGIC, 0);
  out.set(nonce, CACHE_MAGIC.length);
  out.set(sealed, CACHE_MAGIC.length + NONCE_BYTES);
  return out;
}

/** The cached bytes, or null when they are not ours or the key does not fit. */
export async function openCache(key, bytes) {
  if (!bytes || bytes.length < CACHE_MAGIC.length + NONCE_BYTES + 16) return null;
  if (!CACHE_MAGIC.every((b, i) => bytes[i] === b)) return null;
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(CACHE_MAGIC.length, CACHE_MAGIC.length + NONCE_BYTES), additionalData: CACHE_MAGIC, tagLength: TAG_BITS },
      key,
      bytes.subarray(CACHE_MAGIC.length + NONCE_BYTES),
    ));
  } catch (e) {
    return null;
  }
}

/** Decodes one capture in the shape the phone writes it. */
export function decodeCapture(json) {
  return decodeManifest({ format: 8, captures: [json] }).captures[0] ?? null;
}

export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A library's captures, newest first, in the shape the page shows. */
export function decodeManifest(root) {
  const array = Array.isArray(root) ? root : root?.captures ?? [];
  const format = Array.isArray(root) ? 1 : Number(root?.format ?? 0);
  const captures = [];
  for (const o of array) {
    if (!o || typeof o !== "object") continue;
    captures.push({
      id: str(o.id),
      type: str(o.type),
      source: str(o.source),
      sourceApp: str(o.sourceApp),
      sourceUrl: webUrl(o.sourceUrl),
      text: str(o.text),
      title: str(o.title),
      summary: str(o.summary),
      note: str(o.note) ?? str(o.whyISavedThis),
      capturedAt: num(o.capturedAt),
      createdAt: num(o.createdAt),
      keepUntil: num(o.keepUntil),
      pinned: !!o.pinned,
      archived: !!o.archived,
      private: !!o.private,
      entities: (o.entities ?? []).map((e) => ({
        type: str(e?.type),
        value: str(e?.value),
        state: str(e?.state) ?? "AUTO",
      })).filter((e) => e.type && e.value && e.state !== "DISMISSED"),
      files: (o.files ?? []).map((f) => ({
        file: str(f?.file),
        type: str(f?.type) ?? "IMAGE",
        mimeType: str(f?.mimeType),
        textInImage: str(f?.textInImage),
        hash: str(f?.hash),
        transcript: str(f?.transcript),
        width: num(f?.width),
        durationMs: num(f?.durationMs),
        height: num(f?.height),
      })).filter((f) => f.file),
      // Versions before 6 wrote bare names; 6 and later write a name and
      // whether this capture was ticked off in that list.
      collections: (o.collections ?? [])
        .map((c) => (typeof c === "string"
          ? { name: str(c), checked: false, checklist: false }
          // The phone's colour for it, when the phone says (version 9 on).
          // Pinned at the top of this collection only, when it is.
          : { name: str(c?.name), checked: !!c?.checked, checklist: !!c?.checklist, ...(Number.isInteger(c?.color) ? { color: c.color } : {}), ...(c?.pinned ? { pinned: true } : {}), ...(c?.list ? { list: true } : {}) }))
        .filter((c) => c.name),
      links: (o.links ?? []).map(str).filter(Boolean),
      highlights: (o.highlights ?? []).map((h) => ({
        quote: str(h?.quote),
        note: str(h?.note),
      })).filter((h) => h.quote),
      // Reminders still to come, soonest first; the phone sends them from version 12.
      reminders: (o.reminders ?? []).filter((r) => Number.isFinite(r?.at))
        .map((r) => ({ at: r.at, repeat: str(r.repeat) }))
        .sort((a, b) => a.at - b.at),
    });
  }
  captures.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));
  for (const c of captures) c.sourceHost = hostOf(c.sourceUrl);

  // Version 7 and later: a smart collection is a name and the search chips
  // that make it, and no captures. What it holds is worked out here.
  const smartCollections = [];
  for (const s of Array.isArray(root) ? [] : root?.smartCollections ?? []) {
    const name = str(s?.name);
    const r = s?.rule;
    if (!name || !r) continue;
    const rule = {
      query: str(r.query) ?? "",
      filter: str(r.filter) ?? "ALL",
      dateRange: str(r.dateRange) ?? "ANY",
      source: str(r.source),
      includeArchived: !!r.includeArchived,
    };
    if (!rule.query && rule.filter === "ALL" && rule.dateRange === "ANY" && !rule.source) continue;
    smartCollections.push({ name, rule });
  }
  return { format, captures, smartCollections, exportedAt: Number(root?.exportedAt) || null };
}

/** The host of a link, without www., as the app's hostOf has it. */
export function hostOf(url) {
  if (!url) return null;
  const at = url.indexOf("://");
  if (at < 0) return null;
  const host = url.slice(at + 3).split("/")[0].replace(/^www\./, "");
  return host || null;
}

/** An http or https address, or null: a link the page opens is never javascript: or file:. */
function webUrl(v) {
  const s = str(v)?.trim();
  return s && /^https?:\/\/[^\s]/i.test(s) ? s : null;
}

function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.trim() ? s : null;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
