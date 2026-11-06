// The QR code the pairing screen shows: just enough of ISO/IEC 18004 for the
// one thing it carries (pair.js, pairQrText), written here so the page loads
// no script it does not pin.
//
//   version 4 (33 x 33), error correction H, alphanumeric mode:
//   up to 50 characters from 0-9 A-Z space $ % * + - . / :
//   36 data codewords in four blocks of 9, each with 16 of Reed-Solomon.
//
// Level H, the strongest: the page draws the code in dots, which leave a
// scanner less to go on than squares, and a third of it can be lost to glare
// or a smudge and it still reads.

const SIZE = 33;
const BLOCKS = 4;
const DATA_CODEWORDS = 36;
const EC_CODEWORDS = 16; // in each block
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
export const QR_MAX_LENGTH = 50;

/** The code for [text] as rows of 0 and 1 (1 is dark), without the quiet zone around it. */
export function qrModules(text) {
  const codewords = withErrorCorrection(dataCodewords(text));
  const fixed = functionPatterns();
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = fixed.modules.map((row) => row.slice());
    placeCodewords(modules, fixed.reserved, codewords);
    applyMask(modules, fixed.reserved, mask);
    drawFormat(modules, mask);
    const score = penalty(modules);
    if (!best || score < best.score) best = { modules, score };
  }
  return best.modules;
}

/**
 * An SVG path for the dark modules as dots, one unit a module, [quiet]
 * modules in from the edge. The three finders are left to qrFinderPath.
 */
