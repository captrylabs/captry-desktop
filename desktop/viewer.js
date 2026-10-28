// The desktop page: pair with the phone, then read, search and send captures.
//
// Nothing here talks to a server. The file is read from disk, decrypted in
// this tab, and shown. The page's Content-Security-Policy forbids every
// network destination, so that promise is enforced by the browser rather
// than by this code being careful.
//
// Organizing lives in library.js, which mirrors the app's Library and has no
// DOM in it. This file is only the page.

import { sealInbox, INBOX_MAX_BYTES, relayTokenFrom, openFeed, decodeCapture, sealChange, sealCache, openCache, importContentKey, decodeManifest, toBase64 } from "./library-format.js?v=44";
import {
  FILTERS,
  RANGES,
  SORTS,
  catalog,
  sources,
  query,
  titleOf,
  typeName,
  sourceLabel,
  dateGroup,
  viewToHash,
  hashToView,
  sameView,
  viewTitle,
  describeRule,
  searchWords,
} from "./library.js?v=44";
import * as store from "./store.js?v=44";
import * as relay from "./relay.js?v=44";
import * as pair from "./pair.js?v=44";

const PAGE = 150;
let lastShownId = null;
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// --- icons -------------------------------------------------------------------
// Line icons on a 24 grid, drawn in the text's colour.
const ICONS = {
  pencil: "M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4",
  note: "M6 4h9l3 3v13H6zM9 11h6M9 15h4",
  pin: "M9 4h6l-1 6 3 3v2H7v-2l3-3zM12 15v5",
  archive: "M4 5h16v4H4zM6 9v10h12V9M10 13h4",
  folderPlus: "M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  copy: "M9 9h10v11H9zM5 15V4h10",
  markdown: "M3 6h18v12H3zM6.5 15V9l2.5 3 2.5-3v6M17 9v6M15 13l2 2 2-2",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4",
  mic: "M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v3",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9h.01",
  lines: "M5 7h14M5 12h14M5 17h9",
  inbox: "M4 13l2-8h12l2 8v6H4zM4 13h5l1 2h4l1-2h5",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  tag: "M4 4h7l9 9-7 7-9-9zM8 8h.01",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  ticket: "M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4zM10 7v10",
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  check: "M5 12l4 4 10-10",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  x: "M6 6l12 12M18 6L6 18",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  send: "M4 12l16-8-6 16-3-7z",
  done: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM8 12l3 3 5-6",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
};

/** An icon as an element. The paths are fixed strings above, never data. */
function icon(name, size = 16) {
  const span = document.createElement("span");
  span.style.display = "contents";
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${name === "more" ? 3 : 1.9}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
  return span.firstChild;
}

const TYPE_ICONS = { NOTE: "lines", ARTICLE: "doc", RECEIPT: "receipt", COUPON: "ticket", REMINDER: "bell", TODO: "check", TASK: "check", EVENT: "calendar", PRODUCT: "tag" };
const PLACE_ICONS = { captures: "inbox", pinned: "pin", archive: "archive", private: "lock" };

// The phone's gradients (AccentColor.kt: relayGradientPalette and the order
// it hands them out in). The phone sends each collection's number with its
// captures, so a collection wears the same colours here as there.
const PALETTE = [
  ["#1B35FE", "#00FEF6"], ["#741CFE", "#01C1FE"], ["#1C88FE", "#00FEA3"], ["#0EB278", "#A9CB71"],
  ["#FF7C38", "#FEF566"], ["#FF4239", "#FFB839"], ["#D2092C", "#FF6C53"], ["#FF2E69", "#FE7493"],
  ["#751BFE", "#FB00FF"], ["#6052FB", "#EC3438"], ["#371CFE", "#9F40FE"], ["#00027B", "#0711DA"],
];
const PALETTE_ORDER = [0, 5, 8, 3, 10, 4, 7, 2, 9, 1, 6, 11];

/** The colour number the phone gave a collection, from any capture in it. */
function collectionColor(name) {
  const key = name.toLowerCase();
  for (const c of opened?.manifest.captures ?? []) {
    const m = c.collections.find((x) => Number.isInteger(x.color) && x.name.toLowerCase() === key);
    if (m) return m.color;
  }
  // Not sent yet (an older phone, or a library saved before it was): steady, not matched.
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % PALETTE.length;
}

function collectionDot(name) {
  const i = ((collectionColor(name) % PALETTE_ORDER.length) + PALETTE_ORDER.length) % PALETTE_ORDER.length;
  const [a, b] = PALETTE[PALETTE_ORDER[i]];
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = `linear-gradient(135deg, ${a}, ${b})`;
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

function formatDuration(ms) {
  if (!ms) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
const $ = (id) => document.getElementById(id);
const el = {
  again: $("again"),
  againName: $("again-name"),
  againOpen: $("again-open"),
  againForget: $("again-forget"),
  status: $("status"),
  opener: $("opener"),
  app: $("app"),
  close: $("close"),
  compose: $("compose"),
  newCapture: $("new-capture"),
  composeText: $("compose-text"),
  composeImage: $("compose-image"),
  composePreview: $("compose-preview"),
  composePick: $("compose-pick"),
  composeClearImage: $("compose-clear-image"),
  composeNote: $("compose-note"),
  composeFigure: $("compose-figure"),
  composeX: $("compose-x"),
  composeSave: $("compose-save"),
  composeCancel: $("compose-cancel"),
  toast: $("toast"),
  sync: $("sync"),
  syncText: $("sync-text"),
  syncFull: $("sync-full"),
  syncDetail: $("sync-detail"),
  device: $("device"),
  deviceName: $("device-name"),
  filterButton: $("filter-button"),
  filterMenu: $("filter-menu"),
  filterCount: $("filter-count"),
  filterReset: $("filter-reset"),
  sourceField: $("source-field"),
  deviceMenu: $("device-menu"),
  deviceMenuName: $("device-menu-name"),
  keys: $("keys"),
  navToggle: $("nav-toggle"),
  splitNav: $("split-nav"),
  splitList: $("split-list"),
  side: $("side"),
  lightbox: $("lightbox"),
  lbStage: $("lb-stage"),
  lbCaption: $("lb-caption"),
  lbNote: $("lb-note"),
  lbCount: $("lb-count"),
  lbDownload: $("lb-download"),
  lbClose: $("lb-close"),
  lbPrev: $("lb-prev"),
  lbNext: $("lb-next"),
  exportMenu: $("export"),
  nav: $("nav"),
  viewSelect: $("view-select"),
  viewTitle: $("view-title"),
  viewDetail: $("view-detail"),
  search: $("search"),
  chips: $("chips"),
  range: $("range"),
  source: $("source"),
  sort: $("sort"),
  layoutList: $("layout-list"),
  layoutGrid: $("layout-grid"),
  count: $("count"),
  clear: $("clear"),
  list: $("list"),
  more: $("more"),
  detail: $("detail"),
};

document.getElementById("not-loaded").remove();

/**
 * What is open: the library, the content key, the relay token, a name to
 * show, and where it came from ({ kind: "paired", name: the phone }).
 */
let opened = null;

/** Captures sent from this page that the library does not show yet. */
let sentItems = [];

/** What is being looked at. Everything the list shows is worked out from this. */
const state = {
  view: { kind: "captures" },
  query: "",
  filter: "ALL",
  range: "ANY",
  source: "",
  sort: remembered("sort", "newest"),
  layout: remembered("layout", "list"),
  selectedId: null,
};

let shown = []; // the list as filtered and ordered
let doneFrom = -1; // where a checklist's done items start in `shown`
let rendered = 0; // how many of `shown` are on screen
let byId = new Map();

/** Object urls for pictures, kept until the library is closed. */
const fileUrls = new Map();
/** The file behind each of those urls. */
const urlBlobs = new Map();
/** The voice note playing, if one is. */
let playing = null;

// --- pairing with the phone -----------------------------------------------------------
//
// No files and no recovery code: the page shows a code, the person types
// it into the phone, both show the same six digits, and once they tap Pair the
// phone sends the key (sealed for this tab) and then the library.

// Remember this computer: on by default. Off, as on a shared computer,
// nothing about the pairing is kept once the tab is closed.
const rememberBox = document.getElementById("remember-computer");
rememberBox.checked = remembered("rememberComputer", "1") === "1";
rememberBox.addEventListener("change", () => remember("rememberComputer", rememberBox.checked ? "1" : "0"));

const pairEl = {
  start: $("pair-start"),
  panel: $("pairing"),
  code: $("pair-code"),
  status: $("pair-status"),
  check: $("pair-check"),
  progress: $("pair-progress"),
  cancel: $("pair-cancel"),
};
let pairing = null; // { code, cancelled }

pairEl.start.addEventListener("click", startPairing);
pairEl.cancel.addEventListener("click", () => {
  if (pairing) {
    pairing.cancelled = true;
    relay.pairDone(pairing.code, pairing.pageToken);
  }
  pairing = null;
  pairEl.panel.hidden = true;
  pairEl.start.hidden = false;
  document.getElementById("steps").hidden = false;
  rememberBox.parentElement.hidden = false;
});

async function startPairing() {
  pairEl.start.hidden = true;
  document.getElementById("steps").hidden = true;
  rememberBox.parentElement.hidden = true;
  pairEl.panel.hidden = false;
  pairEl.check.hidden = true;
  pairEl.progress.hidden = true;
  pairEl.status.textContent = "Getting a code…";
  pairEl.code.textContent = "";
  // Remembered or not is decided now, before any picture is cached.
  const session = { cancelled: false, pageToken: relay.newPairToken(), ephemeral: !rememberBox.checked };
  pairing = session;
  try {
    const keys = await pair.pairKeys();
    let code;
    for (let i = 0; i < 5; i++) {
      code = pair.newPairCode();
      if (await relay.pairOffer(code, keys.publicKey, pair.browserLabel(), session.pageToken)) break;
      code = null;
    }
    if (!code) throw new Error("no code");
    session.code = code;
    pairEl.code.textContent = code.slice(0, 4) + " " + code.slice(4);
    pairEl.status.textContent = "Waiting for your phone… The code works for 10 minutes.";

    const started = Date.now();
    let secret = null;
    let phoneLabel = "your phone";
    let raw = null;
    while (!raw) {
      if (session.cancelled) return;
      if (Date.now() - started > 10 * 60_000 && !secret) throw new relay.RelayError("The code expired. Start again.", 410);
      await sleep(1500);
      const answer = await relay.pairAnswer(code);
      if (answer.phoneKey && !secret) {
        secret = await pair.pairSecret(keys.privateKey, answer.phoneKey, code, keys.publicKey, answer.phoneKey);
        pairEl.check.textContent = secret.check.slice(0, 3) + " " + secret.check.slice(3);
        pairEl.check.hidden = false;
        pairEl.status.textContent = "Your phone should show these numbers. If they match, tap Pair on the phone.";
      }
      if (answer.sealedKey && secret) {
        raw = await pair.openPairedKey(secret.key, answer.sealedKey);
        if (!raw) throw new relay.RelayError("Pairing did not complete. Start again.", 0);
        phoneLabel = friendlyPhone(answer.label) || phoneLabel;
      }
    }
    const relayToken = await relayTokenFrom(raw);
    const key = await importContentKey(raw);

    pairEl.check.hidden = true;
    pairEl.progress.hidden = false;
    pairEl.status.textContent = "Receiving your library…";
    let status = { total: 0, have: [] };
    const waitedFrom = Date.now();
    while (!status.total || status.have.length < status.total) {
      if (session.cancelled) return;
      if (Date.now() - waitedFrom > 15 * 60_000) throw new relay.RelayError("Your library did not finish arriving. Pair again.", 0);
      await sleep(1200);
      status = await relay.pairSnapshot(code);
      if (status.total) pairEl.progress.firstElementChild.style.width = `${Math.round((status.have.length / status.total) * 50)}%`;
    }

    const captures = [];
    let smartCollections = [];
    let at = Date.now();
    thumbOnly.clear();
    feedFiles.clear();
    for (let i = 0; i < status.total; i++) {
      if (session.cancelled) return;
      const body = await openFeed(key, await relay.pairSnapshotPart(code, i));
      if (!body) throw new relay.RelayError("Part of your library could not be opened. Pair again.", 0);
      for (const change of body.changes) {
        if (change.op === "snapshot") {
          at = change.at ?? at;
          smartCollections = decodeManifest({ format: 8, captures: [], smartCollections: change.smartCollections ?? [] }).smartCollections;
        } else if (change.op === "upsert" && change.capture) {
          const capture = decodeCapture(change.capture);
          if (!capture?.id) continue;
          captures.push(capture);
          for (const f of change.files ?? []) {
            if (!f.file || !f.data) continue;
            const bytes = fromBase64(f.data);
            feedFiles.set(f.file, new Blob([bytes], { type: "image/jpeg" }));
            if (f.thumb) thumbOnly.add(f.file);
            if (!session.ephemeral) sealCache(key, bytes).then((sealed) => store.saveImage(f.file, sealed));
          }
        }
      }
      pairEl.progress.firstElementChild.style.width = `${50 + Math.round(((i + 1) / status.total) * 50)}%`;
    }
    await relay.pairDone(code, session.pageToken);
    captures.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));

    const files = new Map(feedFiles);
    const thumbs = new Set(thumbOnly);
    closeOpened();
    for (const [name, blob] of files) feedFiles.set(name, blob);
    for (const name of thumbs) thumbOnly.add(name);
    const place = { kind: "paired", name: phoneLabel };
    opened = {
      kind: "paired",
      manifest: { captures, smartCollections },
      key,
      relayToken,
      name: `Paired with ${phoneLabel}`,
      place,
      ephemeral: session.ephemeral,
    };
    feed = { seq: 0, since: at, applied: 0, missing: false };
    // Not remembered: nothing about this pairing is written to the browser,
    // so closing the tab is the end of it on this computer.
    if (!session.ephemeral) await store.remember(place, key, relayToken);
    pairing = null;
    pairEl.panel.hidden = true;
    pairEl.start.hidden = false;
    showOpened(null);
    persistLibrary();
    toast(`Paired with ${phoneLabel}`);
  } catch (e) {
    if (session.cancelled) return;
    console.error(e);
    pairEl.status.textContent = e instanceof relay.RelayError ? e.message : "Pairing did not work. Start again.";
    pairEl.check.hidden = true;
    pairEl.progress.hidden = true;
    if (session.code) relay.pairDone(session.code, session.pageToken);
    pairing = null;
    pairEl.start.hidden = false;
    document.getElementById("steps").hidden = false;
  rememberBox.parentElement.hidden = false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pictures known only as a small copy, until the phone sends the full one. */
const thumbOnly = new Set();
const requestedFull = new Set();

/** Asks the phone, once, for the full-size copy of a picture. */
async function requestFull(c, name) {
  if (requestedFull.has(name) || !opened?.relayToken || !opened.key) return;
  requestedFull.add(name);
  try {
    const change = { format: 1, id: crypto.randomUUID(), at: Date.now(), capture: c.id, ops: [{ op: "want", file: name }] };
    await relay.send(opened.relayToken, await sealChange(opened.key, change));
  } catch (e) {
    requestedFull.delete(name);
  }
}

// --- remembered ------------------------------------------------------------

/**
 * Opens what this computer remembers from pairing, at once, from its cache.
 */
async function offerRemembered({ auto = true } = {}) {
  const saved = await store.recall();
  // Only a pairing is remembered now; anything older is left for Forget.
  if (!saved?.key || saved.kind !== "paired") {
    el.again.hidden = true;
    return;
  }
  el.again.hidden = false;
  el.againName.textContent = saved.name ?? "your phone";
  sentItems = await loadSent(saved.key);
  el.againOpen.onclick = () => openRemembered(saved);
  if (auto) await openRemembered(saved);
}

async function openRemembered(saved) {
  if (!opened) showSkeleton();
  if (await openFromCache(saved)) return;
  if (!opened) hideSkeleton();
  say("This computer's copy of your library is too old to bring up to date. Pair with your phone again.", "warn");
}

el.againForget.addEventListener("click", async () => {
  await store.forget();
  sentItems = [];
  el.again.hidden = true;
  say("Forgotten on this computer.");
});

// --- opening and closing ---------------------------------------------------

function showOpened(previous) {
  say("");
  el.opener.hidden = true;
  el.app.hidden = false;
  el.close.hidden = false;
  el.newCapture.hidden = false;
  const phone = opened.place?.name ?? "your phone";
  el.deviceName.textContent = phone;
  el.deviceMenuName.textContent = phone;
  watchDelivery();
  syncFeed();
  takeArrived();
  connectLive();
  mergeSent();
  updateSync();

  if (previous) {
    // A reload: same place, same words, same capture open if it still exists.
    Object.assign(state, previous);
    if (!viewExists(state.view)) state.view = { kind: "captures" };
    el.search.value = state.query;
    buildControls();
    renderNav();
    refresh({ keepSelection: true });
    return;
  }
  Object.assign(state, { query: "", filter: "ALL", range: "ANY", source: "", selectedId: null });
  el.search.value = "";
  const fromHash = hashToView(location.hash);
  state.view = fromHash && viewExists(fromHash) ? fromHash : { kind: "captures" };

  buildControls();
  renderNav();
  refresh();
  el.search.focus();
}

/** The browser tab says where you are: the capture, then the place. */
function setTabTitle(c) {
  if (!opened) {
    document.title = "Captry Desktop";
    return;
  }
  const place = el.viewTitle.textContent || "Captures";
  if (picked.size > 1) document.title = `${picked.size} selected · ${place} · Captry`;
  else if (c) document.title = `${titleOf(c)} · ${place} · Captry`;
  else document.title = `${place} · Captry`;
}

function closeOpened() {
  document.title = "Captry Desktop";
  flushToast();
  if (el.lightbox.open) el.lightbox.close();
  picked.clear();
  lastPhoneAt = 0;
  el.sync.hidden = true;
  thumbOnly.clear();
  requestedFull.clear();
  liveConnection?.stop();
  liveConnection = null;
  liveUp = false;
  feed = { seq: 0, since: 0, applied: 0, missing: false };
  feedFiles.clear();
  for (const url of fileUrls.values()) URL.revokeObjectURL(url);
  fileUrls.clear();
  urlBlobs.clear();
  waves.clear();
  playing?.pause();
  playing = null;
  thumbObserver.disconnect();
  opened = null;
  shown = [];
  byId = new Map();
  el.list.replaceChildren();
  el.detail.replaceChildren();
  el.nav.replaceChildren();
}

/** The phone reset its key: forget this computer's copy and offer pairing. */
async function unpairedHere(oldToken) {
  closeOpened();
  el.app.hidden = true;
  el.opener.hidden = false;
  el.close.hidden = true;
  el.newCapture.hidden = true;
  history.replaceState(null, "", location.pathname);
  // Another tab may have paired again already: keep that one.
  const saved = await store.recall();
  if (!saved || saved.relayToken === oldToken) {
    await store.forget();
    sentItems = [];
  }
  await offerRemembered({ auto: false });
  say("Your phone reset its key. Pair again to keep using Captry here.", "warn");
}

// Unlinking forgets the pairing here: the library, its key and anything
// still queued. The phone keeps everything.
const unlinkDialog = document.getElementById("unlink");
el.close.addEventListener("click", () => {
  el.deviceMenu.hidePopover();
  document.getElementById("unlink-name").textContent = opened?.place?.name ?? "your phone";
  const waiting = pendingEdits.size + sentItems.filter((i) => i.relayId && !i.delivered).length;
  const queued = document.getElementById("unlink-queued");
  queued.hidden = waiting === 0;
  queued.textContent = waiting === 1
    ? "1 change has not reached your phone yet and will be lost."
    : `${waiting} changes have not reached your phone yet and will be lost.`;
  unlinkDialog.returnValue = "";
  unlinkDialog.showModal();
});

unlinkDialog.addEventListener("close", async () => {
  if (unlinkDialog.returnValue !== "unlink") return;
  closeOpened();
  el.app.hidden = true;
  el.opener.hidden = false;
  el.close.hidden = true;
  el.newCapture.hidden = true;
  history.replaceState(null, "", location.pathname);
  clearTimeout(persistTimer);
  await store.forget();
  sentItems = [];
  el.again.hidden = true;
  say("Unlinked. Pair again to use Captry here.");
});

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- sending a capture to the phone ------------------------------------------

let composeImage = null; // { mimeType, bytes, url }

el.newCapture.addEventListener("click", () => openCompose());

/** Opens New capture, with words or a picture already in it when they came from somewhere. */
async function openCompose({ text = "", file = null } = {}) {
  if (!opened?.key || !opened.relayToken) {
    toast("Pair with your phone first, then send captures from here.");
    return;
  }
  if (el.compose.open) {
    if (text) el.composeText.value = [el.composeText.value.trim(), text].filter(Boolean).join("\n");
  } else {
    el.composeText.value = text;
    setComposeImage(null);
    describeDestination();
    el.compose.showModal();
  }
  if (file) await takeImage(file);
  el.composeText.focus();
  el.composeText.setSelectionRange(el.composeText.value.length, el.composeText.value.length);
}

// --- arriving from elsewhere ----------------------------------------------------------------
//
// The share menu (the page installed as an app) and the bookmark button both
// open this page with ?title=&text=&url=. Kept until the library is open, then
// turned into a New capture and taken out of the address bar.

let arrived = (() => {
  const q = new URLSearchParams(location.search);
  const title = q.get("title")?.trim() ?? "";
  const text = q.get("text")?.trim() ?? "";
  let url = q.get("url")?.trim() ?? "";
  // Some apps put the link in the text.
  if (!url && /^https?:\/\/\S+$/.test(text)) url = text;
  const body = text && text !== url ? text : "";
  const lines = [title && title !== url ? title : "", url, body].filter(Boolean);
  return lines.length ? lines.join("\n") : null;
})();

function takeArrived() {
  if (!arrived || !opened?.key) return;
  const text = arrived;
  arrived = null;
  const q = new URLSearchParams(location.search);
  for (const k of ["title", "text", "url"]) q.delete(k);
  history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
  openCompose({ text });
}

// --- paste, drop and N ------------------------------------------------------------------------

function isTyping(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement || target?.isContentEditable;
}

document.addEventListener("paste", (event) => {
  if (!opened || el.app.hidden || el.compose.open || isTyping(event.target)) return;
  const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
  const text = event.clipboardData?.getData("text/plain")?.trim() ?? "";
  if (!file && !text) return;
  event.preventDefault();
  openCompose({ text, file });
});

let dragDepth = 0;
const dropHint = document.getElementById("drop-hint");
const carriesSomething = (event) => [...(event.dataTransfer?.types ?? [])].some((t) => t === "Files" || t === "text/plain" || t === "text/uri-list");
document.addEventListener("dragenter", (event) => {
  if (!opened || el.app.hidden || el.compose.open || !carriesSomething(event)) return;
  dragDepth++;
  dropHint.hidden = false;
});
document.addEventListener("dragleave", () => {
  if (dragDepth && --dragDepth === 0) dropHint.hidden = true;
});
document.addEventListener("dragover", (event) => {
  if (opened && !el.app.hidden && !el.compose.open && carriesSomething(event)) event.preventDefault();
});
document.addEventListener("drop", (event) => {
  dragDepth = 0;
  dropHint.hidden = true;
  if (!opened || el.app.hidden || el.compose.open) return;
  const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
  const text = (event.dataTransfer?.getData("text/uri-list") || event.dataTransfer?.getData("text/plain") || "")
    .split("\n").filter((l) => l && !l.startsWith("#")).join("\n").trim();
  if (!file && !text) return;
  event.preventDefault();
  openCompose({ text, file });
});

// The bookmark button: a link to drag to the bookmarks bar, not one to click
// here (this page's own policy would refuse to run it anyway).
const bookmarklet = document.getElementById("bookmarklet");
if (bookmarklet) {
  bookmarklet.href = "javascript:(()=>{const e=encodeURIComponent;window.open('" + location.origin +
    "/desktop/?title='+e(document.title)+'&url='+e(location.href)+'&text='+e(String(getSelection()).slice(0,4000)),'_blank')})()";
  bookmarklet.addEventListener("click", (event) => {
    event.preventDefault();
    toast("Drag it to your bookmarks bar, then click it on any page.");
  });
}

el.composeCancel.addEventListener("click", () => el.compose.close());

function describeDestination() {
  el.composeNote.textContent = "End-to-end encrypted. Arrives when Captry opens on your phone.";
}

el.composeX.addEventListener("click", () => el.compose.close());
hotkey(el.composeSave, "Send to phone", MAC ? "⌘↵" : "Ctrl+↵");
el.composeSave.setAttribute("aria-keyshortcuts", MAC ? "Meta+Enter" : "Control+Enter");
el.compose.addEventListener("dragenter", () => el.compose.classList.add("dropping"));
el.compose.addEventListener("dragleave", (event) => {
  if (!el.compose.contains(event.relatedTarget)) el.compose.classList.remove("dropping");
});
el.compose.addEventListener("drop", () => el.compose.classList.remove("dropping"));

el.compose.addEventListener("close", () => setComposeImage(null));
el.composePick.addEventListener("click", () => el.composeImage.click());
el.composeClearImage.addEventListener("click", () => setComposeImage(null));
el.composeImage.addEventListener("change", async () => {
  const file = el.composeImage.files?.[0];
  el.composeImage.value = "";
  if (file) await takeImage(file);
});
el.compose.addEventListener("paste", async (event) => {
  const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
  if (!file) return;
  event.preventDefault();
  await takeImage(file);
});
el.compose.addEventListener("dragover", (event) => event.preventDefault());
el.compose.addEventListener("drop", async (event) => {
  const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
  if (!file) return;
  event.preventDefault();
  await takeImage(file);
});
el.composeText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    el.composeSave.click();
  }
});

