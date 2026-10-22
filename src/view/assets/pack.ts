// The built asset pack: the kernel's tables (atlas, per-state models and flags, biome colours) plus
// the HUD's images. PackBuilder encodes resolved models into the kernel layout (kernelTypes.ts);
// both the jar pack (jarPack.ts) and the flat-colour fallback (palette.ts) go through it.
import minecraftData from 'minecraft-data';
import type { RgbaImage } from '../png.js';
import { ELEMENT_FLOATS, SF, TINT, type KernelImage, type KernelPack } from '../kernelTypes.js';
import type { ResolvedModel } from './models.js';
import { isFullCubeModel } from './models.js';
import type { BlockFacts, StateProps } from './states.js';
import { buildAtlasMips, tileFlags } from './textures.js';

export interface HudAssets {
  /** hotbar, hotbar_selection, crosshair, heart_container/full/half, food_empty/full/half, xp_bar, vignette. */
  sprites: Record<string, RgbaImage>;
  /** The 128×128 ASCII font sheet and its glyph advance widths (code points 0–255). */
  font?: RgbaImage;
  fontWidths?: number[];
  /** 16×16 item icons by item name. */
  items: Record<string, RgbaImage>;
  /** Items drawn as blocks (their icon is an isometric block; in hand they are a small cube). */
  blockItems?: string[];
}

export interface ViewPack {
  /** minecraft-data version the pack renders. */
  version: string;
  quality: 'textures' | 'palette';
  kernel: KernelPack;
  hud: HudAssets;
}

/** Bump when the pack layout or its derivation changes (invalidates cached packs). */
export const PACK_FORMAT = 4;

export interface PlacedModel {
  model: ResolvedModel;
  x: number;
  y: number;
  uvlock: boolean;
}

export interface StateModel {
  alternatives: Array<{ weight: number; parts: PlacedModel[] }>;
}

const INVISIBLE = new Set([
  'air',
  'cave_air',
  'void_air',
  'barrier',
  'light',
  'structure_void',
  'moving_piston',
]);

/** Rotates a face direction (DIRS index) by a variant's x then y quarter turns. */
export function rotateDir(dir: number, rx: number, ry: number): number {
  const N = [
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
    [-1, 0, 0],
    [1, 0, 0],
  ];
  let [x, y, z] = N[dir];
  for (let k = 0; k < rx; k++) [y, z] = [z, -y];
  for (let k = 0; k < ry; k++) [x, z] = [-z, x];
  return N.findIndex((n) => n[0] === x && n[1] === y && n[2] === z);
}

export class PackBuilder {
  readonly tiles: Uint8Array[] = [];
  readonly texFlags: number[] = [];
  private readonly texIndex = new Map<string, number>();
  private readonly models: number[] = [];
  private readonly modelIndex = new Map<string, number>();

  constructor(private readonly loadTile: (name: string) => Uint8Array | undefined) {}

  /** Atlas index of a texture (-1 when it does not load). */
  texture(name: string | undefined): number {
    if (!name) return -1;
    const known = this.texIndex.get(name);
    if (known !== undefined) return known;
    const tile = this.loadTile(name);
    const idx = tile ? this.tiles.length : -1;
    if (tile) {
      this.tiles.push(tile);
      this.texFlags.push(tileFlags(tile));
    }
    this.texIndex.set(name, idx);
    return idx;
  }

  hasFlags(name: string | undefined, mask: number): boolean {
    const i = this.texture(name);
    return i >= 0 && (this.texFlags[i] & mask) !== 0;
  }

