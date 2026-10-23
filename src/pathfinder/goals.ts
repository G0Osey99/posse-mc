// Pathfinding goals, named and shaped like mineflayer-pathfinder's (so code ports): a goal says
// whether a node (the block the feet are in) is the end, and estimates the distance to it in
// blocks. Dynamic goals (GoalFollow) say when they've moved.
import { Vec3 } from 'vec3';
import type { Entity } from '../types.js';

export interface Pos {
  x: number;
  y: number;
  z: number;
}

/** Horizontal distance on the grid: diagonal steps cost √2. */
export function distanceXZ(dx: number, dz: number): number {
  dx = Math.abs(dx);
  dz = Math.abs(dz);
  return Math.abs(dx - dz) + Math.min(dx, dz) * Math.SQRT2;
}

export abstract class Goal {
  /** Estimated distance to the goal in blocks (never much more than the real one). */
  abstract heuristic(node: Pos): number;
  abstract isEnd(node: Pos): boolean;
  /** Dynamic goals: whether the target moved since `refresh()` (the path is then recomputed). */
  hasChanged(): boolean {
    return false;
  }
  /** Whether the goal can still be reached at all (e.g. the followed entity still exists). */
  isValid(): boolean {
    return true;
  }
  /** Re-reads the target after `hasChanged()` said it moved. */
  refresh(): void {}
}

/** Stand in a block (feet in it). */
export class GoalBlock extends Goal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  constructor(x: number, y: number, z: number) {
    super();
    this.x = Math.floor(x);
    this.y = Math.floor(y);
    this.z = Math.floor(z);
  }
  static fromVec(v: Pos): GoalBlock {
    return new GoalBlock(v.x, v.y, v.z);
  }
  heuristic(node: Pos): number {
    return distanceXZ(this.x - node.x, this.z - node.z) + Math.abs(this.y - node.y);
  }
  isEnd(node: Pos): boolean {
    return node.x === this.x && node.y === this.y && node.z === this.z;
  }
}

/** Get within `range` blocks of a point. */
export class GoalNear extends Goal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rangeSq: number;
  constructor(x: number, y: number, z: number, range: number) {
    super();
    this.x = Math.floor(x);
    this.y = Math.floor(y);
    this.z = Math.floor(z);
    this.rangeSq = range * range;
  }
  heuristic(node: Pos): number {
    return distanceXZ(this.x - node.x, this.z - node.z) + Math.abs(this.y - node.y);
  }
  isEnd(node: Pos): boolean {
    const dx = this.x - node.x;
    const dy = this.y - node.y;
    const dz = this.z - node.z;
    return dx * dx + dy * dy + dz * dz <= this.rangeSq;
  }
}

/** Reach an x/z column, at any height. */
export class GoalXZ extends Goal {
  readonly x: number;
  readonly z: number;
  constructor(x: number, z: number) {
    super();
    this.x = Math.floor(x);
    this.z = Math.floor(z);
  }
  heuristic(node: Pos): number {
    return distanceXZ(this.x - node.x, this.z - node.z);
  }
  isEnd(node: Pos): boolean {
    return node.x === this.x && node.z === this.z;
  }
}

/** Get within `range` blocks of an x/z column, at any height. */
export class GoalNearXZ extends Goal {
  readonly x: number;
  readonly z: number;
  readonly rangeSq: number;
  constructor(x: number, z: number, range: number) {
    super();
    this.x = Math.floor(x);
    this.z = Math.floor(z);
    this.rangeSq = range * range;
  }
  heuristic(node: Pos): number {
    return distanceXZ(this.x - node.x, this.z - node.z);
  }
  isEnd(node: Pos): boolean {
    const dx = this.x - node.x;
    const dz = this.z - node.z;
    return dx * dx + dz * dz <= this.rangeSq;
  }
}

/** Reach a height. */
export class GoalY extends Goal {
  readonly y: number;
  constructor(y: number) {
    super();
    this.y = Math.floor(y);
  }
  heuristic(node: Pos): number {
    return Math.abs(this.y - node.y);
  }
  isEnd(node: Pos): boolean {
    return node.y === this.y;
  }
}

/** Stand next to a block (touching it, not inside it): to open a chest, use a crafting table… */
export class GoalGetToBlock extends Goal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  constructor(x: number, y: number, z: number) {
    super();
    this.x = Math.floor(x);
    this.y = Math.floor(y);
    this.z = Math.floor(z);
  }
  heuristic(node: Pos): number {
    const dx = node.x - this.x;
    const dy = node.y - this.y;
    const dz = node.z - this.z;
    return distanceXZ(dx, dz) + Math.abs(dy < 0 ? dy + 1 : dy);
  }
  isEnd(node: Pos): boolean {
    const dx = Math.abs(node.x - this.x);
    const dy = node.y - this.y;
    const dz = Math.abs(node.z - this.z);
    // Next to it (feet or head level), or standing on top of it.
    return (dx + dz === 1 && (dy === 0 || dy === -1)) || (dx === 0 && dz === 0 && dy === 1);
  }
}

