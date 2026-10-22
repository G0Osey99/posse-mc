import { describe, it, expect } from 'vitest';
import minecraftData from 'minecraft-data';
import {
  defaultUv,
  isFullCubeModel,
  resolveModel,
  selectAlternatives,
  variantMatches,
  whenMatches,
  type BlockstateJson,
  type ModelJson,
} from '../../src/view/assets/models.js';
import {
  decodeState,
  encodeState,
  isPreFlattening,
  parseStateString,
  propertyValues,
  stateTableFor,
  type MdBlockLike,
} from '../../src/view/assets/states.js';
import { itemModelName } from '../../src/view/assets/jarPack.js';
import {
  colormapAt,
  rotateDir,
  skyColorForTemperature,
  tintFor,
} from '../../src/view/assets/pack.js';
import {
  buildAtlasMips,
  downsample,
  tileFlags,
  toTile,
} from '../../src/view/assets/textures.js';
import { TINT } from '../../src/view/kernelTypes.js';

const MODELS: Record<string, ModelJson> = {
  'block/block': { ambientocclusion: true },
  'block/cube': {
    parent: 'block/block',
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          down: { texture: '#down', cullface: 'down' },
          up: { texture: '#up', cullface: 'up' },
          north: { texture: '#north', cullface: 'north' },
          south: { texture: '#south', cullface: 'south' },
          west: { texture: '#west', cullface: 'west' },
          east: { texture: '#east', cullface: 'east' },
        },
      },
    ],
  },
  'block/cube_all': {
    parent: 'block/cube',
    textures: {
      particle: '#all',
      down: '#all',
      up: '#all',
      north: '#all',
      south: '#all',
      west: '#all',
      east: '#all',
    },
  },
  'block/stone': { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } },
  // 26.1-style sprite objects.
  'block/tinted_glass': {
    parent: 'block/cube_all',
    textures: { all: { sprite: 'minecraft:block/tinted_glass' } as never },
  },
  'block/cross': {
    ambientocclusion: false,
    textures: { particle: '#cross' },
    elements: [
      {
        from: [0.8, 0, 8],
        to: [15.2, 16, 8],
        rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true },
        shade: false,
        faces: {
          north: { uv: [0, 0, 16, 16], texture: '#cross' },
          south: { uv: [0, 0, 16, 16], texture: '#cross' },
        },
      },
    ],
  },
  'block/poppy': { parent: 'block/cross', textures: { cross: 'block/poppy' } },
  'block/loop_a': { parent: 'block/loop_b' },
  'block/loop_b': { parent: 'block/loop_a' },
};
const load = (n: string) => MODELS[n];

describe('blockstate selection', () => {
  it('matches variant keys against properties', () => {
    expect(variantMatches('', { a: '1' })).toBe(true);
    expect(
      variantMatches('facing=east,half=bottom', {
        facing: 'east',
        half: 'bottom',
        shape: 'straight',
      }),
    ).toBe(true);
    expect(variantMatches('facing=east,half=top', { facing: 'east', half: 'bottom' })).toBe(false);
  });

  it('evaluates multipart conditions (alternatives, OR, AND, negation)', () => {
    expect(whenMatches({ north: 'true' }, { north: 'true' })).toBe(true);
    expect(whenMatches({ north: true } as never, { north: 'true' })).toBe(true);
    expect(whenMatches({ east: 'low|tall' }, { east: 'tall' })).toBe(true);
    expect(whenMatches({ OR: [{ a: '1' }, { b: '1' }] }, { a: '0', b: '1' })).toBe(true);
    expect(whenMatches({ AND: [{ a: '1' }, { b: '1' }] }, { a: '0', b: '1' })).toBe(false);
    expect(whenMatches({ a: '!1' }, { a: '2' })).toBe(true);
  });

  it('gives one alternative per weighted variant and normalizes rotations', () => {
    const bs: BlockstateJson = {
      variants: {
        'snowy=false': [
          { model: 'minecraft:block/grass_block' },
          { model: 'minecraft:block/grass_block', y: 90 },
          { model: 'minecraft:block/grass_block', y: -90, weight: 3 },
        ],
        'snowy=true': { model: 'minecraft:block/grass_block_snow' },
      },
    };
    const alts = selectAlternatives(bs, { snowy: 'false' });
    expect(alts.map((a) => [a.weight, a.parts[0].y])).toEqual([
      [1, 0],
      [1, 1],
      [3, 3],
    ]);
    expect(alts[0].parts[0].model).toBe('block/grass_block');
    expect(selectAlternatives(bs, { snowy: 'true' })[0].parts[0].model).toBe(
      'block/grass_block_snow',
    );
  });

  it('collects every matching multipart part into one alternative', () => {
    const fence: BlockstateJson = {
      multipart: [
        { apply: { model: 'block/oak_fence_post' } },
        { when: { north: 'true' }, apply: { model: 'block/oak_fence_side', uvlock: true } },
        { when: { east: 'true' }, apply: { model: 'block/oak_fence_side', y: 90, uvlock: true } },
      ],
    };
    const [alt] = selectAlternatives(fence, { north: 'false', east: 'true' });
    expect(alt.parts).toEqual([
      { model: 'block/oak_fence_post', x: 0, y: 0, uvlock: false },
      { model: 'block/oak_fence_side', x: 0, y: 1, uvlock: true },
    ]);
  });
});

