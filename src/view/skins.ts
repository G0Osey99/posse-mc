// Player skins for the screenshot: fetched from Mojang's texture server (the URL comes from the tab
// list's textures property, which the game server controls, so only textures.minecraft.net is
// fetched), cached on disk and in memory. A skin that fails to load falls back to the default one.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, type RgbaImage } from './png.js';

const SKIN_URL = /^https?:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]{16,128}$/i;
const MEMORY = 64;
const RETRY_MS = 10 * 60_000;

/** True for a URL this cache will fetch (Mojang's texture server). */
export function isAllowedSkinUrl(url: string): boolean {
  return SKIN_URL.test(url);
}

/** A decoded skin when it is a valid 64×64 (or legacy 64×32) image. */
export function decodeSkin(buf: Buffer): RgbaImage | undefined {
  try {
    const img = decodePng(buf);
    if (img.width === 64 && (img.height === 64 || img.height === 32)) return img;
    // HD skins: any square or 2:1 multiple of 64.
    if (
      img.width % 64 === 0 &&
      (img.height === img.width || img.height * 2 === img.width) &&
      img.width <= 1024
    )
      return img;
  } catch {
    // not a PNG
  }
  return undefined;
}

export class SkinCache {
  private readonly memory = new Map<string, RgbaImage>();
  private readonly failed = new Map<string, number>();
  private readonly pending = new Map<string, Promise<RgbaImage | undefined>>();

  constructor(
    private readonly dir: string,
    private readonly fetchFn: typeof fetch,
    private readonly allowDownload: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** The skin at `url`, or undefined (default skin) when it is not allowed or does not load. */
  get(url: string | undefined): Promise<RgbaImage | undefined> {
    if (!url || !isAllowedSkinUrl(url)) return Promise.resolve(undefined);
    const key = url.replace(/^http:/, 'https:');
    const hit = this.memory.get(key);
    if (hit) {
      this.memory.delete(key);
      this.memory.set(key, hit);
      return Promise.resolve(hit);
    }
    const failedAt = this.failed.get(key);
    if (failedAt !== undefined && this.now() - failedAt < RETRY_MS)
      return Promise.resolve(undefined);
    let p = this.pending.get(key);
    if (!p) {
      p = this.load(key).finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  private async load(url: string): Promise<RgbaImage | undefined> {
    const file = join(this.dir, `${createHash('sha1').update(url).digest('hex')}.png`);
    let img: RgbaImage | undefined;
    try {
      img = decodeSkin(await readFile(file));
    } catch {
      img = undefined;
    }
    if (!img && this.allowDownload) {
      try {
        const res = await this.fetchFn(url, { signal: AbortSignal.timeout(5_000) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 512 * 1024) img = decodeSkin(buf);
          if (img) {
            await mkdir(this.dir, { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            await writeFile(tmp, buf);
            await rename(tmp, file);
          }
        }
      } catch {
        img = undefined;
      }
    }
    if (!img) {
      this.failed.set(url, this.now());
      return undefined;
    }
    this.memory.set(url, img);
    while (this.memory.size > MEMORY) this.memory.delete(this.memory.keys().next().value!);
    return img;
  }
}