async function takeImage(file) {
  if (file.size > INBOX_MAX_BYTES) {
    toast("That image is too large to send. The limit is 20 MB.");
    return;
  }
  setComposeImage({ mimeType: file.type || "image/jpeg", bytes: new Uint8Array(await file.arrayBuffer()), blob: file });
}

function setComposeImage(image) {
  if (composeImage?.url) URL.revokeObjectURL(composeImage.url);
  composeImage = image;
  if (image) {
    image.url = URL.createObjectURL(image.blob);
    el.composePreview.src = image.url;
  } else {
    el.composePreview.removeAttribute("src");
  }
  el.composeFigure.hidden = !image;
  el.composePick.hidden = !!image;
}

el.compose.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = el.composeText.value.trim();
  if (!text && !composeImage) {
    el.composeText.focus();
    return;
  }
  el.composeSave.disabled = true;
  try {
    const item = { id: crypto.randomUUID(), createdAt: Date.now(), text: text || null, image: composeImage ? { mimeType: composeImage.mimeType, bytes: composeImage.bytes } : null };
    let relayId;
    try {
      relayId = await relay.send(opened.relayToken, await sealInbox(opened.key, item));
    } catch (e) {
      // Nothing was sent: the dialog stays open with the words in it.
      toast(e.message ?? "That capture could not be sent. Try again.");
      return;
    }
    const record = {
      via: "relay",
      relayId,
      delivered: false,
      id: item.id,
      createdAt: item.createdAt,
      text: item.text,
      image: composeImage ? composeImage.blob : null,
      mimeType: composeImage?.mimeType ?? null,
      imageHash: composeImage ? await sha256Hex(composeImage.bytes) : null,
    };
    sentItems.push(record);
    await saveSent(record);
    el.compose.close();
    mergeSent();
    renderNav();
    refresh();
    const c = byId.get("sent:" + item.id);
    if (c && shown.includes(c)) select(c);
    toast("Sent. It arrives when Captry opens on your phone.");
    watchDelivery();
  } catch (e) {
    console.error(e);
    toast("That capture could not be sent.");
  } finally {
    el.composeSave.disabled = false;
  }
});

/**
 * Drops sent captures the library already has.
 *
 * The phone gives an imported capture its own id, so it is matched by its
 * words or its picture's fingerprint, either newer than the send.
 */
async function settleSent() {
  if (!sentItems.length || !opened) return;
  const texts = new Map();
  const hashes = new Map();
  for (const c of opened.manifest.captures) {
    if (c.sent) continue;
    if (c.text) texts.set(c.text.trim(), Math.max(texts.get(c.text.trim()) ?? 0, c.capturedAt ?? 0));
    for (const f of c.files) if (f.hash) hashes.set(f.hash.toLowerCase(), Math.max(hashes.get(f.hash.toLowerCase()) ?? 0, c.capturedAt ?? 0));
  }
  const arrived = [];
  for (const item of sentItems) {
    if (!item.imageHash && item.image) item.imageHash = await sha256Hex(new Uint8Array(await item.image.arrayBuffer()));
    const byText = item.text && (texts.get(item.text.trim()) ?? -1) >= item.createdAt - 60_000;
    const byImage = item.imageHash && (hashes.get(item.imageHash) ?? -1) >= item.createdAt - 60_000;
    if (byText || byImage) arrived.push(item);
  }
  if (!arrived.length) return;
  const ids = arrived.map((i) => i.id);
  sentItems = sentItems.filter((i) => !ids.includes(i.id));
  await store.removeSent(ids);
}

/**
 * Checks the relay for what the phone has collected, while anything sent
 * through it is still out. Every few seconds while the page is in view, and
 * not at all once nothing is waiting, so an idle page costs the relay nothing.
 */
let deliveryTimer = 0;
const DELIVERY_MS = 8_000;

function watchDelivery(delay = DELIVERY_MS) {
  clearTimeout(deliveryTimer);
  const out = () => opened?.relayToken &&
    (sentItems.some((i) => i.relayId && !i.delivered) || [...pendingEdits.values()].some((e) => !e.collected));
  if (!out()) return;
  deliveryTimer = setTimeout(async () => {
    if (document.visibilityState === "visible" && out()) {
      try {
        const still = await relay.waiting(opened.relayToken);
        for (const edit of pendingEdits.values()) if (!edit.collected && !still.has(edit.relayId)) edit.collected = true;
        const collected = sentItems.filter((i) => i.relayId && !i.delivered && !still.has(i.relayId));
        if (collected.length) {
          for (const item of collected) {
            item.delivered = true;
            await saveSent(item);
          }
          mergeSent();
          renderNav();
          refresh({ keepSelection: true });
          const open = byId.get(state.selectedId);
          if (open?.sent && !editorOpen()) renderDetail(open);
          toast(collected.length === 1 ? "Your phone has it" : `Your phone has ${collected.length} of them`);
        }
        updateSync();
      } catch (e) {
        // Offline for a moment: the next look tries again.
      }
    }
    watchDelivery();
  }, delay);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") watchDelivery();
});

/**
 * The phone's changes since pairing, through the relay's feed.
 *
 * On opening, every kept entry newer than the library is applied in order;
 * after that, only new ones, every half minute while the page is in view.
 * An upsert replaces or adds a capture, with any new pictures; a delete
 * removes one.
 */
let feed = { seq: 0, since: 0, applied: 0, missing: false };
const feedFiles = new Map(); // picture name -> Blob, as the phone sent it
const FEED_MS = 30_000;
let feedRunning = false;
let feedAgain = false;

async function syncFeed() {
  if (!opened?.relayToken || !opened.key) return;
  // Told again while looking: look once more straight after, not in 5 minutes.
  if (feedRunning) {
    feedAgain = true;
    return;
  }
  lastFeedLook = Date.now();
  feedRunning = true;
  const target = opened;
  try {
    let changed = 0;
    for (;;) {
      const page = await relay.feedSince(target.relayToken, feed.seq);
      if (opened !== target) return;
      // Entries were dropped for age or room after this library was made,
      // so something in between may be missing.
      if (feed.seq === 0 && page.trimmedThrough > 0 && page.entries[0] && page.entries[0].createdAt > feed.since) {
        feed.missing = true;
      }
      for (const entry of page.entries) {
        feed.seq = entry.seq;
        lastPhoneAt = Math.max(lastPhoneAt, entry.createdAt ?? 0);
        // Written well before the library was made: already in it.
        if (entry.createdAt < feed.since - 5 * 60_000) continue;
        const body = await openFeed(target.key, await relay.feedEntry(target.relayToken, entry.seq));
        if (!body || body.at < feed.since) continue;
        // The phone reset its key: this computer's copy is no longer kept up
        // to date, and nothing it sends would be read. Forget it here.
        if (body.changes?.some((c) => c.op === "unpaired")) {
          await unpairedHere(target.relayToken);
          return;
        }
        changed += applyChanges(body.changes);
      }
      if (page.entries.length < 500) break;
    }
    updateSync();
    if (changed) {
      persistLibrary();
      feed.applied += changed;
      await settleSent();
      mergeSent();
      renderNav();
      refresh({ keepSelection: true });
      // Not under someone typing: the panel is redrawn when they finish.
      const open = byId.get(state.selectedId);
      if (open && !editorOpen()) renderDetail(open);
    }
    if (feed.missing && !feed.warned) {
      feed.warned = true;
      toast("Some of your phone's changes are older than two weeks and were not kept. Pair again to see everything.");
    }
  } catch (e) {
    // Offline for a moment, or the relay is busy: the next look tries again.
  } finally {
    feedRunning = false;
    if (feedAgain && opened) {
      feedAgain = false;
      syncFeed();
    }
  }
}

