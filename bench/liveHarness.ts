// Runs scenarios against a real vanilla server (bench/vanilla.ts) on each version: a bot joins,
// is made operator, and each scenario sets the world up through the console and checks the bot.
//
//   tsx bench/live-features.ts --accept-eula [--versions 1.21.4,1.12.2] [--dir ./.vanilla] [--only dig,place]
//
// --accept-eula means you accept the Minecraft EULA (https://aka.ms/MinecraftEULA).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createBot, type PosseBot } from '../src/index.js';
import { startVanilla, type VanillaOptions, type VanillaServer } from './vanilla.js';
import { grimJar, paperJar, parseGrimFlag, type GrimFlag } from './paperGrim.js';

const DEFAULT_VERSIONS = ['1.8.9', '1.12.2', '1.16.5', '1.20.4', '1.21.4', '26.1'];

export interface LiveContext {
  bot: PosseBot;
  server: VanillaServer;
  version: string;
  cmd: Commands;
  /** The block the bot stands on at the start (scenarios build around it). */
  base: Vec3;
  sleep(ms: number): Promise<void>;
  waitFor(check: () => boolean, timeoutMs?: number, what?: string): Promise<void>;
  item(name: string): number;
  block(name: string): number;
  log(msg: string): void;
}

/** Console commands across versions (the syntax changed in 1.13). */
export class Commands {
  readonly modern: boolean;
  constructor(
    private readonly server: VanillaServer,
    readonly version: string,
    private readonly name: string,
  ) {
    this.modern = !/^1\.(8|9|10|11|12)\./.test(`${version}.`);
  }
  run(cmd: string): void {
    this.server.command(cmd);
  }
  give(item: string, count = 1, data = 0): void {
    this.run(this.modern ? `give ${this.name} minecraft:${item} ${count}` : `give ${this.name} minecraft:${item} ${count} ${data}`);
  }
  setblock(p: Vec3, block: string): void {
    this.run(`setblock ${p.x} ${p.y} ${p.z} minecraft:${block}`);
  }
  fill(a: Vec3, b: Vec3, block: string): void {
    this.run(`fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} minecraft:${block}`);
  }
  tp(p: Vec3): void {
    this.run(`tp ${this.name} ${p.x} ${p.y} ${p.z}`);
  }
  clear(): void {
    this.run(`clear ${this.name}`);
  }
  levels(n: number): void {
    this.run(this.modern ? `xp add ${this.name} ${n} levels` : `xp ${n}L ${this.name}`);
  }
  gamemode(mode: 'survival' | 'creative'): void {
    this.run(this.modern ? `gamemode ${mode} ${this.name}` : `gamemode ${mode === 'survival' ? 0 : 1} ${this.name}`);
  }
  effect(effect: string, seconds: number, amplifier: number): void {
    this.run(this.modern ? `effect give ${this.name} minecraft:${effect} ${seconds} ${amplifier}` : `effect ${this.name} minecraft:${effect} ${seconds} ${amplifier}`);
  }
}

export type Scenario = (ctx: LiveContext) => Promise<void>;

export interface ScenarioResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

