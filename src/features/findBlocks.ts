// Block search around a point: reads state ids straight from the kept chunks (no Block objects
// unless a matcher function asks for them) and returns the nearest matches first. Only chunks
// within `worldRadius` are kept, so that bounds what can be found.
import { Vec3 } from 'vec3';
import type { Block } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- minecraft-data blocks are loosely typed */

export interface FindBlocksOptions {
  /** Block names (`diamond_ore`), block ids, or a test on the Block (slower: builds each candidate). */
  matching: string | number | readonly (string | number)[] | ((block: Block) => boolean);
  /** Search radius in blocks (default 16). */
  maxDistance?: number;
  /** How many to return, nearest first (default 1). */
  count?: number;
  /** Centre of the search (default: the bot's position). */
  point?: Vec3;
}

export interface StateSource {
  stateIdAt(x: number, y: number, z: number): number | null;
  blockAt(x: number, y: number, z: number): Block | null;
}

/** Every state id of the named (or numbered) blocks. */
export function stateIdsOf(registry: any, matching: readonly (string | number)[]): Set<number> {
  const out = new Set<number>();
  for (const m of matching) {
    const block = typeof m === 'number' ? registry.blocks?.[m] : registry.blocksByName?.[String(m).replace(/^minecraft:/, '')];
    if (!block) continue;
    const min = block.minStateId ?? block.id << 4;
    const max = block.maxStateId ?? min + 15;
    for (let s = min; s <= max; s++) out.add(s);
  }
  return out;
}

/** Positions of matching blocks within `maxDistance` of `point`, nearest first. */
export function findBlocks(world: StateSource, registry: any, origin: Vec3, options: FindBlocksOptions, bounds: { minY: number; maxY: number }): Vec3[] {
  const radius = Math.max(0, Math.floor(options.maxDistance ?? 16));
  const count = Math.max(1, options.count ?? 1);
  const center = (options.point ?? origin).floored();
  const test = typeof options.matching === 'function' ? options.matching : null;
  const ids = test ? null : stateIdsOf(registry, Array.isArray(options.matching) ? options.matching : [options.matching as string | number]);
  if (ids && ids.size === 0) return [];

  const found: { pos: Vec3; d: number }[] = [];
  const r2 = radius * radius;
  const y0 = Math.max(bounds.minY, center.y - radius);
  const y1 = Math.min(bounds.maxY, center.y + radius);
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const h2 = dx * dx + dz * dz;
      if (h2 > r2) continue;
      const x = center.x + dx;
      const z = center.z + dz;
      for (let y = y0; y <= y1; y++) {
        const dy = y - center.y;
        const d = h2 + dy * dy;
        if (d > r2) continue;
        const state = world.stateIdAt(x, y, z);
        if (state === null) break; // the column isn't kept
        if (ids) {
          if (!ids.has(state)) continue;
        } else {
          if (state === 0) continue;
          const block = world.blockAt(x, y, z);
          if (!block || !test!(block)) continue;
        }
        found.push({ pos: new Vec3(x, y, z), d });
      }
    }
  }
  found.sort((a, b) => a.d - b.d);
  return found.slice(0, count).map((f) => f.pos);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
