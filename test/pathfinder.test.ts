/* eslint-disable @typescript-eslint/no-explicit-any -- registries and fake bots are untyped */
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import type { PosseBot } from '../src/bot.js';
import type { Entity } from '../src/types.js';
import { nodeKey, search } from '../src/pathfinder/astar.js';
import { BlockFlag, blockInfo } from '../src/pathfinder/blocks.js';
import { COST_HEURISTIC, distanceToTicks, FALL_N_BLOCKS_COST, JUMP_ONE_BLOCK_COST } from '../src/pathfinder/costs.js';
import {
  distanceXZ,
  Goal,
  GoalBlock,
  GoalCompositeAll,
  GoalCompositeAny,
  GoalFollow,
  GoalGetToBlock,
  GoalInvert,
  GoalNear,
  GoalNearXZ,
  GoalReachBlock,
  GoalXZ,
  GoalY,
} from '../src/pathfinder/goals.js';
import { defaultMovements, MoveGenerator, PathContext, type Move, type MovementSettings } from '../src/pathfinder/movements.js';
import { nodeOf } from '../src/pathfinder/pathfinder.js';
import { versionKit } from '../src/registry.js';

const VERSION = '1.20.4';

/** A world of named blocks: stone below `ground`, air above, plus overrides. */
function fakeBot(blocks: Record<string, string> = {}, options: { ground?: number; items?: Array<{ name: string; count: number }>; version?: string } = {}): PosseBot {
  const kit = versionKit(options.version ?? VERSION);
  const registry = kit.registry as any;
  // `name` or `name[prop=value,…]`.
  const stateOf = (spec: string): number => {
    const [, name, props] = /^([^[]+)(?:\[(.*)\])?$/.exec(spec)!;
    if (!props) return registry.blocksByName[name!].defaultState ?? registry.blocksByName[name!].minStateId;
    const values = Object.fromEntries(props.split(',').map((kv) => kv.split('=')).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : v]));
    return kit.Block.fromProperties(name, values, 0).stateId;
  };
  const ground = options.ground ?? 0;
  const items = (options.items ?? []).map((i) => ({ ...i, type: registry.itemsByName[i.name].id }));
  return {
    kit,
    registry,
    game: { minY: -64, height: 384, gameMode: 'survival' },
    entity: { effects: {} },
    inventory: { items: () => items },
    world: {
      stateIdAt: (x: number, y: number, z: number) => {
        const named = blocks[`${x},${y},${z}`];
        if (named) return stateOf(named);
        return y < ground ? stateOf('stone') : 0;
      },
    },
  } as unknown as PosseBot;
}

function fill(blocks: Record<string, string>, a: [number, number, number], b: [number, number, number], name: string): void {
  for (let x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++)
    for (let y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y++)
      for (let z = Math.min(a[2], b[2]); z <= Math.max(a[2], b[2]); z++) blocks[`${x},${y},${z}`] = name;
}

async function plan(bot: PosseBot, from: [number, number, number], goal: Goal, settings: Partial<MovementSettings> = {}) {
  const ctx = new PathContext(bot, { ...defaultMovements(), ...settings });
  const gen = new MoveGenerator(ctx);
  const start = gen.start({ x: from[0], y: from[1], z: from[2] }, ctx.scaffoldingCount());
  return search<Move>({
    start,
    neighbors: (n) => gen.neighbors(n),
    heuristic: (n) => goal.heuristic(n) * COST_HEURISTIC,
    isEnd: (n) => goal.isEnd(n),
    timeout: 2000,
    sliceMs: 50,
  });
}

describe('node keys', () => {
  it('are unique around any point, negative and far coordinates included', () => {
    for (const [ox, oz] of [[0, 0], [-1, -1], [1_000_000, -1_000_000], [-29_999_000, 29_999_000]]) {
      const seen = new Set<number>();
      for (let x = -3; x <= 3; x++) for (let y = -64; y <= 320; y += 7) for (let z = -3; z <= 3; z++) seen.add(nodeKey(ox! + x, y, oz! + z));
      expect(seen.size).toBe(7 * 7 * Math.ceil(385 / 7));
    }
    expect(Number.isSafeInteger(nodeKey(-1, 320, -1))).toBe(true);
  });
});

