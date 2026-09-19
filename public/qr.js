// A small QR encoder: byte mode, error-correction level M, versions 1-10.
// That covers any LAN URL this app produces, and keeps the project
// dependency-free so `node server.js` runs with nothing installed.
//
// Returns a square array of booleans; true is a dark module.

// Level M: [ecCodewordsPerBlock, blocksInGroup1, dataPerBlock1, blocksInGroup2, dataPerBlock2]
const EC_M = {
  1:  [10, 1, 16, 0, 0],
  2:  [16, 1, 28, 0, 0],
  3:  [26, 1, 44, 0, 0],
  4:  [18, 2, 32, 0, 0],
  5:  [24, 2, 43, 0, 0],
  6:  [16, 4, 27, 0, 0],
  7:  [18, 4, 31, 0, 0],
  8:  [22, 2, 38, 2, 39],
  9:  [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// Version information blocks, only present from version 7 up.
const VERSION_BITS = {
  7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3,
};

/* ---------------------------- GF(256) ---------------------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      // Multiply by (x + alpha^i): the x term shifts, the constant scales.
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecCodewords(data, count) {
  const gen = generatorPoly(count);
  const rem = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < count; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

/* ---------------------------- bit stream ---------------------------- */
class Bits {
  constructor() { this.bits = []; }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  get length() { return this.bits.length; }
  toBytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] || 0);
      out.push(byte);
    }
    return out;
  }
}

const dataCapacity = (version) => {
  const [, b1, d1, b2, d2] = EC_M[version];
  return b1 * d1 + b2 * d2;
};

function pickVersion(byteLength) {
  for (let v = 1; v <= 10; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= dataCapacity(v) * 8) return v;
  }
  throw new Error("Too much data for a version-10 QR code");
}

/* ---------------------------- codewords ---------------------------- */
function buildCodewords(bytes, version) {
  const [ecCount, b1, d1, b2, d2] = EC_M[version];
  const bits = new Bits();
  bits.push(0b0100, 4);                              // byte mode
  bits.push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) bits.push(b, 8);

  const capacityBits = dataCapacity(version) * 8;
  bits.push(0, Math.min(4, capacityBits - bits.length));   // terminator
  while (bits.length % 8) bits.push(0, 1);
  const padBytes = [0xec, 0x11];
  for (let i = 0; bits.length < capacityBits; i++) bits.push(padBytes[i % 2], 8);

  const all = bits.toBytes();
  const blocks = [];
  let at = 0;
  for (let i = 0; i < b1; i++) { blocks.push(all.slice(at, at + d1)); at += d1; }
  for (let i = 0; i < b2; i++) { blocks.push(all.slice(at, at + d2)); at += d2; }
  const ecBlocks = blocks.map((b) => ecCodewords(b, ecCount));

  // Interleave: one codeword from each block in turn, data then EC.
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecCount; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

/* ---------------------------- matrix ---------------------------- */
function emptyMatrix(size) {
  return {
    cells: Array.from({ length: size }, () => new Array(size).fill(null)),
    reserved: Array.from({ length: size }, () => new Array(size).fill(false)),
    size,
  };
}

function placeFinder(m, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r, cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.size || cc >= m.size) continue;
      const edge = r === -1 || r === 7 || c === -1 || c === 7;
      const ring = (r === 0 || r === 6) && c >= 0 && c <= 6;
      const side = (c === 0 || c === 6) && r >= 0 && r <= 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m.cells[rr][cc] = edge ? false : (ring || side || core);
      m.reserved[rr][cc] = true;
    }
  }
}

function placeFunctionPatterns(m, version) {
  placeFinder(m, 0, 0);
  placeFinder(m, 0, m.size - 7);
  placeFinder(m, m.size - 7, 0);

  for (let i = 8; i < m.size - 8; i++) {           // timing
    const dark = i % 2 === 0;
    m.cells[6][i] = dark; m.reserved[6][i] = true;
    m.cells[i][6] = dark; m.reserved[i][6] = true;
  }

  const align = ALIGN[version];                   // alignment
  const last = align[align.length - 1];
  for (const r of align) {
    for (const c of align) {
      // Only the three patterns that would sit on a finder are omitted; the
      // ones centred on the timing line are drawn, and overwrite it.
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          m.cells[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m.reserved[r + dr][c + dc] = true;
        }
      }
    }
  }

  m.cells[m.size - 8][8] = true;                  // the always-dark module
  m.reserved[m.size - 8][8] = true;

  for (let i = 0; i < 9; i++) {                   // format-info area
    if (!m.reserved[8][i]) { m.cells[8][i] = false; m.reserved[8][i] = true; }
    if (!m.reserved[i][8]) { m.cells[i][8] = false; m.reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    if (!m.reserved[8][m.size - 1 - i]) { m.cells[8][m.size - 1 - i] = false; m.reserved[8][m.size - 1 - i] = true; }
    if (!m.reserved[m.size - 1 - i][8]) { m.cells[m.size - 1 - i][8] = false; m.reserved[m.size - 1 - i][8] = true; }
  }

  if (version >= 7) {
    const bits = VERSION_BITS[version];
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >> i) & 1) === 1;
      const a = Math.floor(i / 3), b = (i % 3) + m.size - 11;
      m.cells[b][a] = bit; m.reserved[b][a] = true;
      m.cells[a][b] = bit; m.reserved[a][b] = true;
    }
  }
}

