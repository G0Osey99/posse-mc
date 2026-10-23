// Fishing: cast, wait for a bite, reel in. Bites are seen the way the game shows them: a burst of
// six bubble/fishing particles at the bobber. The bot's own bobber is tracked while it fishes (its
// spawn is watched and its movement decoded), and particle packets are only decoded during a cast.
// Follows mineflayer's fishing plugin (MIT).
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import type { Entity, SpawnInfo } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */

/** Particles in the bite burst (1 + bobber width × 20 in every version). */
const BITE_PARTICLES = 6;
/** How far (blocks, horizontally) from the tracked bobber the burst may be (the tracked position lags a little). */
const BITE_RADIUS = 2;
/** How long after a cast the bobber must have appeared. */
const BOBBER_SPAWN_MS = 3000;

/** Steepest cast considered (degrees above or below level). */
const MAX_CAST_PITCH = 60;
/** How far off a cast may land and still count as aimed (blocks). */
const CAST_TOLERANCE = 0.3;
const MAX_FLIGHT_TICKS = 120;

export interface FishOptions {
  /**
   * Aim the cast to land here (e.g. a water block's top centre): the bot turns to the angle the
   * bobber's flight needs first. Rejects when it's out of reach.
   */
  at?: Vec3;
  /** Give up (reel in) after this many ms without a bite; 0 waits forever (default). */
  timeout?: number;
  /** Aborting reels in and rejects with the signal's reason. */
  signal?: AbortSignal;
}

export interface FishingApi {
  fish(options?: FishOptions): Promise<void>;
  /** The bot's bobber while it fishes, else null. */
  readonly bobber: Entity | null;
}

/**
 * Where a cast lands, as the horizontal distance from the eye when the bobber comes down to `dy`
 * below/above the eye, for a pitch in degrees (the game's sign: positive looks down). Mirrors the
 * game's bobber: before 1.12 it leaves at 1.5 blocks/tick along the look and falls 0.04/tick after
 * moving; from 1.12 it leaves 0.3 blocks ahead at 0.6·cos(pitch) + 0.5 horizontally (the vertical
 * part scaled by −tan(pitch)) and falls 0.03/tick before moving; both keep 92 % a tick in the air.
 * Null when it never comes down to `dy`.
 */
export function castLanding(pitchDeg: number, dy: number, legacy: boolean): number | null {
  const p = (pitchDeg * Math.PI) / 180;
  let x = legacy ? 0 : 0.3;
  let y = legacy ? -0.1 : 0;
  let vx: number;
  let vy: number;
  if (legacy) {
    vx = 1.5 * Math.cos(p);
    vy = -1.5 * Math.sin(p);
  } else {
    const scale = 0.6 * Math.cos(p) + 0.5;
    vx = scale;
    vy = Math.max(-5, Math.min(5, -Math.tan(p))) * scale;
  }
  for (let t = 0; t < MAX_FLIGHT_TICKS; t++) {
    if (!legacy) vy -= 0.03;
    const nx = x + vx;
    const ny = y + vy;
    if (vy < 0 && ny <= dy) return x + ((nx - x) * (y - dy)) / (y - ny);
    x = nx;
    y = ny;
    if (legacy) vy -= 0.04;
    vx *= 0.92;
    vy *= 0.92;
  }
  return null;
}

/**
 * The look (Posse's radians: yaw, pitch up-positive) that lands a cast from `eye` on `target`, or
 * null when it's out of reach. Of the angles that land close enough, the steepest wins: it drops
 * into small holes instead of skimming into their edge.
 */
export function castAngles(eye: Vec3, target: Vec3, legacy: boolean): { yaw: number; pitch: number } | null {
  const dx = target.x - eye.x;
  const dz = target.z - eye.z;
  const distance = Math.hypot(dx, dz);
  const dy = target.y - eye.y;
  let best: { pitch: number; error: number } | null = null;
  for (let deg = -MAX_CAST_PITCH; deg <= MAX_CAST_PITCH; deg += 0.25) {
    const landing = castLanding(deg, dy, legacy);
    if (landing === null) continue;
    const error = Math.abs(landing - distance);
    if (error <= CAST_TOLERANCE) {
      best = { pitch: deg, error };
      break; // the first (steepest upward) angle that lands
    }
    if (!best || error < best.error) best = { pitch: deg, error };
  }
  if (!best || best.error > CAST_TOLERANCE * 2) return null;
  return { yaw: Math.atan2(-dx, -dz), pitch: (-best.pitch * Math.PI) / 180 };
}

/** Names of the particles a bite bursts into (`wake` before 1.13, `fishing` after; `bubble` in both). */
const BITE_NAMES = new Set(['bubble', 'fishing', 'wake']);

