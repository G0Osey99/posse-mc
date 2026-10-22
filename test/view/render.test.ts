import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import minecraftData from 'minecraft-data';
import { posseViewKernel, type ViewKernel } from '../../src/view/kernel.js';
import { buildPalettePack, paletteColor } from '../../src/view/assets/palette.js';
import { deserializePack, serializePack } from '../../src/view/assets/packio.js';
import type { ViewPack } from '../../src/view/assets/pack.js';
import { SF, type KernelJob } from '../../src/view/kernelTypes.js';
import { WorkerRunner, kernelSource, workerSource } from '../../src/view/worker.js';
import { blit, drawVignette, guiScale, textWidth } from '../../src/view/hud.js';
import { projectPoint } from '../../src/view/camera.js';
import { SkinCache, isAllowedSkinUrl } from '../../src/view/skins.js';
import { ViewRenderer, handFor, versionTraits } from '../../src/view/index.js';
import { decodePng, encodePng } from '../../src/view/png.js';
import type { ViewScene } from '../../src/view/types.js';

const VERSION = '1.18.2';
let pack: ViewPack;
const data = minecraftData(VERSION);
const id = (name: string) => data.blocksByName[name].defaultState!;

beforeAll(() => {
  pack = buildPalettePack(VERSION);
});

/** A 16×16×16 region: stone floor, a grass block, a torch, a tree trunk; camera above, looking north-east. */
function tinyScene(): KernelJob {
  const size = 16;
  const states = new Uint16Array(size * size * size);
  const set = (x: number, y: number, z: number, s: number) =>
    (states[(y * size + z) * size + x] = s);
  for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) set(x, 0, z, id('stone'));
  set(8, 1, 10, id('grass_block'));
  set(6, 1, 10, id('torch'));
  for (let y = 1; y < 5; y++) set(10, y, 12, id('oak_log'));
  set(9, 1, 6, id('water'));
  return {
    width: 48,
    height: 32,
    camera: { x: 8.5, y: 64, z: 3.5, yaw: 0, pitch: 25, fov: 70 },
    region: { originX: 0, originY: 60, originZ: 0, sizeX: size, sizeY: size, sizeZ: size, states },
    entities: [
      {
        kind: 'player',
        name: 'player',
        x: 8.5,
        y: 61,
        z: 8.5,
        yaw: 180,
        pitch: 0,
        width: 0.6,
        height: 1.8,
      },
    ],
    timeOfDay: 6000,
    raining: false,
    dimension: 'overworld',
    cloudHeight: 192,
    modernFog: true,
  };
}

describe('palette pack', () => {
  it('colours blocks from their names', () => {
    expect(paletteColor('grass_block').side).not.toBe(paletteColor('grass_block').top);
    expect(paletteColor('oak_log').top).not.toBe(paletteColor('oak_log').side);
    expect(paletteColor('red_wool').side).toBe(0xa12722);
    expect(paletteColor('some_future_block').side).toBe(paletteColor('some_future_block').side);
  });

  it('builds kernel tables for every state of the version', () => {
    const k = pack.kernel;
    expect(pack.quality).toBe('palette');
    expect(k.stateModel.length).toBe(
      Math.max(...data.blocksArray.map((b) => b.maxStateId ?? 0)) + 1,
    );
    expect(k.stateModel[0]).toBe(-1);
    expect(k.stateFlags[id('stone')] & SF.OPAQUE).toBeTruthy();
    expect(k.stateFlags[id('glass')] & SF.OPAQUE).toBeFalsy();
    expect(k.stateFlags[id('water')] & SF.WATER).toBeTruthy();
    expect(k.stateLight[id('torch')] >> 4).toBe(14);
    expect(k.stateModel[id('poppy')]).toBeGreaterThanOrEqual(0);
  });

  it('round-trips through the binary cache format', () => {
    const back = deserializePack(serializePack(pack))!;
    expect(back.version).toBe(VERSION);
    expect(back.kernel.key).toBe(pack.kernel.key);
    expect([...back.kernel.models.subarray(0, 200)]).toEqual([
      ...pack.kernel.models.subarray(0, 200),
    ]);
    expect(back.kernel.mips[0]).toEqual(pack.kernel.mips[0]);
    expect(deserializePack(Buffer.from('garbage'))).toBeUndefined();
  });
});

