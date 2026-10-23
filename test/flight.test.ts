/* eslint-disable @typescript-eslint/no-explicit-any -- registries and fake bots are untyped */
import { describe, expect, it } from 'vitest';
import mc from 'minecraft-protocol';
import { Vec3 } from 'vec3';
import type { PosseBot } from '../src/bot.js';
import { abilitiesWithSpeeds } from '../src/features/motion.js';
import { abilitiesPacket, defaultAbilities, flyAcceleration, flyVerticalPush, parseAbilities } from '../src/features/flight.js';
import { noControls, Simulator, type SimState } from '../src/physics/simulator.js';
import { versionKit } from '../src/registry.js';

/** A flying bot high above flat stone (top at y = 0). */
function flyingBot(version = '1.20.4', y = 50): PosseBot {
  const kit = versionKit(version);
  const registry = kit.registry as any;
  const stone = registry.blocksByName.stone.defaultState ?? registry.blocksByName.stone.id << 4;
  const controls = noControls();
  return {
    kit,
    registry,
    version,
    abilities: { ...defaultAbilities(), allowFlying: true, flying: true },
    entity: { position: new Vec3(0.5, y, 0.5), velocity: new Vec3(0, 0, 0), onGround: false, yaw: 0, pitch: 0, effects: {} },
    inventory: { slots: [] },
    getControlState: (c: keyof typeof controls) => controls[c],
    blockAt: (p: { x: number; y: number; z: number }) => {
      const block = kit.Block.fromStateId(Math.floor(p.y) < 0 ? stone : 0, 0);
      block.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return block;
    },
  } as unknown as PosseBot;
}

/** Blocks moved per tick over the last few ticks of a run (the steady-state speed). */
function steadySpeed(states: SimState[], axis: 'x' | 'y' | 'z'): number {
  const a = states.at(-6)!.pos[axis];
  const b = states.at(-1)!.pos[axis];
  return (b - a) / 5;
}

describe('abilities packet', () => {
  it('reads the flags and speeds', () => {
    expect(parseAbilities({ flags: 0x04, flyingSpeed: 0.05, walkingSpeed: 0.1 })).toEqual({
      flying: false,
      allowFlying: true,
      creative: false,
      invulnerable: false,
      flySpeed: 0.05,
      walkSpeed: 0.1,
    });
    const creative = parseAbilities({ flags: 0x0f, flyingSpeed: 0.1, walkingSpeed: 0.2 });
    expect(creative).toMatchObject({ flying: true, allowFlying: true, creative: true, invulnerable: true, flySpeed: 0.1, walkSpeed: 0.2 });
    // A signed byte with every bit set still reads as the four flags.
    expect(parseAbilities({ flags: -1 })).toMatchObject({ flying: true, allowFlying: true, creative: true, invulnerable: true, flySpeed: 0.05 });
  });

  it('writes what the game writes: every flag and both speeds before 1.16, the flying bit after', () => {
    const a = { ...defaultAbilities(), allowFlying: true, flying: true, flySpeed: 0.08 };
    expect(abilitiesPacket(a, true)).toEqual({ flags: 0x06, flyingSpeed: 0.08, walkingSpeed: 0.1 });
    expect(abilitiesPacket(a, false)).toEqual({ flags: 0x02 });
    expect(abilitiesPacket({ ...a, flying: false }, false)).toEqual({ flags: 0 });
  });

  it('serializes on every version (speeds before 1.16)', () => {
    expect(abilitiesWithSpeeds('1.8.9')).toBe(true);
    expect(abilitiesWithSpeeds('1.15.2')).toBe(true);
    expect(abilitiesWithSpeeds('1.16.5')).toBe(false);
    const a = { ...defaultAbilities(), allowFlying: true, flying: true };
    for (const version of ['1.8.9', '1.12.2', '1.15.2', '1.16.5', '1.20.4', '1.21.4', '1.21.11', '26.1']) {
      const serializer = mc.createSerializer({ state: 'play', isServer: false, version } as unknown as Parameters<typeof mc.createSerializer>[0]);
      expect(() => serializer.createPacketBuffer({ name: 'abilities', params: abilitiesPacket(a, abilitiesWithSpeeds(version)) }), version).not.toThrow();
    }
  });

  it('pushes and accelerates by the fly speed, as floats', () => {
    expect(flyVerticalPush(0.05)).toBe(Math.fround(Math.fround(0.05) * 3));
    expect(flyAcceleration(0.05, false)).toBe(Math.fround(0.05));
    expect(flyAcceleration(0.05, true)).toBe(Math.fround(0.1));
  });
});

