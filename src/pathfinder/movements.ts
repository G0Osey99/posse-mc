// The moves the pathfinder considers from a node, with their cost in ticks: walking (and bridging),
// diagonals, jumping up a block, dropping down, digging down, pillaring/climbing/swimming up,
// parkour across gaps, opening doors. Adapted from minecraft-pathfinding's movement providers (MIT)
// and mineflayer-pathfinder's Movements (MIT), on a per-version block table and a virtual world
// that sees the blocks the path itself breaks and places.
import type { PosseBot } from '../bot.js';
import { enchantsOf } from '../items.js';
import { nodeKey } from './astar.js';
import { BlockFlag, blockInfo, type BlockInfoTable } from './blocks.js';
import {
  CENTER_AFTER_FALL_COST,
  COST_INF,
  fallCost,
  JUMP_ONE_BLOCK_COST,
  LADDER_DOWN_ONE_COST,
  LADDER_UP_ONE_COST,
  SPRINT_ONE_BLOCK_COST,
  WALK_OFF_BLOCK_COST,
  WALK_ONE_BLOCK_COST,
  WALK_ONE_IN_WATER_COST,
  WALK_ONE_OVER_SOUL_SAND_COST,
} from './costs.js';
import type { Pos } from './goals.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- prismarine-block / items are loosely typed */

export type MoveKind = 'start' | 'walk' | 'diagonal' | 'ascend' | 'descend' | 'down' | 'up' | 'parkour';

/** A block to place: at `pos`, clicked against `ref`'s face `face` (pointing from ref to pos). */
export interface PlaceTask {
  pos: Pos;
  ref: Pos;
  face: Pos;
}

/** A change the path makes to the world (seen by later moves of the same path). */
interface Mod {
  key: number;
  /** AIR (broken / opened) or PLACED. */
  state: number;
  next: Mod | null;
}

/** One step of a path: where the feet end up, how, and what to break, place or open first. */
export interface Move extends Pos {
  key: number;
  cost: number;
  parent: Move | null;
  kind: MoveKind;
  toBreak: Pos[];
  toPlace: PlaceTask[];
  /** Doors and gates to open on the way. */
  toOpen: Pos[];
  /** Scaffolding blocks left after this move. */
  remainingBlocks: number;
  /** Parkour: blocks jumped horizontally (2–4). */
  distance?: number;
  /** Changes along the path up to here. */
  mods: Mod | null;
}

/** Extra cost of standing in, breaking or placing at a block (≥ COST_INF forbids it). */
export type ExclusionArea = (pos: Pos, blockName: string) => number;

export interface MovementSettings {
  /** Dig blocks in the way (default true). */
  canDig: boolean;
  /** Place blocks to bridge gaps and pillar up (default true). */
  canPlace: boolean;
  canOpenDoors: boolean;
  allowParkour: boolean;
  allowSprinting: boolean;
  allowDiagonal: boolean;
  /** Pillar straight up by jumping and placing below. */
  allow1by1Towers: boolean;
  /** Highest drop onto solid ground, in blocks (default 4: one heart of damage at most). */
  maxDropDown: number;
  /** Drops into water may be any height. */
  infiniteLiquidDropdownDistance: boolean;
  /** Don't break blocks next to water or lava (they'd flow into the path). */
  dontCreateFlow: boolean;
  /** Don't break a block under sand or gravel. */
  dontMineUnderFallingBlock: boolean;
  /** Extra ticks per block in water. */
  liquidCost: number;
  /** Multiplier on dig time. */
  digCost: number;
  /** Ticks a placement costs. */
  placeCost: number;
  /** Extra ticks per jump. */
  jumpCost: number;
  /** Ticks to open a door or gate. */
  openCost: number;
  /** Items used to bridge and pillar, in order of preference. */
  scaffoldingBlocks: string[];
  /** Never broken. Defaults to blocks holding items (chests, furnaces…) and spawners. */
  blocksCantBreak: Set<string>;
  /** Never walked through. */
  blocksToAvoid: Set<string>;
  exclusionAreasStep: ExclusionArea[];
  exclusionAreasBreak: ExclusionArea[];
  exclusionAreasPlace: ExclusionArea[];
}

