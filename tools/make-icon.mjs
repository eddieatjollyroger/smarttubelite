// Generates public/icon.png: the icon served to VIDAA's app installer and to
// the web manifest. Pure Node (zlib only), so the build kit stays dependency
// free. Run: node tools/make-icon.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 192, H = 192, SS = 2;

function insideRounded(x, y) {
  const l = 24, t = 24, r = 168, b = 168, rad = 30;
  if (x < l || x > r || y < t || y > b) return false;
  const cx = x < l + rad ? l + rad : x > r - rad ? r - rad : x;
  const cy = y < t + rad ? t + rad : y > b - rad ? b - rad : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function insideTriangle(x, y) {
  // Play triangle: (80,64) (80,128) (136,96) with softened edges below.
  const ax = 80, ay = 64, bx = 80, by = 128, cx = 136, cy = 96;
  const d1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const d2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
  const d3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}

function sample(px, py) {
  // 2x2 supersampling for clean edges on a low-DPI TV.
  let red = 0, white = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = px + (sx + 0.5) / SS;
      const y = py + (sy + 0.5) / SS;
      if (insideRounded(x, y)) red++;
      if (insideTriangle(x, y)) white++;
    }
  }
  const bg = [11, 11, 12], rail = [255, 0, 51], fg = [255, 255, 255];
  const a = red / (SS * SS), b = white / (SS * SS);
  const out = [];
  for (let i = 0; i < 3; i++) {
    out.push(Math.round(bg[i] * (1 - a) + rail[i] * a) * (1 - b) + fg[i] * b);
  }
  return out;
}

const raw = Buffer.alloc(H * (1 + W * 4));
let p = 0;
for (let y = 0; y < H; y++) {
  raw[p++] = 0; // PNG filter: none
  for (let x = 0; x < W; x++) {
    const [r, g, bl] = sample(x, y);
    raw[p++] = r; raw[p++] = g; raw[p++] = bl; raw[p++] = 255;
  }
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([len, tag, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(ROOT, 'public', 'icon.png'), png);
console.log('wrote public/icon.png', png.length, 'bytes');
