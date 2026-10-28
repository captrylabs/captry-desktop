// How the desktop page organizes captures, mirroring the app's Library.
//
// No DOM here, so node can test it. Every rule below is the app's rule
// written again, and each one names where it came from, so a change on the
// phone has an obvious place to follow it here.

/** The places to look, in the order the sidebar shows them. */
export const PLACES = [
  { id: "captures", label: "Captures" },
  { id: "pinned", label: "Pinned" },
  { id: "archive", label: "Archive" },
  { id: "private", label: "Private" },
  { id: "sent", label: "Sent from here" },
];

/** CaptureFilter.kt: the chips under the search box, short labels. */
export const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "IMAGES", label: "Images" },
  { id: "VOICE", label: "Voice" },
  { id: "LINKS", label: "Links" },
  { id: "NOTES", label: "Notes" },
  { id: "PINNED", label: "Pinned" },
];

/** CaptureFilters.kt DateRange: rolling windows, not calendar boundaries. */
export const RANGES = [
  { id: "ANY", label: "Any time", days: null },
  { id: "DAY", label: "Last 24 hours", days: 1 },
  { id: "WEEK", label: "Last 7 days", days: 7 },
  { id: "MONTH", label: "Last 30 days", days: 30 },
  { id: "YEAR", label: "Last year", days: 365 },
];

export const SORTS = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "title", label: "Title" },
];

/** LibraryViewModels.kt CaptureType.label(): what a type is called in the Library. */
const TYPE_LABELS = {
  PRODUCT: "Products",
  PLACE: "Places",
  PERSON: "People",
  TASK: "Tasks",
  IDEA: "Ideas",
  ARTICLE: "Articles",
  VIDEO: "Videos",
  EVENT: "Events",
  RECEIPT: "Receipts",
  RETURN_CODE: "Return codes",
  PURCHASE: "Purchases",
  CONFIRMATION: "Orders",
  INSTRUCTIONS: "How-tos",
  RECIPE: "Recipes",
  RECOMMENDATION: "Picks",
  REFERENCE: "Reference",
  COUPON: "Coupons",
  TRACKING: "Tracking",
  MODEL_NUMBER: "Models",
  TROUBLESHOOTING: "Fixes",
  TRAVEL: "Travel",
  TEMPORARY_INFO: "Temp info",
  NOTE: "Notes",
  UNCLASSIFIED: "Unsorted",
};

export function typeLabel(type) {
  if (!type) return "";
  return TYPE_LABELS[type] ?? type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");
}

/** The singular, for a line under a title. "Receipt", not "Receipts". */
export function typeName(type) {
  if (!type || type === "UNCLASSIFIED") return "";
  const special = { PERSON: "Person", CONFIRMATION: "Order", INSTRUCTIONS: "How-to", RECOMMENDATION: "Pick", TROUBLESHOOTING: "Fix", MODEL_NUMBER: "Model", TEMPORARY_INFO: "Temp info", REFERENCE: "Reference", TRAVEL: "Travel", TRACKING: "Tracking" };
  if (special[type]) return special[type];
  const plural = typeLabel(type);
  return plural.endsWith("s") ? plural.slice(0, -1) : plural;
}

/**
 * A friendlier name for a source app's package.
 *
 * The phone asks its package manager; a browser cannot, so the common ones
 * are written out and the rest are guessed from the package's last word.
 */
const KNOWN_APPS = {
  "com.android.chrome": "Chrome",
  "org.mozilla.firefox": "Firefox",
  "com.brave.browser": "Brave",
  "com.microsoft.emmx": "Edge",
  "com.sec.android.app.sbrowser": "Samsung Internet",
  "com.google.android.youtube": "YouTube",
  "com.reddit.frontpage": "Reddit",
  "com.twitter.android": "X",
  "com.instagram.android": "Instagram",
  "com.facebook.katana": "Facebook",
  "com.zhiliaoapp.musically": "TikTok",
  "com.google.android.gm": "Gmail",
  "com.google.android.apps.maps": "Maps",
  "com.google.android.apps.photos": "Photos",
  "com.google.android.keep": "Keep",
  "com.whatsapp": "WhatsApp",
  "org.telegram.messenger": "Telegram",
  "com.google.android.apps.messaging": "Messages",
  "com.amazon.mShop.android.shopping": "Amazon",
  "com.ebay.mobile": "eBay",
  "com.spotify.music": "Spotify",
  "com.linkedin.android": "LinkedIn",
  "com.pinterest": "Pinterest",
  "com.captry": "Captry",
};

