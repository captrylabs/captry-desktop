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
export async function sealInbox(key, item, nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))) {
  const body = { format: INBOX_FORMAT, id: item.id, createdAt: item.createdAt };
  if (item.text) body.text = item.text;
  if (item.image) body.image = { mimeType: item.image.mimeType, data: toBase64(item.image.bytes) };
  const plain = padded(new TextEncoder().encode(JSON.stringify(body)));
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

/** The batch of changes in an entry, or null when it is not one or the key does not fit. */
export async function openFeed(key, bytes) {
  if (bytes.length < FEED_MAGIC.length + NONCE_BYTES + 16) return null;
  if (!FEED_MAGIC.every((b, i) => bytes[i] === b)) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(FEED_MAGIC.length, FEED_MAGIC.length + NONCE_BYTES), additionalData: FEED_MAGIC, tagLength: TAG_BITS },
      key,
      bytes.subarray(FEED_MAGIC.length + NONCE_BYTES),
    );
    const body = JSON.parse(new TextDecoder().decode(plain));
    if (body.format !== 1 || !Array.isArray(body.changes)) return null;
    return body;
  } catch (e) {
    return null;
  }
}

// --- edits for the phone ------------------------------------------------------------
//
//   "CPTRYCH" 0x01 | 12-byte nonce | AES-GCM(content key, nonce, json, aad = the first 8 bytes)
//
// json is {format: 1, id, at, capture: uid, ops: [...]}; DesktopChanges.kt
// applies it, with a title or note changed only if it is still `from`.

export const CHANGE_MAGIC = new Uint8Array([0x43, 0x50, 0x54, 0x52, 0x59, 0x43, 0x48, 1]); // CPTRYCH\1

export async function sealChange(key, change, nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))) {
  const plain = padded(new TextEncoder().encode(typeof change === "string" ? change : JSON.stringify(change)));
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
          : { name: str(c?.name), checked: !!c?.checked, checklist: !!c?.checklist, ...(Number.isInteger(c?.color) ? { color: c.color } : {}) }))
        .filter((c) => c.name),
      links: (o.links ?? []).map(str).filter(Boolean),
      highlights: (o.highlights ?? []).map((h) => ({
        quote: str(h?.quote),
        note: str(h?.note),
      })).filter((h) => h.quote),
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