  /** Offset of an encoded state model in `models` (deduplicated), or -1 when it draws nothing. */
  encode(sm: StateModel, key: string): number {
    const known = this.modelIndex.get(key);
    if (known !== undefined) return known;
    const alts = sm.alternatives.filter((a) => a.parts.some((p) => p.model.elements.length));
    if (!alts.length) {
      this.modelIndex.set(key, -1);
      return -1;
    }
    const m = this.models;
    const off = m.length;
    const total = alts.reduce((s, a) => s + a.weight, 0);
    m.push(alts.length, total);
    const slots: number[] = [];
    for (const a of alts) {
      m.push(a.weight, 0);
      slots.push(m.length - 1);
    }
    alts.forEach((a, ai) => {
      m[slots[ai]] = m.length;
      const elements = a.parts.flatMap((p) => p.model.elements.map((e) => ({ e, p })));
      const full = a.parts.every((p) => isFullCubeModel(p.model) || !p.model.elements.length);
      m.push(elements.length, full ? 1 : 0);
      for (const { e, p } of elements) {
        const start = m.length;
        m.push(
          e.from[0] / 16,
          e.from[1] / 16,
          e.from[2] / 16,
          e.to[0] / 16,
          e.to[1] / 16,
          e.to[2] / 16,
        );
        const c = Math.cos(e.rotAngle);
        const s = Math.sin(e.rotAngle);
        // Rescaled rotations stretch the two non-axis coordinates by 1/cos.
        const scale = e.rescale && e.rotAxis ? Math.abs(c) : 1;
        m.push(
          e.rotAxis,
          c,
          s,
          e.rotOrigin[0] / 16,
          e.rotOrigin[1] / 16,
          e.rotOrigin[2] / 16,
          scale,
        );
        m.push(e.shade ? 1 : 0, p.x, p.y, p.uvlock ? 1 : 0, 0, 0, 0);
        for (let f = 0; f < 6; f++) {
          const face = e.faces[f];
          const tex = face ? this.texture(face.texture) : -1;
          if (!face || tex < 0) {
            m.push(-1, 0, 0, 1, 1, 0, 0, -1);
            continue;
          }
          m.push(
            tex,
            face.uv[0] / 16,
            face.uv[1] / 16,
            face.uv[2] / 16,
            face.uv[3] / 16,
            face.rotation,
            face.tintindex >= 0 ? 1 : 0,
          );
          m.push(face.cullface >= 0 ? rotateDir(face.cullface, p.x, p.y) : -1);
        }
        if (m.length - start !== ELEMENT_FLOATS) throw new Error('element layout mismatch');
      }
    });
    this.modelIndex.set(key, off);
    return off;
  }

  modelData(): Float32Array {
    return Float32Array.from(this.models);
  }
}

/** Blocks tinted by the grass / foliage colour maps or a fixed colour (the game's block colours). */
export function tintFor(name: string, props: Record<string, string>): number {
  if (
    /^(grass_block|grass|short_grass|tall_grass|fern|large_fern|potted_fern|sugar_cane)$/.test(name)
  )
    return TINT.GRASS;
  if (/^(oak|jungle|acacia|dark_oak)_leaves$/.test(name) || name === 'vine') return TINT.FOLIAGE;
  if (name === 'birch_leaves') return 0x1000000 | 0x80a755;
  if (name === 'spruce_leaves') return 0x1000000 | 0x619961;
  if (name === 'mangrove_leaves') return 0x1000000 | 0x92c648;
  if (name === 'lily_pad') return 0x1000000 | 0x208030;
  if (name === 'water' || name === 'bubble_column' || name === 'water_cauldron') return TINT.WATER;
  if (name === 'melon_stem' || name === 'pumpkin_stem') {
    const age = Number(props.age ?? 0);
    return 0x1000000 | ((age * 32) << 16) | ((255 - age * 8) << 8) | (age * 4);
  }
  if (name === 'attached_melon_stem' || name === 'attached_pumpkin_stem')
    return 0x1000000 | 0xe0c71c;
  if (name === 'redstone_wire') {
    const p = Number(props.power ?? 0) / 15;
    const r = p * 0.6 + (p > 0 ? 0.4 : 0.3);
    const g = Math.max(0, p * p * 0.7 - 0.5);
    const b = Math.max(0, p * p * 0.6 - 0.7);
    return (
      0x1000000 | (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)
    );
  }
  return TINT.NONE;
}

const UNDERWATER_PLANTS = new Set([
  'kelp',
  'kelp_plant',
  'seagrass',
  'tall_seagrass',
  'bubble_column',
]);

