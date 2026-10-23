// The pathfinder: plans with A* over the moves in movements.ts (in time slices, so a fleet keeps
// running), then drives the bot along the path on the fleet ticker — digging, opening doors,
// bridging, pillaring and timing parkour jumps with the physics simulator. Replans when the world
// changes along the path, a move fails, the goal moves, or a partial path runs out. The API and
// events follow mineflayer-pathfinder (MIT); the planning follows minecraft-pathfinding (MIT).
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import { fleetTicker } from '../ticker.js';
import type { Block, ControlState } from '../types.js';
import { Simulator } from '../physics/simulator.js';
import { nodeKey, search, type SearchResult } from './astar.js';
import { BlockFlag } from './blocks.js';
import { COST_HEURISTIC } from './costs.js';
import type { Goal, Pos } from './goals.js';
import { defaultMovements, MoveGenerator, PathContext, type Move, type MovementSettings, type PlaceTask } from './movements.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- prismarine objects are loosely typed */

export type PathStatus = 'success' | 'partial' | 'timeout' | 'noPath';

export interface PathResult {
  status: PathStatus;
  path: Move[];
  cost: number;
  visitedNodes: number;
  generatedNodes: number;
  /** Ms spent searching. */
  time: number;
}

export type ResetReason = 'goal_updated' | 'goal_moved' | 'block_updated' | 'move_failed' | 'stuck' | 'partial_end' | 'position_changed';

export interface GotoOptions {
  /** Reject after this many ms (default: never). */
  timeout?: number;
}

/** Thrown by goto when no path exists (from where the bot is). */
export class NoPathError extends Error {
  constructor(message = 'No path to the goal') {
    super(message);
    this.name = 'NoPathError';
  }
}

/** Thrown by goto when it's stopped, the goal is replaced, or the bot disconnects. */
export class PathStoppedError extends Error {
  constructor(message = 'Path was stopped before it could be completed') {
    super(message);
    this.name = 'PathStoppedError';
  }
}

/** Feet position → the node it's in (standing on a slab or soul sand counts as the block above). */
export function nodeOf(pos: { x: number; y: number; z: number }): Pos {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y + 0.6), z: Math.floor(pos.z) };
}

const yawTo = (from: { x: number; z: number }, to: { x: number; z: number }): number => Math.atan2(-(to.x - from.x), -(to.z - from.z));

/** Ticks a move may take before it counts as stuck. */
const BASE_MOVE_TICKS = 40;
/** How long a failed move is penalized when replanning (ms). */
const FAILED_EDGE_MS = 30_000;
const FAILED_EDGE_PENALTY = 200;
/** A move that failed this often isn't tried again (until FAILED_EDGE_MS passes). */
const FAILED_EDGE_LIMIT = 3;
/** Moves in a row that fail before goto gives up. */
const MAX_FAILURE_STREAK = 12;
/** Times a dig, placement or door click is retried on the same block before the move fails. */
const MAX_ACTION_ATTEMPTS = 3;
/** Back-off between searches for a dynamic goal that can't be reached (ms, doubling). */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 8000;
/** Consecutive replans that make no progress before goto gives up. */
const MAX_FRUITLESS_PLANS = 6;

interface MoveRun {
  move: Move;
  ticks: number;
  /** Pre-actions (open, break, place steps) done. */
  prepared: boolean;
  phase: string;
  start: Vec3;
  placed: boolean;
  /** Ticks without horizontal progress (bridging edge detection). */
  still: number;
  /** Tick the jump started (parkour). */
  jumpedAt: number;
  /** Actions tried per block (a refused dig or a door that won't open). */
  attempts: Map<number, number>;
}

export class Pathfinder {
  /** What the bot may do while moving (dig, place, parkour…); see `setMovements`. */
  movements: MovementSettings = defaultMovements();
  /** Max ms for one search (a partial path is used after it). */
  thinkTimeout = 5000;
  /** Max ms a search runs before yielding to the event loop. */
  tickTimeout = 8;
  /** Limit the search to this many ticks of extra cost beyond the start's estimate (≤0: none). */
  searchRadius = -1;
  goal: Goal | null = null;
  dynamicGoal = false;
  /** Called with a line for each failed move or action (for debugging); null by default. */
  debug: ((message: string) => void) | null = null;

