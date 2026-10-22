// Posse screenshots (docs/design.md → Screenshots): ViewRenderer turns a ViewScene into a PNG
// that looks like the game. Assets come from the version's Mojang client jar (downloaded and cached
// on first use, then kept as a compact pack file); without them a flat-colour palette is used.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import minecraftData from 'minecraft-data';
import { ensureClientJar } from './assets/mojang.js';
import { buildPackFromJar } from './assets/jarPack.js';
import { buildPalettePack } from './assets/palette.js';
import { PACK_FORMAT, type ViewPack } from './assets/pack.js';
import { deserializePack, serializePack } from './assets/packio.js';
import { assetVersionFor, isPreFlattening, stateTableFor } from './assets/states.js';
import { ZipReader } from './assets/zip.js';
import { drawHud, drawNametags, drawVignette } from './hud.js';
import type { KernelEntity, KernelHand, KernelJob } from './kernelTypes.js';
import { encodePngAsync } from './png.js';
import { SkinCache } from './skins.js';
import type { ViewRendererOptions, ViewRenderResult, ViewScene } from './types.js';
import { InlineRunner, WorkerRunner, type KernelRunner } from './worker.js';

export type {
  SceneEntity,
  SceneHud,
  SceneRegion,
  ViewRenderResult,
  ViewRendererOptions,
  ViewScene,
} from './types.js';

/** After a failed download the palette is used; the jar is tried again after this long. */
const RETRY_MS = 15 * 60_000;
const MAX_SIZE = 1920;

/** Version facts the kernel needs (clouds moved to y 192 and fog became a short band in 1.18). */
export function versionTraits(version: string): { cloudHeight: number; modernFog: boolean } {
  try {
    const modern = minecraftData(version).isNewerOrEqualTo('1.18');
    return { cloudHeight: modern ? 192 : 128, modernFog: modern };
  } catch {
    return { cloudHeight: 192, modernFog: true };
  }
}

function stateCount(version: string): number {
  try {
    return stateTableFor(version).length;
  } catch {
    return -1;
  }
}

/** A finite number, or the fallback. */
const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** What the first-person view holds for the selected hotbar slot. */
export function handFor(scene: ViewScene, pack: ViewPack): KernelHand {
  const hud = scene.hud;
  const item = hud?.hotbar[Math.max(0, Math.min(8, hud.selectedSlot | 0))];
  if (!item) return { kind: 'arm' };
  const name = item.name.replace(/^minecraft:/, '');
  if (pack.hud.blockItems?.includes(name)) {
    try {
      const block = minecraftData(scene.version).blocksByName[name];
      if (block) {
        const state = isPreFlattening(scene.version)
          ? block.id << 4
          : (block.defaultState ?? block.minStateId ?? 0);
        if (pack.kernel.stateModel[state] >= 0) return { kind: 'block', state };
      }
    } catch {
      // unknown version: fall through to the sprite
    }
  }
  const icon = pack.hud.items[name];
  return icon ? { kind: 'item', icon } : { kind: 'arm' };
}

/** A pack that draws nothing but sky (a version minecraft-data does not know). */
function emptyPack(version: string): ViewPack {
  const one = (v: number) => Uint32Array.of(v, v);
  return {
    version,
    quality: 'palette',
    kernel: {
      key: `${version}:empty`,
      atlasCols: 1,
      atlasRows: 1,
      mips: [16, 8, 4, 2, 1].map((s) => new Uint8Array(s * s * 4)),
      texFlags: new Uint8Array(1),
      waterTex: -1,
      lavaTex: -1,
      stateModel: Int32Array.of(-1),
      stateFlags: new Uint16Array(1),
      stateLight: new Uint8Array(1),
      stateTint: new Uint32Array(1),
      models: new Float32Array(0),
      biomeGrass: one(0x91bd59),
      biomeFoliage: one(0x77ab2f),
      biomeWater: one(0x3f76e4),
      biomeSky: one(0x78a7ff),
      biomeFog: one(0xc0d8ff),
    },
    hud: { sprites: {}, items: {} },
  };
}

export class ViewRenderer {
  private readonly cacheDir: string;
  private readonly allowDownload: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly runners: KernelRunner[];
  private readonly busy: number[];
  private readonly waiting: Array<() => void> = [];
  private readonly packs = new Map<string, Promise<ViewPack>>();
  private readonly paletteAt = new Map<string, number>();
  private readonly skins: SkinCache;
  private closed = false;

  constructor(opts: ViewRendererOptions) {
    this.cacheDir = opts.cacheDir;
    this.allowDownload = opts.allowDownload !== false;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    const n = Math.max(0, Math.floor(opts.workers ?? 1));
    this.runners =
      n === 0 ? [new InlineRunner()] : Array.from({ length: n }, () => new WorkerRunner());
    this.busy = this.runners.map(() => 0);
    this.skins = new SkinCache(join(this.cacheDir, 'skins'), this.fetchFn, this.allowDownload);
  }

