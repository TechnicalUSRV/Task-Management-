// A small QR code encoder (byte mode, error correction level M, versions 1–10: up to 213 bytes). Used for the
// Telegram connect link, so people can scan it from the Task Controlling Management screen with their phone. Pure JavaScript, no network.
const BLOCKS = [null, // [ecc codewords per block, [blocks, data codewords], [blocks, data codewords]?]
 [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const gfMul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; };
function divisor(degree) {
 const r = new Array(degree).fill(0); r[degree - 1] = 1; let root = 1;
 for (let i = 0; i < degree; i++) { for (let j = 0; j < degree; j++) { r[j] = gfMul(r[j], root); if (j + 1 < degree) r[j] ^= r[j + 1]; } root = gfMul(root, 2); }
 return r;
}
function remainder(data, div) {
 const r = div.map(() => 0);
 for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
 return r;
}
const dataCapacity = v => { const [, a, b] = BLOCKS[v]; return a[0] * a[1] + (b ? b[0] * b[1] : 0); };

/** Returns {size, modules} where modules[row][col] is true for a dark module, or throws if the text is too long. */
export function qrMatrix(text) {
 const bytes = [...new TextEncoder().encode(String(text))];
 let version = 1;
 for (; version <= 10; version++) if (4 + (version < 10 ? 8 : 16) + bytes.length * 8 <= dataCapacity(version) * 8) break;
 if (version > 10) throw new Error('Text is too long for this QR code.');
 // Data bits: byte mode, length, bytes, terminator, padding.
 const bits = [], put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
 put(4, 4); put(bytes.length, version < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
 const capacity = dataCapacity(version) * 8;
 put(0, Math.min(4, capacity - bits.length)); while (bits.length % 8) bits.push(0);
 for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
 const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
 // Error correction per block, then interleave.
 const [eccLen, ...groups] = BLOCKS[version], div = divisor(eccLen), blocks = [];
 let at = 0; for (const [count, len] of groups) for (let i = 0; i < count; i++) { const d = data.slice(at, at + len); at += len; blocks.push({ d, e: remainder(d, div) }); }
 const codewords = [], longest = Math.max(...blocks.map(b => b.d.length));
 for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.d.length) codewords.push(b.d[i]);
 for (let i = 0; i < eccLen; i++) for (const b of blocks) codewords.push(b.e[i]);

 const size = version * 4 + 17;
 const modules = Array.from({ length: size }, () => new Array(size).fill(false)), fixed = Array.from({ length: size }, () => new Array(size).fill(false));
 const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };
 for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
 for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
  const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy)); if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
 }
 const align = ALIGN[version], last = align.length - 1;
 align.forEach((ax, i) => align.forEach((ay, j) => {
  if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
 }));
 const formatBits = mask => { const d = mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); return ((d << 10) | r) ^ 0x5412; }; // level M = 00
 const drawFormat = mask => {
  const b = formatBits(mask), bit = i => ((b >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
 };
 drawFormat(0);
 if (version >= 7) {
  let r = version; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
  const b = (version << 12) | r;
  for (let i = 0; i < 18; i++) { const dark = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, dark); set(c, a, dark); }
 }
 // Place the codewords in the zigzag order, leaving the remainder bits light.
 let i = 0; const total = codewords.length * 8;
 for (let right = size - 1; right >= 1; right -= 2) {
  if (right === 6) right = 5;
  for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
   const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
   if (!fixed[y][x] && i < total) { modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
  }
 }
 const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
 const apply = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[m](x, y)) modules[y][x] = !modules[y][x]; };
 let best = 0, bestScore = Infinity;
 for (let m = 0; m < 8; m++) { apply(m); drawFormat(m); const s = penalty(modules, size); if (s < bestScore) { bestScore = s; best = m; } apply(m); }
 apply(best); drawFormat(best);
 return { size, modules, version, mask: best };
}

function penalty(m, size) {
 let score = 0, dark = 0;
 const lines = [];
 for (let y = 0; y < size; y++) lines.push(m[y]);
 for (let x = 0; x < size; x++) lines.push(m.map(row => row[x]));
 for (const line of lines) {
  let run = 1;
  for (let i = 1; i <= size; i++) {
   if (i < size && line[i] === line[i - 1]) run++;
   else { if (run >= 5) score += 3 + run - 5; run = 1; }
  }
  const s = line.map(v => (v ? '1' : '0')).join('');
  for (let at = s.indexOf('1011101'); at !== -1; at = s.indexOf('1011101', at + 1)) {
   const before = s.slice(Math.max(0, at - 4), at), after = s.slice(at + 7, at + 11);
   if ((at >= 4 && before === '0000') || (at + 11 <= size && after === '0000')) score += 40;
  }
 }
 for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3; }
 for (const row of m) for (const v of row) if (v) dark++;
 score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
 return score;
}

/** SVG path data for the dark modules, with a quiet zone of `margin` modules; the view box is (size + 2 × margin) square. */
export function qrPath(text, margin = 4) {
 const { size, modules } = qrMatrix(text);
 let d = '';
 for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
 return { d, view: size + margin * 2 };
}
