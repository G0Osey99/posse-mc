/* eslint-disable @typescript-eslint/no-explicit-any -- registries and fake bots are untyped */
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import type { PosseBot } from '../src/bot.js';
import { noControls, Simulator } from '../src/physics/simulator.js';
import { versionKit } from '../src/registry.js';

/** A bot standing on flat stone (top at y = 0) at the origin. */
function flatBot(version = '1.20.4', extra: Record<string, string> = {}): PosseBot {
  const kit = versionKit(version);
  const registry = kit.registry as any;
  const stone = registry.blocksByName.stone.defaultState ?? registry.blocksByName.stone.id << 4;
  const controls = noControls();
  return {
    kit,
    registry,
    version,
    entity: { position: new Vec3(0.5, 0, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, effects: {} },
    inventory: { slots: [] },
    getControlState: (c: keyof typeof controls) => controls[c],
    blockAt: (p: { x: number; y: number; z: number }) => {
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      const z = Math.floor(p.z);
      const name = extra[`${x},${y},${z}`];
      const state = name ? registry.blocksByName[name].defaultState : y < 0 ? stone : 0;
      const block = kit.Block.fromStateId(state, 0);
      block.position = new Vec3(x, y, z);
      return block;
    },
  } as unknown as PosseBot;
}

describe('simulator', () => {
  it('stands still on the ground', () => {
    const sim = new Simulator(flatBot());
    const states = sim.predict({}, 10);
    expect(states.at(-1)!.pos.y).toBeCloseTo(0);
    expect(states.at(-1)!.onGround).toBe(true);
  });

  it('walks north (yaw 0) at walking speed', () => {
    const sim = new Simulator(flatBot());
    const states = sim.predict({ forward: true }, 20);
    const end = states.at(-1)!.pos;
    expect(end.z).toBeLessThan(0.5 - 3.5); // ~4.3 blocks/s
    expect(end.z).toBeGreaterThan(0.5 - 5);
    expect(end.x).toBeCloseTo(0.5);
  });

  it('sprints faster than it walks', () => {
    const sim = new Simulator(flatBot());
    const walk = sim.predict({ forward: true }, 20).at(-1)!.pos.z;
    const sprint = sim.predict({ forward: true, sprint: true }, 20).at(-1)!.pos.z;
    expect(sprint).toBeLessThan(walk - 0.8);
  });

  it('jumps about 1.25 blocks and lands', () => {
    const sim = new Simulator(flatBot());
    const states = sim.predict({ jump: true }, 6);
    const peak = Math.max(...states.map((s) => s.pos.y));
    expect(peak).toBeGreaterThan(1.1);
    expect(peak).toBeLessThan(1.3);
    const result = sim.simulateUntil(sim.state({ jump: true }), (s, t) => t > 1 && s.onGround, (s, t) => {
      if (t > 0) s.control.jump = false;
    });
    expect(result.reached).toBe(true);
    expect(result.ticks).toBeGreaterThan(8);
    expect(result.ticks).toBeLessThan(15);
  });

  it("doesn't move the bot", () => {
    const bot = flatBot();
    const sim = new Simulator(bot);
    sim.predict({ forward: true, sprint: true }, 20);
    expect(bot.entity.position).toEqual(new Vec3(0.5, 0, 0.5));
  });

  it('falls off an edge and stops at a wall', () => {
    const sim = new Simulator(flatBot('1.20.4', { '0,0,-2': 'stone', '0,1,-2': 'stone' }));
    const states = sim.predict({ forward: true }, 20);
    expect(states.at(-1)!.pos.z).toBeCloseTo(-0.7, 1); // against the wall at z = -1
    expect(states.some((s) => s.isCollidedHorizontally)).toBe(true);
  });
});