export function qrDotsPath(modules, quiet = 4) {
  const n = modules.length;
  const r = 0.47;
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!modules[y][x]) continue;
      if ((x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7)) continue;
      d += `M${x + quiet + 0.5 - r} ${y + quiet + 0.5}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
    }
  }
  return d;
}

/**
 * The three finders of a code [size] modules across, their corners rounded;
 * fill with the even-odd rule. Rounded only a little: a scanner looks for
 * squares, and one tried here (OpenCV) lost the code past a module's radius.
 */
export function qrFinderPath(size, quiet = 4) {
  const square = (x, y, w, r) =>
    `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${w - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${2 * r - w}a${r} ${r} 0 0 1 ${-r} ${-r}v${2 * r - w}a${r} ${r} 0 0 1 ${r} ${-r}z`;
  let d = "";
  for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    d += square(x + quiet, y + quiet, 7, 0.8) + square(x + quiet + 1, y + quiet + 1, 5, 0.4) + square(x + quiet + 2, y + quiet + 2, 3, 0.35);
  }
  return d;
}

function dataCodewords(text) {
  if (text.length > QR_MAX_LENGTH) throw new Error("too long for the code");
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  const value = (c) => {
    const v = CHARS.indexOf(c);
    if (v < 0) throw new Error("not a character the code can carry");
    return v;
  };
  put(0b0010, 4); // alphanumeric
  put(text.length, 9);
  for (let i = 0; i + 1 < text.length; i += 2) put(value(text[i]) * 45 + value(text[i + 1]), 11);
  if (text.length % 2) put(value(text[text.length - 1]), 6);
  put(0, Math.min(4, DATA_CODEWORDS * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < DATA_CODEWORDS * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = new Uint8Array(DATA_CODEWORDS);
  bits.forEach((bit, i) => { out[i >>> 3] |= bit << (7 - (i & 7)); });
  return out;
}

/** Multiplication in GF(2^8) over x^8 + x^4 + x^3 + x^2 + 1. */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** Each block's data with its Reed-Solomon codewords, the blocks dealt out a codeword at a time. */
function withErrorCorrection(data) {
  const each = DATA_CODEWORDS / BLOCKS;
  const blocks = [];
  for (let b = 0; b < BLOCKS; b++) {
    const part = data.subarray(b * each, (b + 1) * each);
    blocks.push({ data: part, ec: reedSolomon(part) });
  }
  const out = new Uint8Array((each + EC_CODEWORDS) * BLOCKS);
  let at = 0;
  for (let i = 0; i < each; i++) for (const block of blocks) out[at++] = block.data[i];
  for (let i = 0; i < EC_CODEWORDS; i++) for (const block of blocks) out[at++] = block.ec[i];
  return out;
}

function reedSolomon(data) {
  // The generator: (x - 1)(x - 2)(x - 4)... with EC_CODEWORDS roots.
  const divisor = new Uint8Array(EC_CODEWORDS);
  divisor[EC_CODEWORDS - 1] = 1;
  let root = 1;
  for (let i = 0; i < EC_CODEWORDS; i++) {
    for (let j = 0; j < EC_CODEWORDS; j++) {
      divisor[j] = gfMul(divisor[j], root);
      if (j + 1 < EC_CODEWORDS) divisor[j] ^= divisor[j + 1];
    }
    root = gfMul(root, 2);
  }
  const remainder = new Uint8Array(EC_CODEWORDS);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[EC_CODEWORDS - 1] = 0;
    for (let i = 0; i < EC_CODEWORDS; i++) remainder[i] ^= gfMul(divisor[i], factor);
  }
  return remainder;
}

/** The finders, timing lines and alignment square, and which modules data must leave alone. */
function functionPatterns() {
  const modules = Array.from({ length: SIZE }, () => new Uint8Array(SIZE));
  const reserved = Array.from({ length: SIZE }, () => new Uint8Array(SIZE));
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    modules[y][x] = dark ? 1 : 0;
    reserved[y][x] = 1;
  };
  for (let i = 0; i < SIZE; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Finders, with the light ring that separates them from the data.
  for (const [cx, cy] of [[3, 3], [SIZE - 4, 3], [3, SIZE - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, ring !== 2 && ring !== 4);
      }
    }
  }
  // Version 4 has one alignment square.
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) set(26 + dx, 26 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Where the format bits go, drawn once the mask is chosen.
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = 1;
    reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][SIZE - 1 - i] = 1;
    reserved[SIZE - 1 - i][8] = 1;
  }
  return { modules, reserved };
}

/** Up and down in two-module columns from the bottom right, skipping the timing column. */
function placeCodewords(modules, reserved, codewords) {
  let i = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < SIZE; step++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? SIZE - 1 - step : step;
        if (reserved[y][x]) continue;
        // Past the last codeword the remainder bits stay light.
        if (i < codewords.length * 8) modules[y][x] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
        i++;
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(modules, reserved, mask) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!reserved[y][x] && MASKS[mask](x, y)) modules[y][x] ^= 1;
    }
  }
}

/** Error correction level H and the mask, with their own BCH code, in both places. */
function drawFormat(modules, mask) {
  const data = (0b10 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => (bits >>> i) & 1;
  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) modules[8][SIZE - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) modules[SIZE - 15 + i][8] = bit(i);
  modules[SIZE - 8][8] = 1;
}

/** The standard's four rules for which mask reads best; lower is better. */
function penalty(modules) {
  let score = 0;
  const lines = [];
  for (let i = 0; i < SIZE; i++) {
    lines.push(Array.from(modules[i]));
    lines.push(modules.map((row) => row[i]));
  }
  for (const line of lines) {
    // Long runs of one colour.
    for (let i = 0, run = 1; i < SIZE; i++, run++) {
      if (i + 1 < SIZE && line[i + 1] === line[i]) continue;
      if (run >= 5) score += run - 2;
      run = 0;
    }
    // Anything that looks like a finder.
    const text = line.join("");
    for (const pattern of ["10111010000", "00001011101"]) {
      for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) score += 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      dark += modules[y][x];
      if (x + 1 < SIZE && y + 1 < SIZE) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
    }
  }
  return score + Math.floor(Math.abs(dark * 20 - SIZE * SIZE * 10) / (SIZE * SIZE)) * 10;
}
