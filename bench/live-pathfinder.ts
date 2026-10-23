// Live checks of the pathfinder against a vanilla server (see liveHarness.ts): courses are built
// with console commands on a flat world, then the bot walks them.
//
//   tsx bench/live-pathfinder.ts --accept-eula [--versions 1.21.4] [--only walk,parkour] [--verbose] [--grim]
// --grim runs Paper with GrimAC instead of vanilla and fails a course on any Grim flag.
// POSSE_TRACE_MOVES=1 logs every movement packet with the held keys (and POSSE_TRACE_PLACE=1 each click).
import { Vec3 } from 'vec3';
import { goals, NoPathError, type PathResult } from '../src/index.js';
import { connect, main, type LiveContext, type Scenario } from './liveHarness.js';

const { GoalBlock, GoalNear, GoalY, GoalFollow } = goals;

/** Clears a box above the ground around the base (and restores the floor). */
async function clearArea(ctx: LiveContext, radius = 14, height = 12): Promise<void> {
  const b = ctx.base;
  ctx.cmd.fill(b.offset(-radius, 1, -radius), b.offset(radius, height, radius), 'air');
  ctx.cmd.fill(b.offset(-radius, -2, -radius), b.offset(radius, -1, radius), 'dirt');
  ctx.cmd.fill(b.offset(-radius, 0, -radius), b.offset(radius, 0, radius), ctx.cmd.modern ? 'grass_block' : 'grass');
  // The previous course may have left the bot in a hole the fill just closed.
  ctx.cmd.tp(b.offset(0.5, 1, 0.5));
  await ctx.sleep(600);
  await ctx.waitFor(() => ctx.bot.entity.onGround && ctx.bot.entity.position.floored().equals(b.offset(0, 1, 0)), 5000, 'standing on the cleared floor');
}

async function goto(ctx: LiveContext, goal: InstanceType<typeof goals.Goal>, timeout = 45_000): Promise<PathResult[]> {
  const updates: PathResult[] = [];
  const onUpdate = (r: PathResult): void => {
    updates.push(r);
    ctx.log(`path ${r.status}: ${r.path.length} moves (${r.path.map((m) => m.kind[0]).join('')}), ${r.visitedNodes} nodes, ${r.time.toFixed(0)} ms`);
  };
  const onReset = (reason: string): void => ctx.log(`reset: ${reason}`);
  ctx.bot.on('path_update', onUpdate);
  ctx.bot.on('path_reset', onReset);
  try {
    await ctx.bot.pathfinder.goto(goal, { timeout });
  } finally {
    ctx.bot.off('path_update', onUpdate);
    ctx.bot.off('path_reset', onReset);
  }
  return updates;
}

const at = (ctx: LiveContext, pos: Vec3, tolerance = 0.6): void => {
  const p = ctx.bot.entity.position;
  if (Math.abs(p.x - (pos.x + 0.5)) > tolerance || Math.abs(p.z - (pos.z + 0.5)) > tolerance || Math.abs(p.y - pos.y) > 0.6) {
    throw new Error(`ended at ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}, wanted ${pos}`);
  }
};

const settings = (ctx: LiveContext, s: Parameters<LiveContext['bot']['pathfinder']['setMovements']>[0]): void => {
  ctx.bot.pathfinder.movements = { ...ctx.bot.pathfinder.movements, ...s };
};

const reset = (ctx: LiveContext): void => {
  ctx.bot.pathfinder.movements = { ...ctx.bot.pathfinder.movements, canDig: true, canPlace: true, allowParkour: true, allowSprinting: true, canOpenDoors: true };
};

