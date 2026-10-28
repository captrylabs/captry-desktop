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
    const reason = response.status === 507
      ? "Too much is waiting for your phone. Open Captry on the phone first."
      : response.status === 413
        ? "That capture is too large to send."
        : response.status === 429
          ? "Too many at once. Try again in a minute."
          : "Captry's server did not accept it.";
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
 * A live connection: the relay says "feed" or "items" the moment something
 * changes, and the page then asks over the ordinary routes. The token goes as
 * a WebSocket subprotocol, never in the URL. Reconnects on its own, more and
 * more slowly, until stop() is called.
 */
export function live(token, onMessage, onState = () => {}) {
  let socket = null;
  let stopped = false;
  let delay = 1000;
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
      delay = 1000;
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

async function pairCall(code, path, init = {}) {
  try {
    return await fetch(`${base()}/pair/${code}${path}`, { ...init, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  } catch (e) {
    throw new RelayError("Captry's server could not be reached.", 0);
  }
}

/** Opens a slot under the code. False when the code happens to be taken. */
export async function pairOffer(code, pageKey, label, pageToken) {
  const r = await pairCall(code, "/offer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageKey, label, pageToken }) });
  if (r.status === 409) return false;
  if (!r.ok) throw new RelayError("Pairing could not start.", r.status);
  return true;
}

/** { phoneKey, sealedKey, label }, each null until the phone has sent it. */
export async function pairAnswer(code) {
  const r = await pairCall(code, "/answer");
  if (!r.ok) throw new RelayError("Pairing stopped.", r.status);
  return r.json();
}

export async function pairSnapshot(code) {
  const r = await pairCall(code, "/snapshot");
  if (!r.ok) throw new RelayError("Pairing stopped.", r.status);
  return r.json();
}

export async function pairSnapshotPart(code, n) {
  const r = await pairCall(code, `/snapshot/${n}`);
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