describe('model resolution', () => {
  it('follows the parent chain and resolves texture variables', () => {
    const m = resolveModel('minecraft:block/stone', load);
    expect(m.elements).toHaveLength(1);
    expect(m.elements[0].faces.map((f) => f?.texture)).toEqual(Array(6).fill('block/stone'));
    expect(m.elements[0].faces[0]?.uv).toEqual([0, 0, 16, 16]);
    expect(m.elements[0].faces[2]?.cullface).toBe(2);
    expect(m.ambientOcclusion).toBe(true);
    expect(m.particle).toBe('block/stone');
    expect(isFullCubeModel(m)).toBe(true);
  });

  it('accepts sprite objects as texture references', () => {
    expect(resolveModel('block/tinted_glass', load).elements[0].faces[1]?.texture).toBe(
      'block/tinted_glass',
    );
  });

  it('keeps element rotation, shade and ambient occlusion flags', () => {
    const m = resolveModel('block/poppy', load);
    const e = m.elements[0];
    expect(m.ambientOcclusion).toBe(false);
    expect(e.rotAxis).toBe(2);
    expect(e.rotAngle).toBeCloseTo(Math.PI / 4);
    expect(e.rescale).toBe(true);
    expect(e.shade).toBe(false);
    expect(e.faces[2]?.texture).toBe('block/poppy');
    expect(e.faces[0]).toBeNull();
    expect(isFullCubeModel(m)).toBe(false);
  });

  it('survives parent cycles and missing models', () => {
    expect(resolveModel('block/loop_a', load).elements).toEqual([]);
    expect(resolveModel('block/missing', load).elements).toEqual([]);
  });

  it('derives default face UVs from the element bounds', () => {
    expect(defaultUv(1, [2, 0, 4], [10, 8, 12])).toEqual([2, 4, 10, 12]);
    expect(defaultUv(2, [2, 0, 4], [10, 8, 12])).toEqual([6, 8, 14, 16]);
  });

  it('rotates face directions like a blockstate variant', () => {
    // y = 90 turns north to east; x = 90 turns up to north.
    expect(rotateDir(2, 0, 1)).toBe(5);
    expect(rotateDir(1, 1, 0)).toBe(2);
  });

  it('finds the model of a 1.21.4+ item definition', () => {
    expect(
      itemModelName({ model: { type: 'minecraft:model', model: 'minecraft:block/stone' } }),
    ).toBe('block/stone');
    expect(
      itemModelName({
        model: {
          type: 'minecraft:condition',
          on_true: { type: 'minecraft:model', model: 'minecraft:item/bow' },
        },
      }),
    ).toBe('item/bow');
    expect(itemModelName(undefined)).toBeUndefined();
  });
});