/** The kernel arrays for a state table, given each state's resolved models. */
export function buildStateArrays(
  builder: PackBuilder,
  table: Array<StateProps | undefined>,
  facts: Map<string, BlockFacts>,
  modelFor: (s: StateProps, id: number) => { sm: StateModel; key: string; ao: boolean } | undefined,
): Pick<KernelPack, 'stateModel' | 'stateFlags' | 'stateLight' | 'stateTint'> {
  const n = table.length;
  const stateModel = new Int32Array(n).fill(-1);
  const stateFlags = new Uint16Array(n);
  const stateLight = new Uint8Array(n);
  const stateTint = new Uint32Array(n);
  for (let id = 0; id < n; id++) {
    const s = table[id];
    if (!s || id === 0 || INVISIBLE.has(s.name)) continue;
    const f = facts.get(s.name);
    let flags = 0;
    if (s.name === 'water' || s.name === 'bubble_column') flags |= SF.WATER;
    else if (s.name === 'lava') flags |= SF.LAVA;
    if (s.props.waterlogged === 'true' || UNDERWATER_PLANTS.has(s.name)) flags |= SF.WATERLOGGED;
    if (flags & (SF.WATER | SF.LAVA))
      flags |= (Math.min(15, Number(s.props.level ?? 0)) & 15) << 12;
    if (
      (/glass$/.test(s.name) && !/pane/.test(s.name)) ||
      s.name === 'ice' ||
      s.name === 'slime_block' ||
      s.name === 'honey_block'
    ) {
      flags |= SF.CULL_SELF;
    }
    const resolved = flags & (SF.WATER | SF.LAVA) ? undefined : modelFor(s, id);
    if (resolved) {
      stateModel[id] = builder.encode(resolved.sm, resolved.key);
      if (!resolved.ao) flags |= SF.NO_AO;
      const alt = resolved.sm.alternatives[0];
      const part = alt?.parts.length === 1 ? alt.parts[0] : undefined;
      if (part && isFullCubeModel(part.model)) {
        // Opaque when some element covers all six faces with opaque textures.
        const opaque = part.model.elements.some((e) =>
          e.faces.every(
            (face) =>
              face &&
              face.texture &&
              builder.texture(face.texture) >= 0 &&
              !builder.hasFlags(face.texture, 3),
          ),
        );
        if (opaque && !(flags & SF.CULL_SELF)) flags |= SF.OPAQUE | SF.AO;
        else if (/leaves$/.test(s.name)) flags |= SF.AO;
      }
    }
    stateFlags[id] = flags;
    // Only opaque cubes stop light; everything else dims it by at most 1 (water, leaves, ice), which
    // also guards against minecraft-data versions that list plants as light-blocking.
    const filter = flags & SF.OPAQUE ? 15 : Math.min(1, f?.filterLight ?? 0);
    stateLight[id] = (Math.min(15, f?.emitLight ?? 0) << 4) | filter;
    stateTint[id] = tintFor(s.name, s.props);
  }
  return { stateModel, stateFlags, stateLight, stateTint };
}

// ── biomes ──────────────────────────────────────────────────────────────────────────────────

const WATER_COLORS: Record<string, number> = {
  swamp: 0x617b64,
  swampland: 0x617b64,
  mangrove_swamp: 0x3a7a6a,
  warm_ocean: 0x43d5ee,
  lukewarm_ocean: 0x45adf2,
  deep_lukewarm_ocean: 0x45adf2,
  cold_ocean: 0x3d57d6,
  deep_cold_ocean: 0x3d57d6,
  frozen_ocean: 0x3938c9,
  deep_frozen_ocean: 0x3938c9,
  frozen_river: 0x3938c9,
  meadow: 0x0e4ecf,
  cherry_grove: 0x5db7ef,
};

const NETHER_FOG: Record<string, number> = {
  nether_wastes: 0x330808,
  nether: 0x330808,
  hell: 0x330808,
  soul_sand_valley: 0x1b4745,
  crimson_forest: 0x330303,
  warped_forest: 0x1a051a,
  basalt_deltas: 0x685f70,
};

/** HSV → 0xRRGGBB (the game's sky colour by temperature). */
function hsv(h: number, s: number, v: number): number {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i];
  // Truncated like Mth.hsvToRgb.
  return (Math.floor(r * 255) << 16) | (Math.floor(g * 255) << 8) | Math.floor(b * 255);
}

export function skyColorForTemperature(temp: number): number {
  const f = Math.max(-1, Math.min(1, temp / 3));
  return hsv(0.62222224 - f * 0.05, 0.5 + f * 0.1, 1);
}