  private path: Move[] = [];
  private index = 0;
  private run: MoveRun | null = null;
  private thinking: { aborted: boolean } | null = null;
  private acting = false;
  private mining = false;
  private building = false;
  private unsubscribe: (() => void) | null = null;
  private ctx: PathContext | null = null;
  private sim: Simulator | null = null;
  private readonly relevant = new Map<number, 'clear' | 'solid'>();
  private readonly failedEdges = new Map<string, { until: number; count: number }>();
  private failureStreak = 0;
  private waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private fruitless = 0;
  private lastPlanFrom: string | null = null;
  private savedMaxDecoded: number | null = null;
  private planAgain = false;
  /** Bumped whenever the path is dropped: async actions check it after each await. */
  private generation = 0;
  /** Blocks the current path changes itself (their updates don't invalidate it). */
  private readonly expected = new Set<number>();
  /** A dynamic goal moved: the next plan starts from the end of the current move and replaces the path there. */
  private pending: { fromKey: number; path: Move[] } | null = null;
  private replanDynamic = false;
  private retryAt = 0;
  private retryDelay = RETRY_MIN_MS;
  private readonly onBlockUpdate = (_old: Block | null, block: Block): void => this.blockChanged(block);
  private readonly onDeath = (): void => this.resetPath('position_changed');
  private readonly onForcedMove = (): void => this.resetPath('position_changed');
  private readonly onEnd = (): void => this.cancel(new PathStoppedError('Disconnected'));

  constructor(private readonly bot: PosseBot) {}

  /** Changes what the bot may do while pathing (takes effect on the next plan). */
  setMovements(movements: Partial<MovementSettings>): void {
    this.movements = { ...this.movements, ...movements };
    if (this.goal) this.resetPath('goal_updated');
  }

  isMoving(): boolean {
    return this.path.length > 0 && this.index < this.path.length;
  }

  isMining(): boolean {
    return this.mining;
  }

  isBuilding(): boolean {
    return this.building;
  }

  isThinking(): boolean {
    return this.thinking !== null;
  }

  /** The remaining moves of the current path. */
  get currentPath(): Move[] {
    return this.path.slice(this.index);
  }

  /**
   * Sets the goal to walk to (null stops). A dynamic goal (e.g. GoalFollow) is re-checked as it
   * moves and never "reached" for good.
   */
  setGoal(goal: Goal | null, dynamic = false): void {
    if (this.goal && this.goal !== goal) this.rejectWaiters(new PathStoppedError('The goal was changed'));
    if (goal && this.bot.isEnded) throw new PathStoppedError('Disconnected');
    this.goal = goal;
    this.dynamicGoal = dynamic;
    this.clearPath();
    if (!goal) {
      this.detach();
      this.bot.emit('path_stop');
      return;
    }
    this.fruitless = 0;
    this.failureStreak = 0;
    this.lastPlanFrom = null;
    this.retryAt = 0;
    this.retryDelay = RETRY_MIN_MS;
    this.attach();
    this.bot.emit('goal_updated', goal, dynamic);
  }

