// The offline fallback: a pack built from minecraft-data alone. Every block gets a flat-colour
// tile (with a little deterministic grain, so surfaces still read as blocks) derived from its name,
// and a rough shape (cube, slab, stairs, cross plant, post, thin layer) — rendered by the same
// kernel as the real textures.
import { DIRS, type ResolvedElement, type ResolvedModel } from './models.js';
import { blockFactsFor, stateTableFor, type StateProps } from './states.js';
import {
  PackBuilder,
  atlasFields,
  buildBiomeTables,
  buildStateArrays,
  type StateModel,
  type ViewPack,
} from './pack.js';

const COLOR_PREFIX: Array<[string, number]> = [
  ['light_blue', 0x3aafd9],
  ['light_gray', 0x8e8e86],
  ['white', 0xe9ecec],
  ['orange', 0xf07613],
  ['magenta', 0xbd44b3],
  ['yellow', 0xf8c627],
  ['lime', 0x70b919],
  ['pink', 0xed8dac],
  ['gray', 0x3e4447],
  ['cyan', 0x158991],
  ['purple', 0x792aac],
  ['blue', 0x35399d],
  ['brown', 0x724728],
  ['green', 0x546d1b],
  ['red', 0xa12722],
  ['black', 0x141519],
];

const WOODS: Record<string, [number, number, number]> = {
  // planks, log side, log top
  oak: [0xa2834f, 0x6b5133, 0xb29157],
  spruce: [0x735531, 0x3b2610, 0x6f5432],
  birch: [0xc0af79, 0xd8d7d2, 0xc4b07c],
  jungle: [0xa07351, 0x554419, 0xa47a4f],
  acacia: [0xa85a32, 0x676157, 0xae5f39],
  dark_oak: [0x432b14, 0x3c2e1a, 0x4a3018],
  mangrove: [0x773636, 0x544332, 0x7a3a33],
  cherry: [0xe2b3ac, 0x371f2c, 0xdab1aa],
  crimson: [0x653045, 0x5c1d1e, 0x6a344a],
  warped: [0x2b6963, 0x3a3a4d, 0x2c6b65],
};

/** Ordered keyword → colour rules (first match wins). */
const KEYWORDS: Array<[RegExp, number]> = [
  [/^grass_block$|^grass_path$|^dirt_path$/, 0x8b5a3c],
  [/podzol|coarse_dirt|rooted_dirt|^dirt$|farmland|mud$/, 0x866043],
  [/red_sand/, 0xbe6621],
  [/sandstone|^sand$|suspicious_sand/, 0xdbd3a0],
  [/gravel/, 0x847f7e],
  [/deepslate|tuff|basalt|blackstone/, 0x505055],
  [/granite/, 0x956755],
  [/diorite|quartz|calcite/, 0xd9d6cf],
  [/andesite/, 0x888888],
  [/netherrack|nether_brick|crimson_nylium/, 0x6f3535],
  [/warped_nylium|warped_wart/, 0x2b8a75],
  [/soul_s(and|oil)/, 0x51402e],
  [/end_stone|end_stone_brick/, 0xdbdea0],
  [/obsidian/, 0x14121e],
  [/bedrock/, 0x555555],
  [/snow|powder_snow/, 0xf0fbfb],
  [/packed_ice|blue_ice/, 0x8db5fc],
  [/ice/, 0x91b7fd],
  [/clay/, 0xa0a6b3],
  [/bricks?$/, 0x966151],
  [/prismarine/, 0x5aa294],
  [/purpur/, 0xa97da9],
  [/glowstone|shroomlight|sea_lantern|lantern|froglight/, 0xf5d888],
  [/magma/, 0x8e3f1f],
  [/tnt/, 0xd13d2a],
  [/melon/, 0x71a031],
  [/pumpkin|jack_o_lantern/, 0xe38a1d],
  [/hay/, 0xa88d10],
  [/sponge/, 0xc3c04a],
  [
    /bookshelf|crafting_table|loom|barrel|composter|chest|note_block|jukebox|lectern|fletching/,
    0x9c7a49,
  ],
  [/furnace|dispenser|dropper|observer|piston|smoker|stonecutter|cobble|stone|ore$/, 0x7f7f7f],
  [/iron/, 0xd8d8d8],
  [/gold/, 0xf6d03d],
  [/diamond/, 0x61dbd5],
  [/emerald/, 0x2ad263],
  [/lapis/, 0x2650a4],
  [/redstone|crimson/, 0xaa1a1a],
  [/copper/, 0xc06b4f],
  [/amethyst/, 0x8662bf],
  [
    /moss|azalea|leaves|vine|grass|fern|sapling|bush|kelp|seagrass|lily|cactus|sugar_cane|bamboo|wheat|carrots|potatoes|beetroots|crop|stem/,
    0x5f9a3a,
  ],
  [/dandelion|sunflower/, 0xf2d22e],
  [/cornflower|blue_orchid/, 0x4a6fd8],
  [/allium|lilac|peony/, 0xb46ad8],
  [/azure_bluet|oxeye_daisy|white_tulip|lily_of_the_valley/, 0xe8e8e0],
  [/rose|poppy|tulip|flower|orchid/, 0xd23a3a],
  [/mushroom/, 0xb36b55],
  [/wool|carpet|bed$|banner|concrete|terracotta|glazed|shulker|candle|stained/, 0xcfcfcf],
  [/glass/, 0xdcecf5],
  [/water/, 0xb8b8b8],
  [/lava/, 0xd45a12],
  [/torch|fire|campfire/, 0xf3b23a],
  [/rail/, 0x8a7a63],
];

