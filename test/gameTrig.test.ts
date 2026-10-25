/* eslint-disable @typescript-eslint/no-explicit-any -- registries and fake bots are untyped */
// The game's movement turns with its sine table (Mth.sin); anticheats replay it bit for bit.
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { createPhysics, gameCos, gameSin } from '../src/features/motion.js';
import { versionKit } from '../src/registry.js';

describe('game trigonometry', () => {
  it('is the 65536-step table', () => {
    expect(gameSin(0)).toBe(0);
    expect(gameSin(Math.PI / 2)).toBe(1);
    expect(gameCos(0)).toBe(1);
    expect(gameCos(Math.PI)).toBe(-1);
    // One table step (2π/65536) rounds down, as the game's (int) cast does.
    expect(gameSin((Math.PI * 2) / 65536) * 0.999).toBeLessThan(gameSin(1.5 * ((Math.PI * 2) / 65536)) + 1e-12);
    // Negative angles wrap like Java's int & 65535.
    expect(gameSin(-Math.PI / 2)).toBe(-1);
    expect(Math.abs(gameSin(1) - Math.sin(1))).toBeLessThan(1e-4);
    expect(gameSin(1)).not.toBe(Math.sin(1));
  });

  it('walks the way GrimAC predicts on 1.21.4', () => {
    // A tick from a live run (Grim's consoledebug): the velocity it starts with, the packet's yaw,
    // forward held on the ground, and the move Grim predicted for it.
    const kit = versionKit('1.21.4');
    const registry = kit.registry as any;
    const stone = registry.blocksByName.stone.defaultState;
    const physics = createPhysics(kit.Physics as any, registry);
    const fr = Math.fround(Math.fround(0.6) * Math.fround(0.91));
    const yawDeg = 1167.5684814453125;
    const bot: any = {
      kit,
      registry,
      version: '1.21.4',
      entity: { position: new Vec3(0.5, 0, 0.5), velocity: new Vec3(-0.12560978487708005 * fr, 0, 0), onGround: true, yaw: Math.PI - Math.fround(yawDeg * Math.fround(Math.PI / 180)), pitch: 0, effects: {}, attributes: {} },
      inventory: { slots: [] },
      jumpTicks: 0,
      jumpQueued: false,
    };
    const world = {
      getBlock: (p: { x: number; y: number; z: number }) => {
        const block = kit.Block.fromStateId(Math.floor(p.y) < 0 ? stone : 0, 0) as any;
        block.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
        return block;
      },
    };
    const state = new kit.PlayerState(bot, { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false });
    physics.simulatePlayer(state, world);
    expect(state.pos.x - 0.5).toBeCloseTo(-0.16649457568260678, 6);
    expect(state.pos.z - 0.5).toBeCloseTo(0.004161013895210733, 8);
  });
});
