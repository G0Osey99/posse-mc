// Before 1.13 the server sends a block's id and data value only: a stair's corner shape and the
// arms of fences, panes and walls are worked out by the client from the blocks around it (1.8's
// getActualState / addCollisionBoxesToList). minecraft-data's shapes for those versions are the bare
// block (a straight stair, a fence post), so a bot walking over stair corners or along fences
// moved where the server has collision, and anticheats flagged it (GroundSpoof, Simulation). These
// are the game's own collision boxes, from the neighbours.

/** What a neighbour is, as far as connections go. */
export interface LegacyNeighbor {
  name: string;
  metadata: number;
  /** Its collision boxes (0–1 within the block). */
  shapes: number[][];
}

type Get = (dx: number, dy: number, dz: number) => LegacyNeighbor | null;

const WOOD_FENCE = /^(fence|spruce_fence|birch_fence|jungle_fence|dark_oak_fence|acacia_fence)$/;
const FENCE_GATE = /fence_gate$/;
const PANE = /^(glass_pane|stained_glass_pane|iron_bars)$/;
const STAIRS = /_stairs$/;
/** Full cubes that aren't opaque (glass, leaves…) or are gourds: fences and walls don't join them. */
const NOT_OPAQUE = /glass|leaves|^ice$|glowstone|sea_lantern|beacon|slime|pumpkin|melon_block|barrier|redstone_block|tnt/;

const isFullCube = (n: LegacyNeighbor): boolean => n.shapes.length === 1 && n.shapes[0]!.join(',') === '0,0,0,1,1,1';
const opaqueCube = (n: LegacyNeighbor): boolean => isFullCube(n) && !NOT_OPAQUE.test(n.name);

/** Families whose shape depends on their neighbours before 1.13. */
export function hasLegacyShape(name: string): boolean {
  return STAIRS.test(name) || WOOD_FENCE.test(name) || name === 'nether_brick_fence' || PANE.test(name) || name === 'cobblestone_wall';
}

// Horizontal neighbours as [dx, dz].
const N: [number, number] = [0, -1];
const S: [number, number] = [0, 1];
const W: [number, number] = [-1, 0];
const E: [number, number] = [1, 0];

function fenceBoxes(n: boolean, s: boolean, w: boolean, e: boolean): number[][] {
  const boxes: number[][] = [];
  if (n || s) boxes.push([0.375, 0, n ? 0 : 0.375, 0.625, 1.5, s ? 1 : 0.625]);
  if (w || e || (!n && !s)) boxes.push([w ? 0 : 0.375, 0, 0.375, e ? 1 : 0.625, 1.5, 0.625]);
  return boxes;
}

function paneBoxes(n: boolean, s: boolean, w: boolean, e: boolean): number[][] {
  const any = n || s || w || e;
  const boxes: number[][] = [];
  if ((!w || !e) && any) {
    if (w) boxes.push([0, 0, 0.4375, 0.5, 1, 0.5625]);
    else if (e) boxes.push([0.5, 0, 0.4375, 1, 1, 0.5625]);
  } else boxes.push([0, 0, 0.4375, 1, 1, 0.5625]);
  if ((!n || !s) && any) {
    if (n) boxes.push([0.4375, 0, 0, 0.5625, 1, 0.5]);
    else if (s) boxes.push([0.4375, 0, 0.5, 0.5625, 1, 1]);
  } else boxes.push([0.4375, 0, 0, 0.5625, 1, 1]);
  return boxes;
}

function wallBox(n: boolean, s: boolean, w: boolean, e: boolean): number[][] {
  let x0 = 0.25;
  let x1 = 0.75;
  let z0 = 0.25;
  let z1 = 0.75;
  if (n) z0 = 0;
  if (s) z1 = 1;
  if (w) x0 = 0;
  if (e) x1 = 1;
  if (n && s && !w && !e) {
    x0 = 0.3125;
    x1 = 0.6875;
  } else if (!n && !s && w && e) {
    z0 = 0.3125;
    z1 = 0.6875;
  }
  // Walls collide 1.5 high whatever they look like.
  return [[x0, 0, z0, x1, 1.5, z1]];
}

// Stairs: data value bits 0–1 the facing (0 east, 1 west, 2 south, 3 north), bit 2 upside down.
type Facing = 'east' | 'west' | 'south' | 'north';
const STAIR_FACING: readonly Facing[] = ['east', 'west', 'south', 'north'];
const FACING_VEC: Readonly<Record<Facing, [number, number]>> = { east: E, west: W, south: S, north: N };
const OPPOSITE: Readonly<Record<Facing, Facing>> = { east: 'west', west: 'east', south: 'north', north: 'south' };
const CCW: Readonly<Record<Facing, Facing>> = { north: 'west', west: 'south', south: 'east', east: 'north' };
const axis = (f: Facing): 'x' | 'z' => (f === 'east' || f === 'west' ? 'x' : 'z');

