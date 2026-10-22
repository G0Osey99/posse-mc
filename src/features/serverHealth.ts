// Server health as the bot sees it: ticks per second (from the server's time updates, which carry
// the world age once a second) and the round trip to the server.
import type { PosseBot } from '../bot.js';
import { packetNames } from '../decode.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */

/** Time updates kept (one a second): the TPS window. */
const SAMPLES = 12;

export interface TimeSample {
  age: number;
  at: number;
}

/**
 * Ticks per second from world-age samples: the age gained over the wall time between the oldest
 * sample and the newest one (or now, when updates stopped coming, so a frozen server reads low).
 * Null until the samples span 3 s.
 */
export function tpsFrom(samples: TimeSample[], now: number): number | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const end = now - last.at > 2_500 ? now : last.at;
  const seconds = (end - first.at) / 1000;
  if (seconds < 3) return null;
  const tps = (last.age - first.age) / seconds;
  return Math.round(Math.max(0, Math.min(20, tps)) * 100) / 100;
}

/** An i64 field as decoded (bigint, or [high, low] in older protodef) → bigint. */
function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (Array.isArray(value)) return (BigInt(value[0] as number) << 32n) | BigInt((value[1] as number) >>> 0);
  return BigInt(value as number);
}

export interface HealthStats {
  tps(): number | null;
  latency(): number | null;
  ping(timeout: number): Promise<number>;
}

export function installHealthStats(bot: PosseBot, now: () => number = Date.now): HealthStats {
  const client = bot._client as any;
  const samples: TimeSample[] = [];
  let measured: number | null = null;

  client.on('login', () => (samples.length = 0));
  client.on('update_time', (packet: any) => {
    const age = Number(packet.age);
    if (!Number.isFinite(age)) return;
    const last = samples[samples.length - 1];
    // A world change can reset the age: start over.
    if (last && age < last.age) samples.length = 0;
    samples.push({ age, at: now() });
    if (samples.length > SAMPLES) samples.shift();
  });

  const canPing = packetNames(bot.version, 'play', 'toServer').includes('ping_request');
  const pending = new Map<bigint, (ms: number) => void>();
  if (canPing) {
    client.on('ping_response', (packet: any) => {
      const id = toBigInt(packet.id);
      pending.get(id)?.(Number(id));
    });
  }
  let nextId = 0n;

  const tabLatency = (): number | null => bot.players[bot.username]?.ping ?? null;

  return {
    tps: () => tpsFrom(samples, now()),
    latency: () => measured ?? tabLatency(),
    ping(timeout) {
      if (!canPing) {
        const ms = tabLatency();
        return ms === null ? Promise.reject(new Error('No latency known yet')) : Promise.resolve(ms);
      }
      if (client.state !== 'play') return Promise.reject(new Error('Not in the game'));
      const id = ++nextId;
      const sent = performance.now();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Ping timed out after ${timeout}ms`));
        }, timeout);
        timer.unref?.();
        pending.set(id, () => {
          clearTimeout(timer);
          pending.delete(id);
          measured = Math.round(performance.now() - sent);
          resolve(measured);
        });
        client.write('ping_request', { id });
      });
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
