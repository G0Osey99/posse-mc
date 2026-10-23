// Movement costs in game ticks (20 per second), so walking, jumping, digging and placing compare
// as time. The constants are Baritone's measured speeds, as minecraft-pathfinding uses them.

/** Walking one block (4.317 blocks/s). */
export const WALK_ONE_BLOCK_COST = 20 / 4.317;
/** Sprinting one block (5.612 blocks/s). */
export const SPRINT_ONE_BLOCK_COST = 20 / 5.612;
/** Swimming or wading one block. */
export const WALK_ONE_IN_WATER_COST = 20 / 2.2;
/** Walking one block on soul sand. */
export const WALK_ONE_OVER_SOUL_SAND_COST = 20 / 2.158;
/** Climbing one block of ladder or vine. */
export const LADDER_UP_ONE_COST = 20 / 2.35;
export const LADDER_DOWN_ONE_COST = 20 / 3.0;
/** Sneaking one block (bridging). */
export const SNEAK_ONE_BLOCK_COST = 20 / 1.3;
/** Walking off a block edge before a drop. */
export const WALK_OFF_BLOCK_COST = WALK_ONE_BLOCK_COST * 0.8;
/** Re-centering after landing. */
export const CENTER_AFTER_FALL_COST = WALK_ONE_BLOCK_COST - WALK_OFF_BLOCK_COST;
/** At or above this a move is impossible. */
export const COST_INF = 1_000_000;

/** Distance fallen in tick `ticks` of a free fall (blocks/tick). */
export function fallVelocity(ticks: number): number {
  return (Math.pow(0.98, ticks) - 1) * -3.92;
}

/** Ticks to fall `distance` blocks from rest. */
export function distanceToTicks(distance: number): number {
  if (distance <= 0) return 0;
  let left = distance;
  let ticks = 0;
  for (;;) {
    const step = fallVelocity(ticks);
    if (left <= step) return ticks + left / step;
    left -= step;
    ticks++;
  }
}

/** Ticks to fall n whole blocks, for n up to 512. */
export const FALL_N_BLOCKS_COST: readonly number[] = Array.from({ length: 513 }, (_, n) => distanceToTicks(n));

/** The useful part of a jump: rising ~1.25 blocks and coming down 0.25. */
export const JUMP_ONE_BLOCK_COST = distanceToTicks(1.25) - distanceToTicks(0.25);

/**
 * Per-block weight of the goal heuristic. Walking (not sprinting) speed makes the search lean
 * towards the goal: paths are at most ~1.3× the optimum (walk / sprint) and far fewer nodes are
 * explored.
 */
export const COST_HEURISTIC = WALK_ONE_BLOCK_COST;

/** Ticks to fall a distance (whole blocks use the table). */
export function fallCost(blocks: number): number {
  return Number.isInteger(blocks) && blocks >= 0 && blocks < FALL_N_BLOCKS_COST.length ? FALL_N_BLOCKS_COST[blocks]! : distanceToTicks(blocks);
}