function applyChanges(changes) {
  let n = 0;
  for (const change of changes) {
    if (change.op === "result" && change.id) {
      n += settleEdit(change) ? 1 : 0;
    } else if (change.op === "files" && Array.isArray(change.files)) {
      for (const f of change.files) {
        if (!f.file || !f.data) continue;
        const bytes = fromBase64(f.data);
        const known = opened.manifest.captures.find((c) => c.id === change.capture)?.files.find((x) => x.file === f.file);
        feedFiles.set(f.file, new Blob([bytes], { type: safeMime(known?.mimeType) }));
        thumbOnly.delete(f.file);
        const old = fileUrls.get(f.file);
        if (old) URL.revokeObjectURL(old);
        fileUrls.delete(f.file);
        if (!opened.ephemeral) sealCache(opened.key, bytes).then((sealed) => store.saveImage(f.file, sealed));
        lightboxArrived(f.file);
        n++;
      }
    } else if (change.op === "delete" && change.id) {
      const before = opened.manifest.captures.length;
      opened.manifest.captures = opened.manifest.captures.filter((c) => c.id !== change.id);
      n += before - opened.manifest.captures.length;
    } else if (change.op === "upsert" && change.capture) {
      const capture = decodeCapture(change.capture);
      if (!capture?.id) continue;
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
          const target = opened;
          if (!target.ephemeral) mine.arrayBuffer().then((b) => sealCache(target.key, new Uint8Array(b))).then((sealed) => store.saveImage(f.file, sealed));
          continue;
        }
        const bytes = fromBase64(f.data);
        feedFiles.set(f.file, new Blob([bytes], { type: safeMime(mime) }));
        if (f.thumb) thumbOnly.add(f.file);
        else thumbOnly.delete(f.file);
        if (!opened.ephemeral) sealCache(opened.key, bytes).then((sealed) => store.saveImage(f.file, sealed));
      }
      // Waiting out its Undo in Trash: stays out of sight until that is settled.
      if (trashPending.has(capture.id)) continue;
      if ([...pendingEdits.values()].some((e) => e.captureId === capture.id && e.ops.some((o) => o.op === "trash"))) continue;
      // An edit the phone has not answered yet may be newer than this copy:
      // keep showing it on top.
      for (const [id, edit] of pendingEdits) {
        if (edit.captureId !== capture.id) continue;
        applyOpsHere(capture, edit.ops);
        capture.pendingEdit = id;
      }
      opened.manifest.captures = opened.manifest.captures.filter((c) => c.id !== capture.id);
      opened.manifest.captures.push(capture);
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

async function saveSent(item) {
  const key = opened?.key;
  if (!key || opened.ephemeral) return;
  const image = item.image ? new Uint8Array(await item.image.arrayBuffer()) : null;
  const plain = { ...item, image: image ? toBase64(image) : null };
  const sealed = await sealCache(key, new TextEncoder().encode(JSON.stringify(plain)));
  await store.addSent({ id: item.id, sealed, savedAt: item.createdAt ?? Date.now() });
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

/** The type a blob may carry: a picture's or a sound's, else plain bytes. */
function safeMime(mime) {
  const m = String(mime ?? "").toLowerCase().split(";")[0].trim();
  return /^(image\/(jpeg|png|gif|webp|heic|heif|avif|bmp)|audio\/[a-z0-9.+-]+)$/.test(m) ? m : "application/octet-stream";
}

function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

setInterval(() => {
  // While the live connection is up the relay says when to look; this is
  // only a safety net then.
  if (document.visibilityState !== "visible") return;
  if (liveUp && Date.now() - lastFeedLook < 5 * 60_000) return;
  syncFeed();
}, FEED_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncFeed();
});

// --- editing, applied on the phone -----------------------------------------------------
//
// An edit is shown here straight away and sent to the phone as a sealed
// instruction. The phone applies a title or note only if it is still what this
// page saw, never deletes past Trash, never touches private captures, and says
// how it went in the feed; the page then keeps or puts back what it showed.

/** Edits sent and not yet answered, by change id. */
const pendingEdits = new Map();

/** Whether a rename, note or collection box is open in the capture panel. */
function editorOpen() {
  return !!el.detail.querySelector(".editor:not([hidden]), .inline-edit");
}

/**
 * Edits the title or the note where it is shown. Enter saves a title,
 * Ctrl or Cmd+Enter a note, and clicking away saves either; Esc puts it back.
 */
function inlineEdit(c, field) {
  if (!editable(c) || el.detail.querySelector(".inline-edit")) return;
  let host;
  if (field === "title") {
    host = el.detail.querySelector("h2");
  } else {
    host = el.detail.querySelector(".note-section .prose");
    if (!host) {
      // No note yet: a place for one, just under the tools and collections.
      const s = section("Your note", "");
      s.classList.add("note-section");
      const after = el.detail.querySelector(".cchips") ?? el.detail.querySelector(".edit-bar");
      after ? after.after(s) : el.detail.append(s);
      host = s.lastChild;
    }
  }
  if (!host) return;
  const start = field === "title" ? (c.title ?? titleOf(c)) : (c.note ?? "");
  const input = document.createElement(field === "title" ? "input" : "textarea");
  input.className = `inline-edit ${field}-edit`;
  input.value = start;
  input.setAttribute("aria-label", field === "title" ? "Title" : "Note");
  if (field === "note") input.placeholder = "Why you saved this, or anything else";
  host.replaceChildren(input);
  host.classList.remove("editable");
  if (field === "note") {
    const hint = document.createElement("p");
    hint.className = "inline-hint";
    hint.textContent = `${MAC ? "⌘" : "Ctrl"}+Enter to save · Esc to cancel`;
    host.after(hint);
    const grow = () => {
      input.style.height = "auto";
      input.style.height = `${Math.max(90, input.scrollHeight + 2)}px`;
    };
    input.addEventListener("input", grow);
    requestAnimationFrame(grow);
  }
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value !== start.trim()) {
      const from = field === "title" ? (c.title ?? null) : (c.note ?? null);
      sendChange(c, [{ op: field, from, to: value || null }]);
    } else {
      renderDetail(c);
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    } else if (event.key === "Enter" && (field === "title" || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      finish(true);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** A collection is a checklist if the phone says so, or anything in it was ever ticked. */
function isChecklist(name) {
  const key = name.toLowerCase();
  return opened.manifest.captures.some((c) =>
    c.collections.some((m) => m.name.toLowerCase() === key && (m.checklist || m.checked)));
}

function tickButton(c, name, className) {
  const membership = c.collections.find((m) => m.name.toLowerCase() === name.toLowerCase());
  const checked = !!membership?.checked;
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.setAttribute("role", "checkbox");
  b.setAttribute("aria-checked", String(checked));
  b.setAttribute("aria-label", `${checked ? "Untick" : "Tick"} in ${name}`);
  b.title = checked ? `Untick in ${name}` : `Tick off in ${name}`;
  b.innerHTML = checked
    ? `<svg viewBox="0 0 24 24" width="${className === "tick" ? 20 : 16}" height="${className === "tick" ? 20 : 16}" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="var(--accent-ink, #fff)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg viewBox="0 0 24 24" width="${className === "tick" ? 20 : 16}" height="${className === "tick" ? 20 : 16}" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    sendChange(c, [{ op: "check", name, value: !checked }]);
  });
  return b;
}

function editable(c) {
  return !!(opened?.relayToken && opened.key && !c.sent && !c.private);
}

/**
 * The capture's tools in one row: the changes it can take, Open for a link,
 * and More for copying and searching.
 */
/** One button of a toolbar: an icon and a word, and its key when it has one. */
function makeTool(label, iconName, onClick, key, extra) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tool" + (extra ? ` ${extra}` : "");
  b.append(icon(iconName), document.createTextNode(label));
  if (key) hotkey(b, label, key);
  b.addEventListener("click", onClick);
  return b;
}

/**
 * What can be done to [c], in order. Those marked tool are the toolbar's
 * buttons; the rest are in its More menu. A null is a line in a menu.
 */
function captureItems(c) {
  const items = [];
  if (editable(c)) {
    items.push(
      { tool: true, label: "Rename", icon: "pencil", key: "R", run: () => openEditor(c, "title") },
      { tool: true, label: c.note ? "Edit note" : "Note", icon: "note", key: "E", run: () => openEditor(c, "note") },
      { tool: true, label: c.pinned ? "Unpin" : "Pin", icon: "pin", key: "P", on: c.pinned, run: () => sendChange(c, [{ op: "pin", value: !c.pinned }]) },
      { tool: true, label: c.archived ? "Unarchive" : "Archive", icon: "archive", key: "A", run: () => sendChange(c, [{ op: "archive", value: !c.archived }]) },
      { tool: true, label: "Collection", icon: "folderPlus", key: "L", run: () => openEditor(c, "collection") },
    );
  }
  if (c.sourceUrl) items.push({ tool: true, label: "Open source", short: "Open", icon: "external", key: "O", href: c.sourceUrl, run: () => window.open(c.sourceUrl, "_blank", "noopener") });
  items.push(null);
  const body = bodyText(c);
  if (body) items.push({ label: "Copy text", icon: "copy", key: "C", run: () => copyNow(body, "Copied the text") });
  items.push({ label: "Copy as Markdown", icon: "markdown", key: "M", run: () => copyNow(markdownOf(c), "Copied as Markdown") });
  if (c.sourceUrl) items.push({ label: "Copy Markdown link", icon: "link", run: () => copyNow(`[${titleOf(c)}](${c.sourceUrl})`, "Copied the link") });
  items.push({ label: "Search the web", icon: "search", run: () => window.open("https://www.google.com/search?q=" + encodeURIComponent(titleOf(c).slice(0, 200)), "_blank", "noopener") });
  if (editable(c)) items.push(null, { tool: true, label: "Trash", icon: "trash", key: DELETE_KEY, danger: true, run: () => trashWithUndo([c]) });
  return items;
}

/** A toolbar button made from an item; a link stays a link. */
function toolFrom(it) {
  let node;
  if (it.href) {
    node = document.createElement("a");
    node.className = "tool";
    node.href = it.href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    node.append(icon(it.icon), document.createTextNode(it.short ?? it.label));
    hotkey(node, it.label, it.key);
  } else {
    node = makeTool(it.short ?? it.label, it.icon, it.run, it.key, [it.danger && "danger", it.on && "on"].filter(Boolean).join(" "));
    node.disabled = !!it.disabled;
  }
  node.dataset.fold = "";
  node.menuItem = it;
  return node;
}

/** A toolbar from [items]: their tools in a row, then More with the rest. */
function itemsToolbar(items) {
  const bar = document.createElement("div");
  bar.className = "toolbar";
  for (const it of items) if (it?.tool) bar.append(toolFrom(it));
  const folded = () => [...bar.querySelectorAll(":scope > [data-fold][hidden]")].map((n) => n.menuItem);
  bar.append(...menuButton("More", () => {
    const gone = folded();
    return [...gone.filter((it) => !it.danger), null, ...items.filter((it) => !it?.tool), null, ...gone.filter((it) => it.danger)];
  }));
  fitToolbar(bar);
  return bar;
}

/** Keeps [bar] on one line: tools that don't fit go, from the end, into More. */
function fitToolbar(bar) {
  const fit = () => {
    const tools = [...bar.querySelectorAll(":scope > [data-fold]")];
    for (const t of tools) t.hidden = false;
    for (let i = tools.length - 1; i >= 0 && bar.scrollWidth > bar.clientWidth + 1; i--) tools[i].hidden = true;
  };
  new ResizeObserver(fit).observe(bar);
}

function detailToolbar(c) {
  return itemsToolbar(captureItems(c));
}

/** An empty menu: a popover, so Esc and a click outside close it. Up and down move in it. */
function newMenu() {
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.popover = "auto";
  menu.setAttribute("role", "menu");
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    const items = [...menu.querySelectorAll(".menu-item:not(:disabled)")];
    const at = items.indexOf(document.activeElement);
    items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  });
  return menu;
}

/** [items] into [menu]: a null is a line between groups, never at an end or twice. */
function fillMenu(menu, items) {
  menu.replaceChildren();
  for (const it of items) {
    if (!it) {
      if (menu.lastChild && !menu.lastChild.classList.contains("menu-sep")) {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        sep.setAttribute("role", "separator");
        menu.append(sep);
      }
      continue;
    }
    const mi = document.createElement("button");
    mi.type = "button";
    mi.className = "menu-item" + (it.danger ? " danger" : "");
    mi.setAttribute("role", "menuitem");
    mi.disabled = !!it.disabled;
    const name = document.createElement("span");
    name.textContent = it.label;
    mi.append(icon(it.icon), name);
    if (it.key) {
      const k = document.createElement("kbd");
      k.textContent = it.key;
      mi.append(k);
    }
    mi.addEventListener("click", () => {
      menu.hidePopover();
      it.run();
    });
    menu.append(mi);
  }
  if (menu.lastChild?.classList.contains("menu-sep")) menu.lastChild.remove();
}

/** A menu where the pointer is, for a right-click. */
function contextMenu(x, y, items) {
  hideTip();
  const menu = newMenu();
  fillMenu(menu, items);
  if (!menu.childElementCount) return;
  document.body.append(menu);
  menu.addEventListener("toggle", (event) => {
    if (event.newState === "closed") menu.remove();
  });
  menu.showPopover();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  menu.style.top = `${y + h + 8 > innerHeight ? Math.max(8, y - h) : y}px`;
  menu.querySelector(".menu-item:not(:disabled)")?.focus({ focusVisible: false });
}

/** A More button and its menu. [items] can be a function, asked each time it opens. */
function menuButton(label, items) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tool";
  b.append(icon("more"), document.createTextNode(label));
  b.setAttribute("aria-haspopup", "menu");
  const menu = newMenu();
  menu.addEventListener("beforetoggle", (event) => {
    if (event.newState === "open") fillMenu(menu, typeof items === "function" ? items() : items);
  });
  b.addEventListener("click", () => {
    menu.togglePopover();
  });
  menu.addEventListener("toggle", (event) => {
    b.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState !== "open") return;
    const r = b.getBoundingClientRect();
    const w = menu.offsetWidth;
    const hgt = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    menu.style.top = `${r.bottom + hgt + 6 > innerHeight ? Math.max(8, r.top - hgt - 6) : r.bottom + 6}px`;
    menu.querySelector(".menu-item")?.focus();
  });
  return [b, menu];
}

function editBar(c) {
  const bar = document.createElement("div");
  bar.className = "edit-bar";
  const pending = c.pendingEdit ? pendingEdits.get(c.pendingEdit) : null;
  if (pending) {
    const note = document.createElement("p");
    note.className = "waiting";
    const minutes = (Date.now() - pending.at) / 60_000;
    note.textContent = pending.collected
      ? "Your phone is applying this."
      : minutes > 3
        ? "Waiting for your phone. Turn on Captry on your computer in Captry > Settings > Network, then open Captry."
        : "Queued for your phone.";
    bar.append(note);
  }
  bar.append(detailToolbar(c));
  const editor = document.createElement("div");
  editor.className = "editor";
  editor.hidden = true;
  bar.append(editor);
  return bar;
}

function openEditor(c, field) {
  if (field === "title" || field === "note") {
    inlineEdit(c, field);
    return;
  }
  const editor = el.detail.querySelector(".editor");
  if (!editor) return;
  editor.replaceChildren();
  editor.hidden = false;
  const form = document.createElement("form");
  let input;
  if (field === "note") {
    input = document.createElement("textarea");
    input.rows = 5;
    input.value = c.note ?? "";
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.value = field === "title" ? (c.title ?? "") : "";
    if (field === "collection") {
      input.placeholder = "Collection name";
      const list = document.createElement("datalist");
      list.id = "collection-names";
      const names = new Set();
      for (const other of opened.manifest.captures) for (const m of other.collections) names.add(m.name);
      for (const name of [...names].sort()) list.append(option(name, name));
      input.setAttribute("list", list.id);
      form.append(list);
    }
  }
  input.className = "editor-input";
  input.setAttribute("aria-label", field === "title" ? "Title" : field === "note" ? "Note" : "Collection");
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "button small primary";
  save.textContent = field === "collection" ? "Add" : "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button small";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    editor.hidden = true;
    editor.replaceChildren();
    // Anything that changed while the editor was open shows now.
    const open = byId.get(state.selectedId);
    if (open) renderDetail(open);
  });
  const row = document.createElement("div");
  row.className = "editor-buttons";
  row.append(save, cancel);
  form.append(input, row);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (field === "title") {
      if (value !== (c.title ?? "")) sendChange(c, [{ op: "title", from: c.title ?? null, to: value || null }]);
    } else if (field === "note") {
      if (value !== (c.note ?? "")) sendChange(c, [{ op: "note", from: c.note ?? null, to: value || null }]);
    } else if (value && !c.collections.some((m) => m.name.toLowerCase() === value.toLowerCase())) {
      sendChange(c, [{ op: "collection", name: value, add: true }]);
    }
    editor.hidden = true;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancel.click();
    if (field === "note" && event.key === "Enter" && (event.ctrlKey || event.metaKey)) form.requestSubmit();
  });
  editor.append(form);
  input.focus();
}

async function sendChange(c, ops, { quiet = false, undo = false } = {}) {
  const change = { format: 1, id: crypto.randomUUID(), at: Date.now(), capture: c.id, ops };
  const before = snapshotCapture(c);
  let relayId;
  try {
    relayId = await relay.send(opened.relayToken, await sealChange(opened.key, change));
  } catch (e) {
    toast(e.message ?? "That change could not be sent.");
    return;
  }
  pendingEdits.set(change.id, { relayId, captureId: c.id, before, ops, at: change.at, collected: false });
  // Shown at once; put back if the phone says otherwise.
  if (ops.some((o) => o.op === "trash")) {
    opened.manifest.captures = opened.manifest.captures.filter((x) => x.id !== c.id);
  } else {
    applyOpsHere(c, ops);
    c.pendingEdit = change.id;
  }
  watchDelivery();
  updateSync();
  if (quiet) return;
  redraw();
  const back = undo ? null : inverseOps(ops);
  toast(undo ? "Undone" : "Queued for your phone", back ? { label: "Undo", run: () => sendChange(c, back, { undo: true }) } : null);
}

/** Shows [ops] on this page's copy of [c], as the phone will apply them. */
function applyOpsHere(c, ops) {
  for (const o of ops) {
    if (o.op === "title") c.title = o.to;
    if (o.op === "note") c.note = o.to;
    if (o.op === "pin") c.pinned = o.value;
    if (o.op === "archive") c.archived = o.value;
    if (o.op === "check") {
      c.collections = c.collections.map((m) => (m.name.toLowerCase() === o.name.toLowerCase() ? { ...m, checked: o.value } : m));
    }
    if (o.op === "collection") {
      const has = c.collections.some((m) => m.name.toLowerCase() === o.name.toLowerCase());
      c.collections = o.add
        ? (has ? c.collections : [...c.collections, { name: o.name, checked: false }])
        : c.collections.filter((m) => m.name.toLowerCase() !== o.name.toLowerCase());
    }
  }
  c._hay = undefined;
}

/** The change that puts [ops] back, or null when there is none to send. */
function inverseOps(ops) {
  const back = [];
  for (const o of ops) {
    if (o.op === "pin" || o.op === "archive") back.push({ op: o.op, value: !o.value });
    else if (o.op === "check") back.push({ op: "check", name: o.name, value: !o.value });
    else if (o.op === "collection") back.push({ op: "collection", name: o.name, add: !o.add });
    else if (o.op === "title" || o.op === "note") back.push({ op: o.op, from: o.to, to: o.from });
    else return null;
  }
  return back.length ? back : null;
}

/**
 * Trash with Undo: gone from here at once, sent to the phone only once the
 * Undo has gone, so Undo needs nothing from the phone at all.
 */
const trashPending = new Set();

function trashWithUndo(list) {
  list = list.filter(editable).slice(0, BULK_MAX);
  if (!list.length) return;
  const ids = new Set(list.map((c) => c.id));
  for (const id of ids) trashPending.add(id);
  opened.manifest.captures = opened.manifest.captures.filter((x) => !ids.has(x.id));
  for (const id of ids) picked.delete(id);
  quietRedraw();
  let settled = false;
  toast(list.length === 1 ? "Moved to Trash" : `Moved ${list.length} to Trash`, {
    label: "Undo",
    run: () => {
      if (settled) return;
      settled = true;
      for (const id of ids) trashPending.delete(id);
      opened.manifest.captures.push(...list);
      quietRedraw();
    },
    expire: async () => {
      if (settled) return;
      settled = true;
      for (const id of ids) trashPending.delete(id);
      for (const c of list) {
        await sendChange(c, [{ op: "trash" }], { quiet: true });
        if (list.length > 1) await new Promise((r) => setTimeout(r, 250));
      }
      redraw();
    },
  });
}

/** Lists and panel again, without saving: used while a change can still be undone. */
function quietRedraw() {
  mergeSent();
  renderNav();
  refresh({ keepSelection: true });
  const open = byId.get(state.selectedId);
  if (open) renderDetail(open);
  else if (picked.size > 1) renderBulk();
}

/** The phone's answer to an edit: keep what was shown, or put back what it did not apply. */
function settleEdit(result) {
  const edit = pendingEdits.get(result.id);
  if (!edit) return false;
  pendingEdits.delete(result.id);
  const conflicts = result.conflicts ?? [];
  const current = opened.manifest.captures.find((x) => x.id === edit.captureId);
  if (result.refused) {
    // Nothing applied: back to how it was before the edit.
    if (!current) opened.manifest.captures.push(edit.before);
    else Object.assign(current, edit.before);
    toast(result.refused === "trashed" ? "Your phone has already moved that to Trash." : "Your phone did not apply that change.");
  } else if (conflicts.length && current) {
    for (const field of conflicts) {
      if (field === "title") current.title = edit.before.title;
      if (field === "note") current.note = edit.before.note;
    }
    current._hay = undefined;
    toast(`Kept the phone's ${conflicts.join(" and ")}: it was changed on the phone too.`);
  }
  if (current && current.pendingEdit === result.id) delete current.pendingEdit;
  updateSync();
  return true;
}

function snapshotCapture(c) {
  const copy = { ...c, collections: c.collections.map((m) => ({ ...m })) };
  delete copy._hay;
  delete copy.pendingEdit;
  return copy;
}

function redraw() {
  persistLibrary();
  mergeSent();
  renderNav();
  refresh({ keepSelection: true });
  const open = byId.get(state.selectedId);
  if (open) renderDetail(open);
}

// --- live updates ---------------------------------------------------------------------------

let liveConnection = null;
let liveToken = null;
let liveUp = false;
let lastFeedLook = 0;

function connectLive() {
  if (!opened?.relayToken) return;
  if (liveConnection && liveToken === opened.relayToken) return;
  liveConnection?.stop();
  liveToken = opened.relayToken;
  liveConnection = relay.live(
    opened.relayToken,
    (message) => {
      if (message.type === "feed") syncFeed();
      if (message.type === "items") watchDelivery(0);
    },
    (up) => {
      liveUp = up;
      updateSync();
      // Catch up on anything said while the connection was down.
      if (up) syncFeed();
    },
  );
}

// --- the library, kept between visits ------------------------------------------------------
//
// The paired library (with the phone's changes applied) is sealed with the
// remembered key and kept in this browser. A reload shows it at once and
// carries on from the same place in the phone's changes.

let persistTimer = 0;

function persistLibrary() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    const target = opened;
    if (!target?.key || !target.place || target.ephemeral) return;
    const captures = target.manifest.captures
      .filter((c) => !c.sent)
      .map((c) => {
        const copy = { ...c };
        delete copy._hay;
        delete copy.pendingEdit;
        return copy;
      });
    const payload = {
      v: 1,
      name: target.name,
      smartCollections: target.manifest.smartCollections,
      captures,
      feed: { seq: feed.seq, since: feed.since },
      thumbs: [...thumbOnly],
    };
    const sealed = await sealCache(target.key, new TextEncoder().encode(JSON.stringify(payload)));
    if (opened !== target) return;
    await store.saveLibrary({ name: target.name, placeKind: target.place.kind, sealed, savedAt: Date.now() });
  }, 1500);
}

