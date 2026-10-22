import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { versionKit } from '../src/registry.js';
import { ChunkStore } from '../src/chunkStore.js';
import { KEEP_MARGIN, LazyWorld, chunkDistance, localIndex, unpackLocalIndex } from '../src/world.js';
import { chunkCoordFilter } from '../src/features/world.js';

const require = createRequire(import.meta.url);

function chunkPayload(version: string, fill: (set: (x: number, y: number, z: number, state: number) => void) => void) {
  const kit = versionKit(version);
  const Chunk = require('prismarine-chunk')(kit.registry);
  const column = new Chunk({ minY: -64, worldHeight: 384 });
  fill((x, y, z, state) => column.setBlockStateId(new Vec3(x, y, z), state));
  return { kit, data: column.dump() as Buffer };
}

describe('local index', () => {
  it('round-trips column coordinates including negative heights', () => {
    for (const [x, y, z] of [[0, -64, 0], [15, 319, 15], [3, 70, 9]] as const) {
      expect(unpackLocalIndex(localIndex(x, y, z, -64), -64)).toEqual({ x, y, z });
    }
  });
});

describe('LazyWorld (1.18.2)', () => {
  const stone = versionKit('1.18.2').registry.blocksByName.stone!.defaultState!;
  const dirt = versionKit('1.18.2').registry.blocksByName.dirt!.defaultState!;
  const dim = () => ({ minY: -64, height: 384, dimension: 'overworld' });

  it('keeps payloads raw until read, then decodes once', () => {
    const { kit, data } = chunkPayload('1.18.2', (set) => set(1, 64, 2, stone));
    const world = new LazyWorld(kit, dim, 4);
    expect(world.addLoad(0, 0, { data })).toBe(true);
    expect(world.stats()).toMatchObject({ columns: 1, decoded: 0 });
    expect(world.stateIdAt(1, 64, 2)).toBe(stone);
    expect(world.stats().decoded).toBe(1);
    expect(world.blockAt(1.5, 64.2, 2.9)?.name).toBe('stone');
  });

  it('replays block changes made before decoding', () => {
    const { kit, data } = chunkPayload('1.18.2', (set) => set(1, 64, 2, stone));
    const world = new LazyWorld(kit, dim, 4);
    world.addLoad(0, 0, { data });
    expect(world.setStateId(1, 64, 2, dirt, false)).toBeUndefined(); // not decoded: no old state
    expect(world.stateIdAt(1, 64, 2)).toBe(dirt);
    expect(world.setStateId(1, 64, 2, 0, false)).toBe(dirt); // decoded now: old state is cheap
  });

  it('returns null for unloaded columns', () => {
    const world = new LazyWorld(versionKit('1.18.2'), dim, 4);
    expect(world.stateIdAt(100, 64, 100)).toBeNull();
    expect(world.setStateId(100, 64, 100, stone, true)).toBeNull();
  });

  it('drops columns outside the keep radius', () => {
    const { kit, data } = chunkPayload('1.18.2', () => undefined);
    const world = new LazyWorld(kit, dim, 2);
    world.setCenter(0, 0);
    // Kept up to radius + KEEP_MARGIN, so a short walk doesn't leave holes the server won't refill.
    expect(world.addLoad(2 + KEEP_MARGIN, 0, { data })).toBe(true);
    expect(world.addLoad(3 + KEEP_MARGIN, 0, { data })).toBe(false);
    world.setCenter(1, 0);
    world.setCenter(0, 0);
    expect(world.hasColumn(2 + KEEP_MARGIN, 0)).toBe(true);
    world.setCenter(10, 10);
    expect(world.hasColumn(2 + KEEP_MARGIN, 0)).toBe(false);
  });

  it('shares identical payloads between bots and frees them with the last one', () => {
    const { kit, data } = chunkPayload('1.18.2', (set) => set(1, 64, 2, stone));
    const store = new ChunkStore();
    const a = new LazyWorld(kit, dim, 4, 16, store);
    const b = new LazyWorld(kit, dim, 4, 16, store);
    a.addLoad(0, 0, { data });
    b.addLoad(0, 0, { data: Buffer.from(data) });
    b.addLoad(1, 0, { data });
    expect(store.stats()).toMatchObject({ payloads: 1, refs: 3 });
    expect(b.stateIdAt(1, 64, 2)).toBe(stone);
    a.clear();
    expect(store.stats()).toMatchObject({ payloads: 1, refs: 2 });
    b.unload(1, 0);
    b.setCenter(100, 100); // evicts (0,0)
    expect(store.stats()).toMatchObject({ payloads: 0, refs: 0, bytes: 0 });
  });

  it('keeps nothing with radius 0', () => {
    const { kit, data } = chunkPayload('1.18.2', () => undefined);
    expect(new LazyWorld(kit, dim, 0).addLoad(0, 0, { data })).toBe(false);
  });

  it('copies a region across columns', () => {
    const { kit, data } = chunkPayload('1.18.2', (set) => {
      set(15, 64, 0, stone);
      set(0, 65, 0, dirt);
    });
    const world = new LazyWorld(kit, dim, 4);
    world.addLoad(0, 0, { data });
    world.addLoad(1, 0, { data });
    expect(world.stats().bytes).toBeLessThan(data.length); // stored deflated
    const { states, biomes } = world.copyRegion(14, 64, 0, 4, 2, 1); // x 14..17, y 64..65
    expect([...states]).toEqual([0, stone, 0, 0, 0, 0, dirt, 0]);
    expect(biomes).toHaveLength(4);
    expect(world.stats().decoded).toBe(0); // decoded for the copy only
  });

  it('evicts decoded columns beyond the LRU size but can decode them again', () => {
    const { kit, data } = chunkPayload('1.18.2', (set) => set(0, 64, 0, stone));
    const world = new LazyWorld(kit, dim, 8, 2);
    for (let x = 0; x < 4; x++) world.addLoad(x, 0, { data });
    for (let x = 0; x < 4; x++) world.stateIdAt(x * 16, 64, 0);
    expect(world.stats().decoded).toBe(2);
    expect(world.stateIdAt(0, 64, 0)).toBe(stone);
  });
});

describe('chunkCoordFilter', () => {
  it('reads the i32 chunk coordinates after the packet id', () => {
    const buf = Buffer.alloc(9);
    buf[0] = 0x22;
    buf.writeInt32BE(-3, 1);
    buf.writeInt32BE(5, 5);
    const seen: number[][] = [];
    chunkCoordFilter((x, z) => (seen.push([x, z]), x < 0))(buf, 1);
    expect(seen).toEqual([[-3, 5]]);
  });
});

describe('chunkDistance', () => {
  it('is the Chebyshev distance', () => {
    expect(chunkDistance(0, 0, 3, -5)).toBe(5);
  });
});