function placeData(m, codewords) {
  let bitIndex = 0;
  const nextBit = () => {
    const byte = codewords[bitIndex >> 3];
    const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit === 1;
  };
  let upward = true;
  for (let right = m.size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;                    // the vertical timing column
    for (let step = 0; step < m.size; step++) {
      const row = upward ? m.size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (m.reserved[row][col]) continue;
        m.cells[row][col] = nextBit();
      }
    }
    upward = !upward;
  }
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

function applyMask(m, maskIndex) {
  const fn = MASKS[maskIndex];
  const out = m.cells.map((row) => row.slice());
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.reserved[r][c] && fn(r, c)) out[r][c] = !out[r][c];
    }
  }
  return out;
}

function formatBits(maskIndex) {
  // Level M is 0b00; BCH(15,5) with generator 0x537, masked with 0x5412.
  let value = (0b00 << 3) | maskIndex;
  let rem = value << 10;
  for (let i = 4; i >= 0; i--) if ((rem >> (i + 10)) & 1) rem ^= 0x537 << i;
  return (((value << 10) | rem) ^ 0x5412) & 0x7fff;
}

function writeFormat(cells, size, maskIndex) {
  const bits = formatBits(maskIndex);
  const bit = (i) => ((bits >> i) & 1) === 1;
  // Copy 1: down column 8 beside the top-left finder, then left along row 8.
  for (let i = 0; i <= 5; i++) cells[i][8] = bit(i);
  cells[7][8] = bit(6);
  cells[8][8] = bit(7);
  cells[8][7] = bit(8);
  for (let i = 9; i <= 14; i++) cells[8][14 - i] = bit(i);
  // Copy 2: along row 8 from the right edge, then up beside the bottom-left finder.
  for (let i = 0; i <= 7; i++) cells[8][size - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) cells[size - 15 + i][8] = bit(i);
  cells[size - 8][8] = true;
}

function penalty(cells, size) {
  let score = 0;
  const runScore = (line) => {
    let run = 1, total = 0;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else { if (run >= 5) total += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };
  for (let i = 0; i < size; i++) {
    score += runScore(cells[i]);
    score += runScore(cells.map((row) => row[i]));
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = cells[r][c];
      if (v === cells[r][c + 1] && v === cells[r + 1][c] && v === cells[r + 1][c + 1]) score += 3;
    }
  }
  const pattern = [true, false, true, true, true, false, true];
  const hasAt = (line, i) => {
    for (let k = 0; k < 7; k++) if (line[i + k] !== pattern[k]) return false;
    const before = line.slice(Math.max(0, i - 4), i);
    const after = line.slice(i + 7, i + 11);
    const quiet = (arr) => arr.length === 4 && arr.every((x) => x === false);
    return quiet(before) || quiet(after);
  };
  for (let i = 0; i < size; i++) {
    const row = cells[i], col = cells.map((r) => r[i]);
    for (let j = 0; j + 7 <= size; j++) {
      if (hasAt(row, j)) score += 40;
      if (hasAt(col, j)) score += 40;
    }
  }
  let dark = 0;
  for (const row of cells) for (const v of row) if (v) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/**
 * Encode `text` and return {size, cells, mask}; cells[r][c] is true for dark.
 * `mask` may be forced to one of 0-7, which is what the conformance test uses;
 * left alone, the lowest-penalty mask wins, as the spec requires.
 */
export function qrMatrix(text, { mask: forced } = {}) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length);
  const size = 17 + version * 4;
  const m = emptyMatrix(size);
  placeFunctionPatterns(m, version);
  placeData(m, buildCodewords(bytes, version));

  let best = null;
  const candidates = forced === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [forced];
  for (const mask of candidates) {
    const cells = applyMask(m, mask);
    writeFormat(cells, size, mask);
    const score = penalty(cells, size);
    if (!best || score < best.score) best = { score, cells, mask };
  }
  return { size, cells: best.cells, mask: best.mask };
}

/** Render a matrix as a standalone SVG string. */
export function qrSvg(text, { margin = 2, light = "#ffffff", dark = "#000000" } = {}) {
  const { size, cells } = qrMatrix(text);
  const dim = size + margin * 2;
  let path = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (cells[r][c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/></svg>`;
}