/** The flat colour of a block (and its top, which differs for grass, logs…), from its name. */
export function paletteColor(name: string): { side: number; top: number; bottom: number } {
  for (const [wood, [planks, log, logTop]] of Object.entries(WOODS)) {
    if (!name.startsWith(wood + '_')) continue;
    if (/_(log|wood|stem|hyphae)$/.test(name))
      return { side: log, top: /_(wood|hyphae)$/.test(name) ? log : logTop, bottom: logTop };
    if (/leaves/.test(name)) break;
    return { side: planks, top: planks, bottom: planks };
  }
  if (name === 'grass_block') return { side: 0x8b5a3c, top: 0x9a9a9a, bottom: 0x866043 };
  let base: number | undefined;
  for (const [re, c] of KEYWORDS) {
    if (re.test(name)) {
      base = c;
      break;
    }
  }
  if (/wool|carpet|bed$|banner|concrete|terracotta|glazed|shulker|candle|stained/.test(name)) {
    const pre = COLOR_PREFIX.find(([p]) => name.startsWith(p + '_'));
    if (pre) base = /terracotta/.test(name) ? mix(pre[1], 0x9a6a50, 0.5) : pre[1];
  }
  if (base === undefined) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
    base = mix(((h & 0xffffff) >>> 0) | 0x202020, 0x808080, 0.5);
  }
  return { side: base, top: base, bottom: base };
}

function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** A 16×16 tile of one colour with grain; `alpha` < 255 makes it translucent, `cutout` see-through. */
export function paletteTile(
  rgb: number,
  seed: number,
  opts: { alpha?: number; cutout?: 'cross' | 'frame'; strip?: number } = {},
): Uint8Array {
  const t = new Uint8Array(16 * 16 * 4);
  let s = (seed * 2654435761) >>> 0;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
      const n = ((s >>> 24) / 255 - 0.5) * 0.18;
      let c = rgb;
      if (opts.strip !== undefined && y < 3) c = opts.strip;
      const o = (y * 16 + x) * 4;
      t[o] = Math.max(0, Math.min(255, ((c >> 16) & 255) * (1 + n)));
      t[o + 1] = Math.max(0, Math.min(255, ((c >> 8) & 255) * (1 + n)));
      t[o + 2] = Math.max(0, Math.min(255, (c & 255) * (1 + n)));
      let a = opts.alpha ?? 255;
      if (opts.cutout === 'cross')
        a = Math.abs(x - 7.5) < 2.5 + (15 - y) / 3 && (s & 3) !== 0 ? 255 : 0;
      if (opts.cutout === 'frame') a = x === 0 || y === 0 || x === 15 || y === 15 ? 255 : 0;
      t[o + 3] = a;
    }
  }
  return t;
}

function el(
  from: [number, number, number],
  to: [number, number, number],
  tex: [string, string, string],
  tint = false,
): ResolvedElement {
  return {
    from,
    to,
    rotAxis: 0,
    rotAngle: 0,
    rotOrigin: [8, 8, 8],
    rescale: false,
    shade: true,
    faces: DIRS.map((_, f) => ({
      texture: f === 0 ? tex[2] : f === 1 ? tex[1] : tex[0],
      uv: [0, 0, 16, 16] as [number, number, number, number],
      rotation: 0,
      tintindex: tint && f === 1 ? 0 : -1,
      cullface: -1,
    })),
  };
}

function crossModel(tex: string, tint: boolean): ResolvedModel {
  const plane = (axis: 'x' | 'z'): ResolvedElement => ({
    from: axis === 'x' ? [0.8, 0, 8] : [8, 0, 0.8],
    to: axis === 'x' ? [15.2, 16, 8] : [8, 16, 15.2],
    rotAxis: 2,
    rotAngle: Math.PI / 4,
    rotOrigin: [8, 8, 8],
    rescale: true,
    shade: false,
    faces: DIRS.map((d) =>
      (axis === 'x' && (d === 'north' || d === 'south')) ||
      (axis === 'z' && (d === 'west' || d === 'east'))
        ? {
            texture: tex,
            uv: [0, 0, 16, 16] as [number, number, number, number],
            rotation: 0,
            tintindex: tint ? 0 : -1,
            cullface: -1,
          }
        : null,
    ),
  });
  return { elements: [plane('x'), plane('z')], ambientOcclusion: false, particle: tex };
}

