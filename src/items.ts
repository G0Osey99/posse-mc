// Item helpers shared by digging, crafting and the pathfinder.
import type { Registry } from 'prismarine-registry';
import type { Item } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- prismarine-item's enchant shapes vary by version */

export interface Enchant {
  name: string;
  lvl: number;
}

/**
 * An item's enchantments as `{ name, lvl }` in every version. prismarine-item returns the raw
 * component (`{ enchantments: [{ id, level }] }`) for 1.20.5+ items, which prismarine-block's dig
 * time can't read.
 */
export function enchantsOf(registry: Registry, item: Item | null | undefined): Enchant[] {
  if (!item) return [];
  let raw: any;
  try {
    raw = (item as any).enchants;
  } catch {
    return [];
  }
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.enchantments) ? raw.enchantments : [];
  const enchantments = (registry as any).enchantments as Record<number, { name: string }> | undefined;
  const out: Enchant[] = [];
  for (const e of list) {
    const name = typeof e.name === 'string' ? e.name : typeof e.id === 'string' ? e.id : enchantments?.[e.id]?.name;
    const lvl = Number(e.lvl ?? e.level ?? 0);
    if (name) out.push({ name: String(name).replace(/^minecraft:/, ''), lvl });
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
