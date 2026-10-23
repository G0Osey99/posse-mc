// What the pathfinder needs to know about a block state (can it be walked through, stood on, broken,
// replaced…), computed once per state and shared by every bot on the version. minecraft-pathfinding
// keeps this in class statics, which breaks a process with bots on several versions.
import type { VersionKit } from '../registry.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- prismarine-block is loosely typed */

export const enum BlockFlag {
  /** No collision: the body can be in it. */
  Passable = 1 << 0,
  /** Collision top high enough to stand on (see `height`). */
  Standable = 1 << 1,
  Water = 1 << 2,
  Lava = 1 << 3,
  Climbable = 1 << 4,
  /** Hurts or traps: fire, cactus, magma, berry bushes, cobwebs, powder snow, portals… */
  Avoid = 1 << 5,
  /** A block can be placed into it (air, plants, fluids, snow layers…). */
  Replaceable = 1 << 6,
  /** Falls when unsupported (sand, gravel, concrete powder…). */
  Gravity = 1 << 7,
  /** Can be dug at all (hardness ≥ 0, not bedrock-like). */
  Breakable = 1 << 8,
  /** A wooden door, gate or trapdoor the bot can open. */
  Openable = 1 << 9,
  /** Open (for openable blocks). */
  Open = 1 << 10,
  /** Holds items or is otherwise not to be broken by default (chests, furnaces, spawners…). */
  Precious = 1 << 11,
  /** Air (or cave/void air). */
  Air = 1 << 12,
  /** Collision so low it doesn't block walking (carpets, lily pads, snow layer 1–2). */
  Flat = 1 << 13,
  /** Slows walking (soul sand, honey). */
  Slow = 1 << 14,
  /** Taller than a block (fences, walls): can't be stood on or jumped over. */
  Tall = 1 << 15,
}

const AVOID = /^(fire|soul_fire|lava|flowing_lava|magma_block|cactus|sweet_berry_bush|cobweb|web|powder_snow|wither_rose|nether_portal|portal|end_portal|end_gateway|end_portal_frame|campfire|soul_campfire|pointed_dripstone|stonecutter|bubble_column)$/;
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|water|flowing_water|lava|flowing_lava|fire|soul_fire|seagrass|tall_seagrass|structure_void|light|bubble_column|hanging_roots|nether_sprouts|warped_roots|crimson_roots|short_dry_grass|tall_dry_grass|bush|leaf_litter)$/;
const CLIMBABLE = /^(ladder|vine|scaffolding|weeping_vines|weeping_vines_plant|twisting_vines|twisting_vines_plant|cave_vines|cave_vines_plant)$/;
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*concrete_powder|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone|scaffolding)$/;
const OPENABLE = /^((?!iron_).*_door|wooden_door|(?!iron_).*trapdoor|.*fence_gate)$/;
const PRECIOUS = /^(chest|trapped_chest|ender_chest|barrel|.*shulker_box|furnace|lit_furnace|blast_furnace|smoker|hopper|dispenser|dropper|brewing_stand|spawner|mob_spawner|trial_spawner|vault|beacon|enchanting_table|enchantment_table|.*_bed|bed|chiseled_bookshelf|decorated_pot|crafter|jukebox|lectern|respawn_anchor|end_portal_frame|reinforced_deepslate|budding_amethyst)$/;
const SLOW = /^(soul_sand|honey_block)$/;
const AIR = /^(air|cave_air|void_air)$/;

export interface BlockInfoTable {
  flags(stateId: number): number;
  /** Top of the collision box within the block (0–1.5; 0 for passable blocks). */
  height(stateId: number): number;
  /** Ms to dig with nothing in hand (Infinity when unbreakable); the planner scales by tool. */
  name(stateId: number): string;
  block(stateId: number): any;
}

const tables = new WeakMap<VersionKit, BlockInfoTable>();