const scenarios: Record<string, Scenario> = {
  async walk(ctx) {
    reset(ctx);
    await clearArea(ctx);
    const dest = ctx.base.offset(12, 1, 7);
    await goto(ctx, new GoalBlock(dest.x, dest.y, dest.z));
    at(ctx, dest);
  },

  async around(ctx) {
    reset(ctx);
    await clearArea(ctx);
    settings(ctx, { canDig: false });
    // A wall across the way, open at one end.
    ctx.cmd.fill(ctx.base.offset(4, 1, -6), ctx.base.offset(4, 3, 5), 'stone');
    await ctx.sleep(400);
    const dest = ctx.base.offset(8, 1, 0);
    await goto(ctx, new GoalBlock(dest.x, dest.y, dest.z));
    at(ctx, dest);
  },

  async tunnel(ctx) {
    reset(ctx);
    await clearArea(ctx);
    // A closed wall: dig through it.
    ctx.cmd.fill(ctx.base.offset(3, 1, -14), ctx.base.offset(3, 4, 14), 'dirt');
    ctx.cmd.give('diamond_shovel');
    await ctx.sleep(600);
    const dest = ctx.base.offset(6, 1, 0);
    await goto(ctx, new GoalBlock(dest.x, dest.y, dest.z));
    at(ctx, dest);
  },

  async stairs(ctx) {
    reset(ctx);
    await clearArea(ctx);
    settings(ctx, { canDig: false, canPlace: false });
    for (let i = 1; i <= 4; i++) ctx.cmd.fill(ctx.base.offset(2 + i, 1, -1), ctx.base.offset(2 + i, i, 1), 'stone');
    await ctx.sleep(400);
    const dest = ctx.base.offset(6, 5, 0);
    await goto(ctx, new GoalBlock(dest.x, dest.y, dest.z));
    at(ctx, dest);
  },

  async drop(ctx) {
    reset(ctx);
    await clearArea(ctx);
    settings(ctx, { canDig: false, canPlace: false });
    // A tower to stand on, then down to the ground.
    ctx.cmd.fill(ctx.base.offset(-1, 1, -1), ctx.base.offset(1, 3, 1), 'stone');
    await ctx.sleep(300);
    ctx.cmd.tp(ctx.base.offset(0.5, 4, 0.5));
    await ctx.waitFor(() => ctx.bot.entity.position.y > ctx.base.y + 3.5 && ctx.bot.entity.onGround, 5000, 'standing on the tower');
    const dest = ctx.base.offset(5, 1, 0);
    await goto(ctx, new GoalBlock(dest.x, dest.y, dest.z));
    at(ctx, dest);
  },

  async parkour(ctx) {
    reset(ctx);
    await clearArea(ctx, 14, 12);
    settings(ctx, { canDig: false, canPlace: false });
    // Pillars 5 high with gaps of 1, 2 and 3 between them.
    const top = 5;
    const xs = [0, 2, 5, 9];
    for (const x of xs) ctx.cmd.fill(ctx.base.offset(x, 1, 0), ctx.base.offset(x, top, 0), 'stone');
    await ctx.sleep(400);
    ctx.cmd.tp(ctx.base.offset(0.5, top + 1, 0.5));
    await ctx.waitFor(() => ctx.bot.entity.position.y > ctx.base.y + top + 0.5 && ctx.bot.entity.onGround, 5000, 'standing on the first pillar');
    const dest = ctx.base.offset(9, top + 1, 0);
    await goto(ctx, new GoalBlock(dest.x, dest.y, dest.z));
    at(ctx, dest);
  },

  async bridge(ctx) {
    reset(ctx);
    await clearArea(ctx, 14, 12);
    settings(ctx, { canDig: false, allowParkour: false });
    ctx.cmd.give('dirt', 32);
    // Two platforms 8 high (too high to drop from) with a 4-block gap.
    ctx.cmd.fill(ctx.base.offset(-2, 1, -1), ctx.base.offset(0, 8, 1), 'stone');
    ctx.cmd.fill(ctx.base.offset(5, 1, -1), ctx.base.offset(7, 8, 1), 'stone');
    await ctx.sleep(400);
    ctx.cmd.tp(ctx.base.offset(-0.5, 9, 0.5));
    await ctx.waitFor(() => ctx.bot.entity.position.y > ctx.base.y + 8.5 && ctx.bot.entity.onGround, 5000, 'standing on the platform');
    const dest = ctx.base.offset(6, 9, 0);
    const updates = await goto(ctx, new GoalBlock(dest.x, dest.y, dest.z));
    at(ctx, dest);
    if (!updates.some((u) => u.path.some((m) => m.toPlace.length > 0 && m.kind === 'walk'))) throw new Error('did not bridge');
  },

  async pillar(ctx) {
    reset(ctx);
    await clearArea(ctx);
    settings(ctx, { canDig: false });
    ctx.cmd.give('cobblestone', 16);
    await ctx.sleep(500);
    const y = ctx.base.y + 1 + 4;
    await goto(ctx, new GoalY(y));
    if (Math.abs(ctx.bot.entity.position.y - y) > 0.6) throw new Error(`at y ${ctx.bot.entity.position.y}`);
  },

  async digdown(ctx) {
    reset(ctx);
    await clearArea(ctx);
    ctx.cmd.give('diamond_shovel');
    await ctx.sleep(400);
    const y = ctx.base.y - 1;
    await goto(ctx, new GoalY(y));
    if (Math.abs(ctx.bot.entity.position.y - y) > 0.6) throw new Error(`at y ${ctx.bot.entity.position.y}`);
  },

  async door(ctx) {
    if (!ctx.cmd.modern) return; // door states are metadata before 1.13
    reset(ctx);
    await clearArea(ctx);
    settings(ctx, { canDig: false, canPlace: false });
    // A closed room with a door.
    ctx.cmd.fill(ctx.base.offset(3, 1, -3), ctx.base.offset(9, 3, 3), 'stone');
    ctx.cmd.fill(ctx.base.offset(4, 1, -2), ctx.base.offset(8, 2, 2), 'air');
    ctx.cmd.setblock(ctx.base.offset(3, 1, 0), 'oak_door[half=lower,facing=east]');
    ctx.cmd.setblock(ctx.base.offset(3, 2, 0), 'oak_door[half=upper,facing=east]');
    await ctx.sleep(500);
    const dest = ctx.base.offset(6, 1, 0);
    await goto(ctx, new GoalBlock(dest.x, dest.y, dest.z));
    at(ctx, dest);
  },

  async swim(ctx) {
    reset(ctx);
    await clearArea(ctx);
    settings(ctx, { canDig: false, canPlace: false });
    // A pool to cross: 2 deep, 8 long, walls on the sides.
    ctx.cmd.fill(ctx.base.offset(2, -1, -3), ctx.base.offset(10, 0, 3), 'water');
    await ctx.sleep(500);
    const dest = ctx.base.offset(12, 1, 0);
    await goto(ctx, new GoalBlock(dest.x, dest.y, dest.z));
    at(ctx, dest);
  },

  async ladder(ctx) {
    if (!ctx.cmd.modern) return;
    reset(ctx);
    await clearArea(ctx, 14, 14);
    settings(ctx, { canDig: false, canPlace: false, allowParkour: false });
    // A wall with a ladder up to a ledge.
    ctx.cmd.fill(ctx.base.offset(4, 1, -2), ctx.base.offset(6, 6, 2), 'stone');
    for (let y = 1; y <= 6; y++) ctx.cmd.setblock(ctx.base.offset(3, y, 0), 'ladder[facing=west]');
    await ctx.sleep(500);
    const dest = ctx.base.offset(5, 7, 0);
    await goto(ctx, new GoalBlock(dest.x, dest.y, dest.z));
    at(ctx, dest);
  },

  async nopath(ctx) {
    reset(ctx);
    await clearArea(ctx);
    settings(ctx, { canDig: false, canPlace: false });
    // Boxed in.
    const p = ctx.bot.entity.position.floored();
    ctx.cmd.fill(p.offset(-1, -1, -1), p.offset(1, 2, 1), 'bedrock');
    ctx.cmd.fill(p.offset(0, 0, 0), p.offset(0, 1, 0), 'air');
    await ctx.sleep(500);
    try {
      await goto(ctx, new GoalBlock(p.x + 6, p.y, p.z), 20_000);
      throw new Error('expected no path');
    } catch (err) {
      if (!(err instanceof NoPathError)) throw err;
    } finally {
      ctx.cmd.fill(p.offset(-1, -1, -1), p.offset(1, 2, 1), 'air');
      ctx.cmd.fill(p.offset(-1, -1, -1), p.offset(1, -1, 1), 'stone');
    }
  },

  async follow(ctx) {
    reset(ctx);
    await clearArea(ctx);
    const leader = await connect(ctx.server, 'PosseLeader', { entities: 'players' });
    try {
      ctx.cmd.run(`tp PosseLeader ${ctx.base.x + 8.5} ${ctx.base.y + 1} ${ctx.base.z + 0.5}`);
      await ctx.waitFor(() => Object.values(ctx.bot.entities).some((e) => e.username === 'PosseLeader'), 5000, 'the leader');
      const entity = Object.values(ctx.bot.entities).find((e) => e.username === 'PosseLeader')!;
      ctx.bot.pathfinder.setGoal(new GoalFollow(entity, 2), true);
      await ctx.waitFor(() => ctx.bot.entity.position.distanceTo(entity.position) < 3, 15_000, 'reaching the leader');
      ctx.cmd.run(`tp PosseLeader ${ctx.base.x - 6.5} ${ctx.base.y + 1} ${ctx.base.z + 6.5}`);
      await ctx.sleep(500);
      await ctx.waitFor(() => ctx.bot.entity.position.distanceTo(entity.position) < 3, 15_000, 'following the leader');
    } finally {
      ctx.bot.pathfinder.stop();
      leader.quit();
    }
  },

  async far(ctx) {
    reset(ctx);
    await clearArea(ctx);
    // Beyond the kept chunks at the start: partial paths, replanned as it goes.
    const dest = ctx.base.offset(80, 1, 30);
    await goto(ctx, new GoalNear(dest.x, dest.y, dest.z, 1), 90_000);
    if (ctx.bot.entity.position.distanceTo(dest.offset(0.5, 0, 0.5)) > 2) throw new Error(`ended at ${ctx.bot.entity.position}`);
    ctx.cmd.tp(ctx.base.offset(0.5, 1, 0.5));
    await ctx.sleep(1000);
  },
};

/** Real terrain (`--terrain`): legs of 40–60 blocks in several directions. */
const terrain: Record<string, Scenario> = {
  async trek(ctx) {
    reset(ctx);
    ctx.cmd.give('dirt', 64);
    ctx.cmd.give('iron_pickaxe');
    ctx.cmd.give('iron_shovel');
    ctx.cmd.give('iron_axe');
    await ctx.sleep(500);
    const legs: Array<[number, number]> = [[50, 0], [0, 50], [-45, -20], [20, -55]];
    for (const [dx, dz] of legs) {
      const p = ctx.bot.entity.position.floored();
      const goal = new goals.GoalNearXZ(p.x + dx, p.z + dz, 2);
      const t0 = Date.now();
      await goto(ctx, goal, 120_000);
      ctx.log(`leg ${dx},${dz}: ${((Date.now() - t0) / 1000).toFixed(1)} s, now at ${ctx.bot.entity.position.floored()}`);
    }
  },
};

if (process.argv.includes('--terrain')) await main(terrain, { flat: false });
else await main(scenarios, { flat: true });

export { Vec3 };
