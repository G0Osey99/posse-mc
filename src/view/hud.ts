// The in-game overlay, drawn into the rendered frame on the calling thread: crosshair (inverted, like
// the game), hotbar with item icons and counts, experience bar, hearts and food, player nametags
// and a caption. Uses the version's own GUI sprites and font; the palette pack has none, so shapes
// and a system font stand in.
import type { HudAssets } from './assets/pack.js';
import { projectPoint } from './camera.js';
import type { RgbaImage } from './png.js';
import type { ViewScene } from './types.js';

/** The game's automatic GUI scale for a window size. */
export function guiScale(width: number, height: number): number {
  return Math.max(1, Math.min(Math.floor(width / 320), Math.floor(height / 240)));
}

/** Alpha-blends an image (nearest-neighbour scaled) into the frame. `invert` uses the crosshair's blend. */
export function blit(
  frame: RgbaImage,
  img: RgbaImage,
  x: number,
  y: number,
  scale: number,
  opts: {
    invert?: boolean;
    opacity?: number;
    tint?: number;
    sx?: number;
    sy?: number;
    sw?: number;
    sh?: number;
  } = {},
): void {
  const sx0 = opts.sx ?? 0;
  const sy0 = opts.sy ?? 0;
  const sw = opts.sw ?? img.width;
  const sh = opts.sh ?? img.height;
  const W = Math.round(sw * scale);
  const H = Math.round(sh * scale);
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const op = opts.opacity ?? 1;
  const tr = opts.tint !== undefined ? ((opts.tint >> 16) & 255) / 255 : 1;
  const tg = opts.tint !== undefined ? ((opts.tint >> 8) & 255) / 255 : 1;
  const tb = opts.tint !== undefined ? (opts.tint & 255) / 255 : 1;
  // Only the part on screen is walked (a huge scale must not cost its full size).
  const j1 = Math.min(H, frame.height - y0);
  const i1 = Math.min(W, frame.width - x0);
  for (let j = Math.max(0, -y0); j < j1; j++) {
    const fy = y0 + j;
    const iy = sy0 + Math.min(sh - 1, Math.floor(j / scale));
    for (let i = Math.max(0, -x0); i < i1; i++) {
      const fx = x0 + i;
      const ix = sx0 + Math.min(sw - 1, Math.floor(i / scale));
      const s = (iy * img.width + ix) * 4;
      const a = (img.data[s + 3] / 255) * op;
      if (a <= 0) continue;
      const d = (fy * frame.width + fx) * 4;
      if (opts.invert) {
        // ONE_MINUS_DST_COLOR, ONE_MINUS_SRC_COLOR: the crosshair inverts what is behind it.
        for (let c = 0; c < 3; c++) {
          const src = (img.data[s + c] / 255) * a;
          const dst = frame.data[d + c] / 255;
          frame.data[d + c] = Math.round(Math.min(1, src * (1 - dst) + dst * (1 - src)) * 255);
        }
        continue;
      }
      frame.data[d] = Math.round(frame.data[d] * (1 - a) + img.data[s] * tr * a);
      frame.data[d + 1] = Math.round(frame.data[d + 1] * (1 - a) + img.data[s + 1] * tg * a);
      frame.data[d + 2] = Math.round(frame.data[d + 2] * (1 - a) + img.data[s + 2] * tb * a);
    }
  }
}

export function fillRect(
  frame: RgbaImage,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: number,
  alpha: number,
): void {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(frame.width, Math.round(x + w));
  const y1 = Math.min(frame.height, Math.round(y + h));
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  for (let j = y0; j < y1; j++) {
    for (let i = x0; i < x1; i++) {
      const d = (j * frame.width + i) * 4;
      frame.data[d] = Math.round(frame.data[d] * (1 - alpha) + r * alpha);
      frame.data[d + 1] = Math.round(frame.data[d + 1] * (1 - alpha) + g * alpha);
      frame.data[d + 2] = Math.round(frame.data[d + 2] * (1 - alpha) + b * alpha);
    }
  }
}

/** Printable ASCII only; other characters draw as `?`. */
const glyph = (ch: string): number => {
  const c = ch.charCodeAt(0);
  return c >= 32 && c < 127 ? c : 63;
};

export function textWidth(hud: HudAssets, text: string): number {
  const w = hud.fontWidths;
  if (!w) return text.length * 6;
  let n = 0;
  for (const ch of text) n += w[glyph(ch)] ?? 6;
  return Math.max(0, n - 1);
}