export function sourceLabel(source) {
  if (!source) return "";
  if (KNOWN_APPS[source]) return KNOWN_APPS[source];
  if (!source.includes(".") || /\.[a-z]{2,}$/.test(source) && !/^(com|org|net|io|app)\./.test(source)) {
    return source; // a host such as example.com
  }
  const last = source.split(".").filter((p) => p !== "android" && p !== "app").pop() ?? source;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** CaptureFilter.matches, over the page's own capture shape. */
export function matchesFilter(c, filter) {
  const image = hasImage(c);
  const audio = hasAudio(c);
  switch (filter) {
    case "IMAGES":
      return image;
    case "VOICE":
      return audio;
    case "LINKS":
      return !!c.sourceUrl;
    case "NOTES":
      return !image && !audio && !c.sourceUrl;
    case "PINNED":
      return c.pinned;
    default:
      return true;
  }
}

export function hasImage(c) {
  return c.files.some((f) => f.type === "IMAGE" || f.mimeType?.startsWith("image/"));
}

export function hasAudio(c) {
  return c.files.some((f) => f.type === "AUDIO" || f.mimeType?.startsWith("audio/"));
}

export function matchesRange(c, range, now) {
  const days = RANGES.find((r) => r.id === range)?.days;
  if (!days) return true;
  return (c.capturedAt ?? 0) >= now - days * 86400000;
}

/** Either side, as the search chip does: a page shared from Chrome is filed under both. */
export function matchesSource(c, source) {
  if (!source) return true;
  return c.sourceApp === source || c.sourceHost === source;
}

/** Everything a search looks through, lowercased once and kept. */
export function haystack(c) {
  if (c._hay === undefined) {
    c._hay = [
      c.title,
      c.text,
      c.note,
      c.summary,
      c.sourceUrl,
      typeLabel(c.type),
      ...c.collections.map((m) => m.name),
      ...c.entities.map((e) => e.value),
      ...c.files.map((f) => f.textInImage),
      ...c.files.map((f) => f.transcript),
      ...c.highlights.map((h) => h.quote),
      ...c.highlights.map((h) => h.note),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
  }
  return c._hay;
}

/**
 * A search, split into words and filters:
 *   type:image (or voice, link, note, or a type such as receipt)
 *   in:groceries, or in:"save for later"
 *   from:amazon, the site or app it came from
 *   is:pinned
 *   -word, to leave out captures that have it
 * The last one asked for is kept, since every capture asks again.
 */
let parsedFor = null;
let parsed = null;
export function parseQuery(query) {
  if (query === parsedFor) return parsed;
  const out = { words: [], not: [], types: [], ins: [], froms: [], pinned: false };
  for (const m of (query ?? "").matchAll(/(-?)(?:(type|in|from|is):)?(?:"([^"]*)"?|(\S+))/gi)) {
    const neg = m[1] === "-";
    const key = m[2]?.toLowerCase();
    const value = (m[3] ?? m[4] ?? "").toLowerCase().trim();
    if (!value) continue;
    if (!key) (neg ? out.not : out.words).push(value);
    else if (neg) out.not.push(`${key}:${value}`);
    else if (key === "type") out.types.push(value);
    else if (key === "in") out.ins.push(value);
    else if (key === "from") out.froms.push(value);
    else if (key === "is" && value === "pinned") out.pinned = true;
    else out.words.push(`${key}:${value}`);
  }
  parsedFor = query;
  parsed = out;
  return out;
}

/** The plain words of a search, for marking where they were found. */
export function searchWords(query) {
  return parseQuery(query).words;
}

function matchesType(c, word) {
  switch (word) {
    case "image": case "images": case "photo": case "photos": case "picture": case "pictures":
      return hasImage(c);
    case "voice": case "audio":
      return hasAudio(c);
    case "link": case "links":
      return !!c.sourceUrl;
    case "note": case "notes":
      return matchesFilter(c, "NOTES");
    default:
      return (c.type ?? "").toLowerCase() === word || typeLabel(c.type).toLowerCase().startsWith(word);
  }
}

/** Every word somewhere in the capture, in any order, and every filter met. */
export function matchesWords(c, query) {
  const q = parseQuery(query);
  if (q.pinned && !c.pinned) return false;
  if (!q.types.every((t) => matchesType(c, t))) return false;
  if (!q.ins.every((name) => c.collections.some((m) => m.name.toLowerCase().startsWith(name)))) return false;
  if (!q.froms.every((from) => [c.sourceHost, c.sourceApp, c.sourceApp && sourceLabel(c.sourceApp)]
    .some((s) => s && s.toLowerCase().includes(from)))) return false;
  if (!q.words.length && !q.not.length) return true;
  const hay = haystack(c);
  return q.words.every((w) => hay.includes(w)) && !q.not.some((w) => hay.includes(w));
}

/** CollectionRule.matches plus its words. */
export function matchesRule(c, rule, now) {
  if (c.private) return false;
  if (c.archived && !rule.includeArchived) return false;
  return (
    matchesFilter(c, rule.filter) &&
    matchesRange(c, rule.dateRange, now) &&
    matchesSource(c, rule.source) &&
    matchesWords(c, rule.query)
  );
}

/** A rule in words, for the line under a smart collection's name. */
export function describeRule(rule) {
  const parts = [];
  if (rule.query) parts.push(`"${rule.query}"`);
  if (rule.filter !== "ALL") parts.push(FILTERS.find((f) => f.id === rule.filter)?.label ?? rule.filter);
  if (rule.dateRange !== "ANY") parts.push(RANGES.find((r) => r.id === rule.dateRange)?.label ?? rule.dateRange);
  if (rule.source) parts.push("from " + sourceLabel(rule.source));
  if (rule.includeArchived) parts.push("archived too");
  return parts.join(" · ");
}

/**
 * Where a capture can be found, before any chip or word narrows it.
 *
 * Private captures appear only under Private, as on the phone, where they
 * sit behind their own door and never in a list someone glances at.
 */
export function inView(c, view, data, now) {
  // Sent from this page and not yet in the library: only where a person would
  // look for something they just made.
  if (c.sent) return view.kind === "captures" || view.kind === "sent";
  if (view.kind === "sent") return false;
  switch (view.kind) {
    case "captures":
      return !c.private && !c.archived;
    case "pinned":
      return !c.private && c.pinned;
    case "archive":
      return !c.private && c.archived;
    case "private":
      return c.private;
    case "collection":
      return !c.private && c.collections.some((m) => m.name === view.name);
    case "smart": {
      const smart = data.smartCollections.find((s) => s.name === view.name);
      return !!smart && matchesRule(c, smart.rule, now);
    }
    case "type":
      return !c.private && !c.archived && c.type === view.type;
    case "source":
      return !c.private && matchesSource(c, view.source);
    default:
      return false;
  }
}

/** The sidebar: each place, collection, smart collection and type, with its count. */
export function catalog(data, now) {
  const all = data.captures;
  const count = (view) => all.reduce((n, c) => n + (inView(c, view, data, now) ? 1 : 0), 0);

  const places = PLACES.map((p) => ({ view: { kind: p.id }, label: p.label, count: count({ kind: p.id }) }))
    .filter((p) => p.view.kind === "captures" || p.count > 0);

  const names = new Map();
  for (const c of all) {
    if (c.private) continue;
    for (const m of c.collections) names.set(m.name.toLowerCase(), names.get(m.name.toLowerCase()) ?? m.name);
  }
  const collections = [...names.values()]
    .map((name) => ({ view: { kind: "collection", name }, label: name, count: count({ kind: "collection", name }) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

  const smart = data.smartCollections.map((s) => ({
    view: { kind: "smart", name: s.name },
    label: s.name,
    detail: describeRule(s.rule),
    count: count({ kind: "smart", name: s.name }),
  }));

  const typeCounts = new Map();
  for (const c of all) {
    if (c.private || c.archived || !c.type) continue;
    typeCounts.set(c.type, (typeCounts.get(c.type) ?? 0) + 1);
  }
  // The Library puts the fullest shelves first and Unsorted last.
  const types = [...typeCounts.entries()]
    .map(([type, n]) => ({ view: { kind: "type", type }, label: typeLabel(type), count: n }))
    .sort((a, b) => (a.view.type === "UNCLASSIFIED") - (b.view.type === "UNCLASSIFIED") || b.count - a.count || a.label.localeCompare(b.label));

  return { places, collections, smart, types };
}

/** Every source in the library, busiest first, for the source picker. */
export function sources(captures) {
  const counts = new Map();
  for (const c of captures) {
    if (c.private) continue;
    for (const s of new Set([c.sourceApp, c.sourceHost].filter(Boolean))) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, label: sourceLabel(id), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** The view, then the chips, then the words, then the order. */
export function query(data, state, now) {
  const list = data.captures.filter(
    (c) =>
      inView(c, state.view, data, now) &&
      matchesFilter(c, state.filter) &&
      matchesRange(c, state.range, now) &&
      matchesSource(c, state.source) &&
      matchesWords(c, state.query),
  );
  sortCaptures(list, state.sort);

  // A checklist collection keeps its done items at the end, as the shelf does.
  if (state.view.kind === "collection") {
    const done = (c) => c.collections.find((m) => m.name === state.view.name)?.checked ?? false;
    const open = list.filter((c) => !done(c));
    const finished = list.filter(done);
    return { list: open.concat(finished), doneFrom: finished.length ? open.length : -1 };
  }
  return { list, doneFrom: -1 };
}

export function sortCaptures(list, sort) {
  if (sort === "oldest") list.sort((a, b) => (a.capturedAt ?? 0) - (b.capturedAt ?? 0));
  else if (sort === "title") list.sort((a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: "base" }));
  else list.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));
  return list;
}

export function titleOf(c) {
  if (c.title) return c.title;
  const first = (c.text ?? "").split("\n").map((s) => s.trim()).find(Boolean);
  if (first) return first.length > 80 ? first.slice(0, 77) + "…" : first;
  if (c.sourceUrl) return c.sourceHost ?? c.sourceUrl;
  return typeName(c.type) || "Capture";
}

/**
 * The heading a capture sits under in a date-ordered list.
 *
 * Calendar days in the viewer's own time zone, which is what "Today" means to
 * a person reading it, then months, then years.
 */
export function dateGroup(ms, now) {
  if (!ms) return "Undated";
  const d = new Date(ms);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((today - day) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  if (d.getFullYear() === today.getFullYear()) return d.toLocaleString(undefined, { month: "long" });
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}

/** The same view written as a URL hash, so Back and a bookmark both work. */
export function viewToHash(view) {
  switch (view.kind) {
    case "collection":
      return "#collection/" + encodeURIComponent(view.name);
    case "smart":
      return "#smart/" + encodeURIComponent(view.name);
    case "type":
      return "#type/" + view.type;
    case "source":
      return "#source/" + encodeURIComponent(view.source);
    default:
      return "#" + view.kind;
  }
}

export function hashToView(hash) {
  const [kind, ...rest] = hash.replace(/^#/, "").split("/");
  // A hand-edited or truncated bookmark can carry a lone %, which
  // decodeURIComponent throws on. That is no view, not a broken page.
  let arg;
  try {
    arg = decodeURIComponent(rest.join("/"));
  } catch (e) {
    return null;
  }
  switch (kind) {
    case "pinned":
    case "archive":
    case "private":
    case "sent":
      return { kind };
    case "collection":
      return arg ? { kind, name: arg } : null;
    case "smart":
      return arg ? { kind, name: arg } : null;
    case "type":
      return arg ? { kind, type: arg } : null;
    case "source":
      return arg ? { kind, source: arg } : null;
    case "captures":
      return { kind };
    default:
      return null;
  }
}

export function sameView(a, b) {
  return a.kind === b.kind && a.name === b.name && a.type === b.type && a.source === b.source;
}

export function viewTitle(view, data) {
  switch (view.kind) {
    case "collection":
    case "smart":
      return view.name;
    case "type":
      return typeLabel(view.type);
    case "source":
      return sourceLabel(view.source);
    default:
      return PLACES.find((p) => p.id === view.kind)?.label ?? "Captures";
  }
}
