// Builds a ViewPack from a client jar: block models per state, the texture atlas, biome colours,
// sky textures, default skins and the HUD (sprites, font, item icons).
import minecraftData from 'minecraft-data';
import { decodePng, type RgbaImage } from '../png.js';
import type { KernelPack } from '../kernelTypes.js';
import type { ZipReader } from './zip.js';
import {
  DIRS,
  normalizeName,
  resolveModel,
  resolveTexture,
  selectAlternatives,
  textureRef,
  type BlockstateJson,
  type ModelJson,
  type ResolvedElement,
  type ResolvedModel,
} from './models.js';
import { blockFactsFor, isPreFlattening, stateTableFor, type StateProps } from './states.js';
import {
  PackBuilder,
  asKernelImage,
  atlasFields,
  buildBiomeTables,
  buildStateArrays,
  type HudAssets,
  type PlacedModel,
  type StateModel,
  type ViewPack,
} from './pack.js';
import { crop, toTile } from './textures.js';

const ROOT = 'assets/minecraft/';

/** A full-face element (0–16) with the given texture per face (null = not drawn). */
export function boxElement(
  from: [number, number, number],
  to: [number, number, number],
  textures: Array<string | null | undefined>,
  opts: { tint?: boolean } = {},
): ResolvedElement {
  return {
    from,
    to,
    rotAxis: 0,
    rotAngle: 0,
    rotOrigin: [8, 8, 8],
    rescale: false,
    shade: true,
    faces: DIRS.map((_, f) => {
      const tex = textures[f];
      if (!tex) return null;
      const [x0, y0, z0] = from;
      const [x1, y1, z1] = to;
      const uv: [number, number, number, number] =
        f === 0
          ? [x0, 16 - z1, x1, 16 - z0]
          : f === 1
            ? [x0, z0, x1, z1]
            : f === 2
              ? [16 - x1, 16 - y1, 16 - x0, 16 - y0]
              : f === 3
                ? [x0, 16 - y1, x1, 16 - y0]
                : f === 4
                  ? [z0, 16 - y1, z1, 16 - y0]
                  : [16 - z1, 16 - y1, 16 - z0, 16 - y0];
      return { texture: tex, uv, rotation: 0, tintindex: opts.tint ? 0 : -1, cullface: -1 };
    }),
  };
}

const FACING_Y: Record<string, number> = { north: 0, east: 1, south: 2, west: 3 };

export class JarAssets {
  private readonly models = new Map<string, ResolvedModel>();
  private readonly blockstates = new Map<string, BlockstateJson | undefined>();
  readonly extraTiles = new Map<string, Uint8Array>();
  private readonly images = new Map<string, RgbaImage | undefined>();

  constructor(readonly zip: ZipReader) {}

  image(path: string): RgbaImage | undefined {
    if (this.images.has(path)) return this.images.get(path);
    let img: RgbaImage | undefined;
    const buf = this.zip.read(ROOT + path);
    if (buf) {
      try {
        img = decodePng(buf);
      } catch {
        img = undefined;
      }
    }
    this.images.set(path, img);
    return img;
  }

  /** A 16×16 tile for a normalized texture name (`block/stone`). */
  tile = (name: string): Uint8Array | undefined => {
    const extra = this.extraTiles.get(name);
    if (extra) return extra;
    if (name.includes(':')) return undefined;
    const img = this.image(`textures/${name}.png`);
    return img ? toTile(img) : undefined;
  };

  model(name: string): ResolvedModel {
    let m = this.models.get(name);
    if (!m) {
      m = resolveModel(name, (n) =>
        n.includes(':') ? undefined : this.zip.readJson<ModelJson>(`${ROOT}models/${n}.json`),
      );
      this.models.set(name, m);
    }
    return m;
  }

  blockstate(name: string): BlockstateJson | undefined {
    if (!this.blockstates.has(name))
      this.blockstates.set(
        name,
        this.zip.readJson<BlockstateJson>(`${ROOT}blockstates/${name}.json`),
      );
    return this.blockstates.get(name);
  }

