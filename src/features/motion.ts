// Movement (docs/design.md → Motion). Instead of simulating physics every tick for every bot,
// physics runs only while the bot settles after a teleport/knockback or while a control is held;
// otherwise the bot just reports its position the way an idle vanilla client does. Every bot shares
// the fleet ticker. Position-packet logic follows mineflayer's physics plugin.
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import * as conv from '../conv.js';
import { readVarInt } from '../decode.js';
import { fleetTicker, TICK_MS } from '../ticker.js';
import type { ControlState, ControlStates } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets and prismarine-physics are untyped */

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
  const physics = (bot.kit as any).sharedPhysics ?? ((bot.kit as any).sharedPhysics = Physics(bot.kit.registry, { getBlock: () => null }));
  const world = { getBlock: (pos: Vec3) => bot.blockAt(pos) };
  const everyTick = sf('positionUpdateSentEveryTick');

  const controls: ControlStates = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const lastSent = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, onGround: false, time: 0, flags: { onGround: false, hasHorizontalCollision: undefined as boolean | undefined } };
  let lastSentYaw = 0;
  let lastSentPitch = 0;
  let active = false; // like mineflayer's shouldUsePhysics: true once the server placed us
  let settling = 0; // ticks of settling left
  let stillTicks = 0;
  let deadTicks = 21;
  let unsubscribe: (() => void) | null = null;
  let pendingLook: { resolve: () => void } | null = null;
  let respawnAt = 0;

  const api: MotionApi = {
    enabled: physicsAllowed,
    controls,
    physicsTicks: 0,
    setControlState(control, state) {
      if (controls[control] === state) return;
      controls[control] = state;
      if (control === 'sprint') {
        client.write('entity_action', { entityId: bot.entity.id, actionId: state ? 3 : 4, jumpBoost: 0 });
      } else if (control === 'sneak') {
        client.write('entity_action', { entityId: bot.entity.id, actionId: state ? 0 : 1, jumpBoost: 0 });
      }
    },
    clearControlStates() {
      for (const key of Object.keys(controls) as ControlState[]) api.setControlState(key, false);
    },
    look(yaw, pitch, force) {
      if (!bot.entity) return Promise.resolve();
      bot.entity.yaw = yaw;
      bot.entity.pitch = pitch;
      if (force) {
        lastSentYaw = yaw;
        lastSentPitch = pitch;
        sendPositionLook(bot.entity.position, conv.toNotchianYaw(yaw), conv.toNotchianPitch(pitch), bot.entity.onGround);
        return Promise.resolve();
      }
      pendingLook?.resolve();
      return new Promise((resolve) => (pendingLook = { resolve }));
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      active = false;
    },
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

  const anyControl = (): boolean => controls.forward || controls.back || controls.left || controls.right || controls.jump;

  const needsPhysics = (): boolean => {
    if (!api.enabled || !physicsAllowed) return false;
    if (anyControl() || settling > 0) return true;
    const v = bot.entity.velocity;
    return Math.abs(v.x) > 1e-4 || Math.abs(v.y) > 1e-4 || Math.abs(v.z) > 1e-4;
  };

  const simulate = (): void => {
    if (bot.blockAt(bot.entity.position) === null) return; // chunk not here yet
    const entity = bot.entity as any;
    entity.effects ??= {};
    entity.attributes ??= {};
    const state = new PlayerState(bot, controls);
    physics.simulatePlayer(state, world).apply(bot);
    api.physicsTicks++;
    if (bot.listenerCount('physicsTick') > 0) bot.emit('physicsTick');
    if (settling > 0) {
      settling--;
      const v = bot.entity.velocity;
      const still = bot.entity.onGround && Math.abs(v.x) < 1e-3 && Math.abs(v.z) < 1e-3 && !anyControl();
      stillTicks = still ? stillTicks + 1 : 0;
      if (stillTicks >= SETTLE_TICKS) {
        settling = 0;
        v.set(0, 0, 0);
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
    if (pendingLook && Math.abs(deltaYaw(entity.yaw, lastSentYaw)) < 0.001) {
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
    if (!active || client.state !== 'play' || !bot.entity?.position) return;
    if (needsPhysics()) simulate();
    updatePosition(performance.now());
  };

  const subscribe = (): void => {
    if (!unsubscribe) unsubscribe = fleetTicker.subscribe(tick);
  };

  // ── Server-driven position ──
  client.on('position', (packet: any) => {
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
      lastSentYaw = entity.yaw;
      lastSentPitch = entity.pitch;
      subscribe();
      bot.emit('forcedMove');
    };
    // Right after a respawn, answering at once gets "invalid move" kicks on older servers.
    if (respawnAt > 0 && Date.now() - respawnAt < 2000) {
      respawnAt = 0;
      const p = pos.clone();
      const onGround = entity.onGround;
      setTimeout(() => {
        sendPositionLook(p, yaw, pitch, onGround);
        finish();
      }, 1500);
      return;
    }
    sendPositionLook(pos, yaw, pitch, entity.onGround);
    finish();
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
    bot.entity.velocity.update(conv.fromNotchVelocity(packet.velocity ?? { x: packet.velocityX, y: packet.velocityY, z: packet.velocityZ }));
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
  });
  bot.on('respawn', () => (active = false));
  client.on('login', () => {
    active = false;
    bot.entity.position = new Vec3(0, 0, 0);
    bot.entity.velocity = new Vec3(0, 0, 0);
  });
  if (sf('hasConfigurationState')) client.on('start_configuration', () => (active = false));

  return api;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
