// A Velocity proxy in front of two vanilla servers (hub and game), like the networks bots join:
// checks that the world, the time, the inventory and item pickup still work after `/server game`, which on
// 1.20.2+ sends the client back through the configuration state.
//
//   tsx bench/live-proxy.ts --accept-eula [--versions 26.1] [--velocity 4.3.0] [--verbose]
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createBot, type PosseBot } from '../src/index.js';
import { startVanilla, type VanillaServer } from './vanilla.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- remote JSON */
const UA = { 'User-Agent': 'posse-mc bench (github.com/G0Osey99/posse-mc)' };

async function velocityJar(version: string, dir: string): Promise<string> {
  const res = await fetch(`https://fill.papermc.io/v3/projects/velocity/versions/${version}/builds/latest`, { headers: UA });
  if (!res.ok) throw new Error(`velocity ${version}: ${res.status}`);
  const d = ((await res.json()) as any).downloads['server:default'];
  const file = path.join(dir, 'jars', d.name);
  if (existsSync(file)) return file;
  const bytes = Buffer.from(await (await fetch(d.url, { headers: UA })).arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== d.checksums.sha256) throw new Error(`${d.name} failed its sha256 check`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}

interface Proxy {
  port: number;
  stop(): Promise<void>;
}

async function startVelocity(jar: string, dir: string, servers: Record<string, number>, log: (l: string) => void): Promise<Proxy> {
  const cwd = path.join(dir, 'servers', 'velocity');
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });
  const port = 25_000 + Math.floor(Math.random() * 5000);
  const run = (until: RegExp): Promise<{ stop(): Promise<void> }> =>
    new Promise((resolve, reject) => {
      const child = spawn('java', ['-Xmx512M', '-jar', jar], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise<void>((r) => child.on('exit', () => r()));
      let buf = '';
      const onData = (c: Buffer): void => {
        buf += c.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          log(line);
          if (until.test(line)) resolve({ stop: async () => (child.stdin!.write('end\n'), await exited) });
        }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.on('exit', (code) => reject(new Error(`velocity exited (${code})`)));
    });
  // The first start writes velocity.toml; then it's pointed at the two servers.
  await (await run(/Done \(/)).stop();
  const file = path.join(cwd, 'velocity.toml');
  let toml = await readFile(file, 'utf8');
  toml = toml
    .replace(/^bind = .*$/m, `bind = "127.0.0.1:${port}"`)
    .replace(/^online-mode = .*$/m, 'online-mode = false')
    .replace(/^force-key-authentication = .*$/m, 'force-key-authentication = false')
    .replace(/^player-info-forwarding-mode = .*$/m, 'player-info-forwarding-mode = "none"')
    .replace(/\[servers\][\s\S]*?\ntry = \[[\s\S]*?\]/, `[servers]\n${Object.entries(servers).map(([n, p]) => `${n} = "127.0.0.1:${p}"`).join('\n')}\ntry = ["${Object.keys(servers)[0]}"]`)
    .replace(/\[forced-hosts\][\s\S]*?(?=\n\[)/, '[forced-hosts]\n');
  await writeFile(file, toml);
  const proxy = await run(/Done \(/);
  return { port, stop: proxy.stop };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const count = (bot: PosseBot, name: string): number =>
  bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);

/** World, inventory and pickup on the server the bot is on now. */
async function check(bot: PosseBot, server: VanillaServer, name: string, label: string): Promise<string[]> {
  const failures: string[] = [];
  const step = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      console.log(`    ✓ ${label}: ${what}`);
    } catch (err) {
      failures.push(`${label}: ${what}: ${(err as Error).message}`);
      console.log(`    ✗ ${label}: ${what}: ${(err as Error).message}`);
    }
  };
  await step('blocks under the bot', () => until('the ground', () => {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    return !!below && below.name !== 'air';
  }));
  await step('the time of day', async () => {
    server.command('time set 1000');
    await until('day time 1000', () => Math.abs(bot.time.timeOfDay - 1000) < 200);
  });
  await step('given items arrive in the inventory', async () => {
    const before = count(bot, 'stick');
    server.command(`give ${name} minecraft:stick 3`);
    await until('3 sticks', () => count(bot, 'stick') >= before + 3);
  });
  await step('an item dropped at its feet is picked up', async () => {
    const before = count(bot, 'diamond');
    const p = bot.entity.position;
    server.command(`summon minecraft:item ${p.x.toFixed(2)} ${(p.y + 0.5).toFixed(2)} ${p.z.toFixed(2)} {Item:{id:"minecraft:diamond",count:1},PickupDelay:0}`);
    await until('a diamond', () => count(bot, 'diamond') > before);
  });
  return failures;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opt = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!argv.includes('--accept-eula')) {
    console.error('Pass --accept-eula to run vanilla servers (you accept the Minecraft EULA: https://aka.ms/MinecraftEULA).');
    process.exit(2);
  }
  const verbose = argv.includes('--verbose');
  const dir = path.resolve(opt('dir') ?? '.vanilla');
  const velocity = opt('velocity') ?? '4.3.0';
  let failed = 0;
  for (const version of (opt('versions') ?? '26.1').split(',')) {
    console.log(version);
    const log = (prefix: string) => (l: string) => verbose && console.log(`  [${prefix}] ${l}`);
    const hub = await startVanilla({ version, dir, acceptEula: true, name: `proxy-hub-${version}`, log: log('hub') });
    const game = await startVanilla({ version, dir, acceptEula: true, name: `proxy-game-${version}`, log: log('game'), properties: { 'level-seed': 'game' } });
    const proxy = await startVelocity(await velocityJar(velocity, dir), dir, { hub: hub.port, game: game.port }, log('velocity'));
    const name = 'PosseProxy';
    const bot = createBot({ host: '127.0.0.1', port: proxy.port, username: name, auth: 'offline', version, hideErrors: false });
    bot.on('error', (err) => console.log(`  [bot] error: ${err.message}`));
    bot.on('kicked', (reason) => console.log(`  [bot] kicked: ${JSON.stringify(reason)}`));
    try {
      await new Promise<void>((resolve, reject) => {
        bot.once('spawn', () => resolve());
        bot.once('end', (r) => reject(new Error(`ended: ${r}`)));
      });
      const failures = await check(bot, hub, name, 'hub');
      let logins = 0;
      bot.on('login', () => logins++);
      bot.chat('/server game');
      await until('the game server login', () => logins > 0, 20_000);
      await sleep(1000);
      failures.push(...(await check(bot, game, name, 'game')));
      failed += failures.length;
    } catch (err) {
      failed++;
      console.log(`  ✗ ${(err as Error).message}`);
    } finally {
      bot.quit();
      await proxy.stop();
      await Promise.all([hub.stop(), game.stop()]);
    }
  }
  console.log(failed === 0 ? 'all passed' : `${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
