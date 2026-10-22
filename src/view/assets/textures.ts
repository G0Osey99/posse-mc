// Texture helpers for pack building: frame extraction, 16×16 tiles, transparency flags, mip levels
// and the atlas.
import type { RgbaImage } from '../png.js';

export const TILE = 16;
export const ATLAS_COLS = 64;
export const MIP_LEVELS = 5; // 16, 8, 4, 2, 1

/** The first animation frame (top square) of a texture strip, resampled to 16×16 (nearest). */
export function toTile(img: RgbaImage): Uint8Array {
  const frame = Math.min(img.width, img.height);
  const out = new Uint8Array(TILE * TILE * 4);
  for (let y = 0; y < TILE; y++) {
    const sy = Math.floor(((y + 0.5) * frame) / TILE);
    for (let x = 0; x < TILE; x++) {
      const sx = Math.floor(((x + 0.5) * frame) / TILE);
      const s = (sy * img.width + sx) * 4;
      const d = (y * TILE + x) * 4;
      out[d] = img.data[s];
      out[d + 1] = img.data[s + 1];
      out[d + 2] = img.data[s + 2];
      out[d + 3] = img.data[s + 3];
    }
  }
  return out;
}

/** TF bits of a tile: CUTOUT (1) when texels are see-through, TRANSLUCENT (2) when many are partly. */
export function tileFlags(tile: Uint8Array): number {
  let clear = 0;
  let partial = 0;
  const n = tile.length / 4;
  for (let i = 0; i < n; i++) {
    const a = tile[i * 4 + 3];
    if (a < 128) clear++;
    if (a >= 16 && a < 240) partial++;
  }
  let flags = 0;
  if (clear > 0) flags |= 1;
  if (partial >= n * 0.1) flags |= 2;
  return flags;
}

/** Average colour of the opaque texels (0xRRGGBB). */
export function tileAverage(tile: Uint8Array): number {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i < tile.length; i += 4) {
    const a = tile[i + 3];
    r += tile[i] * a;
    g += tile[i + 1] * a;
    b += tile[i + 2] * a;
    w += a;
  }
  if (!w) return 0x808080;
  return (Math.round(r / w) << 16) | (Math.round(g / w) << 8) | Math.round(b / w);
}

/** Lays tiles out in an atlas ATLAS_COLS wide and builds every mip level (alpha-weighted box filter). */
export function buildAtlasMips(tiles: Uint8Array[]): {
  cols: number;
  rows: number;
  mips: Uint8Array[];
} {
  const cols = ATLAS_COLS;
  const rows = Math.max(1, Math.ceil(tiles.length / cols));
  const mips: Uint8Array[] = [];
  let level = tiles;
  for (let l = 0; l < MIP_LEVELS; l++) {
    const ts = TILE >> l;
    const W = cols * ts;
    const atlas = new Uint8Array(W * rows * ts * 4);
    for (let i = 0; i < level.length; i++) {
      const tx = (i % cols) * ts;
      const ty = Math.floor(i / cols) * ts;
      const t = level[i];
      for (let y = 0; y < ts; y++)
        atlas.set(t.subarray(y * ts * 4, (y + 1) * ts * 4), ((ty + y) * W + tx) * 4);
    }
    mips.push(atlas);
    if (l < MIP_LEVELS - 1) level = level.map((t) => downsample(t, ts));
  }
  return { cols, rows, mips };
}

/** Halves a ts×ts tile: colour averaged over the visible texels, alpha averaged. */
export function downsample(t: Uint8Array, ts: number): Uint8Array {
  const hs = ts >> 1;
  const out = new Uint8Array(hs * hs * 4);
  for (let y = 0; y < hs; y++) {
    for (let x = 0; x < hs; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < 4; k++) {
        const s = ((y * 2 + (k >> 1)) * ts + x * 2 + (k & 1)) * 4;
        const al = t[s + 3];
        r += t[s] * al;
        g += t[s + 1] * al;
        b += t[s + 2] * al;
        a += al;
      }
      const d = (y * hs + x) * 4;
      if (a > 0) {
        out[d] = Math.round(r / a);
        out[d + 1] = Math.round(g / a);
        out[d + 2] = Math.round(b / a);
      }
      out[d + 3] = Math.round(a / 4);
    }
  }
  return out;
}

/** A sub-rectangle of an image (clamped to its bounds). */
export function crop(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const sx = Math.min(img.width - 1, x + i);
      const sy = Math.min(img.height - 1, y + j);
      data.set(
        img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4),
        (j * w + i) * 4,
      );
    }
  }
  return { width: w, height: h, data };
}
