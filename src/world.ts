// The lazy world (docs/design.md → World). Chunk payloads are kept as received, with the
// block changes since, and only decoded into prismarine-chunk columns when something reads them.
import zlib from 'node:zlib';
import { Vec3 } from 'vec3';
import type { Block } from 'prismarine-block';
import type { VersionKit } from './registry.js';

/** One `Chunk.load` call's arguments, kept until the column is decoded. */
export interface ChunkLoad {
  /** Raw section data as received (stored deflated, see `packed`). */
  data: Buffer;
  /** True once `data` holds the deflated payload. */
  packed?: boolean;
  bitMap?: number;
  skyLightSent?: boolean;
  groundUp?: boolean;
  /** 1.15–1.17: biomes sent next to the data. */
  biomes?: number[];
}

/* eslint-disable @typescript-eslint/no-explicit-any -- prismarine-chunk columns are untyped per version */
type Column = any;

interface ColumnRecord {
  x: number;
  z: number;
  loads: ChunkLoad[];
  /** Block changes since the loads: local index → state id (latest wins). */
  deltas: Map<number, number>;
  decoded: Column | null;
  bytes: number;
}

export interface WorldDimension {
  minY: number;
  height: number;
  dimension: string;
}

export interface WorldStats {
  columns: number;
  decoded: number;
  bytes: number;
}

/** Packs block coordinates inside a column (x, z in 0–15, y relative to minY) into one number. */
export function localIndex(x: number, y: number, z: number, minY: number): number {
  return ((y - minY) << 8) | ((z & 15) << 4) | (x & 15);
}

export function unpackLocalIndex(index: number, minY: number): { x: number; y: number; z: number } {
  return { x: index & 15, z: (index >> 4) & 15, y: (index >> 8) + minY };
}

const key = (x: number, z: number): string => `${x},${z}`;

