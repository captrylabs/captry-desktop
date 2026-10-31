# Captry Desktop

The source of [captry.app/desktop](https://captry.app/desktop/), the web page that
pairs with the [Captry](https://captry.app/) Android app to read, search and send
captures from a computer.

It is published so anyone can check that the page captry.app serves is this code,
byte for byte. The page decrypts your library in the browser, so it is the one
place where Captry's "we can't read your data" depends on code you run; this
repository is how that code can be read and checked.

## What is here

| Path | What it is |
| --- | --- |
| `desktop/` | The page exactly as deployed to captry.app/desktop/ |
| `desktop/releases.json` | The SHA-256 of every release, newest first |
| `_headers` | The site's HTTP headers, including the page's Content Security Policy |
| `verify.mjs` | Checks this source and the live site against `releases.json` |
| `.github/workflows/verify.yml` | Runs `verify.mjs` every hour, in public |

Each release is one commit, made when it is deployed. The history is the record:
a release can't be changed or removed without that showing here.

## Check the live page

With Node 18 or later, nothing to install:

```
node verify.mjs
```

It checks that the source here is the newest release, that the live page is a
published release, and that every script the page loads matches its pin.

It also runs by itself: every hour, [a GitHub Actions check](../../actions/workflows/verify.yml)
does the same from GitHub's machines, and every run is public. If the page stops
matching, it opens an issue here, and closes it once the page matches again.

Or by hand: `curl -s https://captry.app/desktop/ | shasum -a 256` prints the same
hash as the newest `index` in `desktop/releases.json`. That one hash covers the
whole page: `index.html` pins every script it loads by its SHA-384, and the
browser refuses a script that doesn't match.

## How the page protects your data

- Pairing exchanges keys with the phone (ECDH P-256) and both screens show the same
  six digits, so no one in between can join.
- Everything the page sends is sealed with AES-256-GCM before it leaves, and
  padded so its exact size does not show. The relay at api.captry.app holds only
  ciphertext, for at most 14 days.
- The key is kept in the browser as a non-extractable key, which no script can
  read back out.
- The Content Security Policy lets the page load scripts only from captry.app,
  pinned by hash, and talk only to api.captry.app.

The full account is in the [privacy policy](https://captry.app/privacy/).

## Reporting a problem

Security or privacy issues: support@captry.app.

The code is published to be read and checked. All rights reserved.