interface Stair {
  facing: Facing;
  top: boolean;
}

const stairOf = (n: LegacyNeighbor | null): Stair | null => (n && STAIRS.test(n.name) ? { facing: STAIR_FACING[n.metadata & 3]!, top: (n.metadata & 4) !== 0 } : null);

export type StairShape = 'straight' | 'inner_left' | 'inner_right' | 'outer_left' | 'outer_right';

/** A stair's shape from the stairs in front of and behind it (the game's rule). */
export function stairShape(self: Stair, get: Get): StairShape {
  const at = (f: Facing): Stair | null => {
    const [dx, dz] = FACING_VEC[f];
    return stairOf(get(dx, 0, dz));
  };
  const canTake = (f: Facing): boolean => {
    const other = at(f);
    return !other || other.facing !== self.facing || other.top !== self.top;
  };
  const behind = at(self.facing);
  if (behind && behind.top === self.top && axis(behind.facing) !== axis(self.facing) && canTake(OPPOSITE[behind.facing]))
    return behind.facing === CCW[self.facing] ? 'outer_left' : 'outer_right';
  const front = at(OPPOSITE[self.facing]);
  if (front && front.top === self.top && axis(front.facing) !== axis(self.facing) && canTake(front.facing))
    return front.facing === CCW[self.facing] ? 'inner_left' : 'inner_right';
  return 'straight';
}

/** Rotates a box (0–1 coordinates) a quarter turn clockwise seen from above, `q` times. */
function turn(box: number[], q: number): number[] {
  const [, y0, , , y1] = box as [number, number, number, number, number, number];
  let [x0, z0, x1, z1] = [box[0]!, box[2]!, box[3]!, box[5]!];
  for (let i = 0; i < q; i++) [x0, z0, x1, z1] = [1 - z1, x0, 1 - z0, x1];
  return [x0, y0, z0, x1, y1, z1];
}

/** Stair collision boxes for a facing, half and shape (the half slab plus the raised quarters). */
export function stairBoxes(facing: Facing, top: boolean, shape: StairShape): number[][] {
  // Built facing north (the raised part at the north), then turned.
  const [b0, b1, u0, u1] = top ? [0.5, 1, 0, 0.5] : [0, 0.5, 0.5, 1];
  const quarters: number[][] = [];
  if (shape === 'straight') quarters.push([0, u0, 0, 1, u1, 0.5]);
  else if (shape === 'outer_left') quarters.push([0, u0, 0, 0.5, u1, 0.5]);
  else if (shape === 'outer_right') quarters.push([0.5, u0, 0, 1, u1, 0.5]);
  else if (shape === 'inner_left') quarters.push([0, u0, 0, 1, u1, 0.5], [0, u0, 0.5, 0.5, u1, 1]);
  else quarters.push([0, u0, 0, 1, u1, 0.5], [0.5, u0, 0.5, 1, u1, 1]);
  const q = { north: 0, east: 1, south: 2, west: 3 }[facing];
  return [[0, b0, 0, 1, b1, 1], ...quarters.map((b) => turn(b, q))];
}

/** The collision boxes of a neighbour-shaped block before 1.13, or null when its own shapes are right. */
export function legacyShapes(name: string, metadata: number, get: Get): number[][] | null {
  if (STAIRS.test(name)) {
    const self = stairOf({ name, metadata, shapes: [] })!;
    return stairBoxes(self.facing, self.top, stairShape(self, get));
  }
  const side = (d: [number, number], joins: (n: LegacyNeighbor) => boolean): boolean => {
    const n = get(d[0], 0, d[1]);
    return !!n && joins(n);
  };
  if (WOOD_FENCE.test(name) || name === 'nether_brick_fence') {
    const wood = WOOD_FENCE.test(name);
    const joins = (n: LegacyNeighbor): boolean => (wood ? WOOD_FENCE.test(n.name) : n.name === 'nether_brick_fence') || FENCE_GATE.test(n.name) || opaqueCube(n);
    return fenceBoxes(side(N, joins), side(S, joins), side(W, joins), side(E, joins));
  }
  if (PANE.test(name)) {
    const joins = (n: LegacyNeighbor): boolean => isFullCube(n) || PANE.test(n.name) || /glass/.test(n.name);
    return paneBoxes(side(N, joins), side(S, joins), side(W, joins), side(E, joins));
  }
  if (name === 'cobblestone_wall') {
    const joins = (n: LegacyNeighbor): boolean => n.name === 'cobblestone_wall' || FENCE_GATE.test(n.name) || opaqueCube(n);
    return wallBox(side(N, joins), side(S, joins), side(W, joins), side(E, joins));
  }
  return null;
}