  /** Chest tiles composed from the chest entity texture (lid + base + lock). */
  chestTiles(
    kind: string,
  ): { top: string; side: string; front: string; bottom: string } | undefined {
    const key = `posse:chest_${kind}`;
    if (this.extraTiles.has(`${key}_top`))
      return {
        top: `${key}_top`,
        side: `${key}_side`,
        front: `${key}_front`,
        bottom: `${key}_bottom`,
      };
    const img = this.image(`textures/entity/chest/${kind}.png`);
    if (!img || img.width < 64) return undefined;
    const sc = img.width / 64;
    const at = (x: number, y: number): number[] => {
      const o = (Math.floor(y * sc) * img.width + Math.floor(x * sc)) * 4;
      return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
    };
    const tile = (fill: (x: number, y: number) => number[] | undefined): Uint8Array => {
      const t = new Uint8Array(16 * 16 * 4);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const c = fill(x, y);
          if (c) t.set(c, (y * 16 + x) * 4);
        }
      }
      return t;
    };
    // The 14×14 faces sit at (1, 1)–(15, 15) of a tile; sides are 14 wide and 15 tall (lid 5 + base 10).
    // Entity models are drawn upside down: the lid's outer top is its box's "bottom" region.
    this.extraTiles.set(
      `${key}_top`,
      tile((x, y) => (x >= 1 && x < 15 && y >= 1 && y < 15 ? at(28 + x - 1, y - 1) : at(28, 0))),
    );
    this.extraTiles.set(
      `${key}_bottom`,
      tile((x, y) =>
        x >= 1 && x < 15 && y >= 1 && y < 15 ? at(14 + x - 1, 19 + y - 1) : at(14, 19),
      ),
    );
    const side = (u: number, lock: boolean) =>
      tile((x, y) => {
        const cx = Math.min(13, Math.max(0, x - 1));
        if (lock && x >= 7 && x < 9 && y >= 5 && y < 9) return at(1 + (x - 7), 1 + (y - 5));
        if (y < 2) return at(u + cx, 14);
        if (y < 7) return at(u + cx, 14 + (y - 2));
        return at(u + cx, 33 + Math.min(9, y - 7));
      });
    this.extraTiles.set(`${key}_side`, side(0, false));
    this.extraTiles.set(`${key}_front`, side(14, true));
    return {
      top: `${key}_top`,
      side: `${key}_side`,
      front: `${key}_front`,
      bottom: `${key}_bottom`,
    };
  }

  /**
   * Models for blocks the game draws with a block-entity renderer (their model json has no
   * elements): chests, beds, signs, heads; other full-collision ones become a cube of their
   * particle texture.
   */
  builtinModel(
    s: StateProps,
    particle: string | undefined,
    fullCollision: boolean,
  ): StateModel | undefined {
    const name = s.name;
    const one = (elements: ResolvedElement[], y = 0): StateModel => ({
      alternatives: [
        {
          weight: 1,
          parts: [
            { model: { elements, ambientOcclusion: true, particle }, x: 0, y, uvlock: false },
          ],
        },
      ],
    });
    const facingY = FACING_Y[s.props.facing ?? 'north'] ?? 0;
    if (/chest$/.test(name)) {
      const kind =
        name === 'ender_chest' ? 'ender' : name === 'trapped_chest' ? 'trapped' : 'normal';
      const t = this.chestTiles(kind);
      if (t)
        return one(
          [boxElement([1, 0, 1], [15, 14, 15], [t.bottom, t.top, t.front, t.side, t.side, t.side])],
          facingY,
        );
    }
    if (/_bed$/.test(name)) {
      const wool = `block/${name.replace(/_bed$/, '')}_wool`;
      const planks = 'block/oak_planks';
      return one(
        [boxElement([0, 3, 0], [16, 9, 16], [planks, wool, wool, wool, wool, wool])],
        facingY,
      );
    }
    if (/_wall_sign$/.test(name) || /_wall_hanging_sign$/.test(name)) {
      const p = particle ?? 'block/oak_planks';
      return one([boxElement([0, 4.5, 14], [16, 12.5, 16], [p, p, p, p, p, p])], facingY);
    }
    if (/_sign$/.test(name)) {
      const p = particle ?? 'block/oak_planks';
      const rot = Math.round(Number(s.props.rotation ?? 0) / 4) % 4;
      return one(
        [
          boxElement([0, 8, 7.25], [16, 16, 8.75], [p, p, p, p, p, p]),
          boxElement([7.25, 0, 7.25], [8.75, 8, 8.75], [p, p, p, p, p, p]),
        ],
        (rot + 2) % 4,
      );
    }
    if (/(_head|_skull)$/.test(name) && !/wall/.test(name)) {
      const p = particle ?? 'block/soul_sand';
      return one([boxElement([4, 0, 4], [12, 8, 12], [p, p, p, p, p, p])]);
    }
    if (/(_wall_head|_wall_skull)$/.test(name)) {
      const p = particle ?? 'block/soul_sand';
      return one([boxElement([4, 4, 8], [12, 12, 16], [p, p, p, p, p, p])], facingY);
    }
    if (fullCollision && particle)
      return one([
        boxElement(
          [0, 0, 0],
          [16, 16, 16],
          [particle, particle, particle, particle, particle, particle],
        ),
      ]);
    return undefined;
  }

  /** Models of one state (undefined when it draws nothing). */
  stateModel(
    s: StateProps,
    fullCollision: boolean,
  ): { sm: StateModel; key: string; ao: boolean } | undefined {
    const alts = selectAlternatives(this.blockstate(s.name), s.props);
    const sm: StateModel = {
      alternatives: alts.map((a) => ({
        weight: a.weight,
        parts: a.parts.map((p): PlacedModel => ({
          model: this.model(p.model),
          x: p.x,
          y: p.y,
          uvlock: p.uvlock,
        })),
      })),
    };
    const drawn = sm.alternatives.some((a) => a.parts.some((p) => p.model.elements.length));
    if (!drawn) {
      const particle = sm.alternatives[0]?.parts[0]?.model.particle;
      const built = this.builtinModel(s, particle, fullCollision);
      if (!built) return undefined;
      const key = `builtin:${s.name}:${JSON.stringify(s.props)}`;
      return { sm: built, key, ao: true };
    }
    const key = JSON.stringify(alts);
    const ao = sm.alternatives[0]?.parts.every((p) => p.model.ambientOcclusion) ?? true;
    return { sm, key, ao };
  }
}

