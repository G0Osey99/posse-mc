// Fleet benchmark: N bots of mineflayer or Posse against the fake server (run in a child process
// so its CPU is not counted), measuring this process's CPU, event-loop delay and memory.
//
//   tsx bench/bench.ts --client mineflayer|posse --bots 30 --version 1.18.2 --seconds 60
//     [--entities 60] [--chunk-radius 8] [--stagger-ms 200] [--settle 5] [--profile] [--out <dir>]
//     [--honor-view-distance] [--json]
import { fork, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from 'node:inspector';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { loadMineflayer, loadPosse, type BenchBot, type BotFactory } from './clients.js';
import {
  formatSummary,
  summarizeProfile,
  type CpuProfile,
  type ProfileSummary,
} from './cpuProfile.js';
import type { FakeServerStats } from './fakeServer.js';

interface Args {
  client: 'mineflayer' | 'posse';
  bots: number;
  version: string;
  seconds: number;
  entities: number;
  chunkRadius: number;
  staggerMs: number;
  settle: number;
  profile: boolean;
  out: string;
  honorViewDistance: boolean;
  flushPerPacket: boolean;
  json: boolean;
  joinTimeout: number;
}

function parseArgs(argv: string[]): Args {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    raw[key] = next === undefined || next.startsWith('--') ? 'true' : argv[++i];
  }
  const client = (raw.client ?? 'mineflayer') as Args['client'];
  if (client !== 'mineflayer' && client !== 'posse')
    throw new Error('--client must be mineflayer or posse');
  return {
    client,
    bots: Number(raw.bots ?? 10),
    version: raw.version ?? '1.18.2',
    seconds: Number(raw.seconds ?? 60),
    entities: Number(raw.entities ?? 60),
    chunkRadius: Number(raw['chunk-radius'] ?? 8),
    staggerMs: Number(raw['stagger-ms'] ?? 200),
    settle: Number(raw.settle ?? 5),
    profile: raw.profile === 'true',
    out: raw.out ?? join(tmpdir(), 'posse-bench'),
    honorViewDistance: raw['honor-view-distance'] === 'true',
    flushPerPacket: raw['flush-per-packet'] === 'true',
    json: raw.json === 'true',
    joinTimeout: Number(raw['join-timeout'] ?? 120),
  };
}

// ---- re-exec with --expose-gc ----------------------------------------------------------------

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  const script = fileURLToPath(import.meta.url);
  const r = spawnSync(
    process.execPath,
    ['--expose-gc', '--import', 'tsx', script, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
    },
  );
  process.exit(r.status ?? 1);
}

// ---- helpers ---------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mb = (n: number): number => Math.round((n / 1024 / 1024) * 10) / 10;
const r1 = (n: number): number => Math.round(n * 10) / 10;

function fullGc(): void {
  // Two passes: the first frees, the second collects what finalizers released.
  gc?.();
  gc?.();
}

interface ServerHandle {
  child: ChildProcess;
  port: number;
  version: string;
  request(type: 'stats'): Promise<FakeServerStats>;
  send(type: 'reset' | 'close'): void;
}

function startServerChild(a: Args): Promise<ServerHandle> {
  const script = fileURLToPath(new URL('./fakeServer.ts', import.meta.url));
  const args = [
    '--version',
    a.version,
    '--port',
    '0',
    '--chunk-radius',
    String(a.chunkRadius),
    '--entities',
    String(a.entities),
    '--quiet',
    ...(a.honorViewDistance ? ['--honor-view-distance'] : []),
    ...(a.flushPerPacket ? ['--flush-per-packet'] : []),
  ];
  const child = fork(script, args, {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null): void =>
      reject(new Error(`fake server exited (${code}) before ready`));
    child.once('exit', onExit);
    child.once('message', (msg: { type: string; port: number; version: string }) => {
      if (msg.type !== 'ready') return;
      child.off('exit', onExit);
      resolve({
        child,
        port: msg.port,
        version: msg.version,
        request: () =>
          new Promise((res) => {
            const on = (m: { type: string; stats: FakeServerStats }): void => {
              if (m.type !== 'stats') return;
              child.off('message', on);
              res(m.stats);
            };
            child.on('message', on);
            child.send({ type: 'stats' });
          }),
        send: (type) => child.send({ type }),
      });
    });
  });
}