describe('flight physics (vanilla values)', () => {
  it('hovers without keys: no gravity, the vertical velocity dies away', () => {
    const sim = new Simulator(flyingBot());
    const start = sim.state({});
    start.vel.y = 0.2;
    const states = sim.predict({}, 40, start);
    // 0.2 → 0.12 → 0.072 … (×0.6 a tick), so it rises almost 0.5 (the last bit is cut as negligible).
    expect(states[0]!.vel.y).toBeCloseTo(0.12, 6);
    expect(states.at(-1)!.vel.y).toBe(0);
    expect(states.at(-1)!.pos.y).toBeCloseTo(50.495, 2);
    expect(states.at(-1)!.flying).toBe(true);
  });

  it('rises at 0.375 blocks/tick holding jump and sinks as fast sneaking', () => {
    const sim = new Simulator(flyingBot());
    const up = sim.predict({ jump: true }, 40);
    // First tick: 0.15 up, then the velocity keeps 0.6 of it.
    expect(up[0]!.pos.y - 50).toBeCloseTo(0.15, 5);
    expect(steadySpeed(up, 'y')).toBeCloseTo(0.375, 3);
    const down = sim.predict({ sneak: true }, 30);
    expect(steadySpeed(down, 'y')).toBeCloseTo(-0.375, 3);
    expect(down.at(-1)!.flying).toBe(true);
  });

  it('flies 10.89 blocks/s forward and 21.78 sprinting', () => {
    const sim = new Simulator(flyingBot());
    const walk = sim.predict({ forward: true }, 100);
    // Steady state: v = 0.91 (v + 0.98 × 0.05) → v + 0.049 = 0.5445 blocks/tick.
    expect(-steadySpeed(walk, 'z')).toBeCloseTo(0.5445, 3);
    expect(walk.at(-1)!.pos.y).toBeCloseTo(50, 6);
    const sprint = sim.predict({ forward: true, sprint: true }, 100);
    expect(-steadySpeed(sprint, 'z')).toBeCloseTo(1.089, 3);
  });

  it('follows the server fly speed', () => {
    const bot = flyingBot();
    (bot as any).abilities.flySpeed = 0.1;
    const states = new Simulator(bot).predict({ forward: true }, 100);
    expect(-steadySpeed(states, 'z')).toBeCloseTo(1.089, 3);
  });

  it('sneaking slows flying sideways before 1.14 only', () => {
    const modern = new Simulator(flyingBot('1.20.4')).predict({ forward: true, sneak: true }, 100);
    expect(-steadySpeed(modern, 'z')).toBeCloseTo(0.5445, 3);
    const legacy = new Simulator(flyingBot('1.8.8')).predict({ forward: true, sneak: true }, 100);
    expect(-steadySpeed(legacy, 'z')).toBeCloseTo(0.5445 * 0.3, 3);
  });

  it('lands and stops flying when it reaches the ground', () => {
    const sim = new Simulator(flyingBot('1.20.4', 2));
    const states = sim.predict({ sneak: true }, 30);
    const landed = states.findIndex((s) => s.onGround);
    expect(landed).toBeGreaterThan(0);
    expect(states[landed]!.flying).toBe(false);
    expect(states.at(-1)!.pos.y).toBeCloseTo(0, 6);
  });

  it('a bot that is not flying still falls', () => {
    const bot = flyingBot();
    (bot as any).abilities.flying = false;
    const states = new Simulator(bot).predict({}, 10);
    expect(states.at(-1)!.pos.y).toBeLessThan(49);
  });
});