/** Shows the kept library at once, if there is one that fits. True when it did. */
async function openFromCache(saved) {
  const record = await store.loadLibrary();
  if (!record?.sealed || record.placeKind !== "paired") return false;
  // Older than the relay keeps the phone's changes: pair again.
  if (Date.now() - record.savedAt > 13 * 24 * 60 * 60_000) return false;
  const plain = await openCache(saved.key, record.sealed);
  if (!plain) return false;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(plain));
  } catch (e) {
    return false;
  }
  if (payload?.v !== 1 || !Array.isArray(payload.captures)) return false;
  closeOpened();
  const place = { kind: "paired", name: friendlyPhone(saved.name) };
  thumbOnly.clear();
  for (const name of payload.thumbs ?? []) thumbOnly.add(name);
  opened = {
    kind: "paired",
    manifest: { captures: payload.captures, smartCollections: payload.smartCollections ?? [] },
    key: saved.key,
    relayToken: saved.relayToken ?? null,
    name: payload.name,
    place,
    cached: true,
  };
  feed = { seq: payload.feed?.seq ?? 0, since: payload.feed?.since ?? 0, applied: 0, missing: false };
  sentItems = await loadSent(saved.key);
  await settleSent();
  showOpened(null);
  return true;
}

/** Puts what is still waiting into the list as captures, marked as sent. */
function mergeSent() {
  if (!opened) return;
  opened.manifest.captures = opened.manifest.captures.filter((c) => !c.sent);
  for (const item of sentItems) {
    const url = (item.text ?? "").match(/https?:\/\/\S+/)?.[0] ?? null;
    opened.manifest.captures.push({
      id: "sent:" + item.id,
      sent: true,
      delivered: !!item.delivered,
      via: item.via ?? null,
      type: null,
      source: "DESKTOP",
      sourceApp: null,
      sourceUrl: url,
      sourceHost: null,
      text: item.text,
      title: null,
      summary: null,
      note: null,
      capturedAt: item.createdAt,
      createdAt: item.createdAt,
      pinned: false,
      archived: false,
      private: false,
      entities: [],
      files: item.image ? [{ file: "sent:" + item.id, type: "IMAGE", mimeType: item.mimeType, blob: item.image }] : [],
      collections: [],
      links: [],
      highlights: [],
    });
  }
  opened.manifest.captures.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));
  byId = new Map(opened.manifest.captures.map((c) => [c.id, c]));
}

let toastTimer = 0;
let toastExpire = null;

/**
 * A short message, with an optional action such as Undo. `expire` runs when
 * the message goes without the action being taken, or another replaces it.
 */
function toast(message, action = null) {
  flushToast();
  const trouble = /could not|couldn't|too large|nothing to|first,|did not|already|can't/i.test(message);
  const mark = document.createElement("span");
  mark.className = "toast-icon";
  mark.append(icon(trouble ? "bell" : "done"));
  el.toast.replaceChildren(mark, document.createTextNode(message));
  el.toast.hidden = true;
  void el.toast.offsetWidth;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-action";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      toastExpire = null;
      clearTimeout(toastTimer);
      el.toast.hidden = true;
      action.run();
    });
    el.toast.append(b);
    toastExpire = action.expire ?? null;
  }
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
    flushToast();
  }, action ? 7000 : 3500);
}

function flushToast() {
  const run = toastExpire;
  toastExpire = null;
  run?.();
}

// A Trash still waiting out its Undo goes now if the page is left.
addEventListener("pagehide", flushToast);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushToast();
});


// --- the controls above the list -------------------------------------------

function buildControls() {
  el.chips.replaceChildren(
    ...FILTERS.map((f) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip-button";
      b.dataset.filter = f.id;
      b.textContent = f.label;
      b.setAttribute("aria-pressed", String(state.filter === f.id));
      b.addEventListener("click", () => {
        state.filter = state.filter === f.id && f.id !== "ALL" ? "ALL" : f.id;
        refresh();
      });
      return b;
    }),
  );

  el.range.replaceChildren(...RANGES.map((r) => option(r.id, r.label)));
  el.sort.replaceChildren(...SORTS.map((s) => option(s.id, s.label)));

  const all = sources(opened.manifest.captures);
  el.source.replaceChildren(option("", "Any source"), ...all.map((s) => option(s.id, `${s.label} (${s.count})`)));
  el.sourceField.hidden = all.length === 0;
  requestAnimationFrame(chipFades);
}

/** The chips fade out at an edge only where there are more past it. */
function chipFades() {
  const c = el.chips;
  c.style.setProperty("--fade-l", c.scrollLeft > 2 ? "28px" : "0px");
  c.style.setProperty("--fade-r", c.scrollLeft + c.clientWidth < c.scrollWidth - 2 ? "28px" : "0px");
}
el.chips.addEventListener("scroll", chipFades, { passive: true });
new ResizeObserver(chipFades).observe(el.chips);
// A mouse wheel scrolls them sideways.
el.chips.addEventListener("wheel", (event) => {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || el.chips.scrollWidth <= el.chips.clientWidth) return;
  event.preventDefault();
  el.chips.scrollLeft += event.deltaY;
}, { passive: false });

el.filterButton.addEventListener("click", () => el.filterMenu.togglePopover());
el.filterMenu.addEventListener("toggle", (event) => {
  el.filterButton.setAttribute("aria-expanded", String(event.newState === "open"));
  if (event.newState !== "open") return;
  const r = el.filterButton.getBoundingClientRect();
  const w = el.filterMenu.offsetWidth;
  el.filterMenu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  el.filterMenu.style.top = `${r.bottom + 6}px`;
});
el.filterReset.addEventListener("click", () => {
  Object.assign(state, { range: "ANY", source: "" });
  refresh({ keepSelection: true });
  el.filterMenu.hidePopover();
});

function filterBadge() {
  const n = (state.range !== "ANY" ? 1 : 0) + (state.source ? 1 : 0);
  el.filterCount.textContent = String(n);
  el.filterCount.hidden = !n;
  el.filterButton.classList.toggle("active", n > 0);
  el.filterButton.setAttribute("aria-label", n ? `Filter and sort, ${n} on` : "Filter and sort");
  el.filterReset.hidden = !n;
}

el.search.addEventListener("input", () => {
  state.query = el.search.value;
  refresh({ keepSelection: true });
});
el.search.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && el.search.value) {
    event.stopPropagation();
    el.search.value = "";
    state.query = "";
    refresh({ keepSelection: true });
  } else if (event.key === "ArrowDown" || event.key === "Enter") {
    event.preventDefault();
    focusRow(0);
  }
});
el.range.addEventListener("change", () => {
  state.range = el.range.value;
  refresh({ keepSelection: true });
});
el.source.addEventListener("change", () => {
  state.source = el.source.value;
  refresh({ keepSelection: true });
});
el.sort.addEventListener("change", () => {
  state.sort = el.sort.value;
  remember("sort", state.sort);
  refresh({ keepSelection: true });
});
el.layoutList.addEventListener("click", () => setLayout("list"));
el.layoutGrid.addEventListener("click", () => setLayout("grid"));
el.clear.addEventListener("click", () => {
  Object.assign(state, { query: "", filter: "ALL", range: "ANY", source: "" });
  el.search.value = "";
  refresh({ keepSelection: true });
});
el.viewSelect.addEventListener("change", () => {
  const view = hashToView(el.viewSelect.value);
  if (view) go(view);
});

function setLayout(layout) {
  state.layout = layout;
  remember("layout", layout);
  refresh({ keepSelection: true });
}

// --- the sidebar -----------------------------------------------------------

function renderNav() {
  const now = Date.now();
  const cat = catalog(opened.manifest, now);
  const groups = [
    { heading: null, items: cat.places },
    { heading: "Your collections", items: cat.collections },
    { heading: "Smart collections", items: cat.smart },
    { heading: "Browse by type", items: cat.types },
  ].filter((g) => g.items.length);

  const frag = document.createDocumentFragment();
  el.viewSelect.replaceChildren();
  for (const group of groups) {
    const section = document.createElement("div");
    section.className = "nav-group";
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.heading ?? "Places";
    if (group.heading) {
      const h = document.createElement("h2");
      h.textContent = group.heading;
      section.append(h);
    }
    for (const item of group.items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "nav-item";
      b.dataset.hash = viewToHash(item.view);
      if (item.detail) b.title = item.detail;
      const lead = document.createElement("span");
      lead.className = "nav-icon";
      if (item.view.kind === "collection") lead.append(collectionDot(item.view.name));
      else if (item.view.kind === "smart") lead.append(icon("sparkle"));
      else if (item.view.kind === "type") lead.append(icon(TYPE_ICONS[item.view.type] ?? "tag"));
      else lead.append(icon(PLACE_ICONS[item.view.kind] ?? "inbox"));
      b.append(lead);
      const name = document.createElement("span");
      name.className = "nav-name";
      name.textContent = item.label;
      const n = document.createElement("span");
      n.className = "nav-count";
      n.textContent = item.count;
      b.append(name, n);
      b.addEventListener("click", () => go(item.view));
      dropTarget(b, item.view);
      section.append(b);
      optgroup.append(option(viewToHash(item.view), `${item.label} (${item.count})`));
    }
    frag.append(section);
    el.viewSelect.append(optgroup);
  }
  el.nav.replaceChildren(frag);
  markNav();
}

