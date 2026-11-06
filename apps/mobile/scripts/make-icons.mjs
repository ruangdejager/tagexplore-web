// Draws the home-screen icons as PNGs with no image library: a dark olive
// square with a green tag dot and two discovery "waves" around it, in the web
// app's palette. Run with `npm run icons --workspace @tagexplore/mobile`; the
// output is committed under public/icons.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x12, 0x14, 0x0f];
const BG2 = [0x1b, 0x1e, 0x17];
const GREEN = [0x4f, 0xbf, 0x8b];
const AMBER = [0xe9, 0xae, 0x2f];

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));

/** `scale` shrinks the artwork toward the centre — maskable icons need a safe zone. */
function icon(size, scale) {
  const c = size / 2;
  const unit = (size / 100) * scale;
  const aa = 1; // one pixel of edge softening
  return png(size, (x, y) => {
    const dx = x - c;
    // Centre of the mark sits below the middle, so the waves above it balance.
    const dy = y - (c + 14 * unit);
    const d = Math.hypot(dx, dy);
    // Soft radial lift behind the mark.
    let col = mix(BG2, BG, Math.hypot(x - c, y - c) / (size * 0.7));

    // Two arcs above the tag: the discovery waves.
    const angle = Math.atan2(dy, dx);
    const inArc = angle > -Math.PI * 0.95 && angle < -Math.PI * 0.05;
    for (const [r, w, alpha] of [
      [26, 5, 0.85],
      [38, 5, 0.55],
    ]) {
      if (!inArc) continue;
      const edge = Math.abs(d - r * unit) - (w * unit) / 2;
      col = mix(col, GREEN, (1 - edge / aa) * alpha);
    }
    // The tag itself, with a small amber battery dot.
    col = mix(col, GREEN, 1 - (d - 13 * unit) / aa);
    col = mix(col, BG, 1 - (d - 5 * unit) / aa);
    col = mix(col, AMBER, 1 - (d - 3 * unit) / aa);
    return col;
  });
}

const files = {
  'apple-touch-icon.png': icon(180, 1),
  'icon-192.png': icon(192, 1),
  'icon-512.png': icon(512, 1),
  'icon-maskable-512.png': icon(512, 0.78),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(outDir, name), data);
  console.log(`wrote ${name} (${data.length} bytes)`);
}
