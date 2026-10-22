// Checks the fake server against a client for each version: spawn, chat (messagestr), the
// sidebar scoreboard, the tab list (players) and a `/menu` window (windowOpen + a click).
//
//   tsx bench/verify.ts [--client mineflayer|posse] [--versions 1.8.9,1.18.2,...]
import mineflayer from 'mineflayer';
import { startFakeServer } from './fakeServer.js';
import { loadPosse, type BenchBot } from './clients.js';

const DEFAULT_VERSIONS = [
  '1.8.9',
  '1.12.2',
  '1.16.5',
  '1.18.2',
  '1.19.4',
  '1.20.4',
  '1.21.4',
  'latest',
];

interface Check {
  version: string;
  ok: boolean;
  checks: Record<string, boolean | string>;
  error?: string;
}

async function verifyVersion(version: string, client: string, timeoutMs: number): Promise<Check> {
  const server = await startFakeServer({
    version,
    port: 0,
    chunkRadius: 3,
    entities: 6,
    tabExtra: 5,
    chatEveryMs: 300,
    log: process.env.VERBOSE ? (m) => console.log(m) : undefined,
  });
  const checks: Record<string, boolean | string> = {
    spawn: false,
    messagestr: false,
    sidebar: false,
    players: false,
    world: false,
    entities: false,
    entityMoved: false,
    windowOpen: false,
    click: false,
    fall: false,
  };
  let bot: BenchBot | undefined;
  try {
    const options = {
      host: '127.0.0.1',
      port: server.port,
      username: 'VerifyBot',
      auth: 'offline' as const,
      version: server.version,
      viewDistance: 'tiny' as const,
      hideErrors: false,
      checkTimeoutInterval: 60000,
    };
    if (client === 'posse') {
      const posse = await loadPosse();
      bot = posse.createBot(options) as BenchBot;
    } else {
      bot = mineflayer.createBot(options) as unknown as BenchBot;
    }
    const b = bot;
    const errors: string[] = [];
    b.on('error', (err: Error) => errors.push(err.message));
    b.on('kicked', (reason: unknown) => errors.push(`kicked: ${JSON.stringify(reason)}`));

    const until = (pred: () => boolean): Promise<boolean> =>
      new Promise((resolve) => {
        const start = Date.now();
        const t = setInterval(() => {
          if (pred() || Date.now() - start > timeoutMs) {
            clearInterval(t);
            resolve(pred());
          }
        }, 50);
      });

    let messages: string[] = [];
    b.on('messagestr', (m: string) => messages.push(m));
    b.once('spawn', () => (checks.spawn = true));
    await until(() => checks.spawn === true || errors.length > 0);
    await until(() => messages.length >= 3);
    checks.messagestr =
      messages.length > 0 ? `${messages.length}: ${messages.slice(0, 3).join(' | ')}` : false;
    const sidebar = b.scoreboard?.sidebar as { title?: string; items?: unknown[] } | undefined;
    checks.sidebar = sidebar ? `${sidebar.title} (${sidebar.items?.length ?? 0} lines)` : false;
    checks.players =
      Object.keys(b.players ?? {}).length > 1 ? `${Object.keys(b.players).length}` : false;
    // The 3 fake players at least (Posse tracks players only by default; mineflayer also has the mobs).
    await until(() => Object.keys(b.entities ?? {}).length > 3);
    const pos = b.entity?.position;
    const below = pos && b.blockAt ? b.blockAt(pos.offset(0, -1, 0)) : null;
    // Light above the hills (mineflayer reads partially lit sections with a permuted nibble order).
    const sky =
      pos && b.blockAt ? (b.blockAt(pos.offset(0, 30, 0)) as { skyLight?: number } | null) : null;
    checks.world = below
      ? `${below.name} under the bot at y=${pos?.y.toFixed(1)}, sky light ${sky?.skyLight}`
      : false;
    checks.entities =
      Object.keys(b.entities ?? {}).length > 3 ? `${Object.keys(b.entities ?? {}).length}` : false;

    let moved = 0;
    b.on('entityMoved', () => moved++);
    await new Promise((r) => setTimeout(r, 1000));
    checks.entityMoved = moved > 0 ? `${moved}/s` : false;

    const windowOpened = new Promise<{ title: unknown; slots: unknown[] }>((resolve) =>
      b.once('windowOpen', (w: { title: unknown; slots: unknown[] }) => resolve(w)),
    );
    b.chat('/menu');
    const win = await Promise.race([
      windowOpened,
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
    if (win) {
      checks.windowOpen = `title=${JSON.stringify(win.title)} items=${win.slots.filter(Boolean).length}`;
      await b.clickWindow(1, 0, 0).catch((err: Error) => errors.push(`click: ${err.message}`));
      await until(() => server.stats().menuClicks.length > 0);
      checks.click = server.stats().menuClicks.length > 0;
    }
    // Blow out the floor under the bot: it must fall onto the block below, not hover.
    const startY = b.entity?.position.y ?? 0;
    b.chat('/dropfloor');
    await until(() => (b.entity?.position.y ?? startY) <= startY - 3.9);
    const endY = b.entity?.position.y ?? startY;
    checks.fall = startY - endY >= 3.9 ? `fell ${(startY - endY).toFixed(1)} blocks` : false;

    if (client === 'posse') await verifyPosseExtras(b as unknown as PosseExtras, server, checks, until, version);

    messages = [];
    const ok = Object.values(checks).every((v) => v !== false);
    return {
      version: server.version,
      ok,
      checks,
      error: errors.length ? errors.slice(0, 3).join('; ') : undefined,
    };
  } catch (err) {
    return { version: server.version, ok: false, checks, error: (err as Error).stack };
  } finally {
    bot?.quit?.();
    bot?.end?.();
    await server.close();
  }
}

interface PosseExtras extends BenchBot {
  version: string;
  tps: number | null;
  latency: number | null;
  isEnded: boolean;
  ping(timeout?: number): Promise<number>;
  watchSpawns(names: string[], listener: (s: { name: string }) => void): () => void;
  followTransfer(): PosseExtras | null;
}

/** Posse's own features: spawn watching, explosions, TPS, ping, and (1.20.5+) transfer + cookies. */
async function verifyPosseExtras(
  b: PosseExtras,
  server: Awaited<ReturnType<typeof startFakeServer>>,
  checks: Record<string, boolean | string>,
  until: (pred: () => boolean) => Promise<boolean>,
  version: string,
): Promise<void> {
  let tnt = 0;
  let explosions = 0;
  const off = b.watchSpawns(['tnt'], () => tnt++);
  b.on('explosion', () => explosions++);
  b.chat('/tnt');
  await until(() => tnt > 0 && explosions > 0);
  off();
  checks.watchSpawns = tnt > 0 ? `${tnt} tnt` : false;
  checks.explosion = explosions > 0;

  await until(() => b.tps !== null);
  checks.tps = b.tps !== null ? `${b.tps}` : false;
  checks.ping = await b.ping(3000).then(
    (ms) => `${ms} ms${server.stats().pings > 0 ? '' : ' (tab list)'}`,
    (err: Error) => (server.stats().pings === 0 && /latency/.test(err.message) ? 'n/a (no tab latency)' : false),
  );

  const posse = (await import('../src/decode.js')) as typeof import('../src/decode.js');
  if (!posse.packetNames(b.version, 'play').includes('transfer')) return;
  checks.transfer = false;
  b.chat('/transfer');
  await until(() => b.isEnded);
  const next = b.followTransfer();
  if (!next) return;
  next.on('error', () => undefined);
  let spawned = false;
  next.once('spawn', () => (spawned = true));
  await until(() => spawned);
  next.chat('/cookie');
  await until(() => server.stats().cookies['posse:test'] !== undefined);
  const cookie = server.stats().cookies['posse:test'];
  if (process.env.VERBOSE) console.log('transfer:', { ended: b.isEnded, spawned, logins: server.stats().transferLogins, cookie });
  checks.transfer =
    spawned && server.stats().transferLogins === 1 && cookie === 'carried'
      ? `followed (intent 3), cookie "${cookie}"`
      : false;
  next.quit?.();
  void version;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (k: string): string | undefined => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const client = opt('client') ?? 'mineflayer';
  const { testedVersions } = (await import('mineflayer/lib/version.js' as string)) as {
    testedVersions: string[];
  };
  const versions = (opt('versions')?.split(',') ?? DEFAULT_VERSIONS).map((v) =>
    v === 'latest' ? testedVersions[testedVersions.length - 1] : v,
  );
  const results: Check[] = [];
  for (const v of versions) {
    const r = await verifyVersion(v, client, Number(opt('timeout') ?? 8000));
    results.push(r);
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${v} (${r.version})`);
    for (const [k, val] of Object.entries(r.checks)) console.log(`    ${k}: ${val}`);
    if (r.error) console.log(`    error: ${r.error}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} versions passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
