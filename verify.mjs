// Checks that captry.app/desktop serves exactly a published release.
//
//   node verify.mjs [https://captry.app]
//
// Works from the public captry-desktop repository (next to desktop/) and from
// the app's own repository (tools/desktop-viewer/). It:
//
// 1. checks the source here is the newest release: index.html and every file
//    hash to what releases.json records;
// 2. fetches the live page and finds its hash in releases.json;
// 3. fetches every script the page pins and checks each against its SHA-384.
//
// Exits 1 on any mismatch. Needs Node 18 or later; nothing to install.

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

// 2. The live page is a published release.
const get = async (url) => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
const page = await get(`${origin}/desktop/`);
const hash = sha("sha256", page);
const release = published.find((r) => r.index === hash);
if (release) pass(`${origin}/desktop/ is release ${release.release} (${release.date})`);
else {
  fail(`${origin}/desktop/ has sha256 ${hash}, which is not a published release`);
  if (/__CF\$cv\$params|\/cdn-cgi\/challenge-platform\/|cloudflareinsights/.test(page.toString("utf8"))) {
    console.log("      Cloudflare added a script of its own to the page.");
  }
}

// 3. Every script it pins matches its pin.
const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page.toString("utf8"));
const pins = map ? JSON.parse(map[1]).integrity ?? {} : {};
if (!Object.keys(pins).length) fail("the page pins no scripts");
for (const [url, expected] of Object.entries(pins)) {
  if (`sha384-${sha("sha384", await get(origin + url), "base64")}` === expected) pass(url);
  else fail(`${url} does not match its pin`);
}
process.exit(ok ? 0 : 1);