export function blockInfo(kit: VersionKit): BlockInfoTable {
  let table = tables.get(kit);
  if (table) return table;
  const flagCache = new Map<number, number>();
  const heightCache = new Map<number, number>();
  const blockCache = new Map<number, any>();
  const block = (stateId: number): any => {
    let b = blockCache.get(stateId);
    if (b === undefined) {
      try {
        b = kit.Block.fromStateId(stateId, 0);
      } catch {
        b = null;
      }
      blockCache.set(stateId, b);
    }
    return b;
  };
  const compute = (stateId: number): void => {
    const b = block(stateId);
    if (!b) {
      flagCache.set(stateId, BlockFlag.Avoid);
      heightCache.set(stateId, 0);
      return;
    }
    const name: string = b.name;
    const props: Record<string, unknown> = (typeof b.getProperties === 'function' ? b.getProperties() : {}) ?? {};
    const shapes: number[][] = b.shapes ?? [];
    let top = 0;
    let minY = 1;
    for (const s of shapes) {
      top = Math.max(top, s[4]!);
      minY = Math.min(minY, s[1]!);
    }
    let flags = 0;
    const waterlogged = props.waterlogged === true || props.waterlogged === 'true';
    if (AIR.test(name)) flags |= BlockFlag.Air;
    if (name === 'water' || name === 'flowing_water' || name === 'bubble_column' || name === 'seagrass' || name === 'tall_seagrass' || name === 'kelp' || name === 'kelp_plant' || waterlogged) flags |= BlockFlag.Water;
    if (name === 'lava' || name === 'flowing_lava') flags |= BlockFlag.Lava;
    if (CLIMBABLE.test(name)) flags |= BlockFlag.Climbable;
    if (AVOID.test(name)) flags |= BlockFlag.Avoid;
    if (REPLACEABLE.test(name) || (name === 'snow' && Number(props.layers ?? b.metadata + 1) <= 1)) flags |= BlockFlag.Replaceable;
    if (GRAVITY.test(name)) flags |= BlockFlag.Gravity;
    if (SLOW.test(name)) flags |= BlockFlag.Slow;
    if (PRECIOUS.test(name)) flags |= BlockFlag.Precious;
    if (b.diggable !== false && b.hardness !== null && b.hardness >= 0 && !(flags & BlockFlag.Air) && !(flags & (BlockFlag.Water | BlockFlag.Lava) && shapes.length === 0)) {
      flags |= BlockFlag.Breakable;
    }
    if (OPENABLE.test(name)) {
      flags |= BlockFlag.Openable;
      if (props.open === true || props.open === 'true') flags |= BlockFlag.Open;
    }
    let height = 0;
    if (shapes.length === 0) {
      flags |= BlockFlag.Passable;
    } else if (top <= 0.2 && minY === 0) {
      // Carpets, lily pads, thin snow: walked over, and stood on.
      flags |= BlockFlag.Passable | BlockFlag.Flat;
      height = top;
    } else if (flags & BlockFlag.Openable && flags & BlockFlag.Open && !name.endsWith('trapdoor')) {
      flags |= BlockFlag.Passable;
    } else {
      height = top;
      if (top > 1) flags |= BlockFlag.Tall;
      else if (top >= 0.5) flags |= BlockFlag.Standable;
    }
    if (flags & BlockFlag.Climbable && name !== 'scaffolding') flags |= BlockFlag.Passable;
    flagCache.set(stateId, flags);
    heightCache.set(stateId, height);
  };
  table = {
    flags(stateId) {
      let f = flagCache.get(stateId);
      if (f === undefined) {
        compute(stateId);
        f = flagCache.get(stateId)!;
      }
      return f;
    },
    height(stateId) {
      let h = heightCache.get(stateId);
      if (h === undefined) {
        compute(stateId);
        h = heightCache.get(stateId)!;
      }
      return h;
    },
    name(stateId) {
      return block(stateId)?.name ?? 'unknown';
    },
    block,
  };
  tables.set(kit, table);
  return table;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
