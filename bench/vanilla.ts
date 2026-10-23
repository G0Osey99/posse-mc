// A local vanilla Minecraft server for integration tests: downloads Mojang's official server jar
// (sha1-checked, cached), writes an offline-mode config and runs it with the console on stdin.
// Running it means accepting the Minecraft EULA (https://aka.ms/MinecraftEULA): pass
// `acceptEula: true` only if you do.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

export interface VanillaOptions {
  version: string;
  /** Where jars are cached and worlds live. */
  dir: string;
  acceptEula: boolean;
  port?: number;
  /** A flat world (default true). */
  flat?: boolean;
  /** Delete the world first (default true). */
  freshWorld?: boolean;
  /** Extra server.properties entries. */
  properties?: Record<string, string | number | boolean>;
  log?: (line: string) => void;
  java?: string;
  /** Run this server jar (e.g. Paper) instead of Mojang's. */
  jar?: string;
  /** Plugin jars copied into `plugins/` (with `jar` a Bukkit server). */
  plugins?: string[];
  /** World folder name (default: the version). */
  name?: string;
}

export interface VanillaServer {
  port: number;
  version: string;
  /** Runs a console command. */
  command(cmd: string): void;
  /** Runs a console command and waits for a console line matching `expect`. */
  run(cmd: string, expect: RegExp, timeoutMs?: number): Promise<string>;
  /** Waits for a console line. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  stop(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mojang's manifests are untyped JSON
async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Downloads (once) the official server jar for a version; returns its path. */
export async function serverJar(version: string, dir: string): Promise<string> {
  const jar = path.join(dir, 'jars', `${version}.jar`);
  if (existsSync(jar)) return jar;
  const manifest = await fetchJson(MANIFEST);
  const entry = manifest.versions.find((v: { id: string }) => v.id === version);
  if (!entry) throw new Error(`Unknown version ${version}`);
  const meta = await fetchJson(entry.url);
  const server = meta.downloads?.server;
  if (!server) throw new Error(`No server jar for ${version}`);
  const res = await fetch(server.url);
  if (!res.ok) throw new Error(`${server.url}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha1 = createHash('sha1').update(bytes).digest('hex');
  if (sha1 !== server.sha1) throw new Error(`Server jar for ${version} failed its sha1 check`);
  await mkdir(path.dirname(jar), { recursive: true });
  await writeFile(jar, bytes);
  return jar;
}

export async function startVanilla(options: VanillaOptions): Promise<VanillaServer> {
  if (!options.acceptEula) throw new Error('Running a vanilla server requires accepting the Minecraft EULA (acceptEula: true)');
  const { version } = options;
  const jar = options.jar ?? (await serverJar(version, options.dir));
  const worldDir = path.join(options.dir, 'servers', options.name ?? version);
  if (options.freshWorld ?? true) await rm(worldDir, { recursive: true, force: true });
  await mkdir(worldDir, { recursive: true });
  if (options.plugins?.length) {
    await mkdir(path.join(worldDir, 'plugins'), { recursive: true });
    for (const plugin of options.plugins) await copyFile(plugin, path.join(worldDir, 'plugins', path.basename(plugin)));
  }
  const port = options.port ?? (await freePort());
  const flat = options.flat ?? true;
  // Level types are namespaced from 1.19 (`minecraft:flat`); before, `flat` / `default`.
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const namespaced = major > 1 || minor >= 19;
  const props: Record<string, string | number | boolean> = {
    'online-mode': false,
    'server-port': port,
    'server-ip': '127.0.0.1',
    'level-type': namespaced ? (flat ? 'minecraft\\:flat' : 'minecraft\\:normal') : flat ? 'FLAT' : 'DEFAULT',
    'spawn-protection': 0,
    'view-distance': 6,
    'simulation-distance': 6,
    'spawn-monsters': false,
    'spawn-npcs': true,
    'generate-structures': false,
    difficulty: 'easy',
    'max-players': 40,
    'allow-flight': false,
    'enable-command-block': true,
    'network-compression-threshold': 256,
    'sync-chunk-writes': false,
    'level-seed': 'posse',
    motd: 'Posse test server',
    ...options.properties,
  };
  await writeFile(path.join(worldDir, 'server.properties'), Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  await writeFile(path.join(worldDir, 'eula.txt'), 'eula=true\n');

  const child: ChildProcess = spawn(options.java ?? 'java', ['-Xms512M', '-Xmx2G', '-jar', jar, 'nogui'], { cwd: worldDir, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters: Array<{ pattern: RegExp; resolve: (line: string) => void }> = [];
  let buffer = '';
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      options.log?.(line);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pattern.test(line)) {
          const [w] = waiters.splice(i, 1);
          w!.resolve(line);
        }
      }
    }
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => child.on('exit', () => {
    exited = true;
    resolve();
  }));

  const waitFor = (pattern: RegExp, timeoutMs = 60_000): Promise<string> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`Timed out waiting for ${pattern}`));
      }, timeoutMs);
      const waiter = {
        pattern,
        resolve: (line: string) => {
          clearTimeout(timer);
          resolve(line);
        },
      };
      waiters.push(waiter);
    });

  const command = (cmd: string): void => {
    if (!exited) child.stdin!.write(`${cmd}\n`);
  };

  const ready = waitFor(/Done \(/, 240_000);
  await Promise.race([ready, exitPromise.then(() => Promise.reject(new Error(`Server ${version} exited during start-up`)))]);

  return {
    port,
    version,
    command,
    run: (cmd, expect, timeoutMs = 10_000) => {
      const line = waitFor(expect, timeoutMs);
      command(cmd);
      return line;
    },
    waitFor,
    stop: async () => {
      if (exited) return;
      command('stop');
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      await exitPromise;
      clearTimeout(timer);
    },
  };
}

/** Reads the cached manifest's release list (for scripts that pick versions). */
export async function releaseVersions(dir: string): Promise<string[]> {
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) await writeFile(file, JSON.stringify(await fetchJson(MANIFEST)));
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  return manifest.versions.filter((v: { type: string }) => v.type === 'release').map((v: { id: string }) => v.id);
}
