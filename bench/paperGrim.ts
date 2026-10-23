// A Paper server with GrimAC for the live harness (`--grim`): downloads Paper (fill.papermc.io,
// sha256-checked) and GrimAC (Modrinth, sha512-checked) once into `<dir>/jars`, and collects
// Grim's flags from the console so a scenario can be failed on them.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- remote JSON
async function json(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': 'posse-mc bench (github.com/G0Osey99/posse-mc)' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function download(url: string, file: string, algorithm: 'sha256' | 'sha512', hash: string): Promise<string> {
  if (existsSync(file)) return file;
  const res = await fetch(url, { headers: { 'User-Agent': 'posse-mc bench (github.com/G0Osey99/posse-mc)' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash(algorithm).update(bytes).digest('hex') !== hash) throw new Error(`${path.basename(file)} failed its ${algorithm} check`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}

/** The latest stable Paper build for a Minecraft version. */
export async function paperJar(version: string, dir: string): Promise<string> {
  const build = await json(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds/latest`);
  const d = build.downloads['server:default'];
  return download(d.url, path.join(dir, 'jars', d.name), 'sha256', d.checksums.sha256);
}

/** The newest GrimAC release for Paper on a Minecraft version (Modrinth). */
export async function grimJar(version: string, dir: string): Promise<{ file: string; version: string }> {
  const q = new URLSearchParams({ loaders: JSON.stringify(['paper']), game_versions: JSON.stringify([version]) });
  const versions = await json(`https://api.modrinth.com/v2/project/grimac/version?${q}`);
  const release = versions.find((v: { version_type: string }) => v.version_type === 'release') ?? versions[0];
  if (!release) throw new Error(`No GrimAC release for ${version}`);
  const f = release.files.find((x: { primary: boolean }) => x.primary) ?? release.files[0];
  return { file: await download(f.url, path.join(dir, 'jars', f.filename), 'sha512', f.hashes.sha512), version: release.version_number };
}

export interface GrimFlag {
  check: string;
  line: string;
}

/** A console line Grim prints when a player fails a check (`... failed <Check> (x<n>) ...`). */
export function parseGrimFlag(line: string): GrimFlag | null {
  if (!/grim/i.test(line)) return null;
  const m = /failed\s+([A-Za-z]+(?:\s*\w+)?)\s*(?:\(x?\d+\))?/i.exec(line);
  return m ? { check: m[1]!.trim(), line } : null;
}