/** Whether a decoded `world_particles` packet is a bite at `bobber`. */
export function isBiteParticle(packet: any, particleName: (packet: any) => string | undefined, bobber: { x: number; z: number }): boolean {
  const count = packet.amount ?? packet.particles;
  if (count !== BITE_PARTICLES) return false;
  const name = particleName(packet);
  if (!name || !BITE_NAMES.has(name)) return false;
  return Math.hypot(Number(packet.x) - bobber.x, Number(packet.z) - bobber.z) <= BITE_RADIUS;
}

export function installFishing(bot: PosseBot): FishingApi {
  const client = bot._client as any;
  const registry = bot.registry as any;
  const particleNames = new Map<number, string>();
  for (const p of registry.particlesArray ?? []) particleNames.set(p.id, p.name);
  const particleName = (packet: any): string | undefined => {
    const particle = packet.particle;
    if (particle && typeof particle === 'object') {
      const type = particle.type ?? particle.particleId;
      return typeof type === 'string' ? type.replace(/^minecraft:/, '') : particleNames.get(Number(type));
    }
    return particleNames.get(Number(packet.particleId));
  };

  let bobber: Entity | null = null;
  let cancel: ((err: Error) => void) | null = null;

  const legacyCast = bot.registry.version['<']('1.12');

  const fish = async (options: FishOptions = {}): Promise<void> => {
    cancel?.(new Error('Fishing cancelled: fish() was called again'));
    if (options.at) {
      const eye = bot.entity.position.offset(0, (bot.entity as Entity & { eyeHeight?: number }).eyeHeight ?? 1.62, 0);
      const look = castAngles(eye, options.at, legacyCast);
      if (!look) throw new Error(`Fishing: ${options.at} is out of casting reach`);
      await bot.look(look.yaw, look.pitch, true);
    }
    // The server casts along the last rotation it got: a look set just before must go out first.
    await bot.afterTick();
    return new Promise<void>((resolve, reject) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const undo: (() => void)[] = [];
      let done = false;

      const finish = (err: Error | null, reel: boolean): void => {
        if (done) return;
        done = true;
        for (const t of timers) clearTimeout(t);
        for (const u of undo) u();
        cancel = null;
        if (reel && bobber) bot.activateItem();
        bobber = null;
        if (err) reject(err);
        else resolve();
      };
      cancel = (err) => finish(err, true);

      if (options.signal?.aborted) {
        finish(options.signal.reason instanceof Error ? options.signal.reason : new Error('Fishing aborted'), false);
        return;
      }
      if (options.signal) {
        const onAbort = (): void => finish(options.signal!.reason instanceof Error ? options.signal!.reason : new Error('Fishing aborted'), true);
        options.signal.addEventListener('abort', onAbort, { once: true });
        undo.push(() => options.signal!.removeEventListener('abort', onAbort));
      }

      // The bobber: the fishing_bobber whose owner (the spawn's data) is this bot.
      const onSpawn = (spawn: SpawnInfo): void => {
        if (bobber || (spawn.data !== undefined && spawn.data !== bot.entity?.id)) return;
        if (spawn.data === undefined && bot.entity && bot.entity.position.distanceTo(spawn.position) > 4) return;
        let entity = bot.entities[spawn.id];
        if (!entity) {
          entity = new bot.kit.Entity(spawn.id) as Entity;
          entity.type = 'projectile' as Entity['type'];
          entity.name = 'fishing_bobber';
          entity.position = new Vec3(spawn.position.x, spawn.position.y, spawn.position.z);
          // Tracked from here on: its movement packets are decoded and it is dropped when destroyed.
          bot.entities[spawn.id] = entity;
        }
        bobber = entity;
      };
      undo.push(bot.watchSpawns(['fishing_bobber'], onSpawn));

      const onParticles = (packet: any): void => {
        if (bobber && isBiteParticle(packet, particleName, bobber.position)) finish(null, true);
      };
      client.on('world_particles', onParticles);
      undo.push(() => client.removeListener('world_particles', onParticles));

      const onGone = (entity: Entity): void => {
        if (entity === bobber) {
          bobber = null;
          finish(new Error('Fishing cancelled: the bobber is gone'), false);
        }
      };
      bot.on('entityGone', onGone);
      undo.push(() => bot.removeListener('entityGone', onGone));

      timers.push(
        setTimeout(() => {
          if (!bobber) finish(new Error('Fishing failed: no bobber appeared (hold a fishing rod)'), false);
        }, BOBBER_SPAWN_MS),
      );
      if (options.timeout && options.timeout > 0) {
        timers.push(setTimeout(() => finish(new Error('Fishing timed out without a bite'), true), options.timeout));
      }

      bot.activateItem();
    });
  };

  return {
    fish,
    get bobber() {
      return bobber;
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