/** Colour-map lookup (grass.png / foliage.png) for a biome's temperature and rainfall. */
export function colormapAt(
  map: RgbaImage | undefined,
  temp: number,
  rain: number,
  fallback: number,
): number {
  if (!map) return fallback;
  const t = Math.max(0, Math.min(1, temp));
  const r = Math.max(0, Math.min(1, rain)) * t;
  const x = Math.min(map.width - 1, Math.floor((1 - t) * (map.width - 1)));
  const y = Math.min(map.height - 1, Math.floor((1 - r) * (map.height - 1)));
  const o = (y * map.width + x) * 4;
  return (map.data[o] << 16) | (map.data[o + 1] << 8) | map.data[o + 2];
}

/** Per biome id colours for a minecraft-data version. */
export function buildBiomeTables(
  version: string,
  grass?: RgbaImage,
  foliage?: RgbaImage,
): Pick<KernelPack, 'biomeGrass' | 'biomeFoliage' | 'biomeWater' | 'biomeSky' | 'biomeFog'> {
  let biomes: Array<{
    id: number;
    name: string;
    temperature: number;
    rainfall?: number;
    dimension?: string;
  }> = [];
  try {
    biomes = minecraftData(version).biomesArray as typeof biomes;
  } catch {
    // unknown version: plains everywhere
  }
  const n = Math.max(2, ...biomes.map((b) => b.id + 1));
  const out = {
    biomeGrass: new Uint32Array(n).fill(0x91bd59),
    biomeFoliage: new Uint32Array(n).fill(0x77ab2f),
    biomeWater: new Uint32Array(n).fill(0x3f76e4),
    biomeSky: new Uint32Array(n).fill(0x78a7ff),
    biomeFog: new Uint32Array(n).fill(0xc0d8ff),
  };
  for (const b of biomes) {
    const name = b.name.replace(/^minecraft:/, '');
    const temp = b.temperature ?? 0.8;
    const rain = b.rainfall ?? 0.4;
    let g = colormapAt(grass, temp, rain, 0x91bd59);
    let f = colormapAt(foliage, temp, rain, 0x77ab2f);
    if (/swamp/.test(name) && !/mangrove/.test(name)) g = f = 0x6a7039;
    if (name === 'mangrove_swamp') f = 0x8db127;
    if (/badlands|mesa/.test(name)) {
      g = 0x90814d;
      f = 0x9e814d;
    }
    if (/dark_forest|roofed_forest/.test(name)) g = (((g & 0xfefefe) + 0x28340a) >> 1) & 0xffffff;
    if (name === 'cherry_grove') g = f = 0xb6db61;
    if (name === 'pale_garden') {
      g = 0x778272;
      f = 0x878d76;
    }
    out.biomeGrass[b.id] = g;
    out.biomeFoliage[b.id] = f;
    out.biomeWater[b.id] = WATER_COLORS[name] ?? 0x3f76e4;
    const dim = b.dimension ?? '';
    if (NETHER_FOG[name] !== undefined || dim === 'nether') {
      out.biomeFog[b.id] = out.biomeSky[b.id] = NETHER_FOG[name] ?? 0x330808;
    } else if (dim === 'end' || /^(the_end|end_|small_end|sky$)/.test(name)) {
      out.biomeFog[b.id] = out.biomeSky[b.id] = 0x181318;
    } else out.biomeSky[b.id] = skyColorForTemperature(temp);
  }
  return out;
}

/** Atlas fields of a kernel pack from a builder's tiles. */
export function atlasFields(
  builder: PackBuilder,
): Pick<KernelPack, 'atlasCols' | 'atlasRows' | 'mips' | 'texFlags'> {
  const tiles = builder.tiles.length ? builder.tiles : [new Uint8Array(16 * 16 * 4).fill(255)];
  const { cols, rows, mips } = buildAtlasMips(tiles);
  return {
    atlasCols: cols,
    atlasRows: rows,
    mips,
    texFlags: Uint8Array.from(builder.texFlags.length ? builder.texFlags : [0]),
  };
}

export function asKernelImage(img: RgbaImage | undefined): KernelImage | undefined {
  return img ? { width: img.width, height: img.height, data: img.data } : undefined;
}
