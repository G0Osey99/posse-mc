// Movement (docs/design.md → Motion). Instead of simulating physics every tick for every bot,
// physics runs only while the bot settles after a teleport/knockback or while a control is held;
// otherwise the bot just reports its position the way an idle vanilla client does. Every bot shares
// the fleet ticker. Position-packet logic follows mineflayer's physics plugin.
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import * as conv from '../conv.js';
import { readVarInt } from '../decode.js';
import { fleetTicker, TICK_MS } from '../ticker.js';
import type { ControlState, ControlStates } from '../types.js';
import { abilitiesPacket, defaultAbilities, parseAbilities, sameAbilities, simulateFlying, type Abilities } from './flight.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets and prismarine-physics are untyped */

/**
 * prismarine-physics for a version, with the game's own values where it differs: before 1.9 the
 * game zeroes velocities under 0.005 (not 0.003), which an anticheat's simulation (Grim) notices.
 */
export function createPhysics(Physics: (registry: unknown, world: unknown) => any, registry: any): any {
  const physics = Physics(registry, { getBlock: () => null });
  if (registry.version?.['<']?.('1.9')) physics.negligeableVelocity = 0.005;
  return physics;
}

const PI = Math.PI;
const PI_2 = Math.PI * 2;
/** Ticks the bot must be on the ground and still before physics stops. */
const SETTLE_TICKS = 10;
/** Ticks of physics after a teleport before giving up on settling (e.g. the chunk never arrives). */
const MAX_SETTLE_TICKS = 20 * 30;

export interface MotionApi {
  enabled: boolean;
  controls: ControlStates;
  physicsTicks: number;
  setControlState(control: ControlState, state: boolean): void;
  clearControlStates(): void;
  look(yaw: number, pitch: number, force: boolean): Promise<void>;
  /** What the server lets the bot do; `flying` follows the bot's own flight too. */
  readonly abilities: Abilities;
  /** Starts or stops flying from the next tick (see PosseBot.setFlying). */
  setFlying(flying: boolean): Promise<void>;
  /**
   * Resolves once the next tick has sent the bot's position and rotation (at once when nothing is
   * being sent: before the server placed the bot, while dead, or outside the play state). Actions
   * wait for it after a look so the server sees the rotation before the click.
   */
  afterTick(): Promise<void>;
  /** The rotation (yaw, pitch in degrees) the last rotation packet carried, as sent. */
  sentRotation(): { yaw: number; pitch: number };
  /** Counts the movement keys as let go (an inventory screen is open) until the returned function is called. */
  holdInput(): () => void;
  /** Ticks since the last one that moved with a movement key held (what the server last saw). */
  readonly idleInputTicks: number;
  stop(): void;
}

/**
 * Whether a changed block touches the column the bot stands in: from the block under its feet to
 * its head, across the blocks its 0.6-wide box overlaps.
 */
export function touchesBot(pos: { x: number; y: number; z: number }, x: number, y: number, z: number): boolean {
  const half = 0.3;
  if (x < Math.floor(pos.x - half) || x > Math.floor(pos.x + half)) return false;
  if (z < Math.floor(pos.z - half) || z > Math.floor(pos.z + half)) return false;
  return y >= Math.floor(pos.y) - 1 && y <= Math.floor(pos.y + 1.8);
}

/** Whether `entity_velocity` carries an lpVec3 (blocks/tick) rather than 1/8000-block shorts. */
export function velocityIsLpVec3(version: string): boolean {
  const types = (minecraftData(version)?.protocol as any)?.play?.toClient?.types;
  const fields = types?.packet_entity_velocity?.[1] as Array<{ name: string; type: unknown }> | undefined;
  return fields?.find((f) => f.name === 'velocity')?.type === 'lpVec3';
}

function serverboundTypes(version: string): Record<string, any> {
  return (minecraftData(version)?.protocol as any)?.play?.toServer?.types ?? {};
}

function serverboundPacket(version: string, name: string): boolean {
  return serverboundTypes(version)[`packet_${name}`] !== undefined;
}