  /** Walks to a goal; resolves when it's reached. */
  goto(goal: Goal, options: GotoOptions = {}): Promise<void> {
    if (this.bot.isEnded) return Promise.reject(new PathStoppedError('Disconnected'));
    this.setGoal(goal, false);
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const waiter = {
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      };
      this.waiters.push(waiter);
      if (options.timeout) {
        timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          if (this.goal === goal) this.setGoal(null);
          reject(new PathStoppedError(`goto timed out after ${options.timeout} ms`));
        }, options.timeout);
      }
    });
  }

  /** Stops moving (and rejects a pending goto). */
  stop(): void {
    this.rejectWaiters(new PathStoppedError());
    this.setGoal(null);
  }

  /** Plans a path from where the bot stands without moving. */
  async getPathTo(goal: Goal, timeout = this.thinkTimeout): Promise<PathResult> {
    return this.plan(goal, nodeOf(this.bot.entity.position), timeout, undefined, false);
  }

  /** Plans a path between two points without moving. */
  async getPathFromTo(start: Vec3, goal: Goal, timeout = this.thinkTimeout): Promise<PathResult> {
    return this.plan(goal, nodeOf(start), timeout, undefined, false);
  }

  private async plan(goal: Goal, from: Pos, timeout: number, signal?: { aborted: boolean }, own = true): Promise<PathResult> {
    const ctx = new PathContext(this.bot, this.movements);
    const generator = new MoveGenerator(ctx);
    // A query (getPathTo) leaves the executing path's context and the world cache alone.
    if (own) {
      this.ctx = ctx;
      this.growWorldCache();
    }
    const start = generator.start(from, ctx.scaffoldingCount());
    const now = Date.now();
    for (const [edge, entry] of this.failedEdges) if (entry.until < now) this.failedEdges.delete(edge);
    const result: SearchResult<Move> = await search<Move>({
      start,
      neighbors: (node) => {
        const moves = generator.neighbors(node);
        if (this.failedEdges.size === 0) return moves;
        return moves.filter((m) => {
          const failed = this.failedEdges.get(`${node.key}>${m.key}`);
          if (!failed) return true;
          m.cost += failed.count * FAILED_EDGE_PENALTY;
          return failed.count < FAILED_EDGE_LIMIT;
        });
      },
      heuristic: (node) => goal.heuristic(node) * COST_HEURISTIC,
      isEnd: (node) => goal.isEnd(node),
      timeout,
      sliceMs: this.tickTimeout,
      searchRadius: this.searchRadius,
      signal,
    });
    return result;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  private attach(): void {
    if (this.unsubscribe) return;
    this.sim = new Simulator(this.bot);
    this.unsubscribe = fleetTicker.subscribe(() => this.tick());
    this.bot.on('blockUpdate', this.onBlockUpdate);
    this.bot.on('death', this.onDeath);
    this.bot.on('forcedMove', this.onForcedMove);
    this.bot.on('end', this.onEnd);
  }

  private detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.bot.off('blockUpdate', this.onBlockUpdate);
    this.bot.off('death', this.onDeath);
    this.bot.off('forcedMove', this.onForcedMove);
    this.bot.off('end', this.onEnd);
    if (this.thinking) this.thinking.aborted = true;
    this.thinking = null;
    this.restoreWorldCache();
    if (!this.bot.isEnded) this.releaseControls();
  }

  private cancel(err: Error): void {
    this.rejectWaiters(err);
    this.goal = null;
    this.clearPath();
    this.detach();
  }

  private rejectWaiters(err: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
  }

  private resolveWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve();
  }

  private clearPath(): void {
    this.generation++;
    if (this.mining && this.bot.targetDigBlock) this.bot.stopDigging();
    this.path = [];
    this.index = 0;
    this.run = null;
    this.pending = null;
    this.relevant.clear();
    this.expected.clear();
    if (this.thinking) this.thinking.aborted = true;
    this.thinking = null;
    if (!this.bot.isEnded && this.bot.entity) this.releaseControls();
  }

  private resetPath(reason: ResetReason): void {
    if (this.acting) {
      // Let the running dig or placement finish; replan right after it.
      this.planAgain = true;
      return;
    }
    this.clearPath();
    this.bot.emit('path_reset', reason);
  }

  /** Path searches read many columns: keep them decoded while pathing. */
  private growWorldCache(): void {
    const world = this.bot.world;
    if (this.savedMaxDecoded === null) this.savedMaxDecoded = world.maxDecoded;
    const side = 2 * (world.radius + 2) + 1;
    world.maxDecoded = Math.max(this.savedMaxDecoded, side * side);
  }

  private restoreWorldCache(): void {
    if (this.savedMaxDecoded !== null) this.bot.world.maxDecoded = this.savedMaxDecoded;
    this.savedMaxDecoded = null;
  }

  private releaseControls(): void {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as ControlState[]) this.bot.setControlState(c, false);
  }

  // ── Planning while executing ───────────────────────────────

  /**
   * Plans from where the bot stands, or (a moved dynamic goal while walking) from where the current
   * move ends, so the new path can take over there without stopping.
   */
  private startPlanning(): void {
    const goal = this.goal;
    if (!goal || this.thinking) return;
    const continuing = this.path.length > 0 && this.index < this.path.length;
    const from: Pos = continuing ? this.path[this.index]! : nodeOf(this.bot.entity.position);
    const fromKey = nodeKey(from.x, from.y, from.z);
    const signal = { aborted: false };
    this.thinking = signal;
    void this.plan(goal, from, this.thinkTimeout, signal)
      .then((result) => {
        if (signal.aborted || this.goal !== goal) return;
        this.thinking = null;
        this.bot.emit('path_update', result);
        if (result.path.length === 0) {
          if (goal.isEnd(from)) return; // tick() reports it
          this.fail(new NoPathError(result.status === 'timeout' ? 'Took too long to find a path' : 'No path to the goal'));
          return;
        }
        this.retryDelay = RETRY_MIN_MS;
        if (continuing) {
          this.pending = { fromKey, path: result.path };
          return;
        }
        const planKey = `${from.x},${from.y},${from.z}`;
        if (result.status !== 'success') {
          // Partial paths that keep starting from the same place lead nowhere.
          this.fruitless = this.lastPlanFrom === planKey ? this.fruitless + 1 : 0;
          if (this.fruitless >= MAX_FRUITLESS_PLANS) {
            this.fail(new NoPathError('No progress towards the goal'));
            return;
          }
        }
        this.lastPlanFrom = planKey;
        this.setPath(result.path);
      })
      .catch((err: Error) => {
        if (signal.aborted) return;
        this.thinking = null;
        this.fail(err);
      });
  }

  private setPath(path: Move[]): void {
    this.path = path;
    this.index = 0;
    this.run = null;
    this.pending = null;
    this.indexRelevant();
  }

  private fail(err: Error): void {
    const dynamic = this.dynamicGoal;
    this.rejectWaiters(err);
    if (dynamic) {
      // A dynamic goal keeps trying (the target may become reachable), backing off between tries.
      this.clearPath();
      this.retryAt = Date.now() + this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
      return;
    }
    this.goal = null;
    this.clearPath();
    this.detach();
    this.bot.emit('path_stop');
  }

  /** Blocks whose change would invalidate the path: each move's body space and floor. */
  private indexRelevant(): void {
    this.relevant.clear();
    this.expected.clear();
    for (const m of this.path) {
      for (const b of m.toBreak) this.expected.add(nodeKey(b.x, b.y, b.z));
      for (const b of m.toOpen) this.expected.add(nodeKey(b.x, b.y, b.z));
      for (const t of m.toPlace) this.expected.add(nodeKey(t.pos.x, t.pos.y, t.pos.z));
      this.relevant.set(nodeKey(m.x, m.y, m.z), 'clear');
      this.relevant.set(nodeKey(m.x, m.y + 1, m.z), 'clear');
      if (m.kind !== 'up' && m.kind !== 'down') this.relevant.set(nodeKey(m.x, m.y - 1, m.z), 'solid');
    }
  }

  private blockChanged(block: Block): void {
    this.ctx?.invalidate();
    if (this.path.length === 0 || this.acting) return;
    const p = block.position;
    const key = nodeKey(p.x, p.y, p.z);
    const want = this.relevant.get(key);
    // Blocks the path itself breaks, places or opens are expected to change (also late echoes).
    if (!want || this.expected.has(key)) return;
    const flags = this.ctx?.flags(block.stateId as number) ?? 0;
    const ok =
      want === 'clear'
        ? (flags & BlockFlag.Passable) !== 0 && (flags & (BlockFlag.Avoid | BlockFlag.Lava)) === 0
        : (flags & (BlockFlag.Standable | BlockFlag.Water)) !== 0;
    if (!ok) this.resetPath('block_updated');
  }

  // ── Execution ──────────────────────────────────────────────

  private tick(): void {
    const bot = this.bot;
    const goal = this.goal;
    if (!goal || bot.isEnded || !bot.entity?.position || !bot.isAlive) return;
    if (this.acting) return;
    if (this.planAgain) {
      this.planAgain = false;
      this.clearPath();
      bot.emit('path_reset', 'block_updated');
    }
    if (this.dynamicGoal && goal.hasChanged()) {
      // Keep walking the current path while the new one is planned from where this move ends.
      goal.refresh();
      bot.emit('goal_updated', goal, true);
      this.replanDynamic = true;
      this.retryAt = 0;
    }
    if (this.replanDynamic && !this.thinking) {
      this.replanDynamic = false;
      this.pending = null;
      if (this.path.length > 0 && this.index < this.path.length) this.startPlanning();
      else this.clearPath();
    }
    if (!goal.isValid()) {
      this.fail(new PathStoppedError('The goal is no longer valid'));
      return;
    }
    const here = nodeOf(bot.entity.position);
    if (this.path.length === 0 || this.index >= this.path.length) {
      if (goal.isEnd(here) && this.settled()) {
        this.releaseControls();
        this.path = [];
        if (!this.dynamicGoal) {
          this.goal = null;
          this.detach();
          bot.emit('goal_reached', goal);
          this.resolveWaiters();
        }
        return;
      }
      if (this.path.length > 0) {
        // A partial path ran out: plan the next stretch.
        this.clearPath();
        bot.emit('path_reset', 'partial_end');
      }
      this.releaseControls();
      if (!this.thinking && this.settled() && Date.now() >= this.retryAt) this.startPlanning();
      return;
    }
    const move = this.path[this.index]!;
    if (!this.run || this.run.move !== move) {
      this.run = { move, ticks: 0, prepared: false, phase: 'start', start: bot.entity.position.clone(), placed: false, still: 0, jumpedAt: 0, attempts: new Map() };
    }
    const run = this.run;
    run.ticks++;
    try {
      const done = this.step(run);
      if (done) {
        this.index++;
        this.run = null;
        this.failureStreak = 0;
        // A plan made for a moved dynamic goal takes over where it was planned from.
        if (this.pending) {
          if (this.pending.fromKey === move.key) this.setPath(this.pending.path);
          else this.replanDynamic = true;
          this.pending = null;
        }
        if (this.index >= this.path.length) this.releaseControls();
      } else if (run.ticks > this.moveTickLimit(move)) {
        this.moveFailed(move, 'stuck');
      }
    } catch (err) {
      this.moveFailed(move, 'move_failed');
      this.debug?.(`move error: ${(err as Error).message}`);
    }
  }

  private settled(): boolean {
    const e = this.bot.entity as any;
    return e.onGround || e.isInWater || this.isClimbing();
  }

  private moveTickLimit(move: Move): number {
    return BASE_MOVE_TICKS + move.cost * 3 + (move.toBreak.length + move.toPlace.length) * 40;
  }

  private moveFailed(move: Move, reason: ResetReason): void {
    const from = this.index > 0 ? this.path[this.index - 1]! : move.parent;
    if (from) {
      const edge = `${from.key}>${move.key}`;
      const count = (this.failedEdges.get(edge)?.count ?? 0) + 1;
      this.failedEdges.set(edge, { until: Date.now() + FAILED_EDGE_MS, count });
    }
    this.debug?.(`${move.kind} to ${move.x},${move.y},${move.z} failed: ${reason}`);
    if (++this.failureStreak >= MAX_FAILURE_STREAK) {
      this.fail(new NoPathError(`Stuck: ${this.failureStreak} moves failed in a row`));
      return;
    }
    this.resetPath(reason);
  }

  /** Runs an async action (dig, place, open) with movement paused; the move continues after it. */
  private act(run: MoveRun, action: (alive: () => boolean) => Promise<void>, keep: Partial<Record<ControlState, boolean>> = {}): void {
    this.acting = true;
    this.setControls(keep);
    const generation = this.generation;
    // Whether the path the action belongs to is still the current one (checked after each await).
    const alive = (): boolean => this.generation === generation && this.goal !== null && !this.bot.isEnded;
    action(alive)
      .then(() => {
        this.acting = false;
        run.ticks = 0;
      })
      .catch((err: Error) => {
        this.acting = false;
        this.mining = false;
        this.building = false;
        this.debug?.(`action failed: ${err.message}`);
        if (this.goal && this.run === run) this.moveFailed(run.move, 'move_failed');
      });
  }

  /** Opens doors, breaks blocks and places non-special blocks before moving. Returns true when done. */
  private prepare(run: MoveRun): boolean {
    const bot = this.bot;
    const move = run.move;
    /** Counts a try on a block; throws once it was refused too often (a protected block, a stuck door). */
    const attempt = (pos: Pos): void => {
      const key = nodeKey(pos.x, pos.y, pos.z);
      const n = (run.attempts.get(key) ?? 0) + 1;
      if (n > MAX_ACTION_ATTEMPTS) throw new Error(`gave up on the block at ${pos.x},${pos.y},${pos.z}`);
      run.attempts.set(key, n);
    };
    for (const pos of move.toOpen) {
      const block = bot.blockAt(pos);
      if (!block) continue;
      const props = (block as any).getProperties?.() ?? {};
      if (props.open === true || props.open === 'true') continue;
      attempt(pos);
      this.act(run, async (alive) => {
        await bot.activateBlock(block);
        // The door opens once the server says so (a block update), within a second.
        for (let i = 0; i < 20 && alive(); i++) {
          const now = (bot.blockAt(pos) as any)?.getProperties?.() ?? {};
          if (now.open === true || now.open === 'true') return;
          await new Promise((r) => setTimeout(r, 50));
        }
      });
      return false;
    }
    for (const pos of move.toBreak) {
      const block = bot.blockAt(pos);
      if (!block || this.passableNow(block)) continue;
      attempt(pos);
      this.act(run, async (alive) => {
        this.mining = true;
        try {
          await this.equipFor(block);
          if (alive() && !bot.entity.onGround && !(bot.entity as any).isInWater) await this.waitGround();
          if (!alive()) return;
          await bot.dig(block, true);
          // A refused dig comes back as a block update: give it a moment before checking again.
          await new Promise((r) => setTimeout(r, 100));
        } finally {
          this.mining = false;
        }
      });
      return false;
    }
    // Steps for ascends are placed before the jump; bridges and pillars have their own sequences.
    if (move.kind === 'ascend') {
      for (const task of move.toPlace) {
        if (this.solidNow(task.pos)) continue;
        attempt(task.pos);
        this.act(run, (alive) => this.placeTask(task, alive));
        return false;
      }
    }
    return true;
  }

  private passableNow(block: Block): boolean {
    return ((this.ctx?.flags(block.stateId as number) ?? 0) & BlockFlag.Passable) !== 0;
  }

  private solidNow(pos: Pos): boolean {
    const block = this.bot.blockAt(pos);
    return block !== null && ((this.ctx?.flags(block.stateId as number) ?? 0) & BlockFlag.Standable) !== 0;
  }

  private waitGround(): Promise<void> {
    return new Promise((resolve) => {
      let n = 0;
      const unsub = fleetTicker.subscribe(() => {
        if (this.bot.entity.onGround || ++n > 40) {
          unsub();
          resolve();
        }
      });
    });
  }

  private async equipFor(block: Block): Promise<void> {
    const tool = this.ctx?.bestTool(block.stateId as number) ?? null;
    if (tool === null) return;
    if (this.bot.heldItem?.type === tool) return;
    const item = this.bot.inventory.items().find((i) => i.type === tool);
    if (item) await this.bot.equip(item, 'hand');
  }

  private async equipScaffolding(): Promise<void> {
    const names = this.movements.scaffoldingBlocks;
    const held = this.bot.heldItem;
    if (held && names.includes(held.name)) return;
    const items = this.bot.inventory.items();
    for (const name of names) {
      const item = items.find((i) => i.name === name);
      if (item) {
        await this.bot.equip(item, 'hand');
        return;
      }
    }
    throw new Error('No scaffolding blocks left');
  }

  private async placeTask(task: PlaceTask, alive: () => boolean = () => true): Promise<void> {
    this.building = true;
    try {
      await this.equipScaffolding();
      if (!alive()) return;
      const ref = this.bot.blockAt(task.ref);
      if (!ref) throw new Error('Placement reference not loaded');
      await this.bot.placeBlock(ref, new Vec3(task.face.x, task.face.y, task.face.z));
    } finally {
      this.building = false;
    }
  }

  /** Sets the world to the block the held item places, before the server confirms (like the game). */
  private predictPlace(pos: Pos): void {
    const held = this.bot.heldItem;
    const block = held ? (this.bot.registry as any).blocksByName[held.name] : null;
    if (!block) return;
    const state = block.defaultState ?? block.minStateId ?? block.id << 4;
    this.bot.world.setStateId(pos.x, pos.y, pos.z, state, false);
    this.ctx?.invalidate();
  }

  private isClimbing(): boolean {
    const b = this.bot.blockAt(this.bot.entity.position);
    return b !== null && ((this.ctx?.flags(b.stateId as number) ?? 0) & BlockFlag.Climbable) !== 0;
  }

  private lookAlong(target: { x: number; z: number }, pitch = 0): void {
    const p = this.bot.entity.position;
    if (Math.abs(target.x - p.x) < 1e-3 && Math.abs(target.z - p.z) < 1e-3) return;
    void this.bot.look(yawTo(p, target), pitch, true);
  }

  private setControls(c: Partial<Record<ControlState, boolean>>): void {
    for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as ControlState[]) {
      const v = c[key] ?? false;
      if (this.bot.getControlState(key) !== v) this.bot.setControlState(key, v);
    }
  }

  /** Whether the next moves continue straight on the same level (worth sprinting). */
  private straightAhead(move: Move): number {
    let n = 0;
    let prev = move;
    const dx = Math.sign(move.x - (this.index > 0 ? this.path[this.index - 1]!.x : Math.floor(this.run!.start.x)));
    const dz = Math.sign(move.z - (this.index > 0 ? this.path[this.index - 1]!.z : Math.floor(this.run!.start.z)));
    for (let i = this.index + 1; i < this.path.length && n < 4; i++) {
      const m = this.path[i]!;
      if (m.y !== prev.y || Math.sign(m.x - prev.x) !== dx || Math.sign(m.z - prev.z) !== dz || m.toBreak.length || m.toPlace.length) break;
      if (m.kind !== 'walk' && m.kind !== 'diagonal' && m.kind !== 'parkour') break;
      n++;
      prev = m;
    }
    return n;
  }

  private arrived(move: Move, tolerance = 0.35): boolean {
    const e = this.bot.entity as any;
    const p = e.position;
    const dx = p.x - (move.x + 0.5);
    const dz = p.z - (move.z + 0.5);
    if (Math.abs(dx) > tolerance || Math.abs(dz) > tolerance) return false;
    if (p.y < move.y - 0.55 || p.y > move.y + 0.75) return false;
    return e.onGround || e.isInWater || this.isClimbing();
  }

  /** Advances the current move by a tick. Returns true when it's complete. */
  private step(run: MoveRun): boolean {
    const bot = this.bot;
    const move = run.move;
    const e = bot.entity as any;
    const target = new Vec3(move.x + 0.5, move.y, move.z + 0.5);
    if (!run.prepared) {
      if (!this.prepare(run)) return false;
      run.prepared = true;
      run.ticks = 0;
    }
    // Fell far below the move: replan from where the bot is.
    if (e.position.y < Math.min(move.y, run.start.y) - 2.5 && e.onGround) throw new Error('fell');
    const inWater = Boolean(e.isInWater);

    switch (move.kind) {
      case 'walk':
      case 'diagonal':
      case 'ascend':
      case 'descend': {
        if (move.kind === 'walk' && move.toPlace.length > 0 && !run.placed) return this.bridge(run, target);
        const ahead = this.straightAhead(move);
        const sprint = this.movements.allowSprinting && bot.food > 6 && !inWater && ahead >= 2 && move.kind !== 'descend';
        const dist = Math.hypot(target.x - e.position.x, target.z - e.position.z);
        let jump = false;
        if (move.kind === 'ascend') jump = e.onGround && (dist < 1.2 || e.isCollidedHorizontally) && e.position.y < move.y - 0.4;
        if (inWater) jump = e.position.y < move.y + 0.2 || move.kind === 'ascend';
        this.lookAlong(target);
        this.setControls({ forward: dist > 0.1, sprint, jump });
        return this.arrived(move, move.kind === 'diagonal' ? 0.4 : 0.35);
      }
      case 'parkour':
        return this.parkour(run, target);
      case 'up':
        return this.goUp(run, target);
      case 'down': {
        const dist = Math.hypot(target.x - e.position.x, target.z - e.position.z);
        this.lookAlong(target);
        this.setControls({ forward: dist > 0.25 && e.onGround });
        return e.position.y <= move.y + 0.1 && this.arrived(move, 0.45);
      }
      default:
        return true;
    }
  }

  /** Bridging: sneak to the edge, place the block under the destination, walk onto it. */
  private bridge(run: MoveRun, target: Vec3): boolean {
    const bot = this.bot;
    const e = bot.entity;
    const move = run.move;
    const task = move.toPlace[0]!;
    if (this.solidNow(task.pos)) {
      run.placed = true;
      return false;
    }
    const dir = { x: task.face.x, z: task.face.z };
    // How far past the centre of the current block the bot has moved towards the gap.
    const along = (e.position.x - (task.ref.x + 0.5)) * dir.x + (e.position.z - (task.ref.z + 0.5)) * dir.z;
    const moving = Math.hypot(e.velocity.x, e.velocity.z) > 0.01;
    run.still = moving ? 0 : run.still + 1;
    if (along > 0.35 || (along > 0.1 && run.still > 3)) {
      // At the edge: look back at the side of the block underfoot and place against it.
      const key = nodeKey(task.pos.x, task.pos.y, task.pos.z);
      const n = (run.attempts.get(key) ?? 0) + 1;
      if (n > MAX_ACTION_ATTEMPTS) throw new Error('bridging placement refused');
      run.attempts.set(key, n);
      this.act(
        run,
        async (alive) => {
          await this.placeTask(task, alive);
          if (alive()) run.placed = true;
        },
        { sneak: true },
      );
      return false;
    }
    this.lookAlong(target);
    this.setControls({ forward: true, sneak: true });
    return false;
  }

  /** Climbing a ladder, swimming up, or pillaring (jump and place underneath). */
  private goUp(run: MoveRun, target: Vec3): boolean {
    const bot = this.bot;
    const e = bot.entity as any;
    const move = run.move;
    if (move.toPlace.length === 0) {
      if (this.isClimbing()) {
        // Push into the wall the ladder or vine hangs on (older versions only climb against one).
        const wall = this.climbWall(e.position);
        if (wall) void bot.look(yawTo(e.position, { x: e.position.x + wall[0], z: e.position.z + wall[1] }), 0, true);
        this.setControls({ forward: Boolean(wall), jump: true });
      } else {
        this.lookAlong(target);
        const dist = Math.hypot(target.x - e.position.x, target.z - e.position.z);
        this.setControls({ jump: true, forward: dist > 0.3 });
      }
      return e.position.y >= move.y - 0.05 && (e.onGround || e.isInWater || this.isClimbing() || e.position.y >= move.y);
    }
    const task = move.toPlace[0]!;
    if (run.phase === 'start') {
      // Centre on the block first.
      const dx = target.x - e.position.x;
      const dz = target.z - e.position.z;
      if (Math.hypot(dx, dz) > 0.2) {
        this.lookAlong(target);
        this.setControls({ forward: true });
        return false;
      }
      if (!this.equippedScaffolding()) {
        this.act(run, () => this.equipScaffolding());
        return false;
      }
      run.phase = 'jump';
      run.start = e.position.clone();
      void bot.look(e.yaw, -Math.PI / 2, true);
      this.setControls({ jump: true });
      return false;
    }
    if (run.phase === 'jump') {
      void bot.look(e.yaw, -Math.PI / 2, true);
      if (e.position.y >= run.start.y + 1.0 && !run.placed) {
        run.placed = true;
        this.building = true;
        const ref = bot.blockAt(task.ref);
        if (!ref) throw new Error('pillar reference not loaded');
        void bot
          .placeBlock(ref, new Vec3(0, 1, 0), { forceLook: 'ignore' })
          .catch(() => {
            if (this.run === run) this.moveFailed(move, 'move_failed');
          })
          .finally(() => (this.building = false));
        this.predictPlace(task.pos);
        this.setControls({});
        run.phase = 'land';
        return false;
      }
      this.setControls({ jump: true });
      if (run.ticks > 20) throw new Error('pillar jump failed');
      return false;
    }
    // Landing on the new block.
    this.setControls({});
    return e.onGround && e.position.y >= move.y - 0.05;
  }

  /** The horizontal direction of the wall a climbable block at `pos` is attached to. */
  private climbWall(pos: Vec3): [number, number] | null {
    const props = ((this.bot.blockAt(pos) as any)?.getProperties?.() ?? {}) as Record<string, unknown>;
    const ladder = { north: [0, 1], south: [0, -1], west: [1, 0], east: [-1, 0] }[String(props.facing)] as [number, number] | undefined;
    if (ladder) return ladder;
    const vine: Array<[string, [number, number]]> = [['north', [0, -1]], ['south', [0, 1]], ['west', [-1, 0]], ['east', [1, 0]]];
    for (const [side, dir] of vine) if (props[side] === true || props[side] === 'true') return dir;
    // Anything solid around it.
    for (const [, dir] of vine) if (this.solidNow({ x: Math.floor(pos.x) + dir[0], y: Math.floor(pos.y), z: Math.floor(pos.z) + dir[1] })) return dir;
    return null;
  }

  private equippedScaffolding(): boolean {
    const held = this.bot.heldItem;
    return held !== null && this.movements.scaffoldingBlocks.includes(held.name);
  }

  /** Parkour: run, jump at the moment the simulator says the landing is right, steer in the air. */
  private parkour(run: MoveRun, target: Vec3): boolean {
    const bot = this.bot;
    const e = bot.entity as any;
    const move = run.move;
    const from = this.index > 0 ? this.path[this.index - 1]! : nodeOf(run.start);
    const dir = { x: Math.sign(move.x - from.x), z: Math.sign(move.z - from.z) };
    if (run.phase === 'start') {
      // Long jumps need a run-up: back up to the far edge of the block first.
      const speed = Math.abs(e.velocity.x * dir.x + e.velocity.z * dir.z);
      run.phase = (move.distance ?? 2) >= 3 && speed < 0.15 ? 'backup' : 'run';
    }
    if (run.phase === 'backup') {
      const back = { x: from.x + 0.5 - dir.x * 0.3, z: from.z + 0.5 - dir.z * 0.3 };
      const off = (e.position.x - back.x) * dir.x + (e.position.z - back.z) * dir.z;
      if (off > 0.05) {
        void bot.look(yawTo(e.position, { x: e.position.x + dir.x, z: e.position.z + dir.z }), 0, true);
        this.setControls({ back: true });
        return false;
      }
      run.phase = 'run';
    }
    if (run.phase === 'run') {
      void bot.look(yawTo(e.position, { x: target.x, z: target.z }), 0, true);
      if (e.onGround) {
        const jumpNow = this.landsOn(move, from);
        const leaving = !this.staysOnGround();
        if (jumpNow || leaving) {
          this.debug?.(`parkour jump d=${move.distance} jumpNow=${jumpNow} leaving=${leaving} pos=${e.position} vel=${e.velocity}`);
          this.setControls({ forward: true, sprint: true, jump: true });
          run.phase = 'air';
          run.jumpedAt = run.ticks;
          return false;
        }
      }
      this.setControls({ forward: true, sprint: this.movements.allowSprinting });
      if (run.ticks > 30) throw new Error('parkour run-up failed');
      return false;
    }
    // In the air: steer so the predicted landing is on the block (forward, coast or brake).
    void bot.look(yawTo(e.position, { x: target.x, z: target.z }), 0, true);
    this.setControls(this.airControl(move));
    if (e.onGround && run.ticks - run.jumpedAt > 2) {
      if (Math.floor(e.position.x) === move.x && Math.floor(e.position.z) === move.z && Math.abs(e.position.y - move.y) < 0.6) return true;
      throw new Error(`parkour missed: landed at ${e.position}`);
    }
    return false;
  }

  /** Where the bot lands from its current state holding some controls (steering at the target). */
  private landing(move: Move, controls: Partial<Record<ControlState, boolean>>): { pos: Vec3; onTarget: boolean } {
    const sim = this.sim!;
    const state = sim.state({ forward: false, back: false, left: false, right: false, sneak: false, sprint: false, jump: false, ...controls });
    const target = { x: move.x + 0.5, z: move.z + 0.5 };
    const result = sim.simulateUntil(
      state,
      (s, tick) => (tick > 0 && s.onGround) || s.pos.y < move.y - 2,
      (s, tick) => {
        if (tick > 0) s.control.jump = false;
        s.yaw = yawTo(s.pos, target);
      },
      40,
    );
    const p = result.state.pos;
    const onTarget = result.state.onGround && Math.floor(p.x) === move.x && Math.floor(p.z) === move.z && Math.abs(p.y - move.y) < 0.6;
    return { pos: p, onTarget };
  }

  /** Mid-air controls whose predicted landing is on the move's block (else the closest). */
  private airControl(move: Move): Partial<Record<ControlState, boolean>> {
    const sprint = this.movements.allowSprinting;
    const options: Array<Partial<Record<ControlState, boolean>>> = [{ forward: true, sprint }, {}, { back: true }];
    let best = options[0]!;
    let bestDist = Infinity;
    for (const c of options) {
      const { pos, onTarget } = this.landing(move, c);
      if (onTarget) return c;
      const d = Math.hypot(pos.x - (move.x + 0.5), pos.z - (move.z + 0.5));
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  /**
   * Whether jumping now (sprinting forward) reaches the move's block: landing on it, or past it
   * (mid-air braking makes up the difference).
   */
  private landsOn(move: Move, from: Pos): boolean {
    const { pos, onTarget } = this.landing(move, { forward: true, sprint: this.movements.allowSprinting, jump: true });
    if (onTarget) return true;
    const dir = { x: Math.sign(move.x - from.x), z: Math.sign(move.z - from.z) };
    const along = (pos.x - (move.x + 0.5)) * dir.x + (pos.z - (move.z + 0.5)) * dir.z;
    return along >= -0.2 && pos.y >= move.y - 1;
  }

  /** Whether another tick of running keeps the bot on the ground (else it must jump now). */
  private staysOnGround(): boolean {
    const sim = this.sim!;
    const next = sim.predict({ forward: true, sprint: this.movements.allowSprinting, jump: false }, 2);
    return next.every((s) => s.onGround);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
