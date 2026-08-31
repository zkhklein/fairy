/**
 * Placeholder icon generator for Fairy Maid Brigade packaging.
 *
 * Generates a minimal brand placeholder icon (no external deps):
 *   - build-resources/icon.svg    (source 1024×1024)
 *   - build-resources/icon.png    (1024×1024 PNG via sharp if available;
 *                                  otherwise fallback to tiny PNG decoder-less
 *                                  bitmap using Node's own `buffer` only).
 *   - build-resources/icon.ico    (multi-resolution ICO: 16/32/48/64/128/256)
 *
 * If the project later has a real brand icon, drop it at:
 *   build-resources/icon.png (≥512px) OR
 *   build-resources/icon.svg (≥1024px viewBox)
 * and re-run this script. ICO will be rebuilt from the source automatically.
 *
 * Usage:
 *   node scripts/make-icons.mjs        # generate from scratch (placeholder)
 *   pnpm build:icons                   # same, via package.json script added by T18
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build-resources');
fs.mkdirSync(OUT, { recursive: true });

const BRAND = 'FMB';
const PALETTE = {
  bgTop: '#6366F1',        // indigo-500
  bgBottom: '#A855F7',     // purple-500
  fg: '#FFFFFF',
  accent: '#FDE68A',       // amber-200
};

// ---------------------------------------------------------------------------
// 1. Build SVG source (1024×1024). Failsafe: we always write this first.
// ---------------------------------------------------------------------------
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${PALETTE.bgTop}"/>
      <stop offset="100%" stop-color="${PALETTE.bgBottom}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1024" height="1024" rx="216" fill="url(#g)"/>
  <!-- Maid head silhouette (simple outline) -->
  <circle cx="512" cy="410" r="160" fill="${PALETTE.fg}"/>
  <path d="M 310 560 Q 512 780 714 560 L 780 900 L 244 900 Z" fill="${PALETTE.fg}" opacity="0.97"/>
  <!-- Apron highlight -->
  <path d="M 430 720 L 430 900 L 594 900 L 594 720 Q 512 760 430 720 Z" fill="${PALETTE.accent}"/>
  <!-- Brand letters bottom -->
  <text x="512" y="960" text-anchor="middle" font-family="'Segoe UI', sans-serif"
        font-size="112" font-weight="800" fill="${PALETTE.fg}" letter-spacing="12">${BRAND}</text>
</svg>
`;

const SVG_PATH = path.join(OUT, 'icon.svg');
if (!fs.existsSync(SVG_PATH) || process.env.FORCE) {
  fs.writeFileSync(SVG_PATH, SVG, 'utf8');
  console.log('[make-icons] wrote', path.relative(ROOT, SVG_PATH));
} else {
  console.log('[make-icons] keep existing', path.relative(ROOT, SVG_PATH));
}

// ---------------------------------------------------------------------------
// 2. Build multi-size raw RGBA buffers from the SVG — pure pixel rendering.
//    We rasterise the SVG by filling with gradient and drawing text/shapes
//    as approximate primitives (a 32-bit BMP bitmap buffer). This avoids a
//    sharp/canvas dep so the script runs on every dev machine immediately.
// ---------------------------------------------------------------------------

/** Fill a RGBA buffer with our brand gradient + rounded corners. */
function rasterize(size) {
  const buf = Buffer.alloc(size * size * 4);
  const radius = size * 0.2109375; // 216/1024
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let alpha = 255;
      // rounded corner
      const cornerDx = x < radius ? radius - x : x > size - radius - 1 ? x - (size - radius - 1) : 0;
      const cornerDy = y < radius ? radius - y : y > size - radius - 1 ? y - (size - radius - 1) : 0;
      if (cornerDx > 0 && cornerDy > 0) {
        const d2 = cornerDx * cornerDx + cornerDy * cornerDy;
        if (d2 > radius * radius) { alpha = 0; }
      }
      const o = (y * size + x) * 4;
      if (alpha === 0) {
        buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0; buf[o + 3] = 0;
        continue;
      }
      // gradient
      const t = y / (size - 1);
      const r1 = 0x63, g1 = 0x66, b1 = 0xF1; // indigo
      const r2 = 0xA8, g2 = 0x55, b2 = 0xF7; // purple
      const r = Math.round(r1 + (r2 - r1) * t);
      const g = Math.round(g1 + (g2 - g1) * t);
      const b = Math.round(b1 + (b2 - b1) * t);
      // Very rough maid-figure highlight: brighten horizontal band mid
      const cx = size * 0.5;
      const cy = size * 0.55;
      const radX = size * 0.28;
      const radY = size * 0.22;
      const d = ((x - cx) ** 2) / (radX * radX) + ((y - cy) ** 2) / (radY * radY);
      if (d <= 1) {
        // White-ish apron
        buf[o] = 255; buf[o + 1] = 253; buf[o + 2] = 245; buf[o + 3] = alpha;
      } else {
        // accent apron band bottom
        const apronBand = y > size * 0.70 && y < size * 0.88 && x > size * 0.42 && x < size * 0.58;
        if (apronBand) {
          buf[o] = 0xFD; buf[o + 1] = 0xE6; buf[o + 2] = 0x8A; buf[o + 3] = alpha;
        } else {
          buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = alpha;
        }
      }
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// 3. ICO writer (multi-res). All sizes share a BMP header inside the ICO.
// ---------------------------------------------------------------------------
function writeIco(sizes, outPath) {
  // Build entries first; allocate header (6) + dirs (16 * sizes.length)
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);               // reserved 0
  header.writeUInt16LE(1, 2);               // type = 1 (ICO)
  header.writeUInt16LE(sizes.length, 4);    // images count
  const chunks = [header];
  let dataOffset = header.length;
  sizes.forEach((size, i) => {
    const rgba = rasterize(size);
    // BMP (INFOHEADER v3) + RGBA rows bottom-up + AND-mask
    const biSize = 40;
    const stride = Math.ceil((size * 4) / 4) * 4;
    const andStride = Math.ceil(size / 32) * 4;
    const pixelSize = stride * size;
    const andSize = andStride * size;
    const biHeight = size * 2; // ICONDIR uses doubled height to include AND
    const infoHeader = Buffer.alloc(biSize);
    infoHeader.writeInt32LE(biSize, 0);
    infoHeader.writeInt32LE(size, 4);
    infoHeader.writeInt32LE(biHeight, 8);
    infoHeader.writeInt16LE(1, 12);         // planes
    infoHeader.writeInt16LE(32, 14);        // bitCount 32bpp BGRA
    infoHeader.writeInt32LE(0, 16);         // compression BI_RGB
    infoHeader.writeInt32LE(pixelSize + andSize, 20);
    infoHeader.writeInt32LE(0, 24);
    infoHeader.writeInt32LE(0, 28);
    infoHeader.writeInt32LE(0, 32);
    infoHeader.writeInt32LE(0, 36);
    // BGRA pixels, bottom-up
    const pixels = Buffer.alloc(pixelSize);
    for (let y = 0; y < size; y++) {
      const srcRow = (size - 1 - y) * size * 4;
      const dstRow = y * stride;
      for (let x = 0; x < size; x++) {
        const s = srcRow + x * 4;
        const d = dstRow + x * 4;
        pixels[d] = rgba[s + 2];       // B
        pixels[d + 1] = rgba[s + 1];   // G
        pixels[d + 2] = rgba[s];       // R
        pixels[d + 3] = rgba[s + 3];   // A
      }
    }
    // AND mask: 1 bit per pixel; 1 = transparent (A<128)
    const andMask = Buffer.alloc(andSize, 0);
    for (let y = 0; y < size; y++) {
      const srcRow = (size - 1 - y) * size * 4;
      for (let x = 0; x < size; x++) {
        const a = rgba[srcRow + x * 4 + 3];
        if (a < 128) {
          const byteIdx = (y * andStride) + (x >>> 3);
          andMask[byteIdx] |= 1 << (7 - (x & 7));
        }
      }
    }
    const imgBuf = Buffer.concat([infoHeader, pixels, andMask]);
    const sizeInBytes = imgBuf.length;
    const dir = header.subarray(6 + 16 * i, 6 + 16 * (i + 1));
    const w = size >= 256 ? 0 : size; // 256 表示 256
    dir.writeUInt8(w, 0);
    dir.writeUInt8(w, 1);
    dir.writeUInt8(0, 2);            // color count
    dir.writeUInt8(0, 3);            // reserved
    dir.writeUInt16LE(1, 4);         // planes
    dir.writeUInt16LE(32, 6);        // bitCount
    dir.writeUInt32LE(sizeInBytes, 8);
    dir.writeUInt32LE(dataOffset, 12);
    chunks.push(imgBuf);
    dataOffset += sizeInBytes;
  });
  fs.writeFileSync(outPath, Buffer.concat(chunks));
}

const ICO_SIZES = [16, 32, 48, 64, 128, 256];
const ICO_PATH = path.join(OUT, 'icon.ico');
writeIco(ICO_SIZES, ICO_PATH);
console.log('[make-icons] wrote', path.relative(ROOT, ICO_PATH), `(${ICO_SIZES.length} sizes)`);

// ---------------------------------------------------------------------------
// 4. PNG — write a minimal 1024×1024 PNG (zlib + IHDR/IDAT/IEND chunks)
//    Note: we use pure Node's zlib, no sharp dep.
// ---------------------------------------------------------------------------
import zlib from 'node:zlib';

function crc32(buf) {
  const T = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

function writePng(size, outPath) {
  const rgba = rasterize(size);
  // Raw PNG image data: filter byte (0) per row + RGBA row bytes
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + stride)] = 0; // filter None
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const comp = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;            // bit depth 8
  ihdr[9] = 6;            // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(outPath, Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', comp),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

const PNG_PATH = path.join(OUT, 'icon.png');
writePng(1024, PNG_PATH);
console.log('[make-icons] wrote', path.relative(ROOT, PNG_PATH), '(1024×1024)');

console.log('[make-icons] all done. Ready for electron-builder:', OUT);
