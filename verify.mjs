// Checks that captry.app/desktop serves exactly the newest published release.
//
//   node verify.mjs [https://captry.app]
//
// Works from the public captry-desktop repository (next to desktop/) and from
// the app's own repository (tools/desktop-viewer/). It:
//
// 1. checks the source here is the newest release: index.html and every file
//    hash to what releases.json records;
// 2. fetches the live page and checks it is the newest release, or the one
//    before it for a day after the newest is dated (publish.mjs runs just
//    before the deploy), so a rollback to an older release fails;
// 3. checks the page's headers against _headers here, when the page is the
//    release that _headers belongs to;
// 4. fetches every script the page pins and checks each against its SHA-384,
//    and the manifest against the release, for releases that record it.
//
// Exits 1 on a mismatch, and 2 when it could not check at all (the site was
// unreachable or too slow, or refused this machine). Needs Node 18 or later.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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

// 2. The live page is the newest release.
// Not being able to look is not a mismatch, and is reported as its own thing:
// no answer, no answer in time, a refusal, or the server failing. Any other
// answer that is not the file is a mismatch.
const get = async (url) => {
  let response;
  let body;
  try {
    response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
    body = Buffer.from(await response.arrayBuffer());
  } catch (e) {
    const why = e.name === "TimeoutError" ? "no answer in 30 seconds" : e.cause?.code ?? e.message;
    console.log(`COULD NOT CHECK  ${url}: ${why}`);
    process.exit(ok ? 2 : 1);
  }
  if (!response.ok) {
    const challenged = response.headers.get("cf-mitigated");
    const line = `${url} answered ${response.status}${challenged ? ` (Cloudflare: ${challenged})` : ""}`;
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
// The newest is published just before it is deployed, so for a day after its
// date the one before it is still right.
const justReleased = Date.now() - Date.parse(newest.date) < 2 * 86_400_000;
if (at === 0) pass(`${origin}/desktop/ is release ${release.release} (${release.date}), the newest`);
else if (at === 1 && justReleased) pass(`${origin}/desktop/ is release ${release.release}; the newest, ${newest.release}, is not deployed yet`);
else if (release) fail(`${origin}/desktop/ is release ${release.release} (${release.date}), not the newest, ${newest.release}`);
else {
  fail(`${origin}/desktop/ has sha256 ${hash}, which is not a published release`);
  if (/__CF\$cv\$params|\/cdn-cgi\/challenge-platform\/|cloudflareinsights/.test(page.toString("utf8"))) {
    console.log("      Cloudflare added a script of its own to the page.");
  }
}

// 3. Its headers, the Content-Security-Policy above all, are the ones in
// _headers. That file is the newest release's, so an older page is not held to it.
const headersFile = await readFile(new URL("../_headers", dir), "utf8").catch(() => null);
if (!headersFile) console.log("skip  the page's headers: no _headers here");
else if (at !== 0) console.log("skip  the page's headers: _headers here is for the newest release");
else {
  const block = /^\/desktop\/\*\n((?:[ \t]+.*(?:\n|$))*)/m.exec(headersFile.replace(/\r\n/g, "\n"))?.[1] ?? "";
  const wanted = [...block.matchAll(/^[ \t]+([A-Za-z-]+):[ \t]*(.*?)[ \t]*$/gm)];
  if (!wanted.some((m) => m[1].toLowerCase() === "content-security-policy")) fail("_headers here has no Content-Security-Policy for /desktop/*");
  for (const [, name, value] of wanted) {
    const served = live.headers.get(name);
    if (served === value) pass(name);
    else fail(`${name} is ${served === null ? "missing" : `"${served}"`}, not the one in _headers`);
  }
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