function args(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function connect(server: VanillaServer, username: string, extra: Record<string, unknown> = {}): Promise<PosseBot> {
  const bot = createBot({
    host: '127.0.0.1',
    port: server.port,
    username,
    auth: 'offline',
    version: server.version,
    entities: 'all',
    hideErrors: false,
    ...extra,
  });
  bot.on('error', (err) => console.log(`  [${username}] error: ${err.message}`));
  if (process.env.POSSE_TRACE_MOVES) {
    const c = bot._client as any;
    const write = c.write.bind(c);
    c.write = (name: string, p: any) => {
      if (/^(position|position_look|look|flying|entity_action)$/.test(name)) {
        const k = Object.entries((bot as any).motion?.controls ?? {}).filter(([, v]) => v).map(([n]) => n[0]).join('');
        console.log(`  [${Date.now() % 100000}] ${name} ${p.x?.toFixed(4) ?? ''} ${p.y?.toFixed(4) ?? ''} ${p.z?.toFixed(4) ?? ''} ${p.yaw !== undefined ? `yaw ${p.yaw.toFixed(2)}` : ''} ${p.onGround ?? ''} ${p.actionId ?? ''} keys ${k} v ${bot.entity.velocity.x.toFixed(3)},${bot.entity.velocity.y.toFixed(3)},${bot.entity.velocity.z.toFixed(3)}`);
      }
      write(name, p);
    };
  }
  if (process.env.POSSE_TRACE_PLACE) {
    const c = bot._client as any;
    const write = c.write.bind(c);
    let after = 0;
    c.write = (name: string, p: any) => {
      if (name === 'block_place') {
        console.log(`  [place] ${JSON.stringify(p.location)} dir ${p.direction} cursor ${p.cursorX},${p.cursorY},${p.cursorZ} at ${bot.entity.position} eye ${(bot.entity as any).eyeHeight} yaw ${bot.entity.yaw.toFixed(3)} pitch ${bot.entity.pitch.toFixed(3)}`);
        after = 2;
      } else if (after > 0 && /position|look|flying/.test(name)) {
        console.log(`  [after] ${name} ${p.x?.toFixed(3) ?? ''} ${p.y?.toFixed(3) ?? ''} ${p.z?.toFixed(3) ?? ''} yaw ${p.yaw?.toFixed(2) ?? '-'} pitch ${p.pitch?.toFixed(2) ?? '-'}`);
        after--;
      }
      write(name, p);
    };
  }
  if (process.env.POSSE_DEBUG) bot.pathfinder.debug = (m) => console.log(`[pathfinder] ${m}`);
  bot.on('kicked', (reason) => console.log(`  [${username}] kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('spawn timed out')), 60_000);
    bot.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
    bot.once('end', (reason) => reject(new Error(`ended before spawn: ${reason}`)));
  });
  // Wait until the bot stands on loaded ground.
  for (let i = 0; i < 100 && (!bot.entity.onGround || !bot.blockAt(bot.entity.position.offset(0, -1, 0))); i++) await sleep(100);
  return bot;
}

export async function runScenarios(
  version: string,
  scenarios: Record<string, Scenario>,
  options: { dir: string; only?: string[]; flat?: boolean; verbose?: boolean; botOptions?: Record<string, unknown>; scenarioTimeout?: number; grim?: boolean },
): Promise<ScenarioResult[]> {
  // With --grim: Paper plus GrimAC, and every flag Grim prints fails the scenario it came in.
  const flags: GrimFlag[] = [];
  let server: VanillaServer;
  const log = (l: string): void => {
    const flag = options.grim ? parseGrimFlag(l) : null;
    if (flag) flags.push(flag);
    if (options.verbose || flag) console.log(`  [server] ${l}`);
  };
  const base: VanillaOptions = { version, dir: options.dir, acceptEula: true, flat: options.flat ?? true, log };
  if (options.grim) {
    const [paper, grim] = await Promise.all([paperJar(version, options.dir), grimJar(version, options.dir)]);
    console.log(`  ${path.basename(paper)} + GrimAC ${grim.version}`);
    server = await startVanilla({ ...base, jar: paper, plugins: [grim.file], name: `paper-grim-${version}` });
    // Every violation, not just the ones past the alert threshold.
    const config = path.join(options.dir, 'servers', `paper-grim-${version}`, 'plugins', 'GrimAC', 'config.yml');
    await writeFile(config, (await readFile(config, 'utf8')).replace(/verbose:\n(\s+)print-to-console: false/, 'verbose:\n$1print-to-console: true'));
    await server.run('grim reload', /reload/i, 15_000).catch(() => undefined);
  } else {
    server = await startVanilla(base);
  }
  const results: ScenarioResult[] = [];
  const name = 'PosseLive';
  let bot: PosseBot | null = null;
  try {
    server.command('gamerule doDaylightCycle false');
    server.command('gamerule doMobSpawning false');
    server.command('gamerule doWeatherCycle false');
    server.command('gamerule sendCommandFeedback false');
    server.command('time set day');
    bot = await connect(server, name, options.botOptions);
    await server.run(`op ${name}`, /Made .* a server operator|Opped|already/i).catch(() => undefined);
    const cmd = new Commands(server, version, name);
    const home = bot.entity.position.floored();
    const registry = bot.registry as unknown as { itemsByName: Record<string, { id: number }>; blocksByName: Record<string, { id: number }> };
    for (const [scenarioName, scenario] of Object.entries(scenarios)) {
      if (options.only && !options.only.includes(scenarioName)) continue;
      const start = Date.now();
      cmd.clear();
      cmd.gamemode('survival');
      cmd.tp(home.offset(0.5, 0, 0.5));
      await sleep(300);
      for (let i = 0; i < 40 && !(bot.entity.onGround && bot.entity.position.floored().equals(home)); i++) await sleep(100);
      const base = home.offset(0, -1, 0);
      const ctx: LiveContext = {
        bot,
        server,
        version,
        cmd,
        base,
        sleep,
        waitFor: async (check, timeoutMs = 5000, what = 'condition') => {
          const until = Date.now() + timeoutMs;
          while (!check()) {
            if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
            await sleep(50);
          }
        },
        item: (n) => {
          const id = registry.itemsByName[n]?.id;
          if (id === undefined) throw new Error(`no item ${n}`);
          return id;
        },
        block: (n) => {
          const id = registry.blocksByName[n]?.id;
          if (id === undefined) throw new Error(`no block ${n}`);
          return id;
        },
        log: (m) => options.verbose && console.log(`    ${m}`),
      };
      const flagsBefore = flags.length;
      try {
        await Promise.race([scenario(ctx), sleep(options.scenarioTimeout ?? 240_000).then(() => Promise.reject(new Error('scenario timed out')))]);
        await sleep(options.grim ? 1000 : 0); // late alerts
        const raised = flags.slice(flagsBefore);
        if (raised.length) throw new Error(`Grim flagged ${[...new Set(raised.map((f) => f.check))].join(', ')} (${raised.length}×)`);
        results.push({ name: scenarioName, ok: true, ms: Date.now() - start });
        console.log(`  ✓ ${scenarioName} (${Date.now() - start} ms)`);
      } catch (err) {
        results.push({ name: scenarioName, ok: false, ms: Date.now() - start, error: (err as Error).message });
        console.log(`  ✗ ${scenarioName}: ${(err as Error).message}`);
      }
      if (bot.currentWindow) await bot.closeWindow(bot.currentWindow).catch(() => undefined);
      if (bot.isEnded) {
        console.log('  bot disconnected; reconnecting');
        bot = await connect(server, name, options.botOptions);
        ctx.bot = bot;
      }
    }
  } finally {
    bot?.quit();
    await server.stop();
  }
  return results;
}

export async function main(scenarios: Record<string, Scenario>, defaults: { flat?: boolean } = {}): Promise<void> {
  const a = args();
  if (!a['accept-eula']) {
    console.error('Pass --accept-eula to run a vanilla server (you accept the Minecraft EULA: https://aka.ms/MinecraftEULA).');
    process.exit(2);
  }
  const versions = typeof a.versions === 'string' ? a.versions.split(',') : DEFAULT_VERSIONS;
  const dir = typeof a.dir === 'string' ? a.dir : '.vanilla';
  const only = typeof a.only === 'string' ? a.only.split(',') : undefined;
  const grim = Boolean(a.grim);
  let failed = 0;
  for (const version of versions) {
    console.log(`${version}`);
    try {
      const results = await runScenarios(version, scenarios, { dir, only, flat: defaults.flat, verbose: Boolean(a.verbose), grim });
      failed += results.filter((r) => !r.ok).length;
    } catch (err) {
      failed++;
      console.log(`  ✗ ${version}: ${(err as Error).message}`);
    }
  }
  console.log(failed === 0 ? 'all passed' : `${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
