// Flight (docs/design.md → Flight): the abilities the server grants (`/fly`, creative) and the
// game's flying movement. prismarine-physics has no flight, so a flying tick runs its normal
// movement with the flying values swapped in and the vertical part done the game's way
// (LocalPlayer.aiStep / Player.travel; EntityPlayerSP.onLivingUpdate / EntityPlayer.moveEntityWithHeading
// before 1.13).

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets and prismarine-physics are untyped */

/** What the server lets the bot do (the `abilities` packet). */
export interface Abilities {
  /** Flying now. */
  flying: boolean;
  /** May fly (`/fly`, creative, spectator). */
  allowFlying: boolean;
  creative: boolean;
  invulnerable: boolean;
  /** Blocks/tick² of flying acceleration (0.05 by default). */
  flySpeed: number;
  /** The walking speed the client shows (0.1 by default). */
  walkSpeed: number;
}

export const FLAG_INVULNERABLE = 0x01;
export const FLAG_FLYING = 0x02;
export const FLAG_ALLOW_FLYING = 0x04;
export const FLAG_CREATIVE = 0x08;

export function defaultAbilities(): Abilities {
  return { flying: false, allowFlying: false, creative: false, invulnerable: false, flySpeed: 0.05, walkSpeed: 0.1 };
}

/** The abilities in a clientbound `abilities` packet. */
export function parseAbilities(packet: { flags: number; flyingSpeed?: number; walkingSpeed?: number }): Abilities {
  const flags = packet.flags & 0xff;
  return {
    flying: (flags & FLAG_FLYING) !== 0,
    allowFlying: (flags & FLAG_ALLOW_FLYING) !== 0,
    creative: (flags & FLAG_CREATIVE) !== 0,
    invulnerable: (flags & FLAG_INVULNERABLE) !== 0,
    flySpeed: Number.isFinite(packet.flyingSpeed) ? Number(packet.flyingSpeed) : 0.05,
    walkSpeed: Number.isFinite(packet.walkingSpeed) ? Number(packet.walkingSpeed) : 0.1,
  };
}

/**
 * The serverbound `abilities` packet as the game writes it: before 1.16 every flag plus both speeds
 * (PlayerCapabilities.writeCapabilities), from 1.16 only the flying bit.
 */
export function abilitiesPacket(abilities: Abilities, withSpeeds: boolean): { flags: number; flyingSpeed?: number; walkingSpeed?: number } {
  if (!withSpeeds) return { flags: abilities.flying ? FLAG_FLYING : 0 };
  let flags = 0;
  if (abilities.invulnerable) flags |= FLAG_INVULNERABLE;
  if (abilities.flying) flags |= FLAG_FLYING;
  if (abilities.allowFlying) flags |= FLAG_ALLOW_FLYING;
  if (abilities.creative) flags |= FLAG_CREATIVE;
  return { flags, flyingSpeed: abilities.flySpeed, walkingSpeed: abilities.walkSpeed };
}

export function sameAbilities(a: Abilities, b: Abilities): boolean {
  return (
    a.flying === b.flying &&
    a.allowFlying === b.allowFlying &&
    a.creative === b.creative &&
    a.invulnerable === b.invulnerable &&
    a.flySpeed === b.flySpeed &&
    a.walkSpeed === b.walkSpeed
  );
}

/** The vertical push of the jump/sneak keys while flying, per tick (`flySpeed * 3` as a float). */
export function flyVerticalPush(flySpeed: number): number {
  return Math.fround(Math.fround(flySpeed) * 3);
}

/** Horizontal acceleration while flying in the air: the fly speed, doubled sprinting (a float). */
export function flyAcceleration(flySpeed: number, sprinting: boolean): number {
  return Math.fround(Math.fround(flySpeed) * (sprinting ? 2 : 1));
}

/** A prismarine-physics player state (PlayerState or the simulator's SimState). */
interface PhysicsState {
  vel: { x: number; y: number; z: number };
  onGround: boolean;
  isInWater: boolean;
  isInLava: boolean;
  jumpTicks: number;
  jumpQueued: boolean;
  jumpBoost: number;
  control: { forward: boolean; back: boolean; left: boolean; right: boolean; jump: boolean; sprint: boolean; sneak: boolean };
}

export interface FlyingTick {
  /** Sprinting this tick (the bot's sprint state, not the key). */
  sprinting: boolean;
  /** Whether sneaking slows flying sideways (before 1.14, where sneak was a key, not a pose). */
  sneakSlows: boolean;
  /** Treat the jump key as pressed this tick (taking off from the ground). */
  takeoff?: boolean;
}

/**
 * One flying tick on `state`, in place. In the game's order: the jump/sneak keys push the vertical
 * velocity by `flySpeed * 3`; then the normal tick (velocities under the negligible threshold cut, a
 * jump off the ground, the move with the flying acceleration and air friction); then the vertical
 * velocity becomes 0.6 × what it was when the move started, whatever gravity or a collision did.
 */
export function simulateFlying(physics: any, state: PhysicsState, world: unknown, flySpeed: number, tick: FlyingTick): void {
  const vel = state.vel;
  const keys = state.control;
  const jump = keys.jump || Boolean(tick.takeoff);
  const input = (jump ? 1 : 0) - (keys.sneak ? 1 : 0);
  if (input !== 0) vel.y += input * flyVerticalPush(flySpeed);

  // The vertical velocity the move starts with, as prismarine-physics will work it out.
  let start = Math.abs(vel.y) < physics.negligeableVelocity ? 0 : vel.y;
  if (jump || state.jumpQueued) {
    const jumpTicks = state.jumpTicks > 0 ? state.jumpTicks - 1 : 0;
    if (state.isInWater || state.isInLava) start += 0.04;
    else if (state.onGround && jumpTicks === 0) start = Math.fround(0.42) + (state.jumpBoost > 0 ? 0.1 * state.jumpBoost : 0);
  }

  const control = keys;
  const saved = { control, acceleration: physics.airborneAcceleration };
  // On the ground (the tick of a takeoff or a landing) the ground speed applies, sprint included; in
  // the air the flying acceleration replaces the airborne one and its sprint bonus.
  state.control = {
    ...keys,
    jump,
    sprint: state.onGround ? tick.sprinting : false,
    sneak: tick.sneakSlows && keys.sneak,
  };
  physics.airborneAcceleration = flyAcceleration(flySpeed, tick.sprinting);
  try {
    physics.simulatePlayer(state, world);
  } finally {
    physics.airborneAcceleration = saved.acceleration;
    state.control = saved.control;
  }
  vel.y = start * 0.6;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
