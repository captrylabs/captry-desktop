// Checks that captry.app/desktop serves exactly the newest published release.
//
//   node verify.mjs [https://captry.app]
//
// Works from the public captry-desktop repository (next to desktop/) and from
// the app's own repository (tools/desktop-viewer/). It:
//
// 1. checks the source here is the newest release: index.html and every file
//    hash to what releases.json records, and so do the page's headers in
//    _headers, for releases that record them;
// 2. fetches the live page, without following a redirect, and checks it is
//    the newest release, or the one before it until the end of the day after
//    the newest is dated (publish.mjs runs just before the deploy, which can
//    be late in the day), so a rollback to an older release fails;
// 3. checks the page's headers against the ones its release records (every
//    header _headers gives /desktop/, those from /* included), and fails on
//    a header that could send the page or what it reports elsewhere when the
//    release does not set it (but for the error reporting Cloudflare adds
//    of its own: hostsOwn). A release that recorded none is skipped, but
//    for the newest, which is held to _headers here;
// 4. fetches every script the page pins and checks each against its SHA-384,
//    and the manifest against the release, for releases that record it.
//
// Exits 1 on a mismatch, and 2 when it could not check at all (the site was
// unreachable or too slow, or refused this machine). Needs Node 18 or later.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Whether a path pattern in _headers (/*, /desktop/*, /a/:name) covers [at]. */
function covers(pattern, at) {
  const re = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+")).join(".*");
  return new RegExp(`^${re}$`).test(at);
}

/**
 * The headers _headers gives the page at [at], as Cloudflare Pages applies
 * them: every block that covers it, in order; "! Name" takes away what an
 * earlier block set, and a name set twice is joined with ", ". Names in
 * lower case, sorted, so two sets compare as text.
 */
