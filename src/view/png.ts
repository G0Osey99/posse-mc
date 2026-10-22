// A small PNG codec (zlib only): decodes every non-interlaced colour type and bit depth to RGBA8,
// and encodes RGBA8 framebuffers. Mojang's assets and skins are non-interlaced; an interlaced file
// is reported as an error and the caller degrades.
import { deflate, deflateSync, inflateSync } from 'node:zlib';
import { promisify } from 'node:util';

export interface RgbaImage {
  width: number;
  height: number;
  /** width * height * 4 bytes, rows top to bottom. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Uint32Array | undefined;

export function crc32(buf: Uint8Array, crc = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export function isPng(buf: Uint8Array): boolean {
  return buf.length > 8 && Buffer.from(buf.subarray(0, 8)).equals(SIGNATURE);
}

/** Decodes a PNG to RGBA8. Throws on a malformed or interlaced file. */
export function decodePng(input: Uint8Array): RgbaImage {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isPng(buf)) throw new Error('Not a PNG');
  let p = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString('latin1', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
  }
  if (!width || !height || width > 8192 || height > 8192) throw new Error('Bad PNG size');
  if (interlace) throw new Error('Interlaced PNG not supported');
  const channels =
    type === 0 ? 1 : type === 2 ? 3 : type === 3 ? 1 : type === 4 ? 2 : type === 6 ? 4 : 0;
  if (!channels) throw new Error(`Bad PNG colour type ${type}`);
  const bpp = Math.max(1, (channels * depth) >> 3); // bytes per pixel for filtering
  const stride = (width * channels * depth + 7) >> 3;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('Truncated PNG');
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = y > 0 ? px[up + i] : 0;
      const c = i >= bpp && y > 0 ? px[up + i - bpp] : 0;
      let v: number;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`Bad PNG filter ${f}`);
      px[dst + i] = v & 0xff;
    }
  }
  const out = new Uint8Array(width * height * 4);
  const maxV = (1 << depth) - 1;
  // Sample n of row y, at any bit depth (16-bit keeps the high byte).
  const sample = (row: number, n: number): number => {
    if (depth === 8) return px[row + n];
    if (depth === 16) return px[row + n * 2];
    const bit = n * depth;
    const v = (px[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & maxV;
    return type === 3 ? v : Math.round((v * 255) / maxV);
  };
  const trnsGray = trns && type === 0 ? trns.readUInt16BE(0) : -1;
  const trnsRgb =
    trns && type === 2
      ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
      : undefined;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (type === 6) {
        out[o] = sample(row, x * 4);
        out[o + 1] = sample(row, x * 4 + 1);
        out[o + 2] = sample(row, x * 4 + 2);
        out[o + 3] = sample(row, x * 4 + 3);
      } else if (type === 2) {
        const r = sample(row, x * 3);
        const g = sample(row, x * 3 + 1);
        const b = sample(row, x * 3 + 2);
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] =
          trnsRgb && depth === 8 && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2]
            ? 0
            : 255;
      } else if (type === 3) {
        const i = sample(row, x);
        out[o] = palette ? palette[i * 3] : 0;
        out[o + 1] = palette ? palette[i * 3 + 1] : 0;
        out[o + 2] = palette ? palette[i * 3 + 2] : 0;
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (type === 0) {
        const g = sample(row, x);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = depth === 8 && g === trnsGray ? 0 : 255;
      } else {
        const g = sample(row, x * 2);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = sample(row, x * 2 + 1);
      }
    }
  }
  return { width, height, data: out };
}

function chunk(kind: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(kind, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body, crc32(head.subarray(4))), 0);
  return Buffer.concat([head, body, crc]);
}

/** Filtered scanlines of an RGBA image as RGB (alpha dropped) or RGBA, with the Sub filter. */
function scanlines(img: RgbaImage, alpha: boolean): Buffer {
  const ch = alpha ? 4 : 3;
  const stride = img.width * ch;
  const out = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    const o = y * (stride + 1);
    out[o] = 1; // Sub: frames are mostly flat runs, which this compresses well
    let pr = 0;
    let pg = 0;
    let pb = 0;
    let pa = 0;
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      const d = o + 1 + x * ch;
      const r = img.data[s];
      const g = img.data[s + 1];
      const b = img.data[s + 2];
      out[d] = (r - pr) & 0xff;
      out[d + 1] = (g - pg) & 0xff;
      out[d + 2] = (b - pb) & 0xff;
      pr = r;
      pg = g;
      pb = b;
      if (alpha) {
        const a = img.data[s + 3];
        out[d + 3] = (a - pa) & 0xff;
        pa = a;
      }
    }
  }
  return out;
}

function header(img: RgbaImage, alpha: boolean): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return chunk('IHDR', ihdr);
}

/** Encodes an RGBA8 image (synchronously). `alpha: false` writes RGB. */
export function encodePng(img: RgbaImage, alpha = true): Buffer {
  const data = deflateSync(scanlines(img, alpha), { level: 6 });
  return Buffer.concat([
    SIGNATURE,
    header(img, alpha),
    chunk('IDAT', data),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

const deflateAsync = promisify(deflate);

/** Like encodePng, but the compression runs on the libuv thread pool. */
export async function encodePngAsync(img: RgbaImage, alpha = true): Promise<Buffer> {
  const data = await deflateAsync(scanlines(img, alpha), { level: 6 });
  return Buffer.concat([
    SIGNATURE,
    header(img, alpha),
    chunk('IDAT', data),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