function markNav() {
  const hash = viewToHash(state.view);
  for (const b of el.nav.querySelectorAll(".nav-item")) {
    const on = b.dataset.hash === hash;
    b.classList.toggle("current", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  el.viewSelect.value = hash;
}

function viewExists(view) {
  const cat = catalog(opened.manifest, Date.now());
  if (view.kind === "source") return true;
  return [...cat.places, ...cat.collections, ...cat.smart, ...cat.types].some((i) => sameView(i.view, view));
}

/** Moves to a view, as a new history entry so Back returns. */
function go(view) {
  if (sameView(view, state.view)) return;
  history.pushState(null, "", viewToHash(view));
  showView(view);
}

function showView(view) {
  state.view = view;
  // A new place starts unfiltered, as the app's shelves do. The words stay:
  // someone searching across views is looking for one thing.
  Object.assign(state, { filter: "ALL", range: "ANY", source: "" });
  markNav();
  refresh();
  el.list.scrollTop = 0;
}

window.addEventListener("hashchange", () => {
  if (!opened) return;
  const view = hashToView(location.hash);
  if (view && viewExists(view) && !sameView(view, state.view)) showView(view);
});

// --- the list --------------------------------------------------------------

function refresh({ keepSelection = false } = {}) {
  const now = Date.now();
  ({ list: shown, doneFrom } = query(opened.manifest, state, now));

  el.viewTitle.textContent = viewTitle(state.view, opened.manifest);
  const smart = state.view.kind === "smart"
    ? opened.manifest.smartCollections.find((s) => s.name === state.view.name)
    : null;
  el.viewDetail.textContent = smart ? describeRule(smart.rule) : "";
  el.viewDetail.hidden = !smart;

  for (const b of el.chips.children) b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter));
  el.range.value = state.range;
  el.source.value = state.source;
  el.sort.value = state.sort;
  filterBadge();
  el.chips.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  el.layoutList.setAttribute("aria-pressed", String(state.layout === "list"));
  el.layoutGrid.setAttribute("aria-pressed", String(state.layout === "grid"));
  el.list.className = state.layout;

  const narrowed = state.query.trim() || state.filter !== "ALL" || state.range !== "ANY" || state.source;
  el.count.textContent = String(shown.length);
  el.count.title = `${shown.length} capture${shown.length === 1 ? "" : "s"}`;
  el.clear.hidden = !narrowed;
  el.count.classList.toggle("filtered", !!narrowed);

  el.list.replaceChildren();
  rendered = 0;
  renderMore();

  if (!shown.length) el.list.append(emptyList(narrowed));
  // Keep what is open only while it is still in the list; a search that
  // drops it should not leave the detail describing something not shown.
  if (picked.size) {
    const visible = new Set(shown.map((c) => c.id));
    for (const id of [...picked]) if (!visible.has(id)) picked.delete(id);
  }
  const keep = keepSelection && shown.some((c) => c.id === state.selectedId);
  if (keep) {
    markSelected();
    remark(el.detail, searchWords(state.query));
  } else if (shown.length) {
    select(shown[0], { scroll: false });
  } else {
    state.selectedId = null;
    el.detail.replaceChildren(emptyState("inbox", "Nothing selected", ""));
    setTabTitle(null);
  }
}

function renderMore() {
  const from = rendered;
  const slice = shown.slice(from, from + PAGE);
  const dated = state.sort !== "title";
  let lastGroup = from > 0 && dated ? dateGroup(shown[from - 1].capturedAt, Date.now()) : null;
  const now = Date.now();
  // How many under each heading, over the whole list, not just this page of it.
  const groupCounts = new Map();
  if (dated && doneFrom < 0) for (const x of shown) {
    const g = dateGroup(x.capturedAt, now);
    groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
  }
  const frag = document.createDocumentFragment();

  slice.forEach((c, i) => {
    const index = from + i;
    if (index === doneFrom) {
      frag.append(heading("Done", shown.length - doneFrom));
      lastGroup = null;
    } else if (dated && doneFrom < 0) {
      const group = dateGroup(c.capturedAt, now);
      if (group !== lastGroup) {
        frag.append(heading(group, groupCounts.get(group)));
        lastGroup = group;
      }
    }
    const done = index >= doneFrom && doneFrom >= 0;
    if (state.layout !== "grid" && state.view.kind === "collection" && isChecklist(state.view.name) && editable(c)) {
      const line = document.createElement("div");
      line.className = "row-line";
      line.append(tickButton(c, state.view.name, "tick"), row(c, done));
      frag.append(line);
    } else {
      frag.append(state.layout === "grid" ? card(c) : row(c, done));
    }
  });
  el.list.append(frag);
  rendered = from + slice.length;

  const rest = shown.length - rendered;
  el.more.hidden = rest <= 0;
  el.more.textContent = rest > 0 ? `Show ${Math.min(rest, PAGE)} more` : "";
  markSelected();
}

el.more.addEventListener("click", () => renderMore());

function row(c, done) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "row" + (done ? " done" : "");
  b.dataset.id = c.id;

  const text = document.createElement("div");
  text.className = "row-text";
  const words = searchWords(state.query);
  const title = document.createElement("div");
  title.className = "row-title";
  title.append(marked(titleOf(c), words));

  const meta = document.createElement("div");
  meta.className = "row-meta";
  const voice = c.files.find((f) => f.type === "AUDIO" || f.mimeType?.startsWith("audio/"));
  meta.textContent = [shortWhen(c.capturedAt), voice ? formatDuration(voice.durationMs) : "", c.title && !voice ? typeName(c.type) : "", c.sourceHost ?? sourceLabel(c.sourceApp)]
    .filter(Boolean)
    .join(" · ");
  const picture = c.files.find(isImage);
  b.append(picture ? thumb(picture, "row-thumb") : kindTile(c));
  text.append(title, meta);
  const s = snippet(c, 140, words);
  if (s) {
    const snip = document.createElement("div");
    snip.className = "row-snippet";
    snip.append(marked(s, words));
    text.append(snip);
  }
  b.append(text, rowFlags(c));
  draggableCapture(b, c);

  b.addEventListener("click", (event) => onPick(c, event));
  return b;
}

function card(c) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "card";
  b.dataset.id = c.id;
  draggableCapture(b, c);
  const image = c.files.find(isImage);
  if (image) {
    b.append(thumb(image, "card-thumb"));
  } else {
    const words = document.createElement("div");
    const said = snippet(c, 200, searchWords(state.query));
    // Nothing to read: the kind, large and centred, instead of an empty box.
    words.className = "card-words" + (said ? "" : " bare");
    words.append(kindTile(c));
    if (said) words.append(marked(said, searchWords(state.query)));
    b.append(words);
  }
  const title = document.createElement("div");
  title.className = "card-title";
  title.append(marked(titleOf(c), searchWords(state.query)));
  const meta = document.createElement("div");
  meta.className = "row-meta";
  const voice = c.files.find((f) => f.type === "AUDIO" || f.mimeType?.startsWith("audio/"));
  meta.textContent = [shortWhen(c.capturedAt), voice ? formatDuration(voice.durationMs) : typeName(c.type)].filter(Boolean).join(" · ");
  b.append(title, meta, rowFlags(c));
  b.addEventListener("click", (event) => onPick(c, event));
  return b;
}

function markSelected() {
  const nodes = [...el.list.querySelectorAll("[data-id]")];
  // What sits directly in the list: a row, or a checklist line holding one.
  const slot = (node) => (node.parentElement === el.list ? node : node.closest("#list > *"));
  nodes.forEach((node, i) => {
    const isPicked = picked.has(node.dataset.id);
    node.classList.toggle("picked", isPicked);
    node.classList.toggle("selected", !isPicked && picked.size < 2 && node.dataset.id === state.selectedId);
    // Picked rows that touch read as one block: no rounded corners between them.
    const joins = (other) => other && picked.has(other.dataset.id) && state.layout === "list";
    const prev = nodes[i - 1];
    const next = nodes[i + 1];
    node.classList.toggle("join-up", isPicked && joins(prev) && slot(node).previousElementSibling === slot(prev));
    node.classList.toggle("join-down", isPicked && joins(next) && slot(node).nextElementSibling === slot(next));
  });
}

// --- several at once ---------------------------------------------------------
//
// Ctrl or Cmd-click adds and removes, Shift-click takes a range of what is
// shown, X does either from the keyboard. With two or more picked, the panel
// on the right acts on all of them.

/** Ids of the captures picked; one or none means the ordinary single view. */
const picked = new Set();
const BULK_MAX = 50;

function onPick(c, event) {
  if (event.shiftKey && state.selectedId) {
    const ids = shown.map((x) => x.id);
    const from = ids.indexOf(state.selectedId);
    const to = ids.indexOf(c.id);
    if (from >= 0 && to >= 0) {
      if (!event.ctrlKey && !event.metaKey) picked.clear();
      const [a, b] = from < to ? [from, to] : [to, from];
      for (const id of ids.slice(a, b + 1)) picked.add(id);
      showPicked();
      return;
    }
  }
  if (event.ctrlKey || event.metaKey) {
    togglePick(c, { seed: true });
    return;
  }
  picked.clear();
  select(c);
}

/**
 * Adds or removes [c]. A Ctrl-click starts from the open capture as well, the
 * way a file manager does; X picks just the one it is on.
 */
function togglePick(c, { seed = false } = {}) {
  if (seed && picked.size === 0 && state.selectedId && state.selectedId !== c.id) picked.add(state.selectedId);
  if (picked.has(c.id)) picked.delete(c.id);
  else picked.add(c.id);
  if (seed) state.selectedId = c.id;
  showPicked();
}

function showPicked() {
  markSelected();
  if (picked.size > 1) renderBulk();
  else {
    const open = byId.get(state.selectedId);
    if (open) renderDetail(open);
  }
}

function clearPicked() {
  if (!picked.size) return false;
  picked.clear();
  markSelected();
  const open = byId.get(state.selectedId);
  if (open) renderDetail(open);
  return true;
}

function pickedCaptures() {
  return shown.filter((c) => picked.has(c.id));
}

/** What a key or a bulk button acts on: everything picked, or the open capture. */
function targets() {
  if (picked.size) return pickedCaptures();
  const open = byId.get(state.selectedId);
  return open ? [open] : [];
}

/** What can be done to everything picked; the same shape as captureItems. */
function bulkItems(list, changeable) {
  const off = !changeable.length;
  const allPinned = changeable.length && changeable.every((c) => c.pinned);
  const allArchived = changeable.length && changeable.every((c) => c.archived);
  return [
    { tool: true, disabled: off, label: allPinned ? "Unpin" : "Pin", icon: "pin", key: "P", run: () => bulkToggle("pin") },
    { tool: true, disabled: off, label: allArchived ? "Unarchive" : "Archive", icon: "archive", key: "A", run: () => bulkToggle("archive") },
    { tool: true, disabled: off, label: "Collection", icon: "folderPlus", key: "L", run: () => el.detail.querySelector(".bulk form input")?.focus() },
    null,
    { label: "Copy as Markdown", icon: "markdown", key: "M", run: () => copyNow(list.map(markdownOf).join("\n\n---\n\n"), `Copied ${list.length} as Markdown`) },
    { label: "Download Markdown", icon: "download", run: () => downloadList(list, "md", `${list.length} captures`) },
    { label: "Download CSV", icon: "download", run: () => downloadList(list, "csv", `${list.length} captures`) },
    null,
    { tool: true, disabled: off, label: "Trash", icon: "trash", key: DELETE_KEY, danger: true, run: () => bulkTrash() },
  ];
}

// A right-click on a row: its menu, or the selection's when it is one of them.
el.list.addEventListener("contextmenu", (event) => {
  const node = event.target.closest("[data-id]");
  const c = node && byId.get(node.dataset.id);
  if (!c) return;
  event.preventDefault();
  let { clientX: x, clientY: y } = event;
  if (!x && !y) {
    const r = node.getBoundingClientRect();
    x = r.left + 24;
    y = r.bottom - 6;
  }
  // Where the menu comes on the press (a Mac), it waits for the release, which would close it.
  const show = (items) => {
    if (event.buttons) addEventListener("pointerup", () => setTimeout(() => contextMenu(x, y, items)), { once: true });
    else contextMenu(x, y, items);
  };
  if (picked.size > 1 && picked.has(c.id)) {
    const list = pickedCaptures();
    show(bulkItems(list, list.filter(editable)));
    return;
  }
  if (picked.size || state.selectedId !== c.id) {
    picked.clear();
    select(c, { scroll: false });
  }
  show(captureItems(c));
});

function renderBulk() {
  const list = pickedCaptures();
  const changeable = list.filter(editable);
  const d = document.createElement("div");
  d.className = "bulk";
  const head = document.createElement("div");
  head.className = "bulk-head";
  const h = document.createElement("h2");
  h.textContent = `${list.length} selected`;
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "clear";
  clear.textContent = "Clear";
  clear.setAttribute("aria-keyshortcuts", "Escape");
  clear.addEventListener("click", () => clearPicked());
  head.append(h, clear);
  const hint = document.createElement("p");
  hint.className = "bulk-note";
  const skipped = list.length - changeable.length;
  hint.textContent = [
    skipped ? `${skipped} can't be changed from here (private, or not on your phone yet).` : "",
    changeable.length > BULK_MAX ? `Changes go ${BULK_MAX} at a time.` : "",
  ].filter(Boolean).join(" ") || "Changes are made on your phone.";
  d.append(head, hint);

  d.append(itemsToolbar(bulkItems(list, changeable)));

  const form = document.createElement("form");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "editor-input";
  input.placeholder = "Add to a collection";
  input.setAttribute("aria-label", "Add to a collection");
  const names = new Set();
  for (const other of opened.manifest.captures) for (const m of other.collections) names.add(m.name);
  const datalist = document.createElement("datalist");
  datalist.id = "bulk-collection-names";
  for (const name of [...names].sort()) datalist.append(option(name, name));
  input.setAttribute("list", datalist.id);
  const save = makeTool("Add", "folderPlus", () => {});
  save.type = "submit";
  save.disabled = !changeable.length;
  form.append(datalist, input, save);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (name) bulkCollection(name);
  });
  d.append(form);

  el.detail.replaceChildren(d);
  el.detail.scrollTop = 0;
  setTabTitle(null);
}

/** Sends the same kind of change to several captures, a few at a time. */
async function bulkSend(list, opsFor, message, { undo = false } = {}) {
  const work = list.filter(editable).map((c) => [c, opsFor(c)]).filter(([, ops]) => ops?.length).slice(0, BULK_MAX);
  if (!work.length) {
    toast("Nothing to change.");
    return;
  }
  for (const [c, ops] of work) {
    await sendChange(c, ops, { quiet: true });
    // The relay takes a limited number of requests a minute per pairing.
    if (work.length > 1) await new Promise((r) => setTimeout(r, 250));
  }
  redraw();
  updateSync();
  if (undo) {
    toast(message(work.length));
    return;
  }
  const backs = new Map(work.map(([c, ops]) => [c, inverseOps(ops)]));
  toast(message(work.length), {
    label: "Undo",
    run: () => bulkSend([...backs.keys()], (c) => backs.get(c), (n) => (n === 1 ? "Undone" : `Undid ${n}`), { undo: true }),
  });
}

function bulkToggle(field) {
  const list = targets().filter(editable);
  const value = !list.every((c) => c[field === "pin" ? "pinned" : "archived"]);
  const key = field === "pin" ? "pinned" : "archived";
  const verb = field === "pin" ? (value ? "Pinning" : "Unpinning") : (value ? "Archiving" : "Unarchiving");
  bulkSend(list, (c) => (c[key] === value ? null : [{ op: field, value }]), (n) => `${verb} ${n} on your phone`);
}

function bulkTrash() {
  trashWithUndo(targets());
}

function bulkCollection(name) {
  const key = name.toLowerCase();
  bulkSend(targets(), (c) => (c.collections.some((m) => m.name.toLowerCase() === key) ? null : [{ op: "collection", name, add: true }]),
    (n) => `Adding ${n} to ${name} on your phone`);
}

function select(c, { scroll = true } = {}) {
  state.selectedId = c.id;
  markSelected();
  renderDetail(c);
  if (scroll) el.list.querySelector(`[data-id="${CSS.escape(c.id)}"]`)?.scrollIntoView({ block: "nearest" });
}

