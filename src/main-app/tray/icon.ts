/**
 * Minimal 16x16 RGBA PNG encoder — no external asset required.
 *
 * Produces a small blue "fairy" placeholder tray icon at runtime. The encoder
 * is intentionally tiny: signature + IHDR + one IDAT (zlib-deflated scanlines)
 * + IEND, with a manual CRC32. This avoids shipping an .ico/.png binary for
 * T13; T18 replaces it with a branded icon asset.
 */
import { deflateSync } from 'node:zlib';

const WIDTH = 16;
const HEIGHT = 16;
// Brand-ish blue #1677ff with full opacity
const R = 0x16;
const G = 0x77;
const B = 0xff;
const A = 0xff;

// ---- CRC32 (PNG uses the standard CRC-32/ISO-HDLC polynomial) ----
const CRC_TABLE: number[] = (() => {
  const table: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function makeTrayIconPng(): Buffer {
  // Signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // Raw image data: each scanline prefixed with filter byte (0 = None), then RGBA
  const rowLen = 1 + WIDTH * 4;
  const raw = Buffer.alloc(rowLen * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter: None
    for (let x = 0; x < WIDTH; x++) {
      const px = off + 1 + x * 4;
      // Simple inner gradient-ish look: lighten center pixels for a "dot" feel
      const isCenter = (x >= 4 && x <= 11 && y >= 4 && y <= 11);
      raw[px] = isCenter ? Math.min(255, R + 0x30) : R;
      raw[px + 1] = isCenter ? Math.min(255, G + 0x30) : G;
      raw[px + 2] = B;
      raw[px + 3] = A;
    }
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