describe('state ids', () => {
  it('maps 1.18.2 global state ids to properties and back', () => {
    const data = minecraftData('1.18.2');
    const stairs = data.blocksByName.oak_stairs as MdBlockLike;
    // facing (4) > half (2) > shape (5) > waterlogged (2, true first).
    expect(
      encodeState(stairs, {
        facing: 'north',
        half: 'bottom',
        shape: 'straight',
        waterlogged: 'false',
      }),
    ).toBe(stairs.minStateId! + 11);
    expect(encodeState(stairs, {})).toBe(stairs.defaultState);
    expect(decodeState(stairs, 11)).toEqual({
      facing: 'north',
      half: 'bottom',
      shape: 'straight',
      waterlogged: 'false',
    });
    const table = stateTableFor('1.18.2');
    expect(table[data.blocksByName.stone.defaultState!]).toEqual({ name: 'stone', props: {} });
    expect(table[stairs.minStateId! + 20]?.props.facing).toBe('south');
    expect(table.length).toBe(Math.max(...data.blocksArray.map((b) => b.maxStateId ?? 0)) + 1);
  });

  it('numbers int properties from their first value', () => {
    expect(propertyValues('oak_leaves', { name: 'distance', type: 'int', num_values: 7 })).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
    ]);
    expect(propertyValues('water', { name: 'level', type: 'int', num_values: 16 })[0]).toBe('0');
    expect(propertyValues('snow', { name: 'layers', type: 'int', num_values: 8 })[0]).toBe('1');
  });

  it('maps pre-1.13 (id << 4) | meta through the legacy table', () => {
    expect(isPreFlattening('1.8.9')).toBe(true);
    expect(isPreFlattening('1.18.2')).toBe(false);
    const table = stateTableFor('1.8.9');
    expect(table[(1 << 4) | 0]?.name).toBe('stone');
    expect(table[(2 << 4) | 0]).toMatchObject({ name: 'grass_block', props: { snowy: 'false' } });
    expect(table[(17 << 4) | 4]).toMatchObject({ name: 'oak_log', props: { axis: 'x' } });
    // Properties the legacy entry omits get the 1.13.2 defaults.
    expect(table[(53 << 4) | 0]?.props).toMatchObject({
      facing: 'east',
      half: 'bottom',
      shape: 'outer_right',
      waterlogged: 'false',
    });
    // A metadata value the table does not list falls back to metadata 0.
    expect(table[(3 << 4) | 15]?.name).toBe('dirt');
  });

  it('parses state strings', () => {
    expect(parseStateString('minecraft:oak_log[axis=x]')).toEqual({
      name: 'oak_log',
      props: { axis: 'x' },
    });
    expect(parseStateString('stone')).toEqual({ name: 'stone', props: {} });
  });
});

describe('textures and colours', () => {
  const img = (w: number, h: number, fill: (x: number, y: number) => number[]) => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fill(x, y), (y * w + x) * 4);
    return { width: w, height: h, data };
  };

  it('takes the first frame of an animation strip and resamples to 16×16', () => {
    const strip = img(8, 16, (_x, y) => (y < 8 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const tile = toTile(strip);
    expect(tile.length).toBe(16 * 16 * 4);
    expect([...tile.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...tile.subarray(tile.length - 4)]).toEqual([255, 0, 0, 255]);
  });

  it('flags cutout and translucent tiles', () => {
    expect(tileFlags(toTile(img(16, 16, () => [1, 2, 3, 255])))).toBe(0);
    expect(tileFlags(toTile(img(16, 16, (x) => [1, 2, 3, x < 8 ? 0 : 255])))).toBe(1);
    expect(tileFlags(toTile(img(16, 16, () => [1, 2, 3, 180])))).toBe(2);
  });

  it('builds mip levels down to one texel, averaging visible texels only', () => {
    const t = toTile(img(16, 16, (x) => (x < 8 ? [200, 100, 0, 255] : [0, 0, 0, 0])));
    const half = downsample(t, 16);
    expect([...half.subarray(0, 4)]).toEqual([200, 100, 0, 255]);
    const { cols, rows, mips } = buildAtlasMips([t, t]);
    expect(cols).toBe(64);
    expect(rows).toBe(1);
    expect(mips.map((m) => m.length)).toEqual([16, 8, 4, 2, 1].map((s) => s * 64 * s * 4));
    expect([...mips[4].subarray(0, 4)]).toEqual([200, 100, 0, 128]);
  });

  it('looks up the grass colour map like the game', () => {
    const map = img(256, 256, (x, y) => [x, y, 0, 255]);
    // plains: temperature 0.8, rainfall 0.4 → x = (int) ((1 - 0.8) * 255), y = (int) ((1 - 0.32) * 255).
    expect(colormapAt(map, 0.8, 0.4, 0) >> 16).toBe(50);
    expect((colormapAt(map, 0.8, 0.4, 0) >> 8) & 255).toBe(173);
    expect(colormapAt(undefined, 0.8, 0.4, 0x123456)).toBe(0x123456);
  });

  it('derives the vanilla sky colour from temperature', () => {
    expect(skyColorForTemperature(0.8)).toBe(0x78a7ff);
  });

  it('knows which blocks the biome tints', () => {
    expect(tintFor('grass_block', {})).toBe(TINT.GRASS);
    expect(tintFor('oak_leaves', {})).toBe(TINT.FOLIAGE);
    expect(tintFor('water', {})).toBe(TINT.WATER);
    expect(tintFor('birch_leaves', {})).toBe(0x1000000 | 0x80a755);
    expect(tintFor('stone', {})).toBe(TINT.NONE);
  });
});