function focusRow(index) {
  const nodes = [...el.list.querySelectorAll("[data-id]")];
  const node = nodes[Math.max(0, Math.min(index, nodes.length - 1))];
  if (!node) return;
  node.focus();
  const c = byId.get(node.dataset.id);
  if (c) select(c);
}

// Up and down move through the list, / goes to the search box, and single
// letters act on the open capture, or on everything picked. ? lists them.
document.addEventListener("keydown", (event) => {
  if (!opened || event.defaultPrevented || event.altKey) return;
  // Anywhere text is being written, including a note box and the New
  // capture dialog, keys are letters, not shortcuts.
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement || target?.isContentEditable || el.compose.open || el.keys.open || el.lightbox.open;
  if (event.ctrlKey || event.metaKey) {
    if ((event.key === "a" || event.key === "A") && !typing && shown.length) {
      event.preventDefault();
      picked.clear();
      for (const c of shown) picked.add(c.id);
      if (picked.size < 2) picked.clear();
      showPicked();
    }
    return;
  }
  if (!typing && shortcut(event)) {
    event.preventDefault();
    return;
  }
  if ((event.key === "n" || event.key === "N") && !typing) {
    event.preventDefault();
    openCompose();
    return;
  }
  if (event.key === "/" && !typing) {
    event.preventDefault();
    el.search.focus();
    el.search.select();
    return;
  }
  if (typing) return;
  const keys = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };
  const step = keys[event.key];
  if (!step) return;
  const nodes = [...el.list.querySelectorAll("[data-id]")];
  const at = nodes.findIndex((n) => n.dataset.id === state.selectedId);
  if (step > 0 && at === nodes.length - 1 && !el.more.hidden) renderMore();
  event.preventDefault();
  focusRow(at + step);
});

/** Single-letter actions. Returns true when the key was one of them. */
function shortcut(event) {
  const key = event.key;
  if (key === "?") {
    openKeys();
    return true;
  }
  if (key === "[") {
    toggleNav();
    return true;
  }
  if (key === "Escape") return clearPicked();
  const list = targets();
  if (!list.length) return false;
  // Several picked act together; renaming and notes are for the open one.
  const one = list.length === 1 ? list[0] : null;
  const open = byId.get(state.selectedId);
  const canChange = (c) => {
    if (editable(c)) return true;
    toast(c.private ? "Private captures can't be changed from here." : "That one isn't on your phone yet.");
    return false;
  };
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case "x":
      if (open) togglePick(open);
      return !!open;
    case "e":
      if (open && picked.size < 2 && canChange(open)) openEditor(open, "note");
      return !!open;
    case "r":
      if (open && picked.size < 2 && canChange(open)) openEditor(open, "title");
      return !!open;
    case "l":
      if (one && picked.size < 2) {
        if (canChange(one)) openEditor(one, "collection");
      } else {
        el.detail.querySelector(".bulk input")?.focus();
      }
      return true;
    case "p":
      if (one) {
        if (canChange(one)) sendChange(one, [{ op: "pin", value: !one.pinned }]);
      } else bulkToggle("pin");
      return true;
    case "a":
      if (one) {
        if (canChange(one)) sendChange(one, [{ op: "archive", value: !one.archived }]);
      } else bulkToggle("archive");
      return true;
    case "Delete":
    case "Backspace":
      if (!one || canChange(one)) bulkTrash();
      return true;
    case "c": {
      const body = open ? bodyText(open) : null;
      if (body) copyNow(body, "Copied the text");
      return !!open;
    }
    case "m":
      copyNow(list.map(markdownOf).join("\n\n---\n\n"), list.length > 1 ? `Copied ${list.length} as Markdown` : "Copied as Markdown");
      return true;
    case "o":
      if (open?.sourceUrl) window.open(open.sourceUrl, "_blank", "noopener");
      return !!open?.sourceUrl;
    case " ": {
      const button = el.detail.querySelector(".player-play");
      button?.click();
      return !!button;
    }
    case "v": {
      const f = open?.files.find(isImage);
      if (f) openLightbox(open, f);
      return !!f;
    }
    default:
      return false;
  }
}

async function copyNow(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch (e) {
    toast("Could not copy.");
  }
}

/** Which release this is, from the page's own address; releases.json has its hash. */
const RELEASE = new URL(import.meta.url).searchParams.get("v");

function openKeys() {
  const release = document.getElementById("release");
  if (release && RELEASE) release.textContent = `Release ${RELEASE} · verify`;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  for (const k of el.keys.querySelectorAll("kbd.mod")) k.textContent = mac ? "⌘" : "Ctrl";
  for (const k of el.keys.querySelectorAll("kbd.del")) k.textContent = mac ? "⌫" : "Delete";
  el.keys.showModal();
}

// --- sync status -----------------------------------------------------------
//
// The paired phone and a dot in the header: up to date, changes queued,
// waiting on a phone that has not looked in a while, or offline.

let lastPhoneAt = 0;

function updateSync() {
  if (!opened?.relayToken) {
    el.sync.hidden = true;
    return;
  }
  el.sync.hidden = false;
  const now = Date.now();
  const edits = [...pendingEdits.values()];
  const sending = sentItems.filter((i) => i.relayId && !i.delivered);
  const waiting = edits.length + sending.length;
  const oldest = Math.min(...edits.map((e) => e.at), ...sending.map((i) => i.createdAt ?? now), now);
  const changes = waiting === 1 ? "1 change" : `${waiting} changes`;
  // Short words for the pill; the whole sentence for its menu.
  let state, short, full, detail;
  if (!navigator.onLine) {
    [state, short, full, detail] = ["off", "Offline", waiting ? `Offline, ${changes} queued` : "Offline",
      "Changes wait here and go when you're back online."];
  } else if (waiting && now - oldest > 3 * 60_000) {
    [state, short, full, detail] = ["stuck", "Waiting", `${changes} waiting for your phone`,
      "Open Captry on your phone, with Captry on your computer turned on in Settings > Network."];
  } else if (waiting) {
    [state, short, full, detail] = ["saving", `${waiting} queued`, `${changes} queued`,
      "Your phone applies them the next time it checks in."];
  } else if (liveUp) {
    [state, short, full] = ["ok", "Synced", "Up to date"];
    detail = lastPhoneAt ? `Last change ${ago(lastPhoneAt, now)}` : "Connected to your phone";
  } else {
    [state, short, full, detail] = ["off", "Connecting", "Connecting…", "Reaching Captry's relay."];
  }
  el.sync.dataset.state = state;
  el.syncText.textContent = short;
  el.syncFull.textContent = full;
  el.syncDetail.textContent = detail;
  el.device.title = `${opened.place?.name ?? "Your phone"}: ${full}`;
  el.device.setAttribute("aria-label", `${opened.place?.name ?? "Your phone"}. ${full}. ${detail}`);
}

// The pill's menu opens under it, flush with its right edge.
el.deviceMenu.addEventListener("beforetoggle", (e) => {
  const open = e.newState === "open";
  el.device.setAttribute("aria-expanded", String(open));
  if (!open) return;
  updateSync();
  const r = el.device.getBoundingClientRect();
  el.deviceMenu.style.top = `${r.bottom + 8}px`;
  el.deviceMenu.style.right = `${Math.max(8, innerWidth - r.right)}px`;
});

function ago(at, now = Date.now()) {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

addEventListener("online", updateSync);
addEventListener("offline", updateSync);
setInterval(updateSync, 30_000);

// --- dragging onto the sidebar ------------------------------------------------
//
// A capture, or everything picked, dragged onto a collection files it there;
// onto Pinned pins it, onto Archive archives it, onto Captures unarchives it.

const DRAG_TYPE = "application/x-captry-captures";

function draggableCapture(node, c) {
  node.draggable = true;
  node.addEventListener("dragstart", (event) => {
    const ids = picked.size > 1 && picked.has(c.id) ? pickedCaptures().map((x) => x.id) : [c.id];
    event.dataTransfer.clearData();
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = "copyMove";
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = ids.length === 1 ? titleOf(c) : `${ids.length} captures`;
    document.body.append(ghost);
    event.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => ghost.remove());
  });
}