// ── HUD ─────────────────────────────────────────────────────────────────────────────────────

/** HUD sprites: 1.20.2+ ships them as separate files, older versions in icons.png/widgets.png. */
export function hudSprites(a: JarAssets): Record<string, RgbaImage> {
  const out: Record<string, RgbaImage> = {};
  const sprite = (key: string, path: string): void => {
    const img = a.image(`textures/gui/sprites/${path}.png`);
    if (img) out[key] = img;
  };
  sprite('hotbar', 'hud/hotbar');
  sprite('hotbar_selection', 'hud/hotbar_selection');
  sprite('crosshair', 'hud/crosshair');
  sprite('heart_container', 'hud/heart/container');
  sprite('heart_full', 'hud/heart/full');
  sprite('heart_half', 'hud/heart/half');
  sprite('food_empty', 'hud/food_empty');
  sprite('food_full', 'hud/food_full');
  sprite('food_half', 'hud/food_half');
  sprite('xp_bar', 'hud/experience_bar_background');
  const vignette = a.image('textures/misc/vignette.png');
  if (vignette) out.vignette = vignette;
  const widgets = a.image('textures/gui/widgets.png');
  const icons = a.image('textures/gui/icons.png');
  if (widgets && !out.hotbar) {
    const s = widgets.width / 256;
    out.hotbar = crop(widgets, 0, 0, 182 * s, 22 * s);
    out.hotbar_selection = crop(widgets, 0, 22 * s, 24 * s, 22 * s);
  }
  if (icons && !out.heart_full) {
    const s = icons.width / 256;
    const c = (x: number, y: number, w: number, h: number) =>
      crop(icons, x * s, y * s, w * s, h * s);
    out.crosshair ??= c(0, 0, 15, 15);
    out.heart_container = c(16, 0, 9, 9);
    out.heart_full = c(52, 0, 9, 9);
    out.heart_half = c(61, 0, 9, 9);
    out.food_empty = c(16, 27, 9, 9);
    out.food_full = c(52, 27, 9, 9);
    out.food_half = c(61, 27, 9, 9);
    out.xp_bar ??= c(0, 64, 182, 5);
  }
  return out;
}

/** Advance widths of the 16×16 grid ASCII font (the game measures the glyph's last opaque column). */
export function fontWidths(font: RgbaImage): number[] {
  const cell = font.width / 16;
  const widths: number[] = [];
  for (let c = 0; c < 256; c++) {
    const cx = (c % 16) * cell;
    const cy = Math.floor(c / 16) * cell;
    let last = -1;
    for (let x = cell - 1; x >= 0 && last < 0; x--) {
      for (let y = 0; y < cell; y++) {
        if (font.data[((cy + y) * font.width + cx + x) * 4 + 3] > 0) {
          last = x;
          break;
        }
      }
    }
    widths.push(c === 32 ? 4 : last < 0 ? 0 : Math.round(((last + 1) * 8) / cell) + 1);
  }
  return widths;
}