export function defaultMovements(): MovementSettings {
  return {
    canDig: true,
    canPlace: true,
    canOpenDoors: true,
    allowParkour: true,
    allowSprinting: true,
    allowDiagonal: true,
    allow1by1Towers: true,
    maxDropDown: 4,
    infiniteLiquidDropdownDistance: true,
    dontCreateFlow: true,
    dontMineUnderFallingBlock: true,
    liquidCost: WALK_ONE_IN_WATER_COST - WALK_ONE_BLOCK_COST,
    digCost: 1,
    placeCost: 20,
    jumpCost: 0,
    openCost: 4,
    scaffoldingBlocks: ['dirt', 'cobblestone', 'netherrack', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'deepslate', 'end_stone', 'sandstone'],
    blocksCantBreak: new Set(),
    blocksToAvoid: new Set(),
    exclusionAreasStep: [],
    exclusionAreasBreak: [],
    exclusionAreasPlace: [],
  };
}

/** States that only exist in a path's virtual world. */
const AIR = -1;
const PLACED = -2;
const UNLOADED = -3;
/** Mods older than this along a path aren't looked at (they're far behind). */
const MOD_SCAN_LIMIT = 48;
const PARKOUR_PENALTY = 3;
const CARDINALS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIAGONALS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * The world as one search sees it: block states (cached for the search), the path's own changes,
 * and costs for breaking and placing with the bot's inventory.
 */
export class PathContext {
  readonly table: BlockInfoTable;
  private readonly states = new Map<number, number>();
  private readonly digTicks = new Map<number, number>();
  private readonly tools: Array<{ type: number; enchants: Array<{ name: string; lvl: number }> }>;
  private readonly effects: Record<number, unknown>;
  private readonly creative: boolean;
  private readonly cantBreak: Set<string>;
  readonly settings: MovementSettings;
  readonly minY: number;
  readonly maxY: number;

  constructor(
    private readonly bot: PosseBot,
    settings: MovementSettings,
  ) {
    this.settings = settings;
    this.table = blockInfo(bot.kit);
    this.minY = bot.game.minY;
    this.maxY = bot.game.minY + bot.game.height - 1;
    this.creative = bot.game.gameMode === 'creative';
    this.effects = ((bot.entity as any)?.effects ?? {}) as Record<number, unknown>;
    this.cantBreak = settings.blocksCantBreak;
    // Tools to dig with: everything in the inventory (the best one is equipped before digging).
    const seen = new Set<number>();
    this.tools = [{ type: -1, enchants: [] }];
    for (const item of bot.inventory.items()) {
      if (seen.has(item.type)) continue;
      seen.add(item.type);
      this.tools.push({ type: item.type, enchants: enchantsOf(bot.registry, item) });
    }
  }

  /** The state id at a position (cached), UNLOADED if its chunk isn't kept. */
  worldState(x: number, y: number, z: number): number {
    if (y < this.minY || y > this.maxY) return y < this.minY ? UNLOADED : 0;
    const key = nodeKey(x, y, z);
    let s = this.states.get(key);
    if (s === undefined) {
      s = this.bot.world.stateIdAt(x, y, z) ?? UNLOADED;
      this.states.set(key, s);
    }
    return s;
  }

  /** Forgets cached states (after block updates). */
  invalidate(): void {
    this.states.clear();
  }

  state(node: Move | null, x: number, y: number, z: number): number {
    if (node?.mods) {
      const key = nodeKey(x, y, z);
      let n = 0;
      for (let m: Mod | null = node.mods; m && n < MOD_SCAN_LIMIT; m = m.next, n++) if (m.key === key) return m.state;
    }
    return this.worldState(x, y, z);
  }