function dropTarget(node, view) {
  const act = dropAction(view);
  if (!act) return;
  const ours = (event) => [...(event.dataTransfer?.types ?? [])].includes(DRAG_TYPE);
  node.addEventListener("dragover", (event) => {
    if (!ours(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    node.classList.add("drop-target");
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-target"));
  node.addEventListener("drop", (event) => {
    node.classList.remove("drop-target");
    if (!ours(event)) return;
    event.preventDefault();
    event.stopPropagation();
    let ids = [];
    try {
      ids = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
    } catch (e) {
      return;
    }
    const list = ids.map((id) => byId.get(id)).filter(Boolean);
    if (list.length) bulkSend(list, act.ops, act.message);
  });
}

/** What dropping on a place does, or null where nothing should. */
function dropAction(view) {
  if (view.kind === "collection") {
    const key = view.name.toLowerCase();
    return {
      ops: (c) => (c.collections.some((m) => m.name.toLowerCase() === key) ? null : [{ op: "collection", name: view.name, add: true }]),
      message: (n) => `Added ${n === 1 ? "it" : n} to ${view.name}`,
    };
  }
  if (view.kind === "pinned") return { ops: (c) => (c.pinned ? null : [{ op: "pin", value: true }]), message: (n) => `Pinned ${n === 1 ? "it" : n}` };
  if (view.kind === "archive") return { ops: (c) => (c.archived ? null : [{ op: "archive", value: true }]), message: (n) => `Archived ${n === 1 ? "it" : n}` };
  if (view.kind === "captures") return { ops: (c) => (c.archived ? [{ op: "archive", value: false }] : null), message: (n) => `Moved ${n === 1 ? "it" : n} out of Archive` };
  return null;
}

// --- download ----------------------------------------------------------------
//
// What is shown, or what is picked, as a Markdown or CSV file. Made here; it
// goes nowhere but this computer's Downloads.

el.exportMenu.addEventListener("click", (event) => {
  const format = event.target.closest("button[data-format]")?.dataset.format;
  if (!format || !opened) return;
  el.exportMenu.open = false;
  const several = picked.size > 1;
  downloadList(several ? pickedCaptures() : shown, format, several ? `${picked.size} captures` : el.viewTitle.textContent || "Captures");
});
document.addEventListener("click", (event) => {
  if (el.exportMenu.open && !el.exportMenu.contains(event.target)) el.exportMenu.open = false;
});

function downloadList(list, format, name) {
  if (!list.length) {
    toast("Nothing to download.");
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const file = `${name} ${day}`.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
  if (format === "csv") download(`${file}.csv`, "text/csv;charset=utf-8", csvOf(list));
  else download(`${file}.md`, "text/markdown;charset=utf-8", `# ${name}\n\n` + list.map(markdownOf).join("\n---\n\n"));
  toast(list.length === 1 ? "Downloaded 1 capture" : `Downloaded ${list.length} captures`);
}

function csvOf(list) {
  // A cell a spreadsheet would read as a formula starts with a quote mark instead.
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["Title", "Type", "Captured", "Collections", "Pinned", "Archived", "Source", "Note", "Text"];
  const rows = list.map((c) => [
    titleOf(c),
    typeName(c.type),
    c.capturedAt ? new Date(c.capturedAt).toISOString() : "",
    c.collections.map((m) => m.name).join("; "),
    c.pinned ? "yes" : "",
    c.archived ? "yes" : "",
    c.sourceUrl ?? "",
    c.note ?? "",
    bodyText(c),
  ]);
  return "\uFEFF" + [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --- pictures, full screen ----------------------------------------------------
//
// Every picture in what is shown, in order: arrows move through them, a click
// or + and - zoom, dragging moves a zoomed picture. A small copy is shown
// until the phone sends the full one, asked for once.

const lb = { items: [], at: 0, zoom: 0, natural: null };

function isImage(f) {
  return f.type === "IMAGE" || f.mimeType?.startsWith("image/");
}

function imageButton(img, c, f) {
  fadeIn(img);
  const b = document.createElement("button");
  b.type = "button";
  b.className = "img-button";
  hotkey(b, "View full screen", "V");
  b.append(img);
  b.addEventListener("click", () => openLightbox(c, f));
  return b;
}

function openLightbox(c, f) {
  lb.items = [];
  for (const x of shown) for (const file of x.files) if (isImage(file)) lb.items.push({ c: x, f: file });
  lb.at = lb.items.findIndex((i) => i.c.id === c.id && i.f.file === f.file);
  if (lb.at < 0) {
    lb.items.unshift({ c, f });
    lb.at = 0;
  }
  if (!el.lightbox.open) el.lightbox.showModal();
  showLightbox();
}

async function showLightbox() {
  const item = lb.items[lb.at];
  if (!item) return;
  const { c, f } = item;
  lb.zoom = 0;
  el.lbStage.classList.remove("zoomed");
  el.lbCaption.textContent = titleOf(c);
  el.lbCount.textContent = lb.items.length > 1 ? `${lb.at + 1} of ${lb.items.length}` : "";
  el.lbPrev.hidden = lb.at === 0;
  el.lbNext.hidden = lb.at >= lb.items.length - 1;
  const url = await fileUrl(f);
  if (lb.items[lb.at] !== item) return;
  const small = thumbOnly.has(f.file);
  if (!url || small) requestFull(c, f.file);
  el.lbNote.textContent = small ? "Small copy, full picture on its way" : "";
  el.lbDownload.hidden = !url;
  if (url) {
    el.lbDownload.href = url;
    el.lbDownload.download = f.file;
  }
  if (!url) {
    const wait = document.createElement("p");
    wait.className = "lb-wait";
    wait.textContent = c.sent ? "This picture has not arrived yet." : "Waiting for your phone to send this.";
    el.lbStage.replaceChildren(wait);
    return;
  }
  const img = document.createElement("img");
  img.alt = f.textInImage ? "Capture image" : "";
  img.draggable = false;
  img.src = url;
  img.addEventListener("click", (event) => {
    if (lb.dragged) return;
    zoomTo(lb.zoom ? 0 : Math.max(1, fitScale(img) * 2), event);
  });
  el.lbStage.replaceChildren(img);
}

/** The scale the picture is shown at when fitted to the screen. */
function fitScale(img) {
  const stage = el.lbStage.getBoundingClientRect();
  if (!stage.width || !stage.height) return 1;
  return Math.min(1, stage.width / (img.naturalWidth || 1), stage.height / (img.naturalHeight || 1));
}

/** 0 fits the screen; anything else is a scale of the picture's own size. */
function zoomTo(scale, event) {
  const img = el.lbStage.querySelector("img");
  if (!img || !img.naturalWidth) return;
  const stage = el.lbStage;
  const box = img.getBoundingClientRect();
  // Keep the point under the pointer (or the middle) where it is.
  const px = event?.clientX ?? box.left + box.width / 2;
  const py = event?.clientY ?? box.top + box.height / 2;
  const rx = (px - box.left) / box.width;
  const ry = (py - box.top) / box.height;
  lb.zoom = scale <= fitScale(img) ? 0 : Math.min(scale, 8);
  stage.classList.toggle("zoomed", !!lb.zoom);
  img.style.width = lb.zoom ? `${img.naturalWidth * lb.zoom}px` : "";
  if (lb.zoom) {
    const s = stage.getBoundingClientRect();
    stage.scrollLeft = rx * img.naturalWidth * lb.zoom - (px - s.left);
    stage.scrollTop = ry * img.naturalHeight * lb.zoom - (py - s.top);
  }
}

function stepZoom(factor) {
  const img = el.lbStage.querySelector("img");
  if (!img) return;
  zoomTo((lb.zoom || fitScale(img)) * factor);
}

function moveLightbox(step) {
  const next = lb.at + step;
  if (next < 0 || next >= lb.items.length) return;
  lb.at = next;
  showLightbox();
}

/** A full picture arrived from the phone: show it if it is the one open. */
function lightboxArrived(name) {
  if (el.lightbox.open && lb.items[lb.at]?.f.file === name) showLightbox();
}

el.lbClose.addEventListener("click", () => el.lightbox.close());
el.lbPrev.addEventListener("click", () => moveLightbox(-1));
el.lbNext.addEventListener("click", () => moveLightbox(1));
el.lightbox.addEventListener("close", () => {
  el.lbStage.replaceChildren();
  // Back to the list on the capture last looked at.
  const c = lb.items[lb.at]?.c;
  if (c && byId.has(c.id) && c.id !== state.selectedId && picked.size < 2) select(c);
});
el.lightbox.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") moveLightbox(-1);
  else if (event.key === "ArrowRight") moveLightbox(1);
  else if (event.key === "+" || event.key === "=") stepZoom(1.5);
  else if (event.key === "-" || event.key === "_") stepZoom(1 / 1.5);
  else if (event.key === "0") zoomTo(0);
  else return;
  event.preventDefault();
});
// Dragging a zoomed picture moves it.
el.lbStage.addEventListener("pointerdown", (event) => {
  if (!lb.zoom || event.button !== 0) return;
  const stage = el.lbStage;
  const start = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
  lb.dragged = false;
  stage.classList.add("panning");
  stage.setPointerCapture(event.pointerId);
  const move = (e) => {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) lb.dragged = true;
    stage.scrollLeft = start.left - dx;
    stage.scrollTop = start.top - dy;
  };
  const up = () => {
    stage.classList.remove("panning");
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerup", up);
    stage.removeEventListener("pointercancel", up);
    // A drag is not a click on the picture.
    setTimeout(() => (lb.dragged = false));
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
});

// --- a capture's kind, voice notes, empty and loading ----------------------------

/** Pinned, waiting on the phone or on it: small icons, the word on hover. */
function rowFlags(c) {
  const flags = document.createElement("span");
  flags.className = "row-flags";
  const flag = (iconName, label, cls) => {
    const f = document.createElement("span");
    if (cls) f.className = cls;
    f.title = label;
    f.setAttribute("aria-label", label);
    f.setAttribute("role", "img");
    f.append(icon(iconName));
    flags.append(f);
  };
  if (c.pendingEdit) flag("clock", "Queued for your phone");
  if (c.sent) flag(c.delivered ? "done" : "send", c.delivered ? "On your phone" : "Waiting for your phone");
  if (c.pinned && state.view.kind !== "pinned") flag("pin", "Pinned", "pinned");
  return flags;
}

/** The little tile at the start of a row: a site's letter, or the kind's icon. */
function kindTile(c) {
  const tile = document.createElement("span");
  tile.className = "row-kind";
  tile.setAttribute("aria-hidden", "true");
  const audio = c.files.some((f) => f.type === "AUDIO" || f.mimeType?.startsWith("audio/"));
  const host = (c.sourceHost ?? "").replace(/^www\./, "");
  if (audio) tile.append(icon("mic"));
  else if (c.sourceUrl && host) tile.textContent = host.charAt(0).toUpperCase();
  else if (c.private) tile.append(icon("lock"));
  else if (c.files.some(isImage)) tile.append(icon("image"));
  else tile.append(icon(TYPE_ICONS[c.type] ?? "lines"));
  return tile;
}

/** Play, a position bar and the time, in the page's colours. */
const SPEEDS = [1, 1.5, 2];
const BARS = 72;
/** A voice note's loudness in BARS steps, 0 to 1, once worked out. */
const waves = new Map();

async function wavePeaks(f, url) {
  if (waves.has(f.file)) return waves.get(f.file);
  const blob = urlBlobs.get(url);
  if (!blob || typeof OfflineAudioContext === "undefined") return null;
  try {
    const sound = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(await blob.arrayBuffer());
    const data = sound.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / BARS));
    const levels = [];
    for (let i = 0; i < BARS; i++) {
      let sum = 0;
      const end = Math.min(data.length, (i + 1) * step);
      for (let j = i * step; j < end; j++) sum += data[j] * data[j];
      levels.push(Math.sqrt(sum / step));
    }
    const top = Math.max(...levels) || 1;
    const peaks = levels.map((v) => Math.max(0.1, Math.pow(v / top, 0.8)));
    waves.set(f.file, peaks);
    return peaks;
  } catch (e) {
    return null;
  }
}

function voicePlayer(url, f) {
  const wrap = document.createElement("div");
  wrap.className = "player";
  const audio = new Audio();
  audio.preload = "metadata";
  audio.src = url;
  const wave = document.createElement("div");
  wave.className = "player-wave";
  const base = document.createElement("div");
  base.className = "wave-bars";
  const lit = document.createElement("div");
  lit.className = "wave-bars lit";
  const draw = (peaks) => {
    for (const layer of [base, lit]) {
      layer.replaceChildren(...peaks.map((p) => {
        const s = document.createElement("span");
        s.style.height = `${Math.round(p * 100)}%`;
        return s;
      }));
    }
  };
  draw(Array(BARS).fill(0.14));
  wavePeaks(f, url).then((peaks) => peaks && draw(peaks));
  const speed = document.createElement("button");
  speed.type = "button";
  speed.className = "player-speed";
  const setRate = (r) => {
    audio.defaultPlaybackRate = r;
    audio.playbackRate = r;
    speed.textContent = `${r}×`;
    speed.classList.toggle("fast", r !== 1);
    speed.setAttribute("aria-label", `Speed ${r} times`);
    speed.title = "Speed";
  };
  setRate(SPEEDS.includes(Number(remembered("voiceSpeed", "1"))) ? Number(remembered("voiceSpeed", "1")) : 1);
  speed.addEventListener("click", () => {
    const next = SPEEDS[(SPEEDS.indexOf(audio.playbackRate) + 1) % SPEEDS.length] ?? 1;
    setRate(next);
    remember("voiceSpeed", String(next));
  });
  const play = document.createElement("button");
  play.type = "button";
  play.className = "player-play";
  const bar = document.createElement("input");
  bar.type = "range";
  bar.className = "player-bar";
  bar.min = "0";
  bar.max = "1000";
  bar.value = "0";
  bar.setAttribute("aria-label", "Position");
  const time = document.createElement("span");
  time.className = "player-time";
  const PLAY = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
  const PAUSE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>';
  const length = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (f.durationMs ?? 0) / 1000);
  const show = () => {
    const total = length();
    const at = audio.currentTime || 0;
    const p = total ? Math.min(1, at / total) : 0;
    bar.value = String(Math.round(p * 1000));
    wave.style.setProperty("--p", `${p * 100}%`);
    time.textContent = `${formatDuration(at * 1000) || "0:00"} / ${formatDuration(total * 1000) || "0:00"}`;
    play.innerHTML = audio.paused ? PLAY : PAUSE;
    play.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  };
  play.addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
  bar.addEventListener("input", () => {
    const total = length();
    if (total) audio.currentTime = (Number(bar.value) / 1000) * total;
    show();
  });
  for (const e of ["timeupdate", "play", "pause", "loadedmetadata", "durationchange"]) audio.addEventListener(e, show);
  audio.addEventListener("ended", () => {
    audio.currentTime = 0;
    show();
  });
  // Gone from the page, it stops; and one voice note plays at a time.
  audio.addEventListener("timeupdate", () => {
    if (!wrap.isConnected) audio.pause();
  });
  audio.addEventListener("play", () => {
    if (playing && playing !== audio) playing.pause();
    playing = audio;
  });
  wave.append(base, lit, bar);
  wrap.append(play, wave, time, speed);
  show();
  return wrap;
}

/** A quiet icon, a line saying what this is, a hint, and maybe one way out. */
function emptyState(iconName, title, hint, action) {
  const box = document.createElement("div");
  box.className = "empty";
  const i = document.createElement("span");
  i.className = "empty-icon";
  i.append(icon(iconName, 24));
  const t = document.createElement("div");
  t.className = "empty-title";
  t.textContent = title;
  box.append(i, t);
  if (hint) {
    const p = document.createElement("div");
    p.className = "empty-hint";
    p.textContent = hint;
    box.append(p);
  }
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "button small";
    b.textContent = action.label;
    b.addEventListener("click", action.run);
    box.append(b);
  }
  return box;
}

function emptyList(narrowed) {
  if (narrowed) {
    return emptyState("search", "Nothing matches", "Try fewer words, or clear the filters.", { label: "Clear filters", run: () => el.clear.click() });
  }
  const v = state.view;
  if (v.kind === "pinned") return emptyState("pin", "Nothing pinned", "Pin a capture to keep it here.");
  if (v.kind === "archive") return emptyState("archive", "Nothing archived", "Archived captures rest here.");
  if (v.kind === "collection") return emptyState("folderPlus", `Nothing in ${v.name}`, "Drag captures here, or press L on one.");
  if (v.kind === "smart") return emptyState("sparkle", "Nothing matches yet", "Captures that fit this smart collection show up here.");
  if (v.kind === "private") return emptyState("lock", "Nothing private", "");
  return emptyState("inbox", "Nothing here yet", "New captures from your phone show up here.");
}

/** Grey shapes where the library will be, while it opens. */
function showSkeleton() {
  el.opener.hidden = true;
  el.app.hidden = false;
  const bar = (w, extra = "") => Object.assign(document.createElement("div"), { className: `skeleton ${extra}`.trim(), style: `width:${w}` });
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const r = document.createElement("div");
    r.className = "skeleton-row";
    const lines = document.createElement("div");
    lines.className = "s-lines";
    lines.append(bar(`${55 + ((i * 17) % 35)}%`, "s-line"), bar(`${30 + ((i * 11) % 25)}%`, "s-line"));
    r.append(bar("32px", "s-kind"), lines);
    rows.push(r);
  }
  el.list.replaceChildren(...rows);
  el.nav.replaceChildren(...[70, 55, 60, 45, 65, 50].map((w) => {
    const r = bar(`${w}%`, "s-line");
    r.style.margin = "12px 12px";
    r.style.height = "12px";
    return r;
  }));
  el.detail.replaceChildren(bar("60%", "s-line"), bar("35%", "s-line"));
  for (const n of el.detail.children) {
    n.style.height = n === el.detail.firstChild ? "26px" : "14px";
    n.style.marginBottom = "12px";
  }
}

function hideSkeleton() {
  el.list.replaceChildren();
  el.nav.replaceChildren();
  el.detail.replaceChildren();
  el.app.hidden = true;
  el.opener.hidden = false;
}

// --- the layout: pane widths and the sidebar --------------------------------------
//
// Drag a divider to resize, double-click it to reset, or use the arrow keys on
// it. [ or the sidebar button hides the sidebar. Kept in this browser only.

const LAYOUT_DEFAULT = { nav: 232, list: 360, navHidden: false };
const layout = { ...LAYOUT_DEFAULT };
try {
  Object.assign(layout, JSON.parse(localStorage.getItem("captry.layout") ?? "{}"));
} catch (e) {
  // No storage here: the defaults it is.
}

function saveLayout() {
  try {
    localStorage.setItem("captry.layout", JSON.stringify(layout));
  } catch (e) {
    // Fine: it just will not be remembered.
  }
}

function applyLayout() {
  layout.nav = Math.min(380, Math.max(180, layout.nav));
  layout.list = Math.min(680, Math.max(280, layout.list));
  el.app.style.setProperty("--nav-w", `${layout.nav}px`);
  el.app.style.setProperty("--list-w", `${layout.list}px`);
  el.app.classList.toggle("nav-hidden", !!layout.navHidden);
  el.navToggle.setAttribute("aria-label", layout.navHidden ? "Show the sidebar" : "Hide the sidebar");
  el.navToggle.setAttribute("aria-pressed", String(!layout.navHidden));
}

function toggleNav() {
  layout.navHidden = !layout.navHidden;
  applyLayout();
  saveLayout();
}

function splitter(node, key) {
  node.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = { x: event.clientX, width: layout[key] };
    node.setPointerCapture(event.pointerId);
    node.classList.add("dragging");
    document.body.classList.add("resizing");
    const move = (e) => {
      layout[key] = start.width + (e.clientX - start.x);
      applyLayout();
    };
    const up = () => {
      node.classList.remove("dragging");
      document.body.classList.remove("resizing");
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      saveLayout();
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  });
  node.addEventListener("dblclick", () => {
    layout[key] = LAYOUT_DEFAULT[key];
    applyLayout();
    saveLayout();
  });
  node.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    if (!step) return;
    event.preventDefault();
    layout[key] += step;
    applyLayout();
    saveLayout();
  });
}

splitter(el.splitNav, "nav");
splitter(el.splitList, "list");
el.navToggle.addEventListener("click", toggleNav);
applyLayout();

// --- key hints ------------------------------------------------------------------
//
// Hovering, or tabbing to, a button that has a shortcut shows its name and the
// key, drawn as a key cap. One tooltip for the page, moved to whichever button.

const DELETE_KEY = MAC ? "⌫" : "Del";
const tip = { node: $("tip"), label: $("tip-label"), key: $("tip-key"), timer: 0, target: null };

/** Marks [node] as having the shortcut [key]. Returns it, to chain. */
function hotkey(node, label, key) {
  node.dataset.tip = label;
  node.dataset.key = key;
  node.removeAttribute("title");
  const aria = { "⌫": "Backspace", Del: "Delete", Esc: "Escape", "←": "ArrowLeft", "→": "ArrowRight" }[key] ?? key;
  node.setAttribute("aria-keyshortcuts", aria);
  return node;
}

function showTip(target) {
  tip.target = target;
  // The button already says what it does; only a picture or an icon needs it said.
  tip.label.textContent = target.textContent.trim() ? "Shortcut" : target.dataset.tip;
  tip.key.textContent = target.dataset.key;
  tip.node.classList.remove("shown");
  if (!tip.node.matches(":popover-open")) tip.node.showPopover();
  // Above the button, or below it when there is no room; never off screen.
  const r = target.getBoundingClientRect();
  const t = tip.node.getBoundingClientRect();
  const above = r.top - t.height - 8;
  const top = above >= 8 ? above : r.bottom + 8;
  const left = Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2));
  tip.node.style.top = `${top}px`;
  tip.node.style.left = `${left}px`;
  requestAnimationFrame(() => tip.node.classList.add("shown"));
}

function hideTip() {
  clearTimeout(tip.timer);
  tip.target = null;
  if (tip.node.matches(":popover-open")) tip.node.hidePopover();
  tip.node.classList.remove("shown");
}

document.addEventListener("pointerover", (event) => {
  if (event.pointerType === "touch") return;
  const target = event.target.closest?.("[data-key]");
  if (target === tip.target) return;
  hideTip();
  if (!target) return;
  tip.target = target;
  tip.timer = setTimeout(() => tip.target === target && target.isConnected && showTip(target), 450);
});
document.addEventListener("focusin", (event) => {
  const target = event.target.closest?.("[data-key]");
  if (target && target.matches(":focus-visible")) showTip(target);
});
document.addEventListener("focusout", hideTip);
document.addEventListener("pointerdown", hideTip, true);
document.addEventListener("keydown", hideTip, true);
addEventListener("scroll", hideTip, true);
addEventListener("blur", hideTip);

// --- thumbnails ------------------------------------------------------------

/**
 * Images are inflated only once they scroll into view. A year of captures is
 * a lot of photos, and nobody looking for one note needs them all decoded.
 */
const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbObserver.unobserve(entry.target);
      const img = entry.target;
      fileUrl({ file: img.dataset.file, mimeType: img.dataset.mime }).then((url) => {
        if (url) img.src = url;
        else img.classList.add("missing");
      });
    }
  },
  { root: null, rootMargin: "300px" },
);

/** Fades [img] in once it has loaded, rather than popping in. */
function fadeIn(img) {
  img.classList.add("fade");
  if (img.complete && img.naturalWidth) img.classList.add("loaded");
  else img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
  img.addEventListener("error", () => img.classList.add("missing"), { once: true });
  return img;
}

function thumb(file, className) {
  const img = document.createElement("img");
  img.className = className;
  img.draggable = false;
  fadeIn(img);
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.dataset.file = file.file;
  if (file.mimeType) img.dataset.mime = file.mimeType;
  thumbObserver.observe(img);
  return img;
}

/** An object url for a picture, from what the phone sent or the cache. */
async function fileUrl(f) {
  if (fileUrls.has(f.file)) return fileUrls.get(f.file);
  if (feedFiles.has(f.file)) {
    const blob = feedFiles.get(f.file);
    const url = URL.createObjectURL(blob);
    fileUrls.set(f.file, url);
    urlBlobs.set(url, blob);
    return url;
  }
  if (f.blob) {
    const url = URL.createObjectURL(f.blob);
    fileUrls.set(f.file, url);
    urlBlobs.set(url, f.blob);
    return url;
  }
  const target = opened;
  if (!target) return null;
  const bytes = target.key ? await openCache(target.key, await store.loadImage(f.file)) : null;
  if (!bytes || opened !== target) return null;
  const blob = new Blob([bytes], { type: safeMime(f.mimeType) });
  const url = URL.createObjectURL(blob);
  fileUrls.set(f.file, url);
  urlBlobs.set(url, blob);
  return url;
}

// --- the detail ------------------------------------------------------------