/** Get within reach of a block (from the eyes) to dig it, place against it or click it. */
export class GoalReachBlock extends Goal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  constructor(x: number, y: number, z: number, readonly reach = 4.5) {
    super();
    this.x = Math.floor(x);
    this.y = Math.floor(y);
    this.z = Math.floor(z);
  }
  heuristic(node: Pos): number {
    const d = distanceXZ(this.x - node.x, this.z - node.z) + Math.abs(this.y - (node.y + 1));
    return Math.max(0, d - this.reach + 1);
  }
  isEnd(node: Pos): boolean {
    // Not inside the block, eyes within reach of its centre.
    if (node.x === this.x && node.z === this.z && (node.y === this.y || node.y + 1 === this.y)) return false;
    const dx = this.x + 0.5 - (node.x + 0.5);
    const dy = this.y + 0.5 - (node.y + 1.62);
    const dz = this.z + 0.5 - (node.z + 0.5);
    return dx * dx + dy * dy + dz * dz <= this.reach * this.reach;
  }
}

/** mineflayer-pathfinder's name for reaching a block to dig it. */
export class GoalBreakBlock extends GoalReachBlock {}
/** mineflayer-pathfinder's name for reaching a block to look at it. */
export class GoalLookAtBlock extends GoalReachBlock {}

/** Follow an entity, staying within `range` (dynamic: the path is recomputed as it moves). */
export class GoalFollow extends Goal {
  x = 0;
  y = 0;
  z = 0;
  readonly rangeSq: number;
  constructor(
    readonly entity: Entity,
    readonly range: number,
  ) {
    super();
    this.rangeSq = range * range;
    this.refresh();
  }
  heuristic(node: Pos): number {
    return distanceXZ(this.x - node.x, this.z - node.z) + Math.abs(this.y - node.y);
  }
  isEnd(node: Pos): boolean {
    const dx = this.x - node.x;
    const dy = this.y - node.y;
    const dz = this.z - node.z;
    return dx * dx + dy * dy + dz * dz <= this.rangeSq;
  }
  hasChanged(): boolean {
    const p = this.entity.position.floored();
    const dx = this.x - p.x;
    const dy = this.y - p.y;
    const dz = this.z - p.z;
    return dx * dx + dy * dy + dz * dz > this.rangeSq;
  }
  refresh(): void {
    const p = this.entity.position.floored();
    this.x = p.x;
    this.y = p.y;
    this.z = p.z;
  }
  isValid(): boolean {
    return this.entity.isValid !== false;
  }
}

/** The opposite of a goal: get away from it (until its heuristic says far enough). */
export class GoalInvert extends Goal {
  constructor(readonly goal: Goal) {
    super();
  }
  heuristic(node: Pos): number {
    return -this.goal.heuristic(node);
  }
  isEnd(node: Pos): boolean {
    return !this.goal.isEnd(node);
  }
  hasChanged(): boolean {
    return this.goal.hasChanged();
  }
  isValid(): boolean {
    return this.goal.isValid();
  }
  refresh(): void {
    this.goal.refresh();
  }
}

/** Any one of the goals. */
export class GoalCompositeAny extends Goal {
  readonly goals: Goal[];
  constructor(goals: Goal[] = []) {
    super();
    this.goals = goals;
  }
  push(goal: Goal): void {
    this.goals.push(goal);
  }
  heuristic(node: Pos): number {
    let min = Infinity;
    for (const g of this.goals) min = Math.min(min, g.heuristic(node));
    return min;
  }
  isEnd(node: Pos): boolean {
    return this.goals.some((g) => g.isEnd(node));
  }
  hasChanged(): boolean {
    return this.goals.some((g) => g.hasChanged());
  }
  isValid(): boolean {
    return this.goals.some((g) => g.isValid());
  }
  refresh(): void {
    for (const g of this.goals) g.refresh();
  }
}

/** Every goal at once. */
export class GoalCompositeAll extends Goal {
  readonly goals: Goal[];
  constructor(goals: Goal[] = []) {
    super();
    this.goals = goals;
  }
  push(goal: Goal): void {
    this.goals.push(goal);
  }
  heuristic(node: Pos): number {
    let max = 0;
    for (const g of this.goals) max = Math.max(max, g.heuristic(node));
    return max;
  }
  isEnd(node: Pos): boolean {
    return this.goals.every((g) => g.isEnd(node));
  }
  hasChanged(): boolean {
    return this.goals.some((g) => g.hasChanged());
  }
  isValid(): boolean {
    return this.goals.every((g) => g.isValid());
  }
  refresh(): void {
    for (const g of this.goals) g.refresh();
  }
}

/** The center of a node's block at foot level. */
export const nodeCenter = (node: Pos): Vec3 => new Vec3(node.x + 0.5, node.y, node.z + 0.5);
