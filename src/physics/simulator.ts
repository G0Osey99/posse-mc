// Forward simulation of the bot's movement: what happens over the next ticks with given controls,
// without moving the bot. The pathfinder uses it to time jumps; bots can use it to predict where
// they'll land. Runs prismarine-physics (MIT) on a copied player state, with the effect levels and
// armour read once instead of every tick.
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import { enchantsOf } from '../items.js';
import type { ControlStates } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- prismarine-physics is untyped */

/** A player's physics state (prismarine-physics' PlayerState fields). */
export interface SimState {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  isInWater: boolean;
  isInLava: boolean;
  isInWeb: boolean;
  isCollidedHorizontally: boolean;
  isCollidedVertically: boolean;
  elytraFlying: boolean;
  jumpTicks: number;
  jumpQueued: boolean;
  fireworkRocketDuration: number;
  attributes: Record<string, unknown> | undefined;
  yaw: number;
  pitch: number;
  control: ControlStates;
  jumpBoost: number;
  speed: number;
  slowness: number;
  dolphinsGrace: number;
  slowFalling: number;
  levitation: number;
  depthStrider: number;
  elytraEquipped: boolean;
}

export interface SimulationResult {
  state: SimState;
  ticks: number;
  /** Whether `goal` was met (false when `maxTicks` ran out). */
  reached: boolean;
  /** Feet positions after each tick (only with `history: true`). */
  history?: Vec3[];
}

export const noControls = (): ControlStates => ({ forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false });

const copyAttributes = (attributes: Record<string, any> | undefined): Record<string, any> | undefined => {
  if (!attributes) return undefined;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(attributes)) out[k] = v && typeof v === 'object' ? { ...v, modifiers: Array.isArray(v.modifiers) ? [...v.modifiers] : v.modifiers } : v;
  return out;
};

const effectLevel = (registry: any, name: string, effects: Record<number, { amplifier: number }> | undefined): number => {
  const id = registry.effectsByName?.[name]?.id;
  const effect = id === undefined ? undefined : effects?.[id];
  return effect ? effect.amplifier + 1 : 0;
};

export class Simulator {
  private readonly physics: any;
  private readonly world: { getBlock: (pos: Vec3) => unknown };

  constructor(private readonly bot: PosseBot) {
    const kit = bot.kit as any;
    this.physics = kit.sharedPhysics ?? (kit.sharedPhysics = kit.Physics(kit.registry, { getBlock: () => null }));
    this.world = { getBlock: (pos: Vec3) => bot.blockAt(pos) };
  }

  /** The bot's current state, with the given controls (default: what it's pressing now). */
  state(controls?: Partial<ControlStates>): SimState {
    const bot = this.bot;
    const e = bot.entity as any;
    const registry = bot.registry as any;
    const boots = bot.inventory?.slots[8];
    const chest = bot.inventory?.slots[6];
    const control = noControls();
    for (const key of Object.keys(control) as Array<keyof ControlStates>) control[key] = controls?.[key] ?? bot.getControlState(key);
    return {
      pos: e.position.clone(),
      vel: e.velocity.clone(),
      onGround: Boolean(e.onGround),
      isInWater: Boolean(e.isInWater),
      isInLava: Boolean(e.isInLava),
      isInWeb: Boolean(e.isInWeb),
      isCollidedHorizontally: Boolean(e.isCollidedHorizontally),
      isCollidedVertically: Boolean(e.isCollidedVertically),
      elytraFlying: Boolean(e.elytraFlying),
      jumpTicks: (bot as any).jumpTicks ?? 0,
      jumpQueued: Boolean((bot as any).jumpQueued),
      fireworkRocketDuration: (bot as any).fireworkRocketDuration ?? 0,
      // Copied: prismarine-physics rewrites the speed modifiers in place.
      attributes: copyAttributes(e.attributes),
      yaw: e.yaw,
      pitch: e.pitch,
      control,
      jumpBoost: effectLevel(registry, 'JumpBoost', e.effects),
      speed: effectLevel(registry, 'Speed', e.effects),
      slowness: effectLevel(registry, 'Slowness', e.effects),
      dolphinsGrace: effectLevel(registry, 'DolphinsGrace', e.effects),
      slowFalling: effectLevel(registry, 'SlowFalling', e.effects),
      levitation: effectLevel(registry, 'Levitation', e.effects),
      depthStrider: enchantsOf(bot.registry, boots).find((x) => x.name === 'depth_strider')?.lvl ?? 0,
      elytraEquipped: chest?.name === 'elytra',
    };
  }

  /** A copy of a state (vectors and controls cloned). */
  static clone(state: SimState): SimState {
    return { ...state, pos: state.pos.clone(), vel: state.vel.clone(), control: { ...state.control }, attributes: copyAttributes(state.attributes) };
  }

  /** Advances a state by one tick, in place. */
  step(state: SimState): SimState {
    this.physics.simulatePlayer(state, this.world);
    return state;
  }

  /**
   * Simulates from `state` (copied) until `goal` holds or `maxTicks` pass. `controller` runs before
   * each tick and may change the state's controls, yaw and pitch.
   */
  simulateUntil(
    state: SimState,
    goal: (state: SimState, tick: number) => boolean,
    controller: (state: SimState, tick: number) => void = () => undefined,
    maxTicks = 100,
    options: { history?: boolean } = {},
  ): SimulationResult {
    const s = Simulator.clone(state);
    const history = options.history ? [] as Vec3[] : undefined;
    for (let tick = 0; tick < maxTicks; tick++) {
      if (goal(s, tick)) return { state: s, ticks: tick, reached: true, history };
      controller(s, tick);
      this.step(s);
      history?.push(s.pos.clone());
    }
    return { state: s, ticks: maxTicks, reached: goal(s, maxTicks), history };
  }

  /** Simulates `ticks` ticks holding the given controls; returns the state after each tick. */
  predict(controls: Partial<ControlStates>, ticks: number, from: SimState = this.state(controls)): SimState[] {
    const s = Simulator.clone(from);
    Object.assign(s.control, controls);
    const out: SimState[] = [];
    for (let i = 0; i < ticks; i++) out.push(Simulator.clone(this.step(s)));
    return out;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