export function headersFor(file, at = "/desktop/") {
  const out = new Map();
  let on = false;
  for (const line of file.replace(/\r\n/g, "\n").split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    if (!/^[ \t]/.test(line)) {
      on = covers(text, at);
      continue;
    }
    if (!on) continue;
    const detach = /^!\s*([A-Za-z0-9-]+)$/.exec(text);
    if (detach) {
      out.delete(detach[1].toLowerCase());
      continue;
    }
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(text);
    if (!m) continue;
    const name = m[1].toLowerCase();
    out.set(name, out.has(name) ? `${out.get(name)}, ${m[2]}` : m[2]);
  }
  return Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

// Headers no release sets, any of which could send the page somewhere else,
// report on it to an address of someone else's choosing, or leave something
// in the browser. Served when the release does not set it, it is a mismatch.
export const WATCHED = ["refresh", "location", "content-security-policy-report-only", "reporting-endpoints", "report-to", "nel", "link", "set-cookie"];

/**
 * Whether a served report-to or nel is the host's own. Cloudflare adds both
 * to what it serves, for its Network Error Logging: a browser that fails to
 * reach the site tells Cloudflare so. That is the one case let through, and
 * only in exactly that form: a single report-to group, cf-nel, whose every
 * endpoint is https on a.nel.cloudflare.com, and a nel that reports to that
 * group. Anything else under either name is still a mismatch.
 */
export function hostsOwn(name, value) {
  try {
    const v = JSON.parse(value);
    if (name === "nel") return v.report_to === "cf-nel";
    if (name !== "report-to" || v.group !== "cf-nel" || !Array.isArray(v.endpoints) || !v.endpoints.length) return false;
    return v.endpoints.every((e) => {
      const url = new URL(e.url);
      return url.protocol === "https:" && url.hostname === "a.nel.cloudflare.com";
    });
  } catch (e) {
    return false;
  }
}

/** A served value as it may be printed: one line, quoted, short, no backticks. */
export function shown(value) {
  const s = JSON.stringify(String(value)).replace(/`/g, "\\u0060");
  return s.length > 300 ? `${s.slice(0, 300)}…"` : s;
}

/**
 * Compares the headers served ([get] reads one by name, null when absent)
 * with [wanted], a release's headers. Returns lines: [true, text] passes and
 * [false, text] mismatches.
 */
export function compareHeaders(wanted, get) {
  const lines = [];
  for (const [name, value] of Object.entries(wanted)) {
    const served = get(name);
    if (served === value) lines.push([true, name]);
    else lines.push([false, `${name} is ${served === null ? "missing" : shown(served)}, not the release's`]);
  }
  for (const name of WATCHED) {
    if (Object.hasOwn(wanted, name)) continue;
    const served = get(name);
    if (served === null) continue;
    if (hostsOwn(name, served)) lines.push([true, `${name} (Cloudflare's own error reporting)`]);
    else lines.push([false, `${name} is served as ${shown(served)}, and the release sets no ${name}`]);
  }
  return lines;
}

/**
 * Whether [at], the index of the live release in [published], is right at
 * [now]: the newest, or the one before it until the end of the day after
 * the newest's date (UTC).
 */
export function liveIsRight(published, at, now) {
  if (at === 0) return true;
  return at === 1 && now < Date.parse(published[0].date) + 2 * 86_400_000;
}

async function main() {
  const origin = (process.argv[2] ?? "https://captry.app").replace(/\/$/, "");
  const sha = (algo, bytes, enc = "hex") => createHash(algo).update(bytes).digest(enc);

  // The source: desktop/ beside this file, or web/desktop/ in the app's repository.
  let dir;
  for (const candidate of ["./desktop/", "../../web/desktop/"]) {
    const url = new URL(candidate, import.meta.url);
    try {
      await readFile(new URL("releases.json", url));
      dir = url;
      break;
    } catch (e) {
      // Try the next layout.
    }
  }
  if (!dir) throw new Error("releases.json not found beside this script");
  const published = JSON.parse(await readFile(new URL("releases.json", dir), "utf8")).releases;

  let ok = true;
  const pass = (line) => console.log(`ok    ${line}`);
  const fail = (line) => {
    ok = false;
    console.log(`FAIL  ${line}`);
  };

  // 1. The source in this repository is the newest release.
  const newest = published[0];
  const localIndex = await readFile(new URL("index.html", dir));
  if (sha("sha256", localIndex) === newest.index) pass(`the source here is release ${newest.release}`);
  else fail(`the source here does not hash to release ${newest.release}`);
  for (const [name, expected] of Object.entries(newest.files)) {
    const bytes = await readFile(new URL(name, dir)).catch(() => null);
    if (!bytes || sha("sha256", bytes) !== expected) fail(`${name} here is not the one in release ${newest.release}`);
  }
  const headersFile = await readFile(new URL("../_headers", dir), "utf8").catch(() => null);
  const local = headersFile ? headersFor(headersFile) : null;
  if (newest.headers && local && JSON.stringify(local) !== JSON.stringify(newest.headers)) {
    fail(`_headers here does not give the page the headers release ${newest.release} records`);
  }

  // 2. The live page is the newest release.
  // Not being able to look is not a mismatch, and is reported as its own thing:
  // no answer, no answer in time, a refusal, or the server failing. Any other
  // answer that is not the file is a mismatch, a redirect included: it is not
  // followed, as the page is only ever served from its own address.
  const get = async (url) => {
    let response;
    let body;
    try {
      response = await fetch(url, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(30_000) });
      body = Buffer.from(await response.arrayBuffer());
    } catch (e) {
      const why = e.name === "TimeoutError" ? "no answer in 30 seconds" : e.cause?.code ?? e.message;
      console.log(`COULD NOT CHECK  ${url}: ${why}`);
      process.exit(ok ? 2 : 1);
    }
    if (!response.ok) {
      const challenged = response.headers.get("cf-mitigated");
      const to = response.headers.get("location");
      const line = `${url} answered ${response.status}${challenged ? ` (Cloudflare: ${shown(challenged)})` : ""}${to ? `, to ${shown(to)}` : ""}`;
      if (challenged || response.status === 403 || response.status === 429 || response.status >= 500) {
        console.log(`COULD NOT CHECK  ${line}`);
        process.exit(ok ? 2 : 1);
      }
      fail(line);
      return { body: null, headers: response.headers };
    }
    return { body, headers: response.headers };
  };
  const live = await get(`${origin}/desktop/`);
  if (!live.body) process.exit(1);
  const page = live.body;
  const hash = sha("sha256", page);
  const at = published.findIndex((r) => r.index === hash);
  const release = published[at];
  if (at === 0) pass(`${origin}/desktop/ is release ${release.release} (${release.date}), the newest`);
  else if (liveIsRight(published, at, Date.now())) pass(`${origin}/desktop/ is release ${release.release}; the newest, ${newest.release}, is not deployed yet`);
  else if (release) fail(`${origin}/desktop/ is release ${release.release} (${release.date}), not the newest, ${newest.release}`);
  else {
    fail(`${origin}/desktop/ has sha256 ${hash}, which is not a published release`);
    if (/__CF\$cv\$params|\/cdn-cgi\/challenge-platform\/|cloudflareinsights/.test(page.toString("utf8"))) {
      console.log("      Cloudflare added a script of its own to the page.");
    }
  }

  // 3. Its headers, the Content-Security-Policy above all, are its release's.
  // A release records them from release 74 on; before that only _headers
  // here says what they are, and it is the newest release's.
  const wanted = release?.headers ?? (at === 0 ? local : null);
  if (!release) console.log("skip  the page's headers: the page is not a published release");
  else if (!wanted) console.log(`skip  the page's headers: release ${release.release} recorded none${at === 0 ? ", and there is no _headers here" : ""}`);
  else {
    if (!Object.hasOwn(wanted, "content-security-policy")) fail(`release ${release.release} sets no Content-Security-Policy for /desktop/`);
    for (const [good, line] of compareHeaders(wanted, (name) => live.headers.get(name))) (good ? pass : fail)(line);
  }

  // 4. Every script it pins matches its pin, and the manifest is the release's.
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page.toString("utf8"));
  const pins = map ? JSON.parse(map[1]).integrity ?? {} : {};
  if (!Object.keys(pins).length) fail("the page pins no scripts");
  for (const [url, expected] of Object.entries(pins)) {
    const script = (await get(origin + url)).body;
    if (!script) continue;
    if (`sha384-${sha("sha384", script, "base64")}` === expected) pass(url);
    else fail(`${url} does not match its pin`);
  }
  // Releases before 73 did not record it.
  const manifestHash = release?.files?.["manifest.webmanifest"];
  if (manifestHash) {
    const manifest = (await get(`${origin}/desktop/manifest.webmanifest`)).body;
    if (manifest && sha("sha256", manifest) === manifestHash) pass("/desktop/manifest.webmanifest");
    else if (manifest) fail("/desktop/manifest.webmanifest is not the one in the release");
  }
  process.exit(ok ? 0 : 1);
}

// Run, unless imported for its checks (release.mjs, test.mjs).
const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) await main();