/** Whether the client's `abilities` packet carries both speeds (before 1.16) or only the flags. */
export function abilitiesWithSpeeds(version: string): boolean {
  const fields = serverboundTypes(version).packet_abilities?.[1] as Array<{ name: string }> | undefined;
  return fields?.some((f) => f.name === 'flyingSpeed') ?? false;
}

/** `entity_action` action names this version knows. */
export function actionNames(version: string): Set<string> {
  const fields = serverboundTypes(version).packet_entity_action?.[1] as Array<{ name: string; type: any }> | undefined;
  const mapper = fields?.find((f) => f.name === 'actionId')?.type;
  return new Set(Array.isArray(mapper) ? Object.values(mapper[1]?.mappings ?? {}) : []);
}

export function deltaYaw(yaw1: number, yaw2: number): number {
  let d = (yaw1 - yaw2) % PI_2;
  if (d < -PI) d += PI_2;
  else if (d > PI) d -= PI_2;
  return d;
}

export function installMotion(bot: PosseBot, physicsAllowed: boolean): MotionApi {
  const client = bot._client as any;
  const sf = bot.supportFeature;
  const { Physics, PlayerState } = bot.kit;
  const physics = (bot.kit as any).sharedPhysics ?? ((bot.kit as any).sharedPhysics = createPhysics(Physics, bot.kit.registry));
  const world = { getBlock: (pos: Vec3) => bot.blockAt(pos) };
  const everyTick = sf('positionUpdateSentEveryTick');
  // 1.21.2+: the game ends every client tick with this packet; anticheats (Grim's TickTimer) flag
  // movement packets that aren't followed by one.
  const tickEnd = Boolean((minecraftData(bot.version) as any)?.protocol?.play?.toServer?.types?.packet_tick_end);

  // The game sends these from inside its tick, before that tick's movement packet; anticheats (Grim's
  // Post) flag one that comes after the movement packet and before the next tick. Written between
  // ticks, they wait for the start of the next one (at most 50 ms).
  const tickBound = new Set(['entity_action', 'player_input', 'use_item', 'block_dig', 'block_place', 'arm_animation', 'held_item_slot', 'use_entity', 'abilities', 'spectate']);
  if (bot.registry.version['<']('1.13')) tickBound.add('window_click');
  const tickQueue: Array<[string, unknown]> = [];
  let inTick = false;
  const writeNow = client.write.bind(client);
  client.write = (name: string, params: unknown): void => {
    if (!inTick && active && unsubscribe && tickBound.has(name)) tickQueue.push([name, params]);
    else writeNow(name, params);
  };
  const flushTickQueue = (): void => {
    // Through client.write: the state guard (bot.ts) still applies when they go out.
    for (const [name, params] of tickQueue.splice(0)) client.write(name, params);
  };

  const controls: ControlStates = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  /** Held while the inventory is clicked: like the game with a screen open, the movement keys count as let go. */
  let inputHolds = 0;
  let idleInputTicks = 100;
  const input = (): ControlStates => (inputHolds > 0 ? { ...controls, forward: false, back: false, left: false, right: false, jump: false, sprint: false } : controls);
  const lastSent = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, onGround: false, time: 0, flags: { onGround: false, hasHorizontalCollision: undefined as boolean | undefined } };
  let lastSentYaw = 0;
  let lastSentPitch = 0;
  let active = false; // like mineflayer's shouldUsePhysics: true once the server placed us
  let settling = 0; // ticks of settling left
  let stillTicks = 0;
  let deadTicks = 21;
  let unsubscribe: (() => void) | null = null;
  let pendingLook: { resolve: () => void } | null = null;
  let tickWaiters: Array<() => void> = [];
  let respawnAt = 0;
  /** Bumped when the connection's world ends, so a delayed answer from before never resubscribes. */
  let generation = 0;
  let lastErrorAt = 0;
  // 1.21.9+ sends velocity as an lpVec3, which minecraft-protocol already decodes to blocks/tick.
  const velocityInBlocks = velocityIsLpVec3(bot.version);
  const entityActions = actionNames(bot.version);
  const sendsInput = serverboundPacket(bot.version, 'player_input') && bot.registry.version['>=']('1.21.2');
  // Before 1.16 the client's abilities packet carries every flag and both speeds.
  const withSpeeds = abilitiesWithSpeeds(bot.version);
  const abilities = defaultAbilities();
  /** setFlying calls waiting for the next tick. */
  const flightRequests: Array<{ flying: boolean; resolve: () => void; reject: (err: Error) => void }> = [];
  /** Taking off from the ground this tick: the game jumps when flight starts there. */
  let takeoff = false;
  const emitAbilities = (): void => {
    bot.emit('abilities');
  };
  /**
   * The bot starts or stops flying on its own (inside the tick, like the game's onUpdateAbilities).
   * `nextTick` sends the packet at the start of the next tick instead, after this tick's movement.
   */
  const setOwnFlight = (flying: boolean, nextTick = false): void => {
    if (abilities.flying === flying) return;
    abilities.flying = flying;
    const packet = abilitiesPacket(abilities, withSpeeds);
    if (nextTick) tickQueue.push(['abilities', packet]);
    else client.write('abilities', packet);
    settling = Math.max(settling, MAX_SETTLE_TICKS);
    stillTicks = 0;
    emitAbilities();
  };
  const rejectFlightRequests = (why: string): void => {
    for (const r of flightRequests.splice(0)) r.reject(new Error(why));
  };
  const applyFlightRequests = (): void => {
    for (const r of flightRequests.splice(0)) {
      if (r.flying && !abilities.allowFlying) {
        r.reject(new Error('Flight is not allowed: the server has not given this bot flight (e.g. /fly)'));
        continue;
      }
      if (r.flying && !abilities.flying && bot.entity.onGround) takeoff = true;
      setOwnFlight(r.flying);
      r.resolve();
    }
  };

  // The sprint key (controls.sprint) only asks to sprint; like the game, the bot sprints while it also
  // moves forward and isn't hungry, sneaking, using an item, against a wall or wading, and says so
  // with start/stop_sprinting. A bot that kept sprinting through a tick without forward input moved
  // faster than an anticheat's simulation of the game (Grim's Simulation check).
  let sprinting = false;
  // From 1.14 crouching is a pose the game updates at the end of a tick: the sneak key slows the
  // bot from the tick after it's pressed (and until the tick after it's released). Before, at once.
  const crouchPose = bot.registry.version['>=']('1.14');
  let crouching = false;
  // Before 1.19.4 the game works out the sprint bonus to air movement after moving, so in the air a
  // sprint started or stopped this tick only counts from the next one (on the ground, at once).
  const airSprintLags = bot.registry.version['<']('1.19.4');
  let airSprint = false;
  const setSprinting = (on: boolean): void => {
    sprinting = on;
    const action = on ? 'start_sprinting' : 'stop_sprinting';
    if (bot.entity && entityActions.has(action)) client.write('entity_action', { entityId: bot.entity.id, actionId: action, jumpBoost: 0 });
  };
  const updateSprint = (): void => {
    const e = bot.entity as any;
    // A bot that may fly can sprint hungry (the game's hasEnoughFoodToStartSprinting).
    const hungry =
      bot.game.gameMode !== 'creative' && bot.game.gameMode !== 'spectator' && !abilities.allowFlying && typeof bot.food === 'number' && bot.food <= 6;
    // From 1.14 sneaking while flying is no crouch: it only descends.
    const keys = input();
    const slowed = (controls.sneak && !(abilities.flying && crouchPose)) || bot.usingHeldItem;
    const wading = Boolean(e.isInWater) && bot.blockAt(e.position.offset(0, 1.62, 0))?.name !== 'water';
    const blocked = Boolean(e.isCollidedHorizontally) || wading;
    if (sprinting && (!keys.forward || hungry || slowed || blocked)) setSprinting(false);
    else if (!sprinting && keys.sprint && keys.forward && !hungry && !slowed && !blocked) setSprinting(true);
  };

  const sendInput = (): void => {
    if (!sendsInput || !bot.entity || client.state !== 'play') return;
    const keys = input();
    client.write('player_input', {
      inputs: { forward: keys.forward, backward: keys.back, left: keys.left, right: keys.right, jump: keys.jump, shift: keys.sneak, sprint: keys.sprint },
    });
  };

  const api: MotionApi = {
    enabled: physicsAllowed,
    controls,
    physicsTicks: 0,
    setControlState(control, state) {
      if (controls[control] === state) return;
      controls[control] = state;
      if (!bot.entity || client.state !== 'play') return;
      // Action names, not numbers: 1.21.6 renumbered them and dropped sneaking (now player_input).
      // Sprinting itself is decided each tick (updateSprint); letting go of the key stops it.
      const action = control === 'sneak' ? (state ? 'start_sneaking' : 'stop_sneaking') : null;
      if (action && entityActions.has(action)) client.write('entity_action', { entityId: bot.entity.id, actionId: action, jumpBoost: 0 });
      if (control === 'sprint' && !state && sprinting) setSprinting(false);
      // Crouching lowers the eyes (1.27 from 1.14, 1.54 before): looking and ray casts aim from them.
      if (control === 'sneak') (bot.entity as any).eyeHeight = state && !(abilities.flying && crouchPose) ? (crouchPose ? 1.27 : 1.54) : 1.62;
      sendInput();
    },
    holdInput() {
      inputHolds++;
      if (inputHolds === 1) sendInput();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inputHolds--;
        if (inputHolds === 0) sendInput();
      };
    },
    clearControlStates() {
      for (const key of Object.keys(controls) as ControlState[]) api.setControlState(key, false);
    },
    look(yaw, pitch, force) {
      if (!bot.entity) return Promise.resolve();
      bot.entity.yaw = yaw;
      bot.entity.pitch = pitch;
      if (force) {
        // Like mineflayer: the next tick sends it, so it's never sent before the server placed us,
        // while dead or outside the play state. The sent yaw stays continuous (the game never wraps
        // it; a 360° jump is flagged by anticheats, e.g. Grim's AimModulo360).
        lastSentYaw += deltaYaw(yaw, lastSentYaw);
        lastSentPitch = pitch;
        return Promise.resolve();
      }
      pendingLook?.resolve();
      return new Promise((resolve) => (pendingLook = { resolve }));
    },
    abilities,
    setFlying(flying) {
      if (flying && !abilities.allowFlying) {
        return Promise.reject(new Error('Flight is not allowed: the server has not given this bot flight (e.g. /fly)'));
      }
      if (!active || !unsubscribe || client.state !== 'play' || !bot.entity?.position) {
        return Promise.reject(new Error('The bot is not in the world yet'));
      }
      if (abilities.flying === flying && flightRequests.length === 0) return Promise.resolve();
      return new Promise((resolve, reject) => flightRequests.push({ flying, resolve, reject }));
    },
    afterTick() {
      if (!active || !unsubscribe || client.state !== 'play') return Promise.resolve();
      return new Promise((resolve) => tickWaiters.push(resolve));
    },
    get idleInputTicks() {
      return idleInputTicks;
    },
    sentRotation() {
      return { yaw: lastSent.yaw, pitch: lastSent.pitch };
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      active = false;
      generation++;
      pendingLook?.resolve();
      pendingLook = null;
      flushTickWaiters();
      rejectFlightRequests('The connection ended');
    },
  };

  const flushTickWaiters = (): void => {
    if (tickWaiters.length === 0) return;
    const waiters = tickWaiters;
    tickWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const write = (name: string, onGround: boolean): void => {
    lastSent.onGround = onGround;
    lastSent.flags = { onGround, hasHorizontalCollision: undefined };
    client.write(name, lastSent);
    bot.emit('move');
  };
  const finite = (p: Vec3): boolean => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  const sendPosition = (p: Vec3, onGround: boolean): void => {
    if (!finite(p)) return;
    lastSent.x = p.x;
    lastSent.y = p.y;
    lastSent.z = p.z;
    write('position', onGround);
  };
  const sendLook = (yaw: number, pitch: number, onGround: boolean): void => {
    lastSent.yaw = yaw;
    lastSent.pitch = pitch;
    write('look', onGround);
  };
  const sendPositionLook = (p: Vec3, yaw: number, pitch: number, onGround: boolean): void => {
    if (!finite(p)) return;
    lastSent.x = p.x;
    lastSent.y = p.y;
    lastSent.z = p.z;
    lastSent.yaw = yaw;
    lastSent.pitch = pitch;
    write('position_look', onGround);
  };

  const anyControl = (): boolean => {
    const keys = input();
    return keys.forward || keys.back || keys.left || keys.right || keys.jump;
  };

  const needsPhysics = (): boolean => {
    if (!api.enabled || !physicsAllowed) return false;
    if (anyControl() || settling > 0 || takeoff) return true;
    const v = bot.entity.velocity;
    // Standing, the game keeps a small downward velocity (gravity, cancelled by the ground).
    return Math.abs(v.x) > 1e-4 || Math.abs(v.z) > 1e-4 || (!bot.entity.onGround && Math.abs(v.y) > 1e-4);
  };

  const simulate = (): void => {
    if (bot.blockAt(bot.entity.position) === null) {
      // Chunk not here yet; still counts towards giving up on settling.
      if (settling > 0) settling--;
      return;
    }
    const entity = bot.entity as any;
    entity.effects ??= {};
    entity.attributes ??= {};
    if (abilities.flying) {
      // The flying acceleration reads the sprint state of this tick; the keys are the ones held now.
      const state = new PlayerState(bot, { ...input(), sprint: sprinting });
      simulateFlying(physics, state, world, abilities.flySpeed, { sprinting, sneakSlows: !crouchPose, takeoff });
      state.apply(bot);
      takeoff = false;
      // Like the game, landing ends the flight. The server hears it after the landing movement: an
      // anticheat that trusts flying movement (Grim) otherwise checks the landing as a walk that
      // started at the flight's speed, and flags it.
      if (bot.entity.onGround) setOwnFlight(false, true);
    } else {
      const sprint = airSprintLags && !bot.entity.onGround ? airSprint : sprinting;
      const state = new PlayerState(bot, { ...input(), sprint, sneak: crouchPose ? crouching : controls.sneak });
      physics.simulatePlayer(state, world).apply(bot);
    }
    api.physicsTicks++;
    if (bot.listenerCount('physicsTick') > 0) bot.emit('physicsTick');
    if (settling > 0) {
      settling--;
      const v = bot.entity.velocity;
      // A flyer settles hovering: once its vertical velocity has died away too.
      const resting = bot.entity.onGround || (abilities.flying && Math.abs(v.y) < 1e-3);
      const still = resting && Math.abs(v.x) < 1e-3 && Math.abs(v.z) < 1e-3 && !anyControl();
      stillTicks = still ? stillTicks + 1 : 0;
      if (stillTicks >= SETTLE_TICKS) {
        settling = 0;
        // Only the horizontal part: the vertical one is the resting value the game keeps (about
        // -0.078/tick). Zeroing it made the next simulated tick miss the ground (the move has no
        // downward part to collide), so the bot claimed to be in the air after every stop, which
        // anticheats see as a ground spoof and a movement that doesn't match theirs.
        v.x = 0;
        v.z = 0;
      }
    }
  };

  const updatePosition = (now: number): void => {
    if (bot.isAlive) deadTicks = 0;
    else if (deadTicks <= 20) deadTicks++;
    if (deadTicks >= 20) return; // only 20 ticks of updates after death
    const entity = bot.entity;
    if (!finite(entity.position)) return;

    const dYaw = deltaYaw(entity.yaw, lastSentYaw);
    const dPitch = entity.pitch - lastSentPitch;
    const maxYaw = (TICK_MS / 1000) * physics.yawSpeed;
    const maxPitch = (TICK_MS / 1000) * physics.pitchSpeed;
    lastSentYaw += Math.max(-maxYaw, Math.min(dYaw, maxYaw));
    lastSentPitch += Math.max(-maxPitch, Math.min(dPitch, maxPitch));
    if (pendingLook && Math.abs(deltaYaw(entity.yaw, lastSentYaw)) < 0.001 && Math.abs(entity.pitch - lastSentPitch) < 0.001) {
      pendingLook.resolve();
      pendingLook = null;
    }

    const yaw = Math.fround(conv.toNotchianYaw(lastSentYaw));
    const pitch = Math.fround(conv.toNotchianPitch(lastSentPitch));
    const p = entity.position;
    const onGround = entity.onGround;
    const moved = lastSent.x !== p.x || lastSent.y !== p.y || lastSent.z !== p.z ||
      Math.round((now - lastSent.time) / TICK_MS) * TICK_MS >= 1000;
    const looked = lastSent.yaw !== yaw || lastSent.pitch !== pitch;

    if (moved && looked) {
      sendPositionLook(p, yaw, pitch, onGround);
      lastSent.time = now;
    } else if (moved) {
      sendPosition(p, onGround);
      lastSent.time = now;
    } else if (looked) {
      sendLook(yaw, pitch, onGround);
    } else if (everyTick || onGround !== lastSent.onGround) {
      // ≤1.11 servers update health per movement packet, so the vanilla client sends one per tick.
      client.write('flying', { onGround, flags: { onGround, hasHorizontalCollision: undefined } });
    }
    lastSent.onGround = onGround;
    bot.world.setCenter(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4);
  };

  const tick = (): void => {
    inTick = true;
    try {
      tickBody();
    } finally {
      inTick = false;
    }
  };

  const tickBody = (): void => {
    if (!active || client.state !== 'play' || !bot.entity?.position) {
      tickQueue.length = 0;
      flushTickWaiters();
      return;
    }
    try {
      flushTickQueue();
      if (flightRequests.length > 0) applyFlightRequests();
      updateSprint();
      if (needsPhysics()) simulate();
      takeoff = false;
      crouching = controls.sneak && !abilities.flying;
      airSprint = sprinting;
      updatePosition(performance.now());
      idleInputTicks = anyControl() ? 0 : Math.min(idleInputTicks + 1, 100);
      if (tickEnd) client.write('tick_end', {});
      flushTickWaiters();
    } catch (err) {
      flushTickWaiters();
      // Reported (at most once a minute), not swallowed by the fleet ticker.
      const now = Date.now();
      if (now - lastErrorAt >= 60_000) {
        lastErrorAt = now;
        bot.emit('error', err as Error);
      }
    }
  };

  const subscribe = (): void => {
    if (!unsubscribe && !bot.isEnded) unsubscribe = fleetTicker.subscribe(tick);
  };

  // ── Server-driven position ──
  client.on('position', (packet: any) => {
    generation++; // a newer teleport supersedes a delayed answer to an older one
    const entity = bot.entity;
    entity.height = 1.8;
    const vel = entity.velocity;
    const pos = entity.position;
    const flag = (bit: number, name: string): boolean =>
      typeof packet.flags === 'object' ? Boolean(packet.flags[name]) : (packet.flags & bit) !== 0;
    vel.set(flag(1, 'x') ? vel.x : 0, flag(2, 'y') ? vel.y : 0, flag(4, 'z') ? vel.z : 0);
    pos.set(
      flag(1, 'x') ? pos.x + packet.x : packet.x,
      flag(2, 'y') ? pos.y + packet.y : packet.y,
      flag(4, 'z') ? pos.z + packet.z : packet.z,
    );
    const yaw = (flag(8, 'yaw') ? conv.toNotchianYaw(entity.yaw) : 0) + packet.yaw;
    const pitch = (flag(16, 'pitch') ? conv.toNotchianPitch(entity.pitch) : 0) + packet.pitch;
    entity.yaw = conv.fromNotchianYaw(yaw);
    entity.pitch = conv.fromNotchianPitch(pitch);
    entity.onGround = false;
    if (sf('teleportUsesOwnPacket')) client.write('teleport_confirm', { teleportId: packet.teleportId });
    bot.world.setCenter(Math.floor(pos.x) >> 4, Math.floor(pos.z) >> 4);

    const finish = (): void => {
      active = true;
      settling = MAX_SETTLE_TICKS;
      stillTicks = 0;
      // The yaw just echoed, unwrapped (entity.yaw is wrapped to 0–2π): the next rotation continues
      // from it instead of jumping by 360°.
      lastSentYaw = PI - (yaw * PI) / 180;
      lastSentPitch = entity.pitch;
      subscribe();
      bot.emit('forcedMove');
    };
    // Right after a respawn, answering at once gets "invalid move" kicks on older servers.
    if (respawnAt > 0 && Date.now() - respawnAt < 2000) {
      respawnAt = 0;
      const p = pos.clone();
      const onGround = entity.onGround;
      const gen = generation;
      setTimeout(() => {
        if (gen !== generation || bot.isEnded) return;
        sendPositionLook(p, yaw, pitch, onGround);
        finish();
      }, 1500).unref?.();
      return;
    }
    sendPositionLook(pos, yaw, pitch, entity.onGround);
    finish();
  });

  // What the server lets the bot do; it may start or stop the flight itself (e.g. /fly off).
  client.on('abilities', (packet: any) => {
    const next = parseAbilities(packet);
    if (sameAbilities(next, abilities)) return;
    if (next.flying !== abilities.flying) {
      settling = Math.max(settling, MAX_SETTLE_TICKS);
      stillTicks = 0;
    }
    Object.assign(abilities, next);
    emitAbilities();
  });

  // 1.21.3+
  client.on('player_rotation', (packet: any) => {
    bot.entity.yaw = conv.fromNotchianYaw(packet.yaw);
    bot.entity.pitch = conv.fromNotchianPitch(packet.pitch);
  });

  // Knockback on ourselves: only our own entity's velocity is decoded.
  bot.decoding.setFilter('entity_velocity', (buffer, offset) => readVarInt(buffer, offset)?.value === bot.entity?.id);
  client.on('entity_velocity', (packet: any) => {
    if (!bot.entity || packet.entityId !== bot.entity.id || !api.enabled) return;
    const v = packet.velocity ?? { x: packet.velocityX, y: packet.velocityY, z: packet.velocityZ };
    bot.entity.velocity.update(velocityInBlocks ? new Vec3(v.x, v.y, v.z) : conv.fromNotchVelocity(v));
    settling = Math.max(settling, 20 * 5);
  });
  client.on('explosion', (packet: any) => {
    if (!api.enabled || bot.game.gameMode === 'creative' || !bot.entity) return;
    const v = bot.entity.velocity;
    if (packet.playerKnockback) v.translate(packet.playerKnockback.x, packet.playerKnockback.y, packet.playerKnockback.z);
    if ('playerMotionX' in packet) v.translate(packet.playerMotionX, packet.playerMotionY, packet.playerMotionZ);
    settling = Math.max(settling, 20 * 5);
  });

  // The floor (or anything around the bot) changed: simulate until it settles again, so a bot whose
  // floor gets blown up falls instead of hovering where it was.
  bot.world.onBlockChange = (x, y, z) => {
    if (!active || !bot.entity?.position) return;
    if (touchesBot(bot.entity.position, x, y, z)) {
      settling = Math.max(settling, 20 * 10);
      stillTicks = 0;
    }
  };

  bot.on('death', () => {
    active = false;
    respawnAt = Date.now();
    flushTickWaiters();
    rejectFlightRequests('The bot died');
  });
  bot.on('respawn', () => {
    active = false;
    flushTickWaiters();
  });
  client.on('login', () => {
    active = false;
    generation++;
    flushTickWaiters();
    rejectFlightRequests('The bot joined another world');
    Object.assign(abilities, defaultAbilities());
    takeoff = false;
    bot.entity.position = new Vec3(0, 0, 0);
    bot.entity.velocity = new Vec3(0, 0, 0);
  });
  if (sf('hasConfigurationState'))
    client.on('start_configuration', () => {
      active = false;
      generation++;
      flushTickWaiters();
    });

  return api;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