  flags(state: number): number {
    if (state === AIR) return BlockFlag.Passable | BlockFlag.Air | BlockFlag.Replaceable;
    if (state === PLACED) return BlockFlag.Standable | BlockFlag.Breakable;
    if (state === UNLOADED) return 0;
    let f = this.table.flags(state);
    const name = this.table.name(state);
    if (this.settings.blocksToAvoid.has(name)) f |= BlockFlag.Avoid;
    return f;
  }

  height(state: number): number {
    if (state === PLACED) return 1;
    if (state < 0) return 0;
    return this.table.height(state);
  }

  name(state: number): string {
    if (state === AIR) return 'air';
    if (state === PLACED) return 'placed';
    if (state === UNLOADED) return 'unloaded';
    return this.table.name(state);
  }

  isLoaded(state: number): boolean {
    return state !== UNLOADED;
  }

  /** Ticks to dig a state with the best tool in the inventory. */
  digTime(state: number): number {
    if (state === PLACED) return 10; // a scaffolding block
    const cached = this.digTicks.get(state);
    if (cached !== undefined) return cached;
    const block = this.table.block(state);
    let t = Infinity;
    if (block) {
      for (const tool of this.tools) {
        const ms = block.digTime(tool.type === -1 ? null : tool.type, this.creative, false, false, tool.enchants, this.effects);
        if (ms < t) t = ms;
      }
    }
    t = t / 50; // ms → ticks
    this.digTicks.set(state, t);
    return t;
  }

  /** The best tool (item type) for a block, or null for the hand. */
  bestTool(state: number): number | null {
    const block = this.table.block(state);
    if (!block) return null;
    let best: number | null = null;
    let bestTime = Infinity;
    for (const tool of this.tools) {
      const ms = block.digTime(tool.type === -1 ? null : tool.type, this.creative, false, false, tool.enchants, this.effects);
      if (ms < bestTime) {
        bestTime = ms;
        best = tool.type === -1 ? null : tool.type;
      }
    }
    return best;
  }

  /** The scaffolding block count in the inventory. */
  scaffoldingCount(): number {
    const names = new Set(this.settings.scaffoldingBlocks);
    let count = 0;
    for (const item of this.bot.inventory.items()) if (names.has(item.name)) count += item.count;
    return count;
  }
}

const exclusion = (areas: ExclusionArea[], pos: Pos, name: string): number => {
  if (areas.length === 0) return 0;
  let cost = 0;
  for (const area of areas) cost += area(pos, name);
  return cost;
};

/** Builds the moves out of a node. */
export class MoveGenerator {
  constructor(private readonly ctx: PathContext) {}

  private get s(): MovementSettings {
    return this.ctx.settings;
  }

  start(pos: Pos, remainingBlocks: number): Move {
    return { x: pos.x, y: pos.y, z: pos.z, key: nodeKey(pos.x, pos.y, pos.z), cost: 0, parent: null, kind: 'start', toBreak: [], toPlace: [], toOpen: [], remainingBlocks, mods: null };
  }

  private move(from: Move, x: number, y: number, z: number, kind: MoveKind, cost: number, toBreak: Pos[], toPlace: PlaceTask[], toOpen: Pos[], distance?: number): Move {
    let mods = from.mods;
    for (const b of toBreak) mods = { key: nodeKey(b.x, b.y, b.z), state: AIR, next: mods };
    for (const o of toOpen) mods = { key: nodeKey(o.x, o.y, o.z), state: AIR, next: mods };
    for (const p of toPlace) mods = { key: nodeKey(p.pos.x, p.pos.y, p.pos.z), state: PLACED, next: mods };
    return {
      x,
      y,
      z,
      key: nodeKey(x, y, z),
      cost,
      parent: from,
      kind,
      toBreak,
      toPlace,
      toOpen,
      remainingBlocks: from.remainingBlocks - toPlace.length,
      distance,
      mods,
    };
  }

  private st(node: Move, x: number, y: number, z: number): number {
    return this.ctx.state(node, x, y, z);
  }