/** Chebyshev distance in chunks. */
export function chunkDistance(ax: number, az: number, bx: number, bz: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

export class LazyWorld {
  private readonly columns = new Map<string, ColumnRecord>();
  /** Decoded columns, least recently used first. */
  private readonly decodedOrder = new Set<string>();
  /** Called for every applied block change (motion uses it to notice the floor going away). */
  onBlockChange: ((x: number, y: number, z: number) => void) | null = null;
  private centerX = 0;
  private centerZ = 0;
  private hasCenter = false;

  constructor(
    private readonly kit: VersionKit,
    private readonly dim: () => WorldDimension,
    /** Columns kept around the bot, in chunks. 0 keeps nothing. */
    public radius: number,
    /** Decoded columns kept at most (the rest stay raw); physics needs the few around the bot. */
    private readonly maxDecoded = 16,
  ) {}

  stats(): WorldStats {
    let bytes = 0;
    for (const col of this.columns.values()) bytes += col.bytes;
    return { columns: this.columns.size, decoded: this.decodedOrder.size, bytes };
  }

  clear(): void {
    this.columns.clear();
    this.decodedOrder.clear();
  }

  /** Moves the keep-radius to the bot's chunk; drops columns beyond radius + 1. */
  setCenter(chunkX: number, chunkZ: number): void {
    if (this.hasCenter && chunkX === this.centerX && chunkZ === this.centerZ) return;
    this.centerX = chunkX;
    this.centerZ = chunkZ;
    this.hasCenter = true;
    for (const [k, col] of this.columns) {
      if (chunkDistance(col.x, col.z, chunkX, chunkZ) > this.radius + 1) {
        this.columns.delete(k);
        this.decodedOrder.delete(k);
      }
    }
  }

  /** Whether a column at this position would be kept (kept ones are dropped beyond radius + 1). */
  wants(chunkX: number, chunkZ: number): boolean {
    if (this.radius <= 0) return false;
    return !this.hasCenter || chunkDistance(chunkX, chunkZ, this.centerX, this.centerZ) <= this.radius;
  }

  hasColumn(chunkX: number, chunkZ: number): boolean {
    return this.columns.has(key(chunkX, chunkZ));
  }

  /** A chunk payload arrived. Full (ground-up) loads replace the column; partial ones stack. */
  addLoad(chunkX: number, chunkZ: number, load: ChunkLoad): boolean {
    if (!this.wants(chunkX, chunkZ)) return false;
    const k = key(chunkX, chunkZ);
    const full = load.groundUp !== false;
    let col = this.columns.get(k);
    if (!col || full) {
      if (full && load.bitMap === 0 && load.groundUp) {
        // Pre-1.9 "unload" encoding: a ground-up chunk with no sections.
        this.unload(chunkX, chunkZ);
        return false;
      }
      col = { x: chunkX, z: chunkZ, loads: [], deltas: new Map(), decoded: null, bytes: 0 };
      this.columns.set(k, col);
      this.decodedOrder.delete(k);
    }
    // A partial load (≤1.16) rewrites whole sections: earlier block changes in them are superseded.
    if (!full && col.deltas.size > 0) {
      const mask = load.bitMap ?? 0xffff;
      for (const index of col.deltas.keys()) {
        if (mask & (1 << (index >> 12))) col.deltas.delete(index);
      }
    }
    if (col.decoded) this.loadInto(col.decoded, load);
    // Chunk sections compress well (palettes, runs of air): ~5–10× less memory per kept column.
    const packed = load.data.length > 512 ? { ...load, data: zlib.deflateSync(load.data, { level: 1 }), packed: true } : load;
    col.loads.push(packed);
    col.bytes += packed.data.length;
    return true;
  }

  unload(chunkX: number, chunkZ: number): void {
    const k = key(chunkX, chunkZ);
    this.columns.delete(k);
    this.decodedOrder.delete(k);
  }

  private loadInto(column: Column, load: ChunkLoad): void {
    const data = load.packed ? zlib.inflateSync(load.data) : load.data;
    column.load(data, load.bitMap, load.skyLightSent, load.groundUp);
    if (load.biomes !== undefined && typeof column.loadBiomes === 'function') column.loadBiomes(load.biomes);
  }

  /**
   * The decoded column, decoding it now if needed. Null when the column isn't loaded. With
   * `cache: false` a column that wasn't decoded yet is decoded for this call only (screenshots).
   */
  column(chunkX: number, chunkZ: number, cache = true): Column | null {
    const k = key(chunkX, chunkZ);
    const col = this.columns.get(k);
    if (!col) return null;
    if (col.decoded) {
      this.decodedOrder.delete(k);
      this.decodedOrder.add(k);
      return col.decoded;
    }
    const { minY, height } = this.dim();
    const column = new this.kit.Chunk({ minY, worldHeight: height });
    try {
      for (const load of col.loads) this.loadInto(column, load);
    } catch {
      // A malformed payload: forget the column rather than serve garbage.
      this.unload(chunkX, chunkZ);
      return null;
    }
    const pos = new Vec3(0, 0, 0);
    for (const [index, stateId] of col.deltas) {
      const p = unpackLocalIndex(index, minY);
      column.setBlockStateId(pos.set(p.x, p.y, p.z), stateId);
    }
    if (!cache) return column;
    col.decoded = column;
    this.decodedOrder.add(k);
    this.evictDecoded();
    return column;
  }

  private evictDecoded(): void {
    while (this.decodedOrder.size > this.maxDecoded) {
      const oldest = this.decodedOrder.values().next().value as string;
      this.decodedOrder.delete(oldest);
      const col = this.columns.get(oldest);
      if (col) col.decoded = null;
    }
  }

  /** State id at a world position, or null when its column isn't loaded. Decodes the column. */
  stateIdAt(x: number, y: number, z: number): number | null {
    const column = this.column(x >> 4, z >> 4);
    if (!column) return null;
    const { minY, height } = this.dim();
    if (y < minY || y >= minY + height) return 0;
    return column.getBlockStateId(new Vec3(x & 15, y, z & 15)) as number;
  }

  /**
   * Applies a block change. Returns the previous state id when it was cheap or `needOld` asked for
   * it (which decodes the column); otherwise undefined. Null when the column isn't loaded.
   */
  setStateId(x: number, y: number, z: number, stateId: number, needOld: boolean): number | null | undefined {
    const col = this.columns.get(key(x >> 4, z >> 4));
    if (!col) return null;
    this.onBlockChange?.(x, y, z);
    const { minY } = this.dim();
    col.deltas.set(localIndex(x, y, z, minY), stateId);
    const column = col.decoded ?? (needOld ? this.column(col.x, col.z) : null);
    if (!column) return undefined;
    const pos = new Vec3(x & 15, y, z & 15);
    const old = column.getBlockStateId(pos) as number;
    column.setBlockStateId(pos, stateId);
    return old;
  }

  /** A prismarine-block Block with its position, or null when the column isn't loaded. */
  blockAt(x: number, y: number, z: number): Block | null {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    const column = this.column(fx >> 4, fz >> 4);
    if (!column) return null;
    const local = new Vec3(fx & 15, fy, fz & 15);
    const block = column.getBlock(local) as Block;
    block.position = new Vec3(fx, fy, fz);
    return block;
  }

  /** A block from a state id at a position, for blockUpdate. */
  makeBlock(stateId: number, x: number, y: number, z: number): Block {
    const block = this.kit.Block.fromStateId(stateId, 0) as Block;
    block.position = new Vec3(x, y, z);
    return block;
  }

  /**
   * Copies a box of state ids (index `(y * sizeZ + z) * sizeX + x`) for screenshots, and the biome
   * of every column at height `biomeY` (index `z * sizeX + x`). Unloaded columns stay 0 (air).
   * Columns decoded only for this copy aren't kept.
   */
  copyRegion(
    originX: number,
    originY: number,
    originZ: number,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    biomeY = originY + (sizeY >> 1),
  ): { states: Uint16Array; biomes: Uint16Array } {
    const states = new Uint16Array(sizeX * sizeY * sizeZ);
    const biomes = new Uint16Array(sizeX * sizeZ);
    const { minY, height } = this.dim();
    const pos = new Vec3(0, 0, 0);
    const y0 = Math.max(originY, minY);
    const y1 = Math.min(originY + sizeY, minY + height);
    const by = Math.min(Math.max(biomeY, minY), minY + height - 1);
    for (let cx = originX >> 4; cx <= (originX + sizeX - 1) >> 4; cx++) {
      for (let cz = originZ >> 4; cz <= (originZ + sizeZ - 1) >> 4; cz++) {
        const column = this.column(cx, cz, false);
        if (!column) continue;
        const x0 = Math.max(originX, cx << 4);
        const x1 = Math.min(originX + sizeX, (cx << 4) + 16);
        const z0 = Math.max(originZ, cz << 4);
        const z1 = Math.min(originZ + sizeZ, (cz << 4) + 16);
        for (let y = y0; y < y1; y++) {
          for (let z = z0; z < z1; z++) {
            const row = ((y - originY) * sizeZ + (z - originZ)) * sizeX - originX;
            for (let x = x0; x < x1; x++) {
              states[row + x] = column.getBlockStateId(pos.set(x & 15, y, z & 15)) as number;
            }
          }
        }
        if (typeof column.getBiome !== 'function') continue;
        for (let z = z0; z < z1; z++) {
          for (let x = x0; x < x1; x++) {
            biomes[(z - originZ) * sizeX + (x - originX)] = column.getBiome(pos.set(x & 15, by, z & 15)) as number;
          }
        }
      }
    }
    return { states, biomes };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