describe('costs', () => {
  it('times falls like the game', () => {
    expect(FALL_N_BLOCKS_COST[0]).toBe(0);
    expect(distanceToTicks(1)).toBeGreaterThan(5);
    expect(distanceToTicks(1)).toBeLessThan(7);
    for (let i = 1; i < 20; i++) expect(FALL_N_BLOCKS_COST[i]!).toBeGreaterThan(FALL_N_BLOCKS_COST[i - 1]!);
    expect(JUMP_ONE_BLOCK_COST).toBeGreaterThan(0);
  });
});

describe('goals', () => {
  const n = (x: number, y: number, z: number) => ({ x, y, z });
  it('GoalBlock / GoalNear / GoalXZ / GoalNearXZ / GoalY', () => {
    expect(new GoalBlock(1.7, 64, -2.2).isEnd(n(1, 64, -3))).toBe(true);
    expect(new GoalBlock(1, 64, 1).heuristic(n(4, 64, 5))).toBeCloseTo(distanceXZ(3, 4));
    expect(new GoalNear(0, 64, 0, 2).isEnd(n(1, 64, 1))).toBe(true);
    expect(new GoalNear(0, 64, 0, 2).isEnd(n(2, 64, 2))).toBe(false);
    expect(new GoalXZ(5, 5).isEnd(n(5, 100, 5))).toBe(true);
    expect(new GoalNearXZ(0, 0, 3).isEnd(n(2, 0, 2))).toBe(true);
    expect(new GoalY(10).isEnd(n(3, 10, 3))).toBe(true);
    expect(new GoalY(10).heuristic(n(3, 4, 3))).toBe(6);
  });

  it('GoalGetToBlock ends next to the block, not in it', () => {
    const g = new GoalGetToBlock(0, 64, 0);
    expect(g.isEnd(n(1, 64, 0))).toBe(true);
    expect(g.isEnd(n(0, 65, 0))).toBe(true);
    expect(g.isEnd(n(1, 63, 0))).toBe(true);
    expect(g.isEnd(n(0, 64, 0))).toBe(false);
    expect(g.isEnd(n(1, 64, 1))).toBe(false);
  });

  it('GoalReachBlock ends within reach from the eyes', () => {
    const g = new GoalReachBlock(0, 64, 0);
    expect(g.isEnd(n(3, 64, 0))).toBe(true);
    expect(g.isEnd(n(6, 64, 0))).toBe(false);
    expect(g.isEnd(n(0, 64, 0))).toBe(false);
  });

  it('inverts and composes', () => {
    const near = new GoalNear(0, 0, 0, 3);
    expect(new GoalInvert(near).isEnd(n(10, 0, 0))).toBe(true);
    expect(new GoalInvert(near).isEnd(n(1, 0, 0))).toBe(false);
    const any = new GoalCompositeAny([new GoalBlock(0, 0, 0), new GoalBlock(10, 0, 0)]);
    expect(any.isEnd(n(10, 0, 0))).toBe(true);
    expect(any.heuristic(n(9, 0, 0))).toBe(1);
    const all = new GoalCompositeAll([new GoalNear(0, 0, 0, 5), new GoalNear(4, 0, 0, 5)]);
    expect(all.isEnd(n(2, 0, 0))).toBe(true);
    expect(all.isEnd(n(-4, 0, 0))).toBe(false);
  });
});