  private fl(node: Move, x: number, y: number, z: number): number {
    return this.ctx.flags(this.st(node, x, y, z));
  }

  /** Passable for the body, without breaking anything (and not harmful). */
  private passable(node: Move, x: number, y: number, z: number): boolean {
    const f = this.fl(node, x, y, z);
    return (f & BlockFlag.Passable) !== 0 && (f & (BlockFlag.Avoid | BlockFlag.Lava)) === 0;
  }

  /** Can be stood on (and isn't harmful to stand on). */
  private standable(node: Move, x: number, y: number, z: number): boolean {
    const f = this.fl(node, x, y, z);
    return (f & BlockFlag.Standable) !== 0 && (f & BlockFlag.Avoid) === 0;
  }

  /** Water the body can be in (not a waterlogged block with a collision box, not a bubble column). */
  private water(node: Move, x: number, y: number, z: number): boolean {
    const f = this.fl(node, x, y, z);
    return (f & BlockFlag.Water) !== 0 && (f & BlockFlag.Passable) !== 0 && (f & BlockFlag.Avoid) === 0;
  }

  /** The absolute height the feet stand at above a floor block at y. */
  private floorTop(node: Move, x: number, y: number, z: number): number {
    const st = this.st(node, x, y, z);
    const f = this.ctx.flags(st);
    if (f & BlockFlag.Standable) return y + this.ctx.height(st);
    return y + 1; // standing in the block above it anyway (water, ladder)
  }

