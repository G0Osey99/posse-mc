// Downloads a version's client jar from Mojang's piston servers (version manifest → version json
// → downloads.client), checks its sha1 and caches it under `<cacheDir>/jars/`. Only the user's own
// machine talks to Mojang; no Mojang asset is shipped with Posse.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const VERSION_MANIFEST_URL =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

/** Only these hosts are fetched (the manifest's own links point at them). */
const MOJANG_HOSTS = /^https:\/\/(piston-meta|piston-data|launchermeta|launcher)\.mojang\.com\//;

export type FetchFn = typeof fetch;

export function sha1(buf: Uint8Array): string {
  return createHash('sha1').update(buf).digest('hex');
}

async function fetchBytes(fetchFn: FetchFn, url: string, timeoutMs: number): Promise<Buffer> {
  if (!MOJANG_HOSTS.test(url)) throw new Error(`Refusing to download from ${url}`);
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

interface Manifest {
  versions: Array<{ id: string; url: string; sha1?: string }>;
}

interface VersionJson {
  downloads?: { client?: { url: string; sha1: string; size: number } };
}

const inFlight = new Map<string, Promise<Buffer>>();

/**
 * The client jar of a Mojang version id, from the cache or downloaded into it. The cached file is
 * trusted only when its sha1 matches the one recorded next to it. Concurrent calls for the same
 * jar share one download.
 */
export function ensureClientJar(
  version: string,
  cacheDir: string,
  opts: { fetch?: FetchFn; allowDownload?: boolean } = {},
): Promise<Buffer> {
  const key = `${cacheDir}\0${version}`;
  let p = inFlight.get(key);
  if (!p) {
    p = loadClientJar(version, cacheDir, opts).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

async function loadClientJar(
  version: string,
  cacheDir: string,
  opts: { fetch?: FetchFn; allowDownload?: boolean } = {},
): Promise<Buffer> {
  const dir = join(cacheDir, 'jars');
  const indexFile = join(dir, `${version}.sha1`);
  try {
    const want = (await readFile(indexFile, 'utf8')).trim();
    const jar = await readFile(join(dir, `${version}.jar`));
    if (sha1(jar) === want) return jar;
  } catch {
    // not cached yet
  }
  if (opts.allowDownload === false)
    throw new Error(`Client jar ${version} is not cached and downloads are off`);
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const manifest = JSON.parse(
    (await fetchBytes(fetchFn, VERSION_MANIFEST_URL, 30_000)).toString('utf8'),
  ) as Manifest;
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`Version ${version} is not in Mojang's manifest`);
  const vjBuf = await fetchBytes(fetchFn, entry.url, 30_000);
  if (entry.sha1 && sha1(vjBuf) !== entry.sha1)
    throw new Error(`Version json ${version}: sha1 mismatch`);
  const client = (JSON.parse(vjBuf.toString('utf8')) as VersionJson).downloads?.client;
  if (!client) throw new Error(`Version ${version} has no client download`);
  const jar = await fetchBytes(fetchFn, client.url, 10 * 60_000);
  if (sha1(jar) !== client.sha1) throw new Error(`Client jar ${version}: sha1 mismatch`);
  try {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${version}.jar.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, jar);
    await rename(tmp, join(dir, `${version}.jar`));
    await writeFile(indexFile, client.sha1);
  } catch {
    // An unwritable cache costs a download next time, not this verified jar.
  }
  return jar;
}
