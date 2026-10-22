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