  /**
   * Ticks to make a block passable: 0 if it is, the dig time if it can be broken, the open cost for
   * a closed door; COST_INF otherwise. Pushes what to do onto the lists.
   */
  private clear(node: Move, x: number, y: number, z: number, toBreak: Pos[], toOpen: Pos[] | null): number {
    const state = this.st(node, x, y, z);
    if (!this.ctx.isLoaded(state)) return COST_INF;
    const f = this.ctx.flags(state);
    if (f & (BlockFlag.Avoid | BlockFlag.Lava)) return COST_INF;
    if (f & BlockFlag.Passable) return 0;
    if (toOpen && f & BlockFlag.Openable && !(f & BlockFlag.Open) && this.s.canOpenDoors && !this.ctx.name(state).endsWith('trapdoor')) {
      toOpen.push({ x, y, z });
      return this.s.openCost;
    }
    if (!this.s.canDig || !(f & BlockFlag.Breakable) || f & BlockFlag.Precious) return COST_INF;
    const name = this.ctx.name(state);
    if (this.s.blocksCantBreak.has(name)) return COST_INF;
    if (this.s.dontMineUnderFallingBlock && this.fl(node, x, y + 1, z) & BlockFlag.Gravity) return COST_INF;
    if (this.s.dontCreateFlow) {
      for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const) {
        if (this.fl(node, x + dx, y + dy, z + dz) & (BlockFlag.Water | BlockFlag.Lava)) return COST_INF;
      }
    }
    const ticks = this.ctx.digTime(state);
    if (!Number.isFinite(ticks)) return COST_INF;
    const extra = exclusion(this.s.exclusionAreasBreak, { x, y, z }, name);
    toBreak.push({ x, y, z });
    return ticks * this.s.digCost + extra;
  }

  /** Ticks to place a block at a position against a reference block's face; COST_INF if impossible. */
  private place(node: Move, pos: Pos, ref: Pos, toPlace: PlaceTask[]): number {
    if (!this.s.canPlace || node.remainingBlocks - toPlace.length <= 0) return COST_INF;
    const f = this.fl(node, pos.x, pos.y, pos.z);
    if (!(f & BlockFlag.Replaceable) || f & BlockFlag.Lava) return COST_INF;
    // The reference must be solid to click against.
    const rf = this.fl(node, ref.x, ref.y, ref.z);
    if (!(rf & BlockFlag.Standable) && this.st(node, ref.x, ref.y, ref.z) !== PLACED) return COST_INF;
    const extra = exclusion(this.s.exclusionAreasPlace, pos, this.ctx.name(this.st(node, pos.x, pos.y, pos.z)));
    toPlace.push({ pos, ref, face: { x: pos.x - ref.x, y: pos.y - ref.y, z: pos.z - ref.z } });
    return this.s.placeCost + extra;
  }

  private stepExclusion(node: Move, x: number, y: number, z: number): number {
    if (this.s.exclusionAreasStep.length === 0) return 0;
    return exclusion(this.s.exclusionAreasStep, { x, y, z }, this.ctx.name(this.st(node, x, y, z)));
  }

  private travel(blocks: number, node: Move, x: number, y: number, z: number): number {
    let cost = blocks * (this.s.allowSprinting ? SPRINT_ONE_BLOCK_COST : WALK_ONE_BLOCK_COST);
    if (this.water(node, x, y, z) || this.water(node, node.x, node.y, node.z)) cost += this.s.liquidCost * blocks;
    else if (this.fl(node, x, y - 1, z) & BlockFlag.Slow) cost = blocks * WALK_ONE_OVER_SOUL_SAND_COST;
    return cost;
  }

  /** Whether the node stands on something (or swims / climbs). */
  private supported(node: Move): boolean {
    return this.standable(node, node.x, node.y - 1, node.z) || this.water(node, node.x, node.y, node.z) || (this.fl(node, node.x, node.y, node.z) & BlockFlag.Climbable) !== 0;
  }

  neighbors(node: Move): Move[] {
    const out: Move[] = [];
    const onSolid = this.standable(node, node.x, node.y - 1, node.z);
    for (const [dx, dz] of CARDINALS) {
      this.walk(node, dx, dz, out);
      this.ascend(node, dx, dz, out);
      this.descend(node, dx, dz, out);
      if (this.s.allowParkour && onSolid) this.parkour(node, dx, dz, out);
    }
    if (this.s.allowDiagonal) for (const [dx, dz] of DIAGONALS) this.diagonal(node, dx, dz, out);
    this.down(node, out);
    this.up(node, out);
    return out;
  }

  private walk(node: Move, dx: number, dz: number, out: Move[]): void {
    const x = node.x + dx;
    const y = node.y;
    const z = node.z + dz;
    const toBreak: Pos[] = [];
    const toPlace: PlaceTask[] = [];
    const toOpen: Pos[] = [];
    let cost = this.travel(1, node, x, y, z);
    const below = this.fl(node, x, y - 1, z);
    if (!(below & BlockFlag.Standable) && !this.water(node, x, y, z) && !(this.fl(node, x, y, z) & BlockFlag.Climbable)) {
      // Nothing to stand on: bridge (place a block against the one under the bot), or it's a drop.
      if (below & BlockFlag.Passable && !(below & BlockFlag.Water) && this.standable(node, node.x, node.y - 1, node.z)) {
        if (below & BlockFlag.Avoid) return;
        cost += this.place(node, { x, y: y - 1, z }, { x: node.x, y: y - 1, z: node.z }, toPlace);
        if (cost >= COST_INF) return;
        cost += SPRINT_ONE_BLOCK_COST; // bridging is slower than walking
      } else return;
    } else if (below & BlockFlag.Avoid) return;
    // Stepping onto a floor more than half a block higher needs a jump (that's an ascend).
    if (below & BlockFlag.Standable && this.floorTop(node, x, y - 1, z) - this.floorTop(node, node.x, node.y - 1, node.z) > 0.6 && this.supported(node)) return;
    cost += this.clear(node, x, y + 1, z, toBreak, toOpen);
    if (cost >= COST_INF) return;
    cost += this.clear(node, x, y, z, toBreak, toOpen);
    if (cost >= COST_INF) return;
    cost += this.stepExclusion(node, x, y, z);
    if (cost >= COST_INF) return;
    out.push(this.move(node, x, y, z, 'walk', cost, toBreak, toPlace, toOpen));
  }

  private diagonal(node: Move, dx: number, dz: number, out: Move[]): void {
    const x = node.x + dx;
    const y = node.y;
    const z = node.z + dz;
    if (!this.standable(node, x, y - 1, z) && !this.water(node, x, y, z)) return;
    if (this.fl(node, x, y - 1, z) & BlockFlag.Avoid) return;
    if (this.floorTop(node, x, y - 1, z) - this.floorTop(node, node.x, node.y - 1, node.z) > 0.6) return;
    // The body sweeps both side columns: they must be clear (no digging around corners).
    for (const [cx, cz] of [[x, z], [node.x + dx, node.z], [node.x, node.z + dz]] as const) {
      if (!this.passable(node, cx, y, cz) || !this.passable(node, cx, y + 1, cz)) return;
    }
    let cost = this.travel(Math.SQRT2, node, x, y, z);
    cost += this.stepExclusion(node, x, y, z);
    if (cost >= COST_INF) return;
    out.push(this.move(node, x, y, z, 'diagonal', cost, [], [], []));
  }

  private ascend(node: Move, dx: number, dz: number, out: Move[]): void {
    if (!this.supported(node)) return;
    const x = node.x + dx;
    const y = node.y + 1;
    const z = node.z + dz;
    if (y > this.ctx.maxY) return;
    const toBreak: Pos[] = [];
    const toPlace: PlaceTask[] = [];
    let cost = Math.max(JUMP_ONE_BLOCK_COST, WALK_ONE_BLOCK_COST) + this.s.jumpCost;
    if (this.water(node, node.x, node.y, node.z)) cost += this.s.liquidCost;
    const floor = this.fl(node, x, y - 1, z);
    if (floor & BlockFlag.Avoid) return;
    if (!(floor & BlockFlag.Standable)) {
      // Build the step: on top of the block below it.
      if (!(floor & BlockFlag.Replaceable) || floor & BlockFlag.Water) return;
      cost += this.place(node, { x, y: y - 1, z }, { x, y: y - 2, z }, toPlace);
      if (cost >= COST_INF) return;
    } else if (this.floorTop(node, x, y - 1, z) - this.floorTop(node, node.x, node.y - 1, node.z) > 1.2) {
      return; // too high to jump
    }
    // Head room to jump, then the space at the top.
    cost += this.clear(node, node.x, node.y + 2, node.z, toBreak, null);
    if (cost >= COST_INF) return;
    cost += this.clear(node, x, y + 1, z, toBreak, null);
    if (cost >= COST_INF) return;
    cost += this.clear(node, x, y, z, toBreak, null);
    if (cost >= COST_INF) return;
    cost += this.stepExclusion(node, x, y, z);
    if (cost >= COST_INF) return;
    out.push(this.move(node, x, y, z, 'ascend', cost, toBreak, toPlace, []));
  }

  /** The landing below a column: feet y where the fall ends, or null (too far, lava, unloaded). */
  private landing(node: Move, x: number, fromY: number, z: number): number | null {
    // Columns are scanned once per search unless the path itself changed them.
    const cacheable = !this.modsTouchColumn(node, x, z);
    const key = nodeKey(x, fromY, z);
    if (cacheable) {
      const cached = this.landings.get(key);
      if (cached !== undefined) return cached;
    }
    const result = this.scanLanding(node, x, fromY, z);
    if (cacheable) this.landings.set(key, result);
    return result;
  }

  private readonly landings = new Map<number, number | null>();

  private modsTouchColumn(node: Move, x: number, z: number): boolean {
    let n = 0;
    for (let m = node.mods; m && n < 48; m = m.next, n++) {
      // Keys pack x and z above the 11 bits of y.
      if (Math.floor(m.key / 0x800) === Math.floor(nodeKey(x, 0, z) / 0x800)) return true;
    }
    return false;
  }

  private scanLanding(node: Move, x: number, fromY: number, z: number): number | null {
    // Without water to land in, a fall can't go deeper than this anyway.
    const deepest = this.s.infiniteLiquidDropdownDistance ? Math.max(this.ctx.minY, fromY - 128) : fromY - this.s.maxDropDown - 1;
    for (let y = fromY - 1; y >= deepest; y--) {
      const state = this.st(node, x, y, z);
      if (!this.ctx.isLoaded(state)) return null;
      const f = this.ctx.flags(state);
      if (f & (BlockFlag.Avoid | BlockFlag.Lava)) return null;
      // Only real water breaks a fall (a waterlogged block is ground).
      if (f & BlockFlag.Water && f & BlockFlag.Passable) return y;
      if (f & BlockFlag.Standable) return fromY - (y + 1) > this.s.maxDropDown ? null : y + 1;
      if (!(f & BlockFlag.Passable)) return null;
    }
    return null;
  }

  private descend(node: Move, dx: number, dz: number, out: Move[]): void {
    const x = node.x + dx;
    const z = node.z + dz;
    // Walking off needs the column at body height clear; the block below it must not be ground.
    // Ground there is a walk; something solid that can't be stood on (a fence) blocks the way.
    if (this.standable(node, x, node.y - 1, z)) return;
    if (!(this.fl(node, x, node.y - 1, z) & BlockFlag.Passable)) return;
    const toBreak: Pos[] = [];
    let cost = WALK_OFF_BLOCK_COST;
    cost += this.clear(node, x, node.y + 1, z, toBreak, null);
    if (cost >= COST_INF) return;
    cost += this.clear(node, x, node.y, z, toBreak, null);
    if (cost >= COST_INF) return;
    const land = this.landing(node, x, node.y, z);
    if (land === null || land >= node.y) return;
    const drop = node.y - land;
    if (drop > this.s.maxDropDown && !this.water(node, x, land, z)) return;
    cost += fallCost(drop) + CENTER_AFTER_FALL_COST;
    if (this.water(node, x, land, z)) cost += this.s.liquidCost;
    cost += this.stepExclusion(node, x, land, z);
    if (cost >= COST_INF) return;
    out.push(this.move(node, x, land, z, 'descend', cost, toBreak, [], []));
  }

  private down(node: Move, out: Move[]): void {
    const { x, y, z } = node;
    if (y - 1 < this.ctx.minY) return;
    const below = this.fl(node, x, y - 1, z);
    const toBreak: Pos[] = [];
    let cost = 0;
    if (below & (BlockFlag.Climbable | BlockFlag.Water) && below & BlockFlag.Passable) {
      cost = below & BlockFlag.Climbable ? LADDER_DOWN_ONE_COST : WALK_ONE_IN_WATER_COST;
      // Down a ladder or through water one block at a time.
      cost += this.stepExclusion(node, x, y - 1, z);
      if (cost < COST_INF) out.push(this.move(node, x, y - 1, z, 'down', cost, [], [], []));
      return;
    }
    if (!(below & BlockFlag.Standable) && !(below & BlockFlag.Flat)) return; // a drop, not a dig
    cost += this.clear(node, x, y - 1, z, toBreak, null);
    if (cost >= COST_INF || toBreak.length === 0) return;
    const land = this.landing({ ...node, mods: { key: nodeKey(x, y - 1, z), state: AIR, next: node.mods } } as Move, x, y, z);
    if (land === null || land >= y) return;
    cost += fallCost(y - land);
    cost += this.stepExclusion(node, x, land, z);
    if (cost >= COST_INF) return;
    out.push(this.move(node, x, land, z, 'down', cost, toBreak, [], []));
  }

  private up(node: Move, out: Move[]): void {
    const { x, y, z } = node;
    if (y + 1 > this.ctx.maxY) return;
    const here = this.fl(node, x, y, z);
    const toBreak: Pos[] = [];
    const toPlace: PlaceTask[] = [];
    let cost: number;
    if (here & BlockFlag.Climbable) {
      cost = LADDER_UP_ONE_COST;
      const above = this.fl(node, x, y + 1, z);
      if (!(above & BlockFlag.Passable) && !(above & BlockFlag.Climbable)) cost += this.clear(node, x, y + 1, z, toBreak, null);
    } else if (here & BlockFlag.Water) {
      cost = WALK_ONE_IN_WATER_COST;
      cost += this.clear(node, x, y + 1, z, toBreak, null);
    } else {
      // Pillar: jump and place a block where the feet were.
      if (!this.s.allow1by1Towers || !this.standable(node, x, y - 1, z)) return;
      if (this.floorTop(node, x, y - 1, z) < y - 0.01) return; // can't pillar from a slab
      cost = JUMP_ONE_BLOCK_COST + this.s.jumpCost;
      cost += this.place(node, { x, y, z }, { x, y: y - 1, z }, toPlace);
      if (cost >= COST_INF) return;
      cost += this.clear(node, x, y + 1, z, toBreak, null);
    }
    if (cost >= COST_INF) return;
    cost += this.clear(node, x, y + 2, z, toBreak, null);
    if (cost >= COST_INF) return;
    cost += this.stepExclusion(node, x, y + 1, z);
    if (cost >= COST_INF) return;
    out.push(this.move(node, x, y + 1, z, 'up', cost, toBreak, toPlace, []));
  }

  private parkour(node: Move, dx: number, dz: number, out: Move[]): void {
    const { x, y, z } = node;
    if (this.water(node, x, y, z) || this.fl(node, x, y, z) & BlockFlag.Climbable) return;
    // Only worth it over a gap: the next block must not be walkable ground.
    const first = this.fl(node, x + dx, y - 1, z + dz);
    if (first & BlockFlag.Standable || first & BlockFlag.Water) return;
    if (first & BlockFlag.Lava) return;
    if (!this.passable(node, x + dx, y, z + dz) || !this.passable(node, x + dx, y + 1, z + dz)) return;
    if (!this.passable(node, x, y + 2, z)) return;
    const maxD = this.s.allowSprinting ? 4 : 2;
    let ceiling = this.passable(node, x + dx, y + 2, z + dz);
    for (let d = 2; d <= maxD; d++) {
      const lx = x + dx * d;
      const lz = z + dz * d;
      const feet = this.passable(node, lx, y, lz);
      const head = this.passable(node, lx, y + 1, lz);
      const base = JUMP_ONE_BLOCK_COST + this.s.jumpCost + d * SPRINT_ONE_BLOCK_COST + PARKOUR_PENALTY;
      // Same level.
      if (feet && head && this.standable(node, lx, y - 1, lz) && ceiling) {
        const cost = base + this.stepExclusion(node, lx, y, lz);
        if (cost < COST_INF) out.push(this.move(node, lx, y, lz, 'parkour', cost, [], [], [], d));
        return;
      }
      // One up (not the longest jumps).
      if (d <= 3 && !feet && this.standable(node, lx, y, lz) && this.passable(node, lx, y + 1, lz) && this.passable(node, lx, y + 2, lz) && ceiling) {
        if (this.floorTop(node, lx, y, lz) - this.floorTop(node, x, y - 1, z) <= 1.2) {
          const cost = base + this.stepExclusion(node, lx, y + 1, lz);
          if (cost < COST_INF) out.push(this.move(node, lx, y + 1, lz, 'parkour', cost, [], [], [], d));
        }
        return;
      }
      // One down.
      if (feet && head && !(this.fl(node, lx, y - 1, lz) & BlockFlag.Standable) && this.passable(node, lx, y - 1, lz) && this.standable(node, lx, y - 2, lz)) {
        const cost = base + fallCost(1) + this.stepExclusion(node, lx, y - 1, lz);
        if (cost < COST_INF) out.push(this.move(node, lx, y - 1, lz, 'parkour', cost, [], [], [], d));
        return;
      }
      if (!feet || !head) return; // a wall in the way
      if (this.fl(node, lx, y - 1, lz) & BlockFlag.Lava) return;
      ceiling = ceiling && this.passable(node, lx, y + 2, lz);
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
