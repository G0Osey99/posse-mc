// Deterministic terrain for the fake server and the per-version chunk packets (map_chunk, plus
// update_light where the version sends light separately). Chunks are built with prismarine-chunk;
// light sections (1.14+) are built here directly, which is much faster than per-block setSkyLight.
import prismarineChunk from 'prismarine-chunk';
import { Vec3 } from 'vec3';
import type { IndexedData } from 'minecraft-data';
import type { PacketFiller } from './protoFill.js';

export const SEA_LEVEL = 62;

/** Surface height of the hills at a world column. */
export function surfaceHeight(x: number, z: number): number {
  const h =
    4 * Math.sin(x / 9) +
    3 * Math.cos(z / 7) +
    2 * Math.sin((x + z) / 5) +
    Math.cos((x - z) / 13) * 3;
  return 64 + Math.round(h);
}

function hash(x: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

interface BlockStates {
  bedrock: number;
  stone: number;
  deep: number;
  dirt: number;
  grass: number;
  water: number;
  sand: number;
  log: number;
  leaves: number;
  air: number;
}

/** State ids for the blocks the terrain uses (pre-1.13: id << 4 | meta). */
export function blockStates(mcData: IndexedData): BlockStates {
  const flat = mcData.supportFeature('blockStateId');
  const pick = (...names: string[]): number => {
    for (const n of names) {
      const b = mcData.blocksByName[n];
      if (b) return flat ? (b.defaultState ?? b.minStateId ?? 0) : b.id << 4;
    }
    throw new Error(`No block ${names.join('/')} in ${mcData.version.minecraftVersion}`);
  };
  return {
    bedrock: pick('bedrock'),
    stone: pick('stone'),
    deep: mcData.blocksByName.deepslate ? pick('deepslate') : pick('stone'),
    dirt: pick('dirt'),
    grass: pick('grass_block', 'grass'),
    water: pick('water'),
    sand: pick('sand'),
    log: pick('oak_log', 'log'),
    leaves: pick('oak_leaves', 'leaves'),
    air: pick('air'),
  };
}

export interface WorldContext {
  version: string;
  mcData: IndexedData;
  filler: PacketFiller;
  /** 1.18+: world bottom and height from the overworld dimension type. */
  minY: number;
  height: number;
}

interface ColumnLike {
  setBlockStateId(pos: Vec3, id: number): void;
  setSkyLight(pos: Vec3, light: number): void;
  getMask(): number | unknown[];
  dump(): Buffer;
  dumpBiomes?(): number[];
}

/** One chunk column as the packets to send ([name, params]), in order. */
export function chunkPackets(
  ctx: WorldContext,
  cx: number,
  cz: number,
): Array<[string, Record<string, unknown>]> {
  const { mcData, filler, minY, height } = ctx;
  const Chunk = prismarineChunk(ctx.version as never) as unknown as new (
    opts?: object,
  ) => ColumnLike;
  const column = new Chunk({ minY, worldHeight: height });
  const s = blockStates(mcData);
  const legacyLight =
    !filler.has('update_light') && !filler.fields('map_chunk')?.includes('skyLight');
  const pos = new Vec3(0, 0, 0);
  const heights = new Int32Array(256);
  let maxTop = minY;
  let minTop = Infinity;

  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx;
      const wz = cz * 16 + lz;
      const h = surfaceHeight(wx, wz);
      const water = h < SEA_LEVEL;
      const set = (y: number, id: number): void => {
        pos.set(lx, y, lz);
        column.setBlockStateId(pos, id);
      };
      set(minY, s.bedrock);
      for (let y = minY + 1; y <= h; y++) {
        let id = y < 0 ? s.deep : s.stone;
        if (y > h - 4) id = water || h <= SEA_LEVEL + 1 ? s.sand : s.dirt;
        if (y === h && !water && h > SEA_LEVEL + 1) id = s.grass;
        set(y, id);
      }
      let top = h;
      if (water) {
        for (let y = h + 1; y <= SEA_LEVEL; y++) set(y, s.water);
        top = SEA_LEVEL;
      } else if (
        lx >= 2 &&
        lx <= 13 &&
        lz >= 2 &&
        lz <= 13 &&
        h > SEA_LEVEL + 1 &&
        hash(wx, wz) % 61 === 0
      ) {
        // A small oak: 4 logs and a 5x5x2 + 3x3 leaf crown (stays inside this chunk).
        for (let y = h + 1; y <= h + 4; y++) set(y, s.log);
        for (let dy = 3; dy <= 5; dy++) {
          const r = dy === 5 ? 1 : 2;
          for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
              if (
                (dx !== 0 || dz !== 0 || dy === 5) &&
                Math.abs(dx) + Math.abs(dz) < 2 * r + (dy === 5 ? 1 : 0)
              ) {
                pos.set(lx + dx, h + dy, lz + dz);
                column.setBlockStateId(pos, s.leaves);
              }
            }
          }
        }
        top = h + 5;
      }
      heights[lz * 16 + lx] = top;
      maxTop = Math.max(maxTop, top);
      minTop = Math.min(minTop, top);
    }
  }
  if (legacyLight) {
    // Pre-1.14 sections carry sky light: full light above the surface, up to the top section.
    const sectionTop = (Math.floor((maxTop - minY) / 16) + 1) * 16 + minY;
    for (let i = 0; i < 256; i++) {
      for (let y = heights[i] + 1; y < sectionTop; y++) {
        pos.set(i & 15, y, i >> 4);
        column.setSkyLight(pos, 15);
      }
    }
  }

  const fields = filler.fields('map_chunk') ?? [];
  const params: Record<string, unknown> = {
    x: cx,
    z: cz,
    groundUp: true,
    bitMap: column.getMask(),
    chunkData: column.dump(),
    blockEntities: [],
    trustEdges: true,
    heightmaps:
      fields.includes('heightmaps') && filler.fieldIsArray('map_chunk', 'heightmaps')
        ? []
        : emptyNbt(),
  };
  if (fields.includes('biomes') && column.dumpBiomes) params.biomes = column.dumpBiomes();
  const out: Array<[string, Record<string, unknown>]> = [];
  if (legacyLight) {
    out.push(['map_chunk', params]);
    return out;
  }

  const light = buildLight(heights, minY, height, minTop, maxTop);
  if (fields.includes('skyLight')) {
    // 1.18+: light travels in map_chunk.
    Object.assign(params, light.modern);
    out.push(['map_chunk', params]);
  } else if (filler.fieldIsArray('update_light', 'skyLightMask')) {
    // 1.17: separate update_light with long-array masks.
    const mask = params.bitMap as unknown;
    if (filler.fieldIsArray('map_chunk', 'bitMap') && !Array.isArray(mask))
      params.bitMap = [BigInt(mask as number)];
    out.push(['update_light', { chunkX: cx, chunkZ: cz, trustEdges: true, ...light.modern }]);
    out.push(['map_chunk', params]);
  } else {
    // 1.14–1.16: update_light with int masks and a raw payload, sent before the chunk.
    out.push(['update_light', { chunkX: cx, chunkZ: cz, trustEdges: true, ...light.legacy }]);
    out.push(['map_chunk', params]);
  }
  return out;
}

