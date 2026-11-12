// Pairing with the phone: the key exchange (DesktopPairing.kt is the other half).
//
//   page and phone each make an ECDH P-256 key pair and swap public keys
//   (SubjectPublicKeyInfo, base64) through a pairing slot on the relay;
//   shared = ECDH(own private, other public)            32 bytes, the x coordinate
//
// The page's QR code carries the slot's code and a secret the relay never
// sees ("CAPTRY:P1:" | code | ":" | secret, 26 characters of the code's
// alphabet), so only a phone that read this screen can finish:
//
//   okm    = HKDF-SHA256(shared, salt = the secret,
//                        info = "captry pair v2" | code | page key | phone key, 48 bytes)
//   key    = okm[0..32], an AES-256-GCM key
//   proof  = okm[32..48], base64: the phone answers with its key | "." | proof,
//            and the page goes no further without the right one
//
// The phone sends the content key only after the person taps Pair:
// sealedKey = nonce | AES-GCM(key, content key, aad = "CPTRYPK1"). A relay
// that swapped in keys of its own cannot open it, or make a proof the page
// takes, without the secret.
//
// The code alone was once enough, typed into the phone with six digits to
// compare on both screens. That went: the relay knows the code, and with
// nothing committing either side to its key before the digits showed, a
// relay swapping keys could try keys until the digits matched.

const enc = new TextEncoder();
const AAD = enc.encode("CPTRYPK1");
export const PAIR_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** The slot's name on the relay. Not a secret: the relay knows it. */
export function newPairCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => PAIR_ALPHABET[b & 31]).join("");
}

/** What the QR code adds to the code: 26 characters, 130 bits, shown and never sent. */
export function newPairSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return [...bytes].map((b) => PAIR_ALPHABET[b & 31]).join("");
}

/** What the QR code says. Characters a QR code packs tightly, and nothing else. */
export function pairQrText(code, secret) {
  return `CAPTRY:P1:${code}:${secret}`;
}

export function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A fresh key pair; the private half cannot leave this tab. */
export async function pairKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, publicKey: b64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))) };
}

/** The AES key and the proof the phone answers with, from either side's point of view. */
export async function pairScanSecret(privateKey, peerKeyB64, code, secret, pageKeyB64, phoneKeyB64) {
  const peer = await crypto.subtle.importKey("spki", unb64(peerKeyB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256));
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const parts = [enc.encode(`captry pair v2${code}`), unb64(pageKeyB64), unb64(phoneKeyB64)];
  const info = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (info.set(p, at), at + p.length), 0);
  const okm = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode(secret), info }, ikm, 48 * 8));
  shared.fill(0);
  const key = await crypto.subtle.importKey("raw", okm.subarray(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const proof = b64(okm.subarray(32, 48));
  okm.fill(0);
  return { key, proof };
}

/** The phone's answer: its key, then the proof after a ".". */
export function splitAnswer(answer) {
  const [phoneKey, proof = ""] = String(answer).split(".");
  return { phoneKey, proof };
}

/** The content key the phone sent, or null if it does not open. */
export async function openPairedKey(key, sealedB64) {
  const bytes = unb64(sealedB64);
  if (bytes.length < 12 + 32 + 16) return null;
  try {
    const raw = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: AAD, tagLength: 128 },
      key,
      bytes.subarray(12),
    ));
    return raw.length === 32 ? raw : null;
  } catch (e) {
    return null;
  }
}

/** The phone's side of sealing, for tests: nonce | AES-GCM(key, content key). */
export async function sealPairedKey(key, contentKey, nonce = crypto.getRandomValues(new Uint8Array(12))) {
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: AAD, tagLength: 128 }, key, contentKey));
  const out = new Uint8Array(12 + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, 12);
  return b64(out);
}

/** "Chrome on Windows", for the phone to show who is asking. */
/** How long the relay keeps a code open for a phone to answer (OFFER_TTL_MS in worker/feedback/src/pairing.js). */
export const PAIR_CODE_MS = 10 * 60_000;

/**
 * How long to wait for the sealed key once the phone has answered: the time
 * for the person to read the computer's name and tap Pair, and for the phone
 * to measure the library first. As long again as the code was open, which is
 * plenty, and well inside the hour the relay keeps the slot.
 */
export const PAIR_KEY_MS = 10 * 60_000;

/**
 * Whether the wait for the phone is over at [now]: "code" when no phone
 * answered within PAIR_CODE_MS of [started], "key" when one answered at
 * [answeredAt] but its key has not come within PAIR_KEY_MS, else null.
 */
export function pairWaitOver(now, started, answeredAt) {
  if (answeredAt === null) return now - started > PAIR_CODE_MS ? "code" : null;
  return now - answeredAt > PAIR_KEY_MS ? "key" : null;
}

export function browserLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "a Mac" : /CrOS/.test(ua) ? "a Chromebook" : /Linux/.test(ua) ? "Linux" : "a computer";
  return `${browser} on ${os}`;
}