function renderDetail(c) {
  if (picked.size > 1) {
    renderBulk();
    return;
  }
  const d = document.createDocumentFragment();

  const words = searchWords(state.query);
  const h = document.createElement("h2");
  h.append(marked(titleOf(c), words));
  if (editable(c)) {
    h.classList.add("editable");
    h.title = "Click to rename";
    h.addEventListener("click", () => inlineEdit(c, "title"));
  }
  d.append(h);

  // The facts under the title are ways into the rest of the library: the type
  // opens its shelf, the source opens everything from the same place.
  const meta = document.createElement("div");
  meta.className = "meta-row";
  const date = document.createElement("span");
  date.className = "meta-date";
  date.textContent = when(c.capturedAt);
  meta.append(date);
  const chip = (label, iconName, view, extra) => {
    const node = view ? viewLink(label, view) : document.createElement("span");
    node.className = "meta-chip" + (extra ? ` ${extra}` : "");
    node.textContent = "";
    node.append(icon(iconName), document.createTextNode(label));
    meta.append(node);
  };
  if (c.type && c.type !== "UNCLASSIFIED" && !c.private && !c.archived && !c.sent) {
    chip(typeName(c.type), TYPE_ICONS[c.type] ?? "tag", { kind: "type", type: c.type });
  }
  const source = c.sourceApp || c.sourceHost;
  if (source && !c.private && !c.sent) chip(sourceLabel(source), c.sourceUrl ? "link" : "inbox", { kind: "source", source });
  if (c.pinned) chip("Pinned", "pin", null, "accent");
  if (c.archived) chip("Archived", "archive");
  if (c.private) chip("Private", "lock");
  d.append(meta);
  d.append(editBar(c));
  if (c.sent) {
    const waiting = document.createElement("p");
    waiting.className = "waiting";
    const minutes = (Date.now() - (c.createdAt ?? Date.now())) / 60_000;
    waiting.textContent = c.delivered
      ? "Your phone has it. "
      : c.via === "relay" && minutes > 3
        ? "Not collected yet. On the phone, turn on Captry on your computer in Captry > Settings > Network, then open Captry. "
        : c.via === "relay"
          ? "Sent. It arrives when Captry opens on your phone. "
          : "Sent from this computer. ";
    const letGo = document.createElement("button");
    letGo.type = "button";
    letGo.className = "link-button";
    letGo.textContent = "Stop showing this";
    letGo.title = "Hides it on this computer. It does not take it back from the phone.";
    letGo.addEventListener("click", async () => {
      const id = c.id.replace(/^sent:/, "");
      sentItems = sentItems.filter((i) => i.id !== id);
      await store.removeSent([id]);
      mergeSent();
      renderNav();
      refresh();
    });
    waiting.append(letGo);
    d.append(waiting);
  }

  if (c.collections.length && !c.private) {
    const chips = document.createElement("div");
    chips.className = "cchips";
    for (const m of c.collections) {
      const chip = document.createElement("span");
      chip.className = "cchip" + (m.checked ? " done" : "") + (editable(c) ? "" : " plain");
      if (editable(c) && isChecklist(m.name)) chip.append(tickButton(c, m.name, "cchip-tick"));
      else chip.append(collectionDot(m.name));
      const name = viewLink(m.name, { kind: "collection", name: m.name });
      name.className = "cchip-name";
      if (m.checked) name.title = "Ticked off in this list";
      chip.append(name);
      if (editable(c)) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "cchip-x";
        remove.append(icon("x", 13));
        remove.setAttribute("aria-label", `Remove from ${m.name}`);
        remove.title = `Remove from ${m.name}`;
        remove.addEventListener("click", () => sendChange(c, [{ op: "collection", name: m.name, add: false }]));
        chip.append(remove);
      }
      chips.append(chip);
    }
    d.append(chips);
  }

  if (c.note) {
    const s = section("Your note", c.note);
    s.classList.add("note-section");
    if (editable(c)) {
      s.lastChild.classList.add("editable");
      s.lastChild.title = "Click to edit";
      s.lastChild.addEventListener("click", () => inlineEdit(c, "note"));
    }
    d.append(s);
  }
  if (c.summary) d.append(section("Summary", c.summary));
  if (c.text) d.append(section("Text", c.text));
  if (c.sourceUrl) {
    const s = section("Source", "");
    const card = document.createElement("a");
    card.className = "link-card";
    card.href = c.sourceUrl;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    const tile = kindTile({ ...c, files: [] });
    const text = document.createElement("span");
    text.className = "link-text";
    const t = document.createElement("span");
    t.className = "link-title";
    t.append(marked(c.title || (c.sourceHost ?? "").replace(/^www\./, "") || c.sourceUrl, words));
    const u = document.createElement("span");
    u.className = "link-url";
    u.append(marked(c.sourceUrl.replace(/^https?:\/\//, ""), words));
    text.append(t, u);
    card.append(tile, text, icon("external", 18));
    s.lastChild.replaceChildren(card);
    d.append(s);
  }

  if (c.highlights.length) {
    const s = section("Highlights", "");
    s.lastChild.replaceChildren();
    for (const hl of c.highlights) {
      const q = document.createElement("blockquote");
      q.append(marked(hl.quote, words));
      if (hl.note) {
        const p = document.createElement("p");
        p.append(marked(hl.note, words));
        q.append(p);
      }
      s.lastChild.append(q);
    }
    d.append(s);
  }

  const linked = c.links.map((id) => byId.get(id)).filter((o) => o && (!o.private || c.private));
  if (linked.length) {
    const s = section("Linked captures", "");
    const list = document.createElement("div");
    list.className = "linked";
    for (const other of linked) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "linked-row";
      const picture = other.files.find(isImage);
      const words = document.createElement("span");
      words.className = "linked-text";
      const t = document.createElement("span");
      t.className = "linked-title";
      t.textContent = titleOf(other);
      const m = document.createElement("span");
      m.className = "linked-meta";
      m.textContent = [shortWhen(other.capturedAt), typeName(other.type)].filter(Boolean).join(" · ");
      words.append(t, m);
      b.append(picture ? thumb(picture, "row-thumb") : kindTile(other), words);
      b.addEventListener("click", () => openCapture(other));
      list.append(b);
    }
    s.lastChild.replaceChildren(list);
    d.append(s);
  }

  if (c.entities.length) {
    const s = section("Found in it", "");
    const list = document.createElement("div");
    list.className = "entities";
    for (const e of c.entities) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "entity";
      b.title = "Copy";
      const type = document.createElement("span");
      type.className = "entity-type";
      type.textContent = entityLabel(e.type);
      const value = document.createElement("span");
      value.className = "entity-value";
      value.append(marked(e.value, words));
      b.append(type, value, icon("copy"));
      b.addEventListener("click", () => copyNow(e.value, `Copied ${entityLabel(e.type).toLowerCase()}`));
      list.append(b);
    }
    s.lastChild.replaceChildren(list);
    d.append(s);
  }

  for (const f of c.files) d.append(fileBlock(f, c));

  el.detail.replaceChildren(d);
  el.detail.scrollTop = 0;
  setTabTitle(c);
  // Opened from a search, the first match below the fold is brought into view.
  const match = c.id !== lastShownId && words.length ? el.detail.querySelector("mark") : null;
  if (match) {
    const below = match.getBoundingClientRect().top - el.detail.getBoundingClientRect().top;
    if (below > el.detail.clientHeight * 0.7) el.detail.scrollTop = below - el.detail.clientHeight / 3;
  }
  // Only a different capture moves; an update to the same one stays still.
  if (c.id !== lastShownId) {
    el.detail.classList.remove("settle");
    void el.detail.offsetWidth;
    el.detail.classList.add("settle");
    lastShownId = c.id;
  }
}

/**
 * Shows a capture that may not be in the current list, as a linked one often
 * is not. Captures is the widest place it can be in, so that is where it opens.
 */
function openCapture(c) {
  if (!shown.includes(c)) {
    const home = c.private ? { kind: "private" } : c.archived ? { kind: "archive" } : { kind: "captures" };
    state.query = "";
    el.search.value = "";
    history.pushState(null, "", viewToHash(home));
    state.view = home;
    Object.assign(state, { filter: "ALL", range: "ANY", source: "" });
    markNav();
    refresh();
    while (!el.list.querySelector(`[data-id="${CSS.escape(c.id)}"]`) && rendered < shown.length) renderMore();
  }
  select(c);
}

function fileBlock(f, c) {
  const wrap = document.createElement("div");
  wrap.className = "file";
  const slot = document.createElement("div");
  slot.className = "file-slot";
  slot.textContent = "Loading…";
  wrap.append(slot);
  if (f.textInImage) wrap.append(section("Text in image", f.textInImage));
  if (f.transcript) wrap.append(section("Transcript", f.transcript));

  fileUrl(f)
    .then((url) => {
      if (!url) {
        // Never sent: ask the phone for it, as for a full-size picture.
        if (!c.sent) requestFull(c, f.file);
        slot.textContent = c.sent ? "This picture has not arrived yet. Open Captry on your phone." : "Waiting for your phone to send this.";
        slot.className = "file-slot muted";
        return;
      }
      if ((f.type === "IMAGE" || f.mimeType?.startsWith("image/")) && thumbOnly.has(f.file)) {
        // A thumbnail now, the full picture when the
        // phone next looks, asked for once.
        requestFull(c, f.file);
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        img.className = "thumb-only";
        const wrap = document.createElement("div");
        wrap.className = "img-wrap";
        const label = document.createElement("span");
        label.className = "img-badge";
        label.textContent = "Small copy";
        wrap.title = "The full picture comes from your phone the next time Captry opens there.";
        wrap.append(imageButton(img, c, f), label);
        slot.replaceChildren(wrap);
      } else if (f.type === "IMAGE" || f.mimeType?.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = f.textInImage ? "Capture image" : "";
        if (f.width && f.height) {
          img.width = f.width;
          img.height = f.height;
        }
        slot.replaceChildren(imageButton(img, c, f));
      } else if (f.type === "AUDIO" || f.mimeType?.startsWith("audio/")) {
        slot.replaceChildren(voicePlayer(url, f));
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.download = f.file;
        a.textContent = `Save ${f.file}`;
        slot.replaceChildren(a);
      }
    })
    .catch(() => {
      slot.textContent = "This file could not be read.";
      slot.className = "file-slot muted";
    });
  return wrap;
}

// --- small helpers -----------------------------------------------------------

function snippet(c, max = 140, words = []) {
  const fields = [c.note, c.summary, c.text, ...c.files.map((f) => f.textInImage), ...c.files.map((f) => f.transcript)]
    .filter(Boolean)
    .map((t) => t.replace(/\s+/g, " ").trim());
  // Searching: the part that has the words in it, not just the start.
  const hit = words.length ? fields.find((t) => words.some((w) => t.toLowerCase().includes(w))) : null;
  const body = hit ?? fields[0] ?? "";
  if (!body || body === titleOf(c)) return "";
  if (hit) {
    const at = Math.min(...words.map((w) => body.toLowerCase().indexOf(w)).filter((i) => i >= 0));
    if (at > max / 2) {
      const from = body.lastIndexOf(" ", at - 30) + 1 || at - 30;
      const part = body.slice(from);
      return "…" + (part.length > max - 1 ? part.slice(0, max - 4) + "…" : part);
    }
  }
  return body.length > max ? body.slice(0, max - 3) + "…" : body;
}

/** Where the open capture's words are marked, so a changed search can mark them again. */
const MARKED = "h2, .prose, blockquote, .link-title, .link-url, .entity-value";

/** Marks [words] afresh in what is already shown under [root], without building it again. */
function remark(root, words) {
  for (const m of root.querySelectorAll("mark")) m.replaceWith(m.textContent);
  for (const host of root.querySelectorAll(MARKED)) {
    host.normalize();
    if (!words.length) continue;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const frag = marked(node.data, words);
      if (frag.childNodes.length > 1) node.replaceWith(frag);
    }
  }
}

/** [text] with every search word in it marked. */
function marked(text, words) {
  const frag = document.createDocumentFragment();
  if (!words?.length || !text) {
    frag.append(text ?? "");
    return frag;
  }
  const lower = text.toLowerCase();
  const spans = [];
  for (const w of words) {
    for (let i = lower.indexOf(w); i >= 0 && w; i = lower.indexOf(w, i + w.length)) spans.push([i, i + w.length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let at = 0;
  for (const [from, to] of spans) {
    if (from < at) continue;
    frag.append(text.slice(at, from));
    const m = document.createElement("mark");
    m.textContent = text.slice(from, to);
    frag.append(m);
    at = to;
  }
  frag.append(text.slice(at));
  return frag;
}

function bodyText(c) {
  return [c.text, c.files.map((f) => f.textInImage).find(Boolean), c.files.map((f) => f.transcript).find(Boolean)]
    .filter(Boolean)
    .join("\n");
}

function markdownOf(c) {
  const lines = [`## ${titleOf(c)}`, ""];
  const facts = [when(c.capturedAt), typeName(c.type), c.collections.map((m) => m.name).join(", ")].filter(Boolean);
  if (facts.length) lines.push(`_${facts.join(" · ")}_`, "");
  if (c.sourceUrl) lines.push(`Source: <${c.sourceUrl}>`, "");
  if (c.note) lines.push(c.note, "");
  if (c.summary) lines.push(c.summary, "");
  const body = bodyText(c);
  if (body) lines.push(body, "");
  for (const h of c.highlights) lines.push(`> ${h.quote.replace(/\n/g, "\n> ")}`, ...(h.note ? ["", h.note] : []), "");
  return lines.join("\n").trim() + "\n";
}

const ENTITY_LABELS = {
  URL: "Link",
  TRACKING_NUMBER: "Tracking",
  ORDER_NUMBER: "Order",
  MODEL_NUMBER: "Model",
  PRODUCT_NAME: "Product",
};

function entityLabel(type) {
  return ENTITY_LABELS[type] ?? type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");
}

function when(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Time for today, the day otherwise: the list's headings already carry the rest. */
function shortWhen(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(undefined, { timeStyle: "short" });
  if (d.getFullYear() === today.getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function section(heading, body) {
  const s = document.createElement("section");
  const h = document.createElement("h3");
  h.append(heading);
  if (body) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-section";
    copy.append(icon("copy"), "Copy");
    copy.setAttribute("aria-label", `Copy ${heading.toLowerCase()}`);
    copy.addEventListener("click", () => copyNow(body, `Copied ${heading.toLowerCase()}`));
    h.append(copy);
  }
  const div = document.createElement("div");
  div.className = "prose";
  div.append(marked(body, searchWords(state.query)));
  s.append(h, div);
  return s;
}

function heading(textContent, count) {
  const h = document.createElement("div");
  h.className = "list-heading";
  h.append(textContent);
  if (count) {
    const n = document.createElement("span");
    n.className = "heading-count";
    n.textContent = String(count);
    h.append(n);
  }
  return h;
}

function note(textContent) {
  const p = document.createElement("p");
  p.className = "muted list-note";
  p.textContent = textContent;
  return p;
}

function badge(textContent) {
  const b = document.createElement("span");
  b.className = "badge";
  b.textContent = textContent;
  return b;
}

function text(value) {
  return document.createTextNode(value);
}

function option(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function viewLink(label, view) {
  const a = document.createElement("a");
  a.href = viewToHash(view);
  a.textContent = label;
  a.addEventListener("click", (event) => {
    event.preventDefault();
    go(view);
  });
  return a;
}

function link(label, href, plain) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = label;
  if (!plain) a.className = "button";
  return a;
}

function copyButton(label, value) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "button";
  b.textContent = label;
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value());
      b.textContent = "Copied";
    } catch (e) {
      b.textContent = "Could not copy";
    }
    setTimeout(() => (b.textContent = label), 1200);
  });
  return b;
}

function say(message, kind) {
  el.status.textContent = message;
  el.status.className = kind ?? "";
  // The status line lives on the opening screen. With the library open, say it
  // where it can be seen.
  if (message && !el.app.hidden) toast(message);
}

/** Small per-browser preferences. Never captures, never keys. */
/** A phone's name as people say it: an emulator, or a bare model code, reads as one. */
function friendlyPhone(name) {
  const n = (name ?? "").trim();
  if (/^(sdk_|generic)|emulator|_x86/i.test(n)) return "Android emulator";
  if (n.includes("_") && !/\s/.test(n)) return "Android phone";
  return n;
}

function remembered(key, fallback) {
  try {
    return localStorage.getItem("captry.desktop." + key) ?? fallback;
  } catch (e) {
    return fallback;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem("captry.desktop." + key, value);
  } catch (e) {
    // Private window or storage blocked: the default next time is fine.
  }
}

// For checking the page with a fixture, without a file picker in the way.
window.captryViewer = { state: () => ({ cached: !!opened?.cached, live: liveUp, seq: feed.seq }) };

offerRemembered();