describe('render kernel', () => {
  let kernel: ViewKernel;
  beforeAll(() => {
    kernel = posseViewKernel();
    kernel.setPack(pack.kernel);
  });

  it('is deterministic', () => {
    const a = kernel.render(tinyScene(), pack.kernel.key);
    const b = kernel.render(tinyScene(), pack.kernel.key);
    expect(a.width).toBe(48);
    expect(a.rgba.length).toBe(48 * 32 * 4);
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
  });

  it('draws sky above and terrain below', () => {
    const { rgba } = kernel.render(
      { ...tinyScene(), camera: { x: 8.5, y: 64, z: 3.5, yaw: 0, pitch: 10, fov: 70 } },
      pack.kernel.key,
    );
    const px = (x: number, y: number) => [...rgba.subarray((y * 48 + x) * 4, (y * 48 + x) * 4 + 3)];
    const [sr, , sb] = px(24, 0);
    expect(sb).toBeGreaterThan(sr); // blue sky
    const [gr, , gb] = px(24, 31);
    expect(gr).toBeGreaterThan(gb); // grey-brown stone floor, not sky
  });

  it('renders a region seen from outside it', () => {
    // From above and to the side of the region, looking down at it.
    const job = { ...tinyScene(), camera: { x: -1, y: 66, z: 8, yaw: -90, pitch: 45, fov: 70 } };
    const seen = kernel.render(job, pack.kernel.key).rgba;
    const empty = kernel.render(
      { ...job, region: { ...job.region, states: new Uint16Array(16 ** 3) } },
      pack.kernel.key,
    ).rgba;
    const at = (a: Uint8Array) => [...a.subarray((16 * 48 + 24) * 4, (16 * 48 + 24) * 4 + 3)];
    expect(at(seen)).not.toEqual(at(empty));
  });

  it('is self-contained: its source text renders the same picture in a fresh scope', () => {
    // What the worker does: evaluate the function's source with no module scope around it.
    const fresh = new Function(kernelSource())() as ViewKernel;
    fresh.setPack(pack.kernel);
    const a = fresh.render(tinyScene(), pack.kernel.key);
    const b = kernel.render(tinyScene(), pack.kernel.key);
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
    expect(workerSource()).toContain('parentPort');
  });

  it("renders the same picture in an eval'd worker thread", async () => {
    const runner = new WorkerRunner();
    try {
      const a = await runner.render(tinyScene(), pack.kernel);
      const b = kernel.render(tinyScene(), pack.kernel.key);
      expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
    } finally {
      await runner.close();
    }
  });

  it('renders the nether and night without sky light', () => {
    const night = kernel.render({ ...tinyScene(), timeOfDay: 18000 }, pack.kernel.key);
    const day = kernel.render(tinyScene(), pack.kernel.key);
    const sum = (a: Uint8Array) => a.reduce((s, v) => s + v, 0);
    expect(sum(night.rgba)).toBeLessThan(sum(day.rgba));
    const nether = kernel.render(
      { ...tinyScene(), dimension: 'minecraft:the_nether' },
      pack.kernel.key,
    );
    expect(nether.rgba.length).toBe(day.rgba.length);
  });

  it('draws the held block or the arm over the bottom-right corner', () => {
    const plain = kernel.render(tinyScene(), pack.kernel.key).rgba;
    const withBlock = kernel.render(
      { ...tinyScene(), hand: { kind: 'block', state: id('stone') } },
      pack.kernel.key,
    ).rgba;
    const withArm = kernel.render({ ...tinyScene(), hand: { kind: 'arm' } }, pack.kernel.key).rgba;
    const at = (a: Uint8Array, x: number, y: number) => [
      ...a.subarray((y * 48 + x) * 4, (y * 48 + x) * 4 + 3),
    ];
    expect(at(withBlock, 40, 30)).not.toEqual(at(plain, 40, 30));
    // The palette pack has no skin, so the arm is skipped rather than drawn wrong.
    expect(Buffer.from(withArm).equals(Buffer.from(plain))).toBe(true);
    // Top-left stays untouched.
    expect(at(withBlock, 2, 2)).toEqual(at(plain, 2, 2));
  });

  it('reports the brightness at the eyes (day vs night)', () => {
    expect(kernel.render(tinyScene(), pack.kernel.key).eyeBrightness).toBeCloseTo(1, 1);
    expect(
      kernel.render({ ...tinyScene(), timeOfDay: 18000 }, pack.kernel.key).eyeBrightness,
    ).toBeLessThan(0.2);
  });

  it('degrades on unknown states and short region arrays', () => {
    const job = tinyScene();
    job.region.states[5] = 65000;
    expect(() => kernel.render(job, pack.kernel.key)).not.toThrow();
    const short = { ...tinyScene(), region: { ...tinyScene().region, states: new Uint16Array(3) } };
    expect(() => kernel.render(short, pack.kernel.key)).not.toThrow();
  });
});