/** The rough shape of a state for the palette pack. */
export function paletteShape(
  s: StateProps,
  full: boolean,
  tex: [string, string, string],
  tint: boolean,
): ResolvedModel | undefined {
  const n = s.name;
  const m = (elements: ResolvedElement[], ao = true): ResolvedModel => ({
    elements,
    ambientOcclusion: ao,
    particle: tex[0],
  });
  if (/_slab$/.test(n)) {
    const type = s.props.type ?? 'bottom';
    if (type === 'double') return m([el([0, 0, 0], [16, 16, 16], tex)]);
    return m([type === 'top' ? el([0, 8, 0], [16, 16, 16], tex) : el([0, 0, 0], [16, 8, 16], tex)]);
  }
  if (/_stairs$/.test(n)) {
    const top = s.props.half === 'top';
    const f = s.props.facing ?? 'north';
    const step: [[number, number, number], [number, number, number]] =
      f === 'east'
        ? [
            [8, 0, 0],
            [16, 16, 16],
          ]
        : f === 'west'
          ? [
              [0, 0, 0],
              [8, 16, 16],
            ]
          : f === 'south'
            ? [
                [0, 0, 8],
                [16, 16, 16],
              ]
            : [
                [0, 0, 0],
                [16, 16, 8],
              ];
    const y0 = top ? 0 : 8;
    const y1 = top ? 8 : 16;
    return m([
      el([0, top ? 8 : 0, 0], [16, top ? 16 : 8, 16], tex),
      el([step[0][0], y0, step[0][2]], [step[1][0], y1, step[1][2]], tex),
    ]);
  }
  if (/(_fence|_wall|_pane|iron_bars|chain)$/.test(n)) return m([el([6, 0, 6], [10, 16, 10], tex)]);
  if (/torch$/.test(n)) return m([el([7, 0, 7], [9, 10, 9], tex)], false);
  if (
    /(carpet|pressure_plate|rail|^snow$|_trapdoor|lily_pad|redstone_wire|tripwire)$/.test(n) ||
    /^(rail|powered_rail|detector_rail|activator_rail)$/.test(n)
  ) {
    return m([
      el([0, 0, 0], [16, n === 'snow' ? 2 * Number(s.props.layers ?? 1) : 1, 16], tex, tint),
    ]);
  }
  if (/_door$/.test(n)) return m([el([0, 0, 0], [16, 16, 3], tex)]);
  if (full) return m([el([0, 0, 0], [16, 16, 16], tex, tint)]);
  if (/air$|^water$|^lava$|^light$|barrier|structure_void|bubble_column/.test(n)) return undefined;
  return crossModel(tex[0], tint);
}

/** The flat-colour pack of a minecraft-data version. */
export function buildPalettePack(version: string): ViewPack {
  const table = stateTableFor(version);
  const facts = blockFactsFor(version);
  const tiles = new Map<string, Uint8Array>();
  const builder = new PackBuilder((name) => tiles.get(name));
  let seed = 1;
  const tileFor = (key: string, make: () => Uint8Array): string => {
    if (!tiles.has(key)) tiles.set(key, make());
    return key;
  };
  const arrays = buildStateArrays(builder, table, facts, (s) => {
    const c = paletteColor(s.name);
    const f = facts.get(s.name);
    const full = (f?.boundingBox ?? 'block') === 'block';
    const leaves = /leaves$/.test(s.name);
    const glass = /glass/.test(s.name);
    const ice = s.name === 'ice';
    const tint = s.name === 'grass_block' || leaves || /grass|fern|vine/.test(s.name);
    const opts = glass ? { cutout: 'frame' as const } : ice ? { alpha: 200 } : {};
    const side = tileFor(`pal:${s.name}:side`, () =>
      paletteTile(
        c.side,
        seed++,
        s.name === 'grass_block' ? { strip: 0x6b9a3a } : full ? opts : { cutout: 'cross' },
      ),
    );
    const top = tileFor(`pal:${s.name}:top`, () =>
      paletteTile(c.top, seed++, full ? opts : { cutout: 'cross' }),
    );
    const bottom = tileFor(`pal:${s.name}:bottom`, () => paletteTile(c.bottom, seed++, opts));
    const shape = paletteShape(s, full, [side, top, bottom], tint);
    if (!shape) return undefined;
    const sm: StateModel = {
      alternatives: [{ weight: 1, parts: [{ model: shape, x: 0, y: 0, uvlock: false }] }],
    };
    return { sm, key: `pal:${JSON.stringify(shape.elements)}`, ao: shape.ambientOcclusion };
  });
  const waterTex = builder.texture(
    tileFor('pal:water', () => paletteTile(0xc8c8c8, 99, { alpha: 180 })),
  );
  const lavaTex = builder.texture(tileFor('pal:lava', () => paletteTile(0xd45a12, 98)));
  return {
    version,
    quality: 'palette',
    kernel: {
      key: `${version}:palette`,
      ...atlasFields(builder),
      waterTex,
      lavaTex,
      ...arrays,
      models: builder.modelData(),
      ...buildBiomeTables(version),
    },
    hud: { sprites: {}, items: {} },
  };
}