describe('block table', () => {
  it('classifies states', () => {
    const kit = versionKit(VERSION);
    const table = blockInfo(kit);
    const s = (name: string) => (kit.registry as any).blocksByName[name].defaultState;
    expect(table.flags(s('air')) & BlockFlag.Passable).toBeTruthy();
    expect(table.flags(s('stone')) & BlockFlag.Standable).toBeTruthy();
    expect(table.flags(s('water')) & BlockFlag.Water).toBeTruthy();
    expect(table.flags(s('lava')) & BlockFlag.Avoid).toBeTruthy();
    expect(table.flags(s('ladder')) & BlockFlag.Climbable).toBeTruthy();
    expect(table.flags(s('oak_fence')) & BlockFlag.Tall).toBeTruthy();
    expect(table.flags(s('chest')) & BlockFlag.Precious).toBeTruthy();
    expect(table.flags(s('sand')) & BlockFlag.Gravity).toBeTruthy();
    expect(table.flags(s('bedrock')) & BlockFlag.Breakable).toBeFalsy();
    expect(table.flags(s('white_carpet')) & BlockFlag.Flat).toBeTruthy();
    expect(table.height(s('soul_sand'))).toBeCloseTo(0.875);
    expect(table.flags(s('magma_block')) & BlockFlag.Avoid).toBeTruthy();
    expect(blockInfo(kit)).toBe(table);
    expect(blockInfo(versionKit('1.12.2'))).not.toBe(table);
  });

  it('works on pre-flattening versions', () => {
    const kit = versionKit('1.8.9');
    const table = blockInfo(kit);
    const s = (name: string) => (kit.registry as any).blocksByName[name].id << 4;
    expect(table.flags(s('stone')) & BlockFlag.Standable).toBeTruthy();
    expect(table.flags(s('air')) & BlockFlag.Passable).toBeTruthy();
    expect(table.flags(s('water')) & BlockFlag.Water).toBeTruthy();
  });
});

