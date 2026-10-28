// Pairing with the phone: the key exchange (DesktopPairing.kt is the other half).
//
//   page and phone each make an ECDH P-256 key pair and swap public keys
//   (SubjectPublicKeyInfo, base64) through a pairing slot on the relay;
//   shared = ECDH(own private, other public)            32 bytes, the x coordinate
//   okm    = HKDF-SHA256(shared, salt = the code,
//                        info = "captry pair v1" | page key | phone key, 35 bytes)
//   key    = okm[0..32], an AES-256-GCM key
//   check  = okm[32..35] as a number, mod 1,000,000: the six digits both show
//
// The phone sends the content key only after the person has seen the same six
// digits on both screens and tapped Pair: sealedKey = nonce | AES-GCM(key,
// content key, aad = "CPTRYPK1"). A relay that swapped in keys of its own
// would make the two screens show different digits.

const enc = new TextEncoder();
const AAD = enc.encode("CPTRYPK1");
export const PAIR_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function newPairCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => PAIR_ALPHABET[b & 31]).join("");
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

/** The AES key and the six-digit check, from either side's point of view. */
export async function pairSecret(privateKey, peerKeyB64, code, pageKeyB64, phoneKeyB64) {
  const peer = await crypto.subtle.importKey("spki", unb64(peerKeyB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256));
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const pageKey = unb64(pageKeyB64);
  const phoneKey = unb64(phoneKeyB64);
  const label = enc.encode("captry pair v1");
  const info = new Uint8Array(label.length + pageKey.length + phoneKey.length);
  info.set(label, 0);
  info.set(pageKey, label.length);
  info.set(phoneKey, label.length + pageKey.length);
  const okm = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode(code), info }, ikm, 35 * 8));
  shared.fill(0);
  const key = await crypto.subtle.importKey("raw", okm.subarray(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const n = (okm[32] << 16) | (okm[33] << 8) | okm[34];
  const check = String(n % 1_000_000).padStart(6, "0");
  okm.fill(0);
  return { key, check };
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
export function browserLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "a Mac" : /CrOS/.test(ua) ? "a Chromebook" : /Linux/.test(ua) ? "Linux" : "a computer";
  return `${browser} on ${os}`;
}