// ---- main ------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  mkdirSync(a.out, { recursive: true });
  const say = (msg: string): void => {
    if (!a.json) console.error(msg);
  };

  let factory: BotFactory;
  try {
    factory = a.client === 'posse' ? await loadPosse() : await loadMineflayer();
  } catch (err) {
    console.error(`Cannot load client "${a.client}": ${(err as Error).message}`);
    process.exit(2);
  }

  say(`Starting fake server ${a.version} (radius ${a.chunkRadius}, ${a.entities} entities)…`);
  const server = await startServerChild(a);
  say(`Fake server ${server.version} on port ${server.port}`);

  fullGc();
  const baseline = process.memoryUsage();
  const cpuJoin0 = process.cpuUsage();
  const tJoin0 = Date.now();

  const bots: BenchBot[] = [];
  let tcpReads = 0;
  let tcpBytes = 0;
  let spawned = 0;
  let ended = 0;
  const errors: string[] = [];
  const spawnedAll = new Promise<void>((resolve) => {
    const check = (): void => {
      if (spawned >= a.bots) resolve();
    };
    for (let i = 0; i < a.bots; i++) {
      setTimeout(() => {
        const bot = factory.createBot({
          host: '127.0.0.1',
          port: server.port,
          username: `Bench${String(i).padStart(3, '0')}`,
          auth: 'offline',
          version: server.version,
          // Matches src/core/MinecraftBot.ts.
          viewDistance: 'tiny',
          hideErrors: true,
          checkTimeoutInterval: 60000,
        });
        bots.push(bot);
        const c = bot._client as unknown as {
          on(e: string, f: () => void): void;
          socket?: { on(e: string, f: (d: Buffer) => void): void };
        };
        c.on('connect', () =>
          c.socket?.on('data', (d: Buffer) => {
            tcpReads++;
            tcpBytes += d.length;
          }),
        );
        bot.once('spawn', () => {
          spawned++;
          check();
        });
        bot.on('error', (err: Error) => errors.push(`${i}: ${err.message}`));
        bot.on('kicked', (reason: unknown) =>
          errors.push(`${i} kicked: ${JSON.stringify(reason).slice(0, 200)}`),
        );
        bot.on('end', () => ended++);
      }, i * a.staggerMs);
    }
  });
  const joined = await Promise.race([
    spawnedAll.then(() => true),
    sleep(a.joinTimeout * 1000).then(() => false),
  ]);
  const joinSeconds = (Date.now() - tJoin0) / 1000;
  const joinCpu = process.cpuUsage(cpuJoin0);
  say(
    `${spawned}/${a.bots} bots spawned in ${joinSeconds.toFixed(1)} s${joined ? '' : ' (timeout)'}; settling ${a.settle} s…`,
  );
  await sleep(a.settle * 1000);

  // ---- measured window ----
  // The histogram records the full timer interval; values below subtract it (delay beyond 1 ms).
  const ELD_RESOLUTION_MS = 1;
  const eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
  let session: Session | undefined;
  if (a.profile) {
    session = new Session();
    session.connect();
    await post(session, 'Profiler.enable');
    await post(session, 'Profiler.setSamplingInterval', { interval: 500 });
    await post(session, 'Profiler.start');
  }
  server.send('reset');
  tcpReads = 0;
  tcpBytes = 0;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  eld.enable();
  const perSecondCpu: number[] = [];
  const memSamples: Array<{ heap: number; rss: number }> = [];
  let lastCpu = process.cpuUsage();
  let lastT = performance.now();
  const sampler = setInterval(() => {
    const now = performance.now();
    const c = process.cpuUsage(lastCpu);
    perSecondCpu.push(((c.user + c.system) / 1000 / (now - lastT)) * 100);
    lastCpu = process.cpuUsage();
    lastT = now;
    const m = process.memoryUsage();
    memSamples.push({ heap: m.heapUsed, rss: m.rss });
  }, 1000);
  say(`Measuring for ${a.seconds} s${a.profile ? ' (CPU profile on)' : ''}…`);
  await sleep(a.seconds * 1000);
  clearInterval(sampler);
  eld.disable();
  const elapsedMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const serverStats = await server.request('stats');

  let profileSummary: ProfileSummary | undefined;
  let profilePath: string | undefined;
  if (session) {
    const { profile } = (await post(session, 'Profiler.stop')) as { profile: CpuProfile };
    session.disconnect();
    profilePath = join(a.out, `${a.client}-${server.version}-${a.bots}b.cpuprofile`);
    writeFileSync(profilePath, JSON.stringify(profile));
    profileSummary = summarizeProfile(profile, 25);
  }

  fullGc();
  const after = process.memoryUsage();
  const online = spawned - ended;

  // ---- results ----
  const cpuPercent = ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100;
  const ms = (ns: number): number =>
    Math.max(0, Math.round((ns / 1e6 - ELD_RESOLUTION_MS) * 100) / 100);
  const secs = serverStats.seconds || a.seconds;
  const perSec = (rec: Record<string, number>): Record<string, number> =>
    Object.fromEntries(
      Object.entries(rec)
        .sort((x, y) => y[1] - x[1])
        .map(([k, v]) => [k, r1(v / secs)]),
    );
  const totalPackets = Object.values(serverStats.packets).reduce((s, v) => s + v, 0);
  const totalBytes = Object.values(serverStats.bytes).reduce((s, v) => s + v, 0);
  const result = {
    client: a.client,
    version: server.version,
    bots: a.bots,
    spawned,
    onlineAtEnd: online,
    seconds: r1(elapsedMs / 1000),
    config: {
      entities: a.entities,
      chunkRadius: a.chunkRadius,
      staggerMs: a.staggerMs,
      honorViewDistance: a.honorViewDistance,
    },
    join: {
      seconds: r1(joinSeconds),
      cpuPercent: r1(((joinCpu.user + joinCpu.system) / 1000 / (joinSeconds * 1000)) * 100),
    },
    cpu: {
      percentOfOneCore: r1(cpuPercent),
      perBotPercent: r1(cpuPercent / Math.max(1, online)),
      userMs: r1(cpu.user / 1000),
      systemMs: r1(cpu.system / 1000),
      perSecondMin: r1(Math.min(...perSecondCpu)),
      perSecondMax: r1(Math.max(...perSecondCpu)),
    },
    eventLoopDelayMs: {
      p50: ms(eld.percentile(50)),
      p99: ms(eld.percentile(99)),
      max: ms(eld.max),
      mean: ms(eld.mean),
    },
    memoryMb: {
      baselineHeap: mb(baseline.heapUsed),
      baselineRss: mb(baseline.rss),
      heapAfterGc: mb(after.heapUsed),
      rssAfterGc: mb(after.rss),
      heapPerBot: r1(mb(after.heapUsed - baseline.heapUsed) / Math.max(1, online)),
      rssPerBot: r1(mb(after.rss - baseline.rss) / Math.max(1, online)),
      heapPeak: mb(Math.max(...memSamples.map((s) => s.heap))),
      rssPeak: mb(Math.max(...memSamples.map((s) => s.rss))),
      external: mb(after.external),
      arrayBuffers: mb(after.arrayBuffers),
    },
    packets: {
      receivedPerSecond: r1(totalPackets / secs),
      perBotPerSecond: r1(totalPackets / secs / Math.max(1, online)),
      kbPerSecond: r1(totalBytes / 1024 / secs),
      tcpReadsPerBotPerSecond: r1(tcpReads / (elapsedMs / 1000) / Math.max(1, online)),
      tcpKbPerSecond: r1(tcpBytes / 1024 / (elapsedMs / 1000)),
      perClientByType: perSec(serverStats.perClient),
    },
    server: {
      tickLagMaxMs: serverStats.tickLagMaxMs,
      cpuPercent: r1((serverStats.serverCpuMs / (secs * 1000)) * 100),
    },
    errors: errors.slice(0, 20),
    errorCount: errors.length,
    profile: profileSummary ? { path: profilePath, ...profileSummary } : undefined,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(a.out, `${a.client}-${server.version}-${a.bots}b-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  if (a.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTable(result));
    if (profileSummary) console.log(`\n${formatSummary(profileSummary)}\nProfile: ${profilePath}`);
    console.log(`\nJSON: ${jsonPath}`);
  }

  for (const b of bots) {
    try {
      b.quit?.();
    } catch {
      // already gone
    }
  }
  server.send('close');
  await sleep(300);
  server.child.kill();
  process.exit(0);
}

function post(session: Session, method: string, params?: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    session.post(method, params ?? {}, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

type Result = {
  client: string;
  version: string;
  bots: number;
  spawned: number;
  onlineAtEnd: number;
  seconds: number;
  join: { seconds: number; cpuPercent: number };
  cpu: {
    percentOfOneCore: number;
    perBotPercent: number;
    perSecondMin: number;
    perSecondMax: number;
  };
  eventLoopDelayMs: { p50: number; p99: number; max: number; mean: number };
  memoryMb: Record<string, number>;
  packets: {
    receivedPerSecond: number;
    perBotPerSecond: number;
    kbPerSecond: number;
    tcpReadsPerBotPerSecond: number;
    tcpKbPerSecond: number;
    perClientByType: Record<string, number>;
  };
  server: { tickLagMaxMs: number; cpuPercent: number };
  errorCount: number;
};

function formatTable(r: Result): string {
  const rows: Array<[string, string]> = [
    ['client / version', `${r.client} ${r.version}`],
    ['bots (spawned / online at end)', `${r.bots} (${r.spawned} / ${r.onlineAtEnd})`],
    ['window', `${r.seconds} s`],
    ['join', `${r.join.seconds} s at ${r.join.cpuPercent}% CPU`],
    [
      'CPU (% of one core)',
      `${r.cpu.percentOfOneCore}%  (${r.cpu.perBotPercent}%/bot, 1 s range ${r.cpu.perSecondMin}–${r.cpu.perSecondMax}%)`,
    ],
    [
      'event-loop delay p50 / p99 / max',
      `${r.eventLoopDelayMs.p50} / ${r.eventLoopDelayMs.p99} / ${r.eventLoopDelayMs.max} ms`,
    ],
    [
      'heap after GC (per bot)',
      `${r.memoryMb.heapAfterGc} MB (${r.memoryMb.heapPerBot} MB/bot over ${r.memoryMb.baselineHeap} MB baseline)`,
    ],
    [
      'RSS after GC (per bot)',
      `${r.memoryMb.rssAfterGc} MB (${r.memoryMb.rssPerBot} MB/bot over ${r.memoryMb.baselineRss} MB baseline)`,
    ],
    ['heap / RSS peak', `${r.memoryMb.heapPeak} / ${r.memoryMb.rssPeak} MB`],
    ['external / ArrayBuffers after GC', `${r.memoryMb.external} / ${r.memoryMb.arrayBuffers} MB`],
    [
      'packets received',
      `${r.packets.receivedPerSecond}/s total, ${r.packets.perBotPerSecond}/s per bot, ${r.packets.kbPerSecond} KB/s uncompressed`,
    ],
    [
      'socket reads',
      `${r.packets.tcpReadsPerBotPerSecond}/s per bot, ${r.packets.tcpKbPerSecond} KB/s on the wire`,
    ],
    ['fake server', `max tick lag ${r.server.tickLagMaxMs} ms, ${r.server.cpuPercent}% CPU`],
    ['bot errors / kicks', `${r.errorCount}`],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`);
  lines.push('', 'Packets per second seen by one client:');
  for (const [k, v] of Object.entries(r.packets.perClientByType).slice(0, 20))
    lines.push(`  ${String(v).padStart(8)}  ${k}`);
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