/** Draws text with the game's bitmap font (`scale` may be fractional); returns false without a font. */
export function drawText(
  frame: RgbaImage,
  hud: HudAssets,
  text: string,
  x: number,
  y: number,
  scale: number,
  rgb = 0xffffff,
  shadow = true,
): boolean {
  const font = hud.font;
  const widths = hud.fontWidths;
  if (!font || !widths) return false;
  const cell = font.width / 16;
  const pass = (ox: number, oy: number, color: number): void => {
    let cx = x + ox;
    for (const ch of text) {
      const g = glyph(ch);
      blit(frame, font, cx, y + oy, (scale * 8) / cell, {
        sx: (g % 16) * cell,
        sy: Math.floor(g / 16) * cell,
        sw: cell,
        sh: cell,
        tint: color,
      });
      cx += (widths[g] ?? 6) * scale;
    }
  };
  if (shadow) {
    // The game's shadow: the colour at a quarter brightness, one pixel down-right.
    pass(scale, scale, ((rgb >> 2) & 0x3f3f3f) >>> 0);
  }
  pass(0, 0, rgb);
  return true;
}

let canvasMod: typeof import('@napi-rs/canvas') | null | undefined;

/** System-font text for packs without the game font (the palette fallback). */
async function drawFallbackText(
  frame: RgbaImage,
  text: string,
  x: number,
  y: number,
  px: number,
): Promise<void> {
  if (canvasMod === undefined) {
    try {
      canvasMod = await import('@napi-rs/canvas');
    } catch {
      canvasMod = null;
    }
  }
  if (!canvasMod) return;
  const w = Math.ceil(text.length * px * 0.7) + 4;
  const h = Math.ceil(px * 1.4);
  const c = canvasMod.createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.font = `${px}px monospace`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#3f3f3f';
  ctx.fillText(text, 1, 1);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  blit(
    frame,
    {
      width: w,
      height: h,
      data: new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength),
    },
    x,
    y,
    1,
  );
}

async function text(
  frame: RgbaImage,
  hud: HudAssets,
  s: string,
  x: number,
  y: number,
  scale: number,
  rgb = 0xffffff,
  shadow = true,
): Promise<void> {
  if (!drawText(frame, hud, s, x, y, scale, rgb, shadow))
    await drawFallbackText(frame, s, x, y - scale, Math.round(9 * scale));
}

/**
 * The game's vignette (fancy graphics): the frame darkens towards the edges by the vignette
 * texture times (1 - brightness at the eyes), so it shows in caves and at night, not in daylight.
 */
export function drawVignette(frame: RgbaImage, hud: HudAssets, eyeBrightness: number): void {
  const v = hud.sprites.vignette;
  const k = Math.max(0, Math.min(1, 1 - eyeBrightness));
  if (!v || k <= 0.01) return;
  for (let y = 0; y < frame.height; y++) {
    const vy = Math.min(v.height - 1, Math.floor((y * v.height) / frame.height));
    for (let x = 0; x < frame.width; x++) {
      const vx = Math.min(v.width - 1, Math.floor((x * v.width) / frame.width));
      const s = (vy * v.width + vx) * 4;
      const d = (y * frame.width + x) * 4;
      // Blend ZERO, ONE_MINUS_SRC_COLOR with the texture tinted by k.
      frame.data[d] = Math.round(frame.data[d] * (1 - (v.data[s] / 255) * k));
      frame.data[d + 1] = Math.round(frame.data[d + 1] * (1 - (v.data[s + 1] / 255) * k));
      frame.data[d + 2] = Math.round(frame.data[d + 2] * (1 - (v.data[s + 2] / 255) * k));
    }
  }
}

/** Names above players, sized by distance like the game's (0.025 blocks per font pixel). */
export async function drawNametags(
  frame: RgbaImage,
  hud: HudAssets,
  scene: ViewScene,
): Promise<void> {
  const tags = scene.entities
    .filter((e) => e.label)
    .map((e) => ({
      e,
      p: projectPoint(
        scene.camera,
        frame.width,
        frame.height,
        e.x,
        e.y + (e.height || 1.8) + 0.5,
        e.z,
      ),
    }))
    .filter(
      (t): t is { e: (typeof t)['e']; p: NonNullable<(typeof t)['p']> } =>
        t.p !== null && t.p.depth > 0.3 && t.p.depth < 64,
    )
    .sort((a, b) => b.p.depth - a.p.depth);
  const th = Math.tan(((scene.camera.fov ?? 70) * Math.PI) / 360);
  for (const { e, p } of tags) {
    // The game's size (0.025 blocks per font pixel), but never so small that the name is unreadable.
    // ...nor larger than a sixth of the frame.
    const scale = Math.min(
      frame.height / 48,
      Math.max(0.5, (0.025 / (p.depth * th)) * (frame.height / 2)),
    );
    const label = e.label!.slice(0, 32);
    const w = textWidth(hud, label) * scale;
    const x = p.x - w / 2;
    const y = p.y - 8 * scale;
    fillRect(frame, x - scale, y - scale, w + 2 * scale, 9 * scale, 0x000000, 0.25);
    await text(frame, hud, label, x, y, scale, 0xffffff, false);
  }
}