/** Draws an isometric block icon (top, left = north, right = east) like the inventory does. */
export function isoIcon(
  top: Uint8Array | undefined,
  left: Uint8Array | undefined,
  right: Uint8Array | undefined,
): RgbaImage {
  const S = 16;
  const data = new Uint8Array(S * S * 4);
  const put = (
    x: number,
    y: number,
    t: Uint8Array | undefined,
    u: number,
    v: number,
    shade: number,
  ): void => {
    if (!t) return;
    const iu = Math.min(15, Math.max(0, Math.floor(u * 16)));
    const iv = Math.min(15, Math.max(0, Math.floor(v * 16)));
    const s = (iv * 16 + iu) * 4;
    if (t[s + 3] < 128) return;
    const d = (y * S + x) * 4;
    data[d] = Math.round(t[s] * shade);
    data[d + 1] = Math.round(t[s + 1] * shade);
    data[d + 2] = Math.round(t[s + 2] * shade);
    data[d + 3] = 255;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Top rhombus: (8,1) + s·(7,3.5) + t·(-7,3.5).
      const qx = px - 8;
      const qy = py - 1;
      const s = (qx / 7 + qy / 3.5) / 2;
      const t = (qy / 3.5 - qx / 7) / 2;
      if (s >= 0 && s < 1 && t >= 0 && t < 1) {
        put(x, y, top, s, t, 1);
        continue;
      }
      // Left face: (1,4.5) + s·(7,3.5) + t·(0,7).
      let sx = (px - 1) / 7;
      let ty = (py - 4.5 - sx * 3.5) / 7;
      if (sx >= 0 && sx < 1 && ty >= 0 && ty < 1) {
        put(x, y, left, sx, ty, 0.8);
        continue;
      }
      // Right face: (8,8) + s·(7,-3.5) + t·(0,7).
      sx = (px - 8) / 7;
      ty = (py - 8 + sx * 3.5) / 7;
      if (sx >= 0 && sx < 1 && ty >= 0 && ty < 1) put(x, y, right, sx, ty, 0.6);
    }
  }
  return { width: S, height: S, data };
}

