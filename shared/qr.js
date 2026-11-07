// A small QR code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1–10
// (up to 213 bytes). Enough for a device link code, and no third-party script in the page.

// Level M block structure per version: [ec codewords per block, [blocks, data codewords]...]
const BLOCKS = [
  null,
  [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
  [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const MAX_VERSION = 10;

// ---------- GF(256) and Reed–Solomon ----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function ecc(data, n) {
  const g = generator(n);
  const r = [...data, ...new Array(n).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const c = r[i];
    if (c) for (let j = 0; j < g.length; j++) r[i + j] ^= mul(g[j], c);
  }
  return r.slice(data.length);
}

// ---------- data codewords ----------
const dataCapacity = (v) => BLOCKS[v].slice(1).reduce((s, [n, d]) => s + n * d, 0);

function codewords(bytes, v) {
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCapacity(v) * 8;
  put(0, Math.min(4, cap - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; out.length < cap / 8; pad++) out.push(pad % 2 ? 0x11 : 0xec);
  return out;
}

function interleave(data, v) {
  const [ecLen, ...groups] = BLOCKS[v];
  const blocks = [];
  let at = 0;
  for (const [n, d] of groups) for (let i = 0; i < n; i++) { blocks.push(data.slice(at, at + d)); at += d; }
  const ecs = blocks.map((b) => ecc(b, ecLen));
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

// ---------- matrix ----------
/** Format (15-bit) and version (18-bit) words: data followed by its BCH remainder. */
function formatBits(mask) {
  const data = (0b00 << 3) | mask; // level M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function versionBits(v) {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (v << 12) | (rem & 0xfff);
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function base(v) {
  const size = 17 + 4 * v;
  const m = Array.from({ length: size }, () => new Array(size).fill(null)); // null = not yet set
  const set = (r, c, on) => { m[r][c] = on ? 1 : 0; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      set(rr, cc, ring !== 2 && ring !== 4);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const last = ALIGN[v].at(-1);
  for (const r of ALIGN[v]) for (const c of ALIGN[v]) {
    if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue; // finder corners
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // reserve the format (and version) areas; writeFormat fills them in
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) { m[8][size - 1 - i] = 0; m[size - 1 - i][8] = 0; }
  set(size - 8, 8, true); // dark module
  if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { m[i][size - 11 + j] = 0; m[size - 11 + j][i] = 0; }
  return m;
}

function placeData(m, fixed, bytes) {
  const size = m.length;
  let bit = 0;
  const total = bytes.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (fixed[r][c]) continue;
        m[r][c] = bit < total ? (bytes[bit >> 3] >>> (7 - (bit & 7))) & 1 : 0;
        bit++;
      }
    }
  }
}

function writeFormat(m, mask, v) {
  const size = m.length;
  const f = formatBits(mask);
  const b = (i) => (f >>> i) & 1;
  // copy 1, around the top-left finder
  for (let i = 0; i <= 5; i++) m[i][8] = b(i);
  m[7][8] = b(6);
  m[8][8] = b(7);
  m[8][7] = b(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = b(i);
  // copy 2, split between the top-right and bottom-left finders
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = b(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = b(i);
  m[size - 8][8] = 1; // the dark module
  if (v >= 7) {
    const vi = versionBits(v);
    for (let i = 0; i < 18; i++) {
      const bit = (vi >>> i) & 1;
      const a = size - 11 + (i % 3), c = Math.floor(i / 3);
      m[c][a] = bit;
      m[a][c] = bit;
    }
  }
}

function penalty(m) {
  const size = m.length;
  let p = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = pass ? m[j][i] : m[i][j];
        const b = pass ? m[j - 1][i] : m[i][j - 1];
        if (a === b) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      if (run >= 5) p += run - 2;
    }
  }
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const s = m[r][c] + m[r + 1][c] + m[r][c + 1] + m[r + 1][c + 1];
    if (s === 0 || s === 4) p += 3;
  }
  const pat = [1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r++) for (let c = 0; c + 7 <= size; c++) {
    for (const horiz of [true, false]) {
      let hit = true;
      for (let k = 0; k < 7 && hit; k++) hit = (horiz ? m[r][c + k] : m[c + k][r]) === pat[k];
      if (hit) p += 40;
    }
  }
  let dark = 0;
  for (const row of m) for (const x of row) dark += x;
  p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return p;
}

/**
 * Encode text as a QR code. Returns a square array of rows, 1 = dark module (no quiet zone).
 */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let v = 1;
  while (v <= MAX_VERSION && dataCapacity(v) * 8 < 4 + (v < 10 ? 8 : 16) + bytes.length * 8) v++;
  if (v > MAX_VERSION) throw new Error('too long for a QR code');
  const final = interleave(codewords(bytes, v), v);
  const template = base(v);
  const fixed = template.map((row) => row.map((x) => x !== null));
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = template.map((row) => row.slice());
    placeData(m, fixed, final);
    const fn = MASKS[mask];
    for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) if (!fixed[r][c] && fn(r, c)) m[r][c] ^= 1;
    writeFormat(m, mask, v);
    const score = penalty(m);
    if (!best || score < best.score) best = { m, score };
  }
  return best.m;
}