describe('HUD helpers', () => {
  it('picks the game GUI scale', () => {
    expect(guiScale(640, 360)).toBe(1);
    expect(guiScale(1280, 720)).toBe(3);
    expect(guiScale(1920, 1080)).toBe(4);
  });

  it('measures text with the font widths', () => {
    const widths = Array(256).fill(6);
    widths[32] = 4;
    expect(textWidth({ sprites: {}, items: {}, fontWidths: widths }, 'a b')).toBe(15);
  });

  it('inverts what is behind the crosshair', () => {
    const frame = { width: 1, height: 1, data: new Uint8Array([200, 50, 0, 255]) };
    blit(frame, { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }, 0, 0, 1, {
      invert: true,
    });
    expect([...frame.data]).toEqual([55, 205, 255, 255]);
  });

  it('darkens the frame edges by the vignette only when it is dark', () => {
    const vignette = {
      width: 2,
      height: 1,
      data: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]),
    };
    const hud = { sprites: { vignette }, items: {} };
    const frame = () => ({
      width: 2,
      height: 1,
      data: new Uint8Array([200, 200, 200, 255, 200, 200, 200, 255]),
    });
    const day = frame();
    drawVignette(day, hud, 1);
    expect([...day.data]).toEqual([...frame().data]);
    const night = frame();
    drawVignette(night, hud, 0.25);
    expect(night.data[0]).toBe(50);
    expect(night.data[4]).toBe(200);
  });

  it('picks the held item for the first-person view', () => {
    const base = {
      version: VERSION,
      hud: { health: 20, food: 20, selectedSlot: 0, hotbar: [null] },
    } as unknown as ViewScene;
    expect(handFor(base, pack)).toEqual({ kind: 'arm' });
    const withIcon = {
      ...pack,
      hud: {
        ...pack.hud,
        items: { stick: { width: 16, height: 16, data: new Uint8Array(1024) } },
        blockItems: ['stone'],
      },
    };
    const holding = (name: string) =>
      ({ ...base, hud: { ...base.hud!, hotbar: [{ name, count: 1 }] } }) as ViewScene;
    expect(handFor(holding('stick'), withIcon).kind).toBe('item');
    expect(handFor(holding('stone'), withIcon)).toEqual({ kind: 'block', state: id('stone') });
    expect(handFor(holding('unknown_thing'), withIcon)).toEqual({ kind: 'arm' });
  });

  it('projects world points like the kernel camera', () => {
    const cam = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, fov: 70 };
    expect(projectPoint(cam, 640, 360, 0, 0, 10)).toMatchObject({ x: 320, y: 180, depth: 10 });
    // Facing south (+Z), +X (east) is on the left.
    expect(projectPoint(cam, 640, 360, 2, 0, 10)!.x).toBeLessThan(320);
    expect(projectPoint(cam, 640, 360, 0, 0, -10)).toBeNull();
  });

  it('only fetches skins from Mojang', () => {
    expect(
      isAllowedSkinUrl(
        'http://textures.minecraft.net/texture/1a4af718455d4aab528e7a61f86fa25e6a369d1768dcb13f7df319a713eb810b',
      ),
    ).toBe(true);
    expect(isAllowedSkinUrl('http://127.0.0.1:8080/texture/abcdefabcdefabcdef')).toBe(false);
    expect(
      isAllowedSkinUrl('https://textures.minecraft.net.evil.com/texture/abcdefabcdefabcdef'),
    ).toBe(false);
  });
});

describe('SkinCache', () => {
  const url = 'http://textures.minecraft.net/texture/0123456789abcdef0123456789abcdef';
  const skinPng = encodePng({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(200) });

  it('fetches over https, caches on disk and in memory, and remembers failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'posse-skin-'));
    const calls: string[] = [];
    const ok = (async (u: string) => {
      calls.push(u);
      return new Response(new Uint8Array(skinPng));
    }) as unknown as typeof fetch;
    try {
      const cache = new SkinCache(dir, ok, true);
      expect((await cache.get(url))?.width).toBe(64);
      expect(await cache.get(url)).toBeDefined();
      expect(calls).toEqual([url.replace('http:', 'https:')]);
      // A new cache (fresh process) reads the file without fetching.
      const offline = new SkinCache(dir, ok, false);
      expect((await offline.get(url))?.height).toBe(64);
      expect(calls).toHaveLength(1);
      const failing = new SkinCache(
        join(dir, 'other'),
        (async () => new Response('x', { status: 500 })) as unknown as typeof fetch,
        true,
      );
      expect(await failing.get(url)).toBeUndefined();
      expect(await cache.get('https://example.com/skin.png')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ViewRenderer', () => {
  it('falls back to the palette offline and returns a PNG of the requested size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'posse-view-'));
    const renderer = new ViewRenderer({
      cacheDir: dir,
      workers: 0,
      allowDownload: false,
      fetch: () => Promise.reject(new Error('no network in tests')),
    });
    try {
      const job = tinyScene();
      const scene: ViewScene = {
        version: VERSION,
        width: 64,
        height: 40,
        camera: job.camera,
        region: job.region,
        entities: [
          {
            kind: 'player',
            name: 'player',
            x: 8.5,
            y: 61,
            z: 8.5,
            yaw: 0,
            pitch: 0,
            width: 0.6,
            height: 1.8,
            label: 'Steve',
            skinUrl: 'http://evil.example/skin.png',
          },
        ],
        timeOfDay: 6000,
        raining: true,
        dimension: 'overworld',
        hud: {
          health: 13,
          food: 7,
          hotbar: [{ name: 'stone', count: 3 }, null, null, null, null, null, null, null, null],
          selectedSlot: 0,
          caption: 'bot',
        },
      };
      const result = await renderer.render(scene);
      expect(result.quality).toBe('palette');
      expect(result.width).toBe(64);
      expect(decodePng(result.png)).toMatchObject({ width: 64, height: 40 });
    } finally {
      await renderer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('knows the cloud height and fog style per version', () => {
    expect(versionTraits('1.18.2')).toEqual({ cloudHeight: 192, modernFog: true });
    expect(versionTraits('1.8.9')).toEqual({ cloudHeight: 128, modernFog: false });
  });
});