describe('planning', () => {
  it('walks across flat ground', async () => {
    const result = await plan(fakeBot(), [0, 0, 0], new GoalBlock(10, 0, 4));
    expect(result.status).toBe('success');
    expect(result.path.every((m) => m.kind === 'walk' || m.kind === 'diagonal')).toBe(true);
    expect(result.path.at(-1)).toMatchObject({ x: 10, y: 0, z: 4 });
  });

  it('goes around a wall it may not dig', async () => {
    const blocks: Record<string, string> = {};
    fill(blocks, [3, 0, -5], [3, 2, 5], 'stone');
    const result = await plan(fakeBot(blocks), [0, 0, 0], new GoalBlock(6, 0, 0), { canDig: false });
    expect(result.status).toBe('success');
    expect(result.path.every((m) => m.toBreak.length === 0)).toBe(true);
    expect(result.path.some((m) => Math.abs(m.z) >= 6)).toBe(true);
  });

  it('digs through a long wall', async () => {
    const blocks: Record<string, string> = {};
    fill(blocks, [3, 0, -40], [3, 3, 40], 'dirt');
    const result = await plan(fakeBot(blocks), [0, 0, 0], new GoalBlock(6, 0, 0));
    expect(result.status).toBe('success');
    const dig = result.path.find((m) => m.toBreak.length > 0)!;
    expect(dig.toBreak).toEqual(expect.arrayContaining([{ x: 3, y: 0, z: 0 }, { x: 3, y: 1, z: 0 }]));
  });

  it('never breaks precious blocks or under falling ones', async () => {
    const blocks: Record<string, string> = {};
    fill(blocks, [3, 0, -40], [3, 1, 40], 'chest');
    const result = await plan(fakeBot(blocks), [0, 0, 0], new GoalBlock(6, 0, 0));
    expect(result.path.flatMap((m) => m.toBreak)).toEqual([]);
  });

  it('climbs stairs and drops off ledges', async () => {
    const blocks: Record<string, string> = {};
    for (let i = 1; i <= 3; i++) fill(blocks, [i + 1, 0, -1], [i + 1, i - 1, 1], 'stone');
    const up = await plan(fakeBot(blocks), [0, 0, 0], new GoalBlock(4, 3, 0), { canDig: false, canPlace: false });
    expect(up.status).toBe('success');
    expect(up.path.filter((m) => m.kind === 'ascend')).toHaveLength(3);
    const down = await plan(fakeBot(blocks), [4, 3, 0], new GoalBlock(8, 0, 0), { canDig: false, canPlace: false });
    expect(down.status).toBe('success');
    expect(down.path.some((m) => m.kind === 'descend')).toBe(true);
  });

  it('lands in water from any height, but not on waterlogged blocks or lava', async () => {
    const tower = (top: string): Record<string, string> => {
      const blocks: Record<string, string> = {};
      fill(blocks, [-1, 0, -1], [1, 19, 1], 'stone');
      blocks['2,0,0'] = top;
      return blocks;
    };
    const settings = { canDig: false, canPlace: false, allowParkour: false };
    const water = await plan(fakeBot(tower('water')), [0, 20, 0], new GoalBlock(2, 0, 0), settings);
    expect(water.status).toBe('success');
    const leaves = await plan(fakeBot(tower('oak_leaves[waterlogged=true]')), [0, 20, 0], new GoalXZ(2, 0), settings);
    expect(leaves.status).not.toBe('success');
    const lava = await plan(fakeBot(tower('lava')), [0, 20, 0], new GoalBlock(2, 0, 0), settings);
    expect(lava.status).not.toBe('success');
  });

  it('respects maxDropDown', async () => {
    const blocks: Record<string, string> = {};
    fill(blocks, [-1, 0, -1], [1, 9, 1], 'stone');
    const result = await plan(fakeBot(blocks), [0, 10, 0], new GoalY(0), { canDig: false, canPlace: false, maxDropDown: 4 });
    expect(result.status).not.toBe('success');
  });

  it('jumps gaps (parkour) when it may not build', async () => {
    const blocks: Record<string, string> = {};
    fill(blocks, [0, 0, 0], [0, 4, 0], 'stone');
    fill(blocks, [3, 0, 0], [3, 4, 0], 'stone');
    fill(blocks, [7, 0, 0], [7, 4, 0], 'stone');
    const result = await plan(fakeBot(blocks), [0, 5, 0], new GoalBlock(7, 5, 0), { canDig: false, canPlace: false });
    expect(result.status).toBe('success');
    expect(result.path.map((m) => [m.kind, m.distance])).toEqual([['parkour', 3], ['parkour', 4]]);
  });

  it("doesn't jump over lava", async () => {
    const blocks: Record<string, string> = {};
    fill(blocks, [0, 0, -1], [0, 4, 1], 'stone');
    fill(blocks, [1, 4, -1], [2, 4, 1], 'lava');
    fill(blocks, [3, 0, -1], [3, 4, 1], 'stone');
    const result = await plan(fakeBot(blocks), [0, 5, 0], new GoalBlock(3, 5, 0), { canDig: false, canPlace: false });
    expect(result.status).not.toBe('success');
  });

  it('bridges with scaffolding blocks', async () => {
    const blocks: Record<string, string> = {};
    fill(blocks, [-2, 0, -1], [0, 4, 1], 'stone');
    fill(blocks, [7, 0, -1], [9, 4, 1], 'stone');
    const result = await plan(fakeBot(blocks, { items: [{ name: 'dirt', count: 32 }] }), [0, 5, 0], new GoalBlock(8, 5, 0), { canDig: false, allowParkour: false });
    expect(result.status).toBe('success');
    const placed = result.path.flatMap((m) => m.toPlace.map((t) => t.pos));
    expect(placed).toEqual(expect.arrayContaining([{ x: 1, y: 4, z: 0 }, { x: 6, y: 4, z: 0 }]));
    // Each placement clicks against a solid block.
    for (const m of result.path) for (const t of m.toPlace) expect(Math.abs(t.face.x) + Math.abs(t.face.y) + Math.abs(t.face.z)).toBe(1);
  });

  it("can't bridge without blocks", async () => {
    const blocks: Record<string, string> = {};
    fill(blocks, [-2, 0, -1], [0, 4, 1], 'stone');
    fill(blocks, [7, 0, -1], [9, 4, 1], 'stone');
    const result = await plan(fakeBot(blocks), [0, 5, 0], new GoalBlock(8, 5, 0), { canDig: false, allowParkour: false });
    expect(result.status).not.toBe('success');
  });

  it('pillars up', async () => {
    const result = await plan(fakeBot({}, { items: [{ name: 'cobblestone', count: 10 }] }), [0, 0, 0], new GoalY(4), { canDig: false });
    expect(result.status).toBe('success');
    expect(result.path.map((m) => m.kind)).toEqual(['up', 'up', 'up', 'up']);
    expect(result.path.at(-1)!.remainingBlocks).toBe(6);
  });

  it('digs down', async () => {
    const result = await plan(fakeBot(), [0, 0, 0], new GoalY(-3));
    expect(result.status).toBe('success');
    expect(result.path.every((m) => m.kind === 'down')).toBe(true);
  });

  it('climbs ladders and swims', async () => {
    const blocks: Record<string, string> = {};
    fill(blocks, [2, 0, -1], [2, 4, 1], 'stone');
    fill(blocks, [1, 0, 0], [1, 4, 0], 'ladder');
    const result = await plan(fakeBot(blocks), [0, 0, 0], new GoalBlock(2, 5, 0), { canDig: false, canPlace: false, allowParkour: false });
    expect(result.status).toBe('success');
    expect(result.path.filter((m) => m.kind === 'up').length).toBeGreaterThanOrEqual(3);
    const pool: Record<string, string> = {};
    fill(pool, [2, -2, -5], [8, -1, 5], 'water');
    const swim = await plan(fakeBot(pool), [0, 0, 0], new GoalBlock(10, 0, 0), { canDig: false, canPlace: false, allowParkour: false });
    expect(swim.status).toBe('success');
  });

  it('opens doors instead of digging', async () => {
    const blocks: Record<string, string> = {};
    fill(blocks, [3, 0, -30], [3, 2, 30], 'stone');
    blocks['3,0,0'] = 'oak_door';
    blocks['3,1,0'] = 'oak_door';
    const result = await plan(fakeBot(blocks), [0, 0, 0], new GoalBlock(6, 0, 0), { canDig: false });
    expect(result.status).toBe('success');
    expect(result.path.flatMap((m) => m.toOpen)).toEqual(expect.arrayContaining([{ x: 3, y: 0, z: 0 }]));
  });

  it('reports no path when boxed in', async () => {
    const blocks: Record<string, string> = {};
    fill(blocks, [-1, 0, -1], [1, 2, 1], 'bedrock');
    blocks['0,0,0'] = 'air';
    blocks['0,1,0'] = 'air';
    const result = await plan(fakeBot(blocks), [0, 0, 0], new GoalBlock(5, 0, 0), { canPlace: false, canDig: false });
    expect(result.status).toBe('noPath');
    expect(result.path).toEqual([]);
  });

  it('applies exclusion zones', async () => {
    const result = await plan(fakeBot(), [0, 0, 0], new GoalBlock(6, 0, 0), {
      exclusionAreasStep: [(p) => (p.z === 0 && p.x > 0 && p.x < 6 ? 1_000_000 : 0)],
    });
    expect(result.status).toBe('success');
    expect(result.path.slice(0, -1).every((m) => m.z !== 0)).toBe(true);
  });

  it('plans on 1.8 worlds too', async () => {
    const result = await plan(fakeBot({}, { version: '1.8.9' }), [0, 0, 0], new GoalBlock(5, 0, 5));
    expect(result.status).toBe('success');
  });
});

describe('feet to node', () => {
  it('counts slabs and soul sand as standing on the block below', () => {
    expect(nodeOf(new Vec3(0.5, 64, 0.5))).toEqual({ x: 0, y: 64, z: 0 });
    expect(nodeOf(new Vec3(0.5, 64.5, 0.5))).toEqual({ x: 0, y: 65, z: 0 });
    expect(nodeOf(new Vec3(0.5, 63.875, 0.5))).toEqual({ x: 0, y: 64, z: 0 });
    expect(nodeOf(new Vec3(-0.5, 64, -0.5))).toEqual({ x: -1, y: 64, z: -1 });
  });
});

describe('GoalFollow', () => {
  it('re-aims as soon as the target is on another block', () => {
    const entity = { position: new Vec3(10.4, 64, 10.6), isValid: true } as unknown as Entity;
    const goal = new GoalFollow(entity, 3);
    expect(goal.hasChanged()).toBe(false);
    entity.position.set(10.9, 64, 10.2); // same block
    expect(goal.hasChanged()).toBe(false);
    entity.position.set(11.1, 64, 10.2);
    expect(goal.hasChanged()).toBe(true);
    goal.refresh();
    expect(goal.hasChanged()).toBe(false);
  });
});