function emptyNbt(): Record<string, unknown> {
  return { type: 'compound', name: '', value: {} };
}

/**
 * Sky light per section (block light all empty). Section i covers y = minY + (i-1)*16 … +15
 * (index 0 and the last one are the light sections just below/above the world).
 */
function buildLight(
  heights: Int32Array,
  minY: number,
  height: number,
  minTop: number,
  maxTop: number,
) {
  const count = height / 16 + 2;
  const full = new Uint8Array(2048).fill(0xff);
  const sky: Uint8Array[] = [];
  let skyMask = 0n;
  let emptySky = 0n;
  for (let i = 0; i < count; i++) {
    const base = minY + (i - 1) * 16;
    if (base + 15 <= minTop) {
      emptySky |= 1n << BigInt(i);
      continue;
    }
    skyMask |= 1n << BigInt(i);
    if (base > maxTop) {
      sky.push(full);
      continue;
    }
    const arr = new Uint8Array(2048);
    for (let y = 0; y < 16; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          if (base + y > heights[z * 16 + x]) {
            const idx = (y << 8) | (z << 4) | x;
            arr[idx >> 1] |= idx & 1 ? 0xf0 : 0x0f;
          }
        }
      }
    }
    sky.push(arr);
  }
  const allBlock = (1n << BigInt(count)) - 1n;
  const longs = (m: bigint): bigint[] => (m === 0n ? [] : [BigInt.asIntN(64, m)]);
  const varintHeader = Buffer.from([0x80, 0x10]); // varint 2048
  return {
    modern: {
      skyLightMask: longs(skyMask),
      blockLightMask: [],
      emptySkyLightMask: longs(emptySky),
      emptyBlockLightMask: longs(allBlock),
      skyLight: sky.map((a) => Array.from(a)),
      blockLight: [],
    },
    legacy: {
      skyLightMask: Number(skyMask),
      blockLightMask: 0,
      emptySkyLightMask: Number(emptySky),
      emptyBlockLightMask: Number(allBlock),
      data: Buffer.concat(sky.flatMap((a) => [varintHeader, Buffer.from(a)])),
    },
  };
}