/** The first plain model an item definition (1.21.4+ `items/*.json`) points at. */
export function itemModelName(def: unknown): string | undefined {
  const walk = (v: unknown, depth: number): string | undefined => {
    if (!v || typeof v !== 'object' || depth > 8) return undefined;
    const o = v as Record<string, unknown>;
    if (
      typeof o.model === 'string' &&
      (o.type === undefined || o.type === 'minecraft:model' || o.type === 'model')
    )
      return normalizeName(o.model);
    for (const child of Object.values(o)) {
      const found = Array.isArray(child)
        ? child.map((c) => walk(c, depth + 1)).find(Boolean)
        : walk(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(def, 0);
}

const GRASS_ITEMS =
  /^(grass|short_grass|tall_grass|fern|large_fern|vine|lily_pad|(oak|jungle|acacia|dark_oak|birch|spruce|mangrove)_leaves)$/;

function tinted(t: Uint8Array, rgb: number): Uint8Array {
  const out = Uint8Array.from(t);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = (out[i] * (rgb >> 16)) / 255;
    out[i + 1] = (out[i + 1] * ((rgb >> 8) & 255)) / 255;
    out[i + 2] = (out[i + 2] * (rgb & 255)) / 255;
  }
  return out;
}

/** 16×16 icons for every item of the version (keyed by the version's item names). */
export function itemIcons(
  a: JarAssets,
  version: string,
): { items: Record<string, RgbaImage>; blockItems: string[] } {
  const out: Record<string, RgbaImage> = {};
  const blockItems: string[] = [];
  let names: Array<{ name: string; asset: string }>;
  try {
    const data = minecraftData(version);
    if (isPreFlattening(version)) {
      const legacy = (minecraftData.legacy.pc as { items?: Record<string, string> }).items ?? {};
      names = data.itemsArray.map((i) => ({
        name: i.name,
        asset: normalizeName(legacy[`${i.id}:0`] ?? i.name),
      }));
    } else names = data.itemsArray.map((i) => ({ name: i.name, asset: i.name }));
  } catch {
    return { items: out, blockItems };
  }
  for (const { name, asset } of names) {
    // 1.21.4+ item definitions (items/<name>.json) name the model; before, models/item/<name>.json.
    const modelName =
      itemModelName(a.zip.readJson(`${ROOT}items/${asset}.json`)) ?? `item/${asset}`;
    let json: ModelJson | undefined;
    let blockParent: string | undefined;
    if (modelName.startsWith('block/')) {
      blockParent = modelName;
      json = {};
    } else json = a.zip.readJson<ModelJson>(`${ROOT}models/${modelName}.json`);
    if (!json) continue;
    // layer0 through the parent chain; otherwise the block model it points at.
    const chainTextures: Record<string, string> = {};
    let cur: ModelJson | undefined = blockParent ? undefined : json;
    for (let i = 0; i < 16 && cur; i++) {
      for (const [k, v] of Object.entries(cur.textures ?? {})) {
        const ref = textureRef(v);
        if (ref !== undefined && !(k in chainTextures)) chainTextures[k] = ref;
      }
      const parent: string | undefined = cur.parent ? normalizeName(cur.parent) : undefined;
      if (!parent || parent.startsWith('builtin/')) break;
      if (parent.startsWith('block/')) {
        blockParent = parent;
        break;
      }
      cur = a.zip.readJson<ModelJson>(`${ROOT}models/${parent}.json`);
    }
    const layer0 = resolveTexture('#layer0', chainTextures);
    let icon: RgbaImage | undefined;
    if (layer0) {
      let t = a.tile(layer0);
      if (t && GRASS_ITEMS.test(asset))
        t = tinted(t, asset.includes('leaves') ? 0x48b518 : 0x7cbd6b);
      if (t) icon = { width: 16, height: 16, data: t };
    } else if (blockParent) {
      const m = a.model(blockParent);
      const merged = { ...chainTextures };
      const el = m.elements[0];
      if (el) {
        const tex = (f: number): Uint8Array | undefined => {
          const face = el.faces[f];
          const n = face?.texture ?? (face ? undefined : undefined);
          let t = n ? a.tile(n) : undefined;
          if (!t && face) {
            const r = resolveTexture(face.texture, merged);
            t = r ? a.tile(r) : undefined;
          }
          if (t && face && face.tintindex >= 0)
            t = tinted(t, asset.includes('leaves') ? 0x48b518 : 0x7cbd6b);
          return t;
        };
        icon = isoIcon(tex(1), tex(2), tex(5));
        blockItems.push(name);
      } else if (m.particle) {
        const t = a.tile(m.particle);
        if (t) icon = { width: 16, height: 16, data: t };
      }
    }
    if (icon) out[name] = icon;
  }
  return { items: out, blockItems };
}

// ── pack ────────────────────────────────────────────────────────────────────────────────────

/** Builds the pack of a minecraft-data `version` from the jar of its asset version. */
export function buildPackFromJar(version: string, zip: ZipReader): ViewPack {
  const a = new JarAssets(zip);
  const builder = new PackBuilder(a.tile);
  const table = stateTableFor(version);
  const facts = blockFactsFor(version);
  const arrays = buildStateArrays(builder, table, facts, (s) =>
    a.stateModel(s, (facts.get(s.name)?.boundingBox ?? 'block') === 'block'),
  );
  const waterTex = builder.texture('block/water_still');
  const lavaTex = builder.texture('block/lava_still');
  const kernel: KernelPack = {
    key: `${version}:textures`,
    ...atlasFields(builder),
    waterTex,
    lavaTex,
    ...arrays,
    models: builder.modelData(),
    ...buildBiomeTables(
      version,
      a.image('textures/colormap/grass.png'),
      a.image('textures/colormap/foliage.png'),
    ),
    sun: asKernelImage(
      a.image('textures/environment/sun.png') ?? a.image('textures/environment/celestial/sun.png'),
    ),
    moon: asKernelImage(
      a.image('textures/environment/moon_phases.png') ??
        a.image('textures/environment/celestial/moon/full_moon.png'),
    ),
    clouds: asKernelImage(a.image('textures/environment/clouds.png')),
    steve: asKernelImage(
      a.image('textures/entity/steve.png') ?? a.image('textures/entity/player/wide/steve.png'),
    ),
    alex: asKernelImage(
      a.image('textures/entity/alex.png') ?? a.image('textures/entity/player/slim/alex.png'),
    ),
  };
  const font = a.image('textures/font/ascii.png');
  const hud: HudAssets = {
    sprites: hudSprites(a),
    ...(font ? { font, fontWidths: fontWidths(font) } : {}),
    ...itemIcons(a, version),
  };
  return { version, quality: 'textures', kernel, hud };
}