/** Crosshair, hotbar, experience bar, health and food, caption. */
export async function drawHud(
  frame: RgbaImage,
  hud: HudAssets,
  state: NonNullable<ViewScene['hud']>,
): Promise<void> {
  const s = guiScale(frame.width, frame.height);
  const W = frame.width;
  const H = frame.height;
  const sp = hud.sprites;
  const cx = Math.floor(W / 2);

  if (sp.crosshair)
    blit(
      frame,
      sp.crosshair,
      cx - Math.floor((sp.crosshair.width * s) / 2),
      Math.floor(H / 2) - Math.floor((sp.crosshair.height * s) / 2),
      s,
      { invert: true },
    );
  else {
    fillRect(frame, cx - 4 * s, Math.floor(H / 2), 9 * s, s, 0xffffff, 0.8);
    fillRect(frame, cx, Math.floor(H / 2) - 4 * s, s, 9 * s, 0xffffff, 0.8);
  }

  const hx = cx - 91 * s;
  const hy = H - 22 * s;
  if (sp.hotbar) blit(frame, sp.hotbar, hx, hy, s);
  else {
    fillRect(frame, hx, hy, 182 * s, 22 * s, 0x000000, 0.45);
    for (let i = 0; i < 9; i++)
      fillRect(frame, hx + (i * 20 + 2) * s, hy + 2 * s, 18 * s, 18 * s, 0x8b8b8b, 0.35);
  }
  const sel = Math.max(0, Math.min(8, state.selectedSlot | 0));
  if (sp.hotbar_selection) blit(frame, sp.hotbar_selection, hx - s + sel * 20 * s, hy - s, s);
  else {
    const x = hx - s + sel * 20 * s;
    fillRect(frame, x, hy - s, 24 * s, 2 * s, 0xffffff, 0.9);
    fillRect(frame, x, hy + 21 * s, 24 * s, 2 * s, 0xffffff, 0.9);
    fillRect(frame, x, hy - s, 2 * s, 24 * s, 0xffffff, 0.9);
    fillRect(frame, x + 22 * s, hy - s, 2 * s, 24 * s, 0xffffff, 0.9);
  }
  for (let i = 0; i < 9; i++) {
    const item = state.hotbar[i];
    if (!item) continue;
    const ix = hx + (i * 20 + 3) * s;
    const iy = hy + 3 * s;
    const icon = hud.items[item.name.replace(/^minecraft:/, '')];
    if (icon) blit(frame, icon, ix, iy, s);
    else fillRect(frame, ix + 3 * s, iy + 3 * s, 10 * s, 10 * s, 0xa0a0a0, 0.8);
    if (item.count > 1) {
      const label = String(item.count);
      await text(frame, hud, label, ix + 17 * s - textWidth(hud, label) * s, iy + 9 * s, s);
    }
  }

  // Experience bar (empty: the scene carries no experience).
  if (sp.xp_bar) blit(frame, sp.xp_bar, hx, H - 29 * s, s);

  // Hearts (left) and food (right), 10 icons each, two points per icon.
  const rowY = H - 39 * s;
  const health = Math.max(0, Math.min(20, Math.ceil(state.health)));
  const food = Math.max(0, Math.min(20, Math.ceil(state.food)));
  for (let i = 0; i < 10; i++) {
    const x = hx + i * 8 * s;
    if (sp.heart_container) blit(frame, sp.heart_container, x, rowY, s);
    const v = health - i * 2;
    const heart = v >= 2 ? sp.heart_full : v === 1 ? sp.heart_half : undefined;
    if (heart) blit(frame, heart, x, rowY, s);
    else if (!sp.heart_container && v > 0)
      fillRect(frame, x + s, rowY + s, (v >= 2 ? 7 : 3.5) * s, 7 * s, 0xd01818, 1);
    const fx = cx + 91 * s - 9 * s - i * 8 * s;
    if (sp.food_empty) blit(frame, sp.food_empty, fx, rowY, s);
    const f = food - i * 2;
    const icon = f >= 2 ? sp.food_full : f === 1 ? sp.food_half : undefined;
    if (icon) blit(frame, icon, fx, rowY, s);
    else if (!sp.food_empty && f > 0)
      fillRect(frame, fx + s, rowY + s, (f >= 2 ? 7 : 3.5) * s, 7 * s, 0x9a6a3a, 1);
  }

  if (state.caption) {
    const label = state.caption.slice(0, 64);
    const w = textWidth(hud, label) * s;
    fillRect(frame, s, s, w + 3 * s, 11 * s, 0x505050, 0.56);
    await text(frame, hud, label, 2 * s, 3 * s, s, 0xe0e0e0);
  }
}