  /** Loads (or downloads and builds) the version's pack ahead of the first render. */
  async prepare(version: string): Promise<void> {
    await this.pack(version);
  }

  private pack(version: string): Promise<ViewPack> {
    const at = this.paletteAt.get(version);
    if (at !== undefined && Date.now() - at > RETRY_MS && this.allowDownload) {
      this.paletteAt.delete(version);
      this.packs.delete(version);
    }
    let p = this.packs.get(version);
    if (!p) {
      p = this.loadPack(version);
      this.packs.set(version, p);
    }
    return p;
  }

  private async loadPack(version: string): Promise<ViewPack> {
    const dir = join(this.cacheDir, 'assets');
    const file = join(dir, 'packs', `${version}.v${PACK_FORMAT}.pack`);
    try {
      const cached = deserializePack(await readFile(file));
      // A minecraft-data update that changed the version's state count invalidates the pack.
      if (
        cached &&
        cached.version === version &&
        cached.kernel.stateModel.length === stateCount(version)
      )
        return cached;
    } catch {
      // no cached pack
    }
    try {
      const jar = await ensureClientJar(assetVersionFor(version), dir, {
        fetch: this.fetchFn,
        allowDownload: this.allowDownload,
      });
      const pack = buildPackFromJar(version, new ZipReader(jar));
      await mkdir(join(dir, 'packs'), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, serializePack(pack));
      await rename(tmp, file);
      return pack;
    } catch {
      this.paletteAt.set(version, Date.now());
      try {
        return buildPalettePack(version);
      } catch {
        return emptyPack(version);
      }
    }
  }

  /** Waits for a free runner (renders are queued, one at a time per worker). */
  private async acquire(): Promise<number> {
    for (;;) {
      if (this.closed) throw new Error('ViewRenderer is closed');
      const i = this.busy.indexOf(0);
      if (i >= 0) {
        this.busy[i] = 1;
        return i;
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  private release(i: number): void {
    this.busy[i] = 0;
    this.waiting.shift()?.();
  }

  async render(scene: ViewScene): Promise<ViewRenderResult> {
    const width = Math.max(16, Math.min(MAX_SIZE, Math.round(scene.width) || 640));
    const height = Math.max(16, Math.min(MAX_SIZE, Math.round(scene.height) || 360));
    const pack = await this.pack(scene.version);
    const entities: KernelEntity[] = await Promise.all(
      scene.entities.slice(0, 64).map(async (e) => {
        const skin = e.kind === 'player' ? await this.skins.get(e.skinUrl) : undefined;
        return {
          kind: e.kind,
          name: e.name,
          x: e.x,
          y: e.y,
          z: e.z,
          yaw: e.yaw,
          pitch: e.pitch,
          width: e.width,
          height: e.height,
          ...(skin ? { skin } : {}),
          ...(e.slim ? { slim: true } : {}),
        };
      }),
    );
    const job: KernelJob = {
      width,
      height,
      camera: {
        x: finite(scene.camera.x, 0),
        y: finite(scene.camera.y, 64),
        z: finite(scene.camera.z, 0),
        yaw: finite(scene.camera.yaw, 0),
        pitch: Math.max(-90, Math.min(90, finite(scene.camera.pitch, 0))),
        fov: Math.max(10, Math.min(170, finite(scene.camera.fov ?? 70, 70))),
      },
      region: scene.region,
      entities,
      timeOfDay: scene.timeOfDay,
      raining: scene.raining,
      dimension: scene.dimension,
      ...versionTraits(scene.version),
      ...(scene.hud ? { hand: handFor(scene, pack) } : {}),
    };
    const slot = await this.acquire();
    const t0 = performance.now();
    let rgba: Uint8Array;
    let eyeBrightness: number;
    try {
      const r = await this.runners[slot].render(job, pack.kernel);
      rgba = r.rgba;
      eyeBrightness = r.eyeBrightness;
    } finally {
      this.release(slot);
    }
    const frame = { width, height, data: rgba };
    const sized = { ...scene, width, height };
    if (scene.hud) drawVignette(frame, pack.hud, eyeBrightness);
    await drawNametags(frame, pack.hud, sized);
    if (scene.hud) await drawHud(frame, pack.hud, scene.hud);
    const png = await encodePngAsync(frame, false);
    return { png, width, height, ms: performance.now() - t0, quality: pack.quality };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const w of this.waiting.splice(0)) w();
    await Promise.all(this.runners.map((r) => r.close()));
  }
}
