// Walking while turning: each tick's movement has to use the rotation that tick's packet carries
// (anticheats replay it with that rotation: Grim's Simulation flagged the bot when the physics used
// the look it was still turning to).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServer, type FakeServer } from '../bench/fakeServer.js';
import { createBot, type PosseBot } from '../src/index.js';

const VERSION = '1.21.4';
/** Ground friction × 0.91 for an ordinary block (what's left of the velocity after a tick). */
const GROUND = 0.6 * 0.91;

interface Sent {
  x: number;
  y: number;
  z: number;
  yaw: number;
  onGround: boolean;
}

describe('motion while turning', () => {
  let server: FakeServer;
  let bot: PosseBot;
  const sent: Sent[] = [];

  beforeAll(async () => {
    server = await startFakeServer({ version: VERSION, port: 0, chunkRadius: 2, entities: 0 });
    bot = createBot({ host: '127.0.0.1', port: server.port, username: 'TurnBot', auth: 'offline', version: VERSION });
    await new Promise<void>((resolve, reject) => {
      bot.once('spawn', () => resolve());
      bot.once('end', (r: string) => reject(new Error(`ended: ${r}`)));
    });
    for (let i = 0; i < 100 && !bot.entity.onGround; i++) await new Promise((r) => setTimeout(r, 50));
    const client = bot._client as unknown as { write: (n: string, p: Record<string, unknown>) => void };
    const write = client.write.bind(client);
    let yaw = 0;
    client.write = (n, p) => {
      if (n === 'look' || n === 'position_look') yaw = p.yaw as number;
      if (n === 'position' || n === 'position_look') sent.push({ x: p.x as number, y: p.y as number, z: p.z as number, yaw, onGround: (p.flags as { onGround: boolean } | undefined)?.onGround ?? (p.onGround as boolean) });
      write(n, p);
    };
  }, 30_000);

  afterAll(async () => {
    bot?.quit();
    await server?.close();
  });

  it('moves along the yaw it sends', async () => {
    // Face one way, walk, and turn right round: the sent look turns at the game's speed over
    // several ticks while the target look is already the new one.
    await bot.look(0, 0, true);
    bot.setControlState('forward', true);
    await new Promise((r) => setTimeout(r, 400));
    sent.length = 0;
    void bot.look(Math.PI, 0, false);
    await new Promise((r) => setTimeout(r, 700));
    void bot.look(Math.PI / 2, 0, false);
    await new Promise((r) => setTimeout(r, 700));
    void bot.look(-Math.PI / 4, 0, false);
    await new Promise((r) => setTimeout(r, 700));
    bot.setControlState('forward', false);

    let checked = 0;
    for (let i = 2; i < sent.length; i++) {
      const [a, b, c] = [sent[i - 2]!, sent[i - 1]!, sent[i]!];
      // Flat ground both ticks (no step, no fall): v = previous move × friction + this tick's push.
      if (!a.onGround || !b.onGround || !c.onGround || a.y !== b.y || b.y !== c.y) continue;
      // The carried velocity, with each axis under 0.003 zeroed as the game does (before 1.21.5).
      const carry = (d: number): number => (Math.abs(d * GROUND) < 0.003 ? 0 : d * GROUND);
      const ax = c.x - b.x - carry(b.x - a.x);
      const az = c.z - b.z - carry(b.z - a.z);
      if (Math.hypot(ax, az) < 0.05) continue; // a collision ate the push
      // The game's forward: x = -sin(yaw), z = cos(yaw), yaw in degrees.
      const r = (c.yaw * Math.PI) / 180;
      const off = Math.atan2(ax * Math.cos(r) + az * Math.sin(r), -ax * Math.sin(r) + az * Math.cos(r));
      expect(Math.abs(off)).toBeLessThan(0.01);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  }, 20_000);
});
