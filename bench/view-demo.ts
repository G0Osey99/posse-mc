// Renders a synthetic scene (grass hills, a tree, a pond, stairs, a slab, a torch, flowers and a
// player) with the Posse screenshot renderer, to eyeball fidelity against the game.
//
//   npx tsx bench/view-demo.ts <outDir> [version ...] [--cache <dir>] [--workers <n>]
//     [--time <0-24000>] [--palette] [--yaw <deg>] [--pitch <deg>] [--cam <x,z>] [--slot <0-8>]
//     [--size <WxH>]
//
// The first run per version downloads that version's client jar from Mojang into the cache dir.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import minecraftData from 'minecraft-data';
import { ViewRenderer, type ViewScene } from '../src/view/index.js';
import {
  encodeState,
  isPreFlattening,
  parseStateString,
  type MdBlockLike,
} from '../src/view/assets/states.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const cacheDir = resolve(flag('--cache') ?? join(process.cwd(), 'data', 'posse'));
const workers = Number(flag('--workers') ?? 0);
const time = Number(flag('--time') ?? 3000);
const yawFlag = flag('--yaw');
const pitch = Number(flag('--pitch') ?? 10);
const camFlag = flag('--cam');
const slot = Number(flag('--slot') ?? 0);
const [outW, outH] = (flag('--size') ?? '640x360').split('x').map(Number);
const paletteOnly = args.includes('--palette');
const positional = args.filter((a) => !a.startsWith('--'));
const outDir = positional[0];
if (!outDir) {
  console.error(
    'usage: posse-view-demo <outDir> [version ...] [--cache dir] [--workers n] [--time t] [--palette]',
  );
  process.exit(1);
}
const versions = positional.slice(1).length ? positional.slice(1) : ['1.18.2'];

/** A state id for `name[props]` in a version (flattened ids, or (id << 4) | meta before 1.13). */
function stateId(version: string, spec: string): number {
  const { name, props } = parseStateString(spec);
  if (isPreFlattening(version)) {
    // Reverse lookup in the legacy table: the first id:meta whose modern state matches.
    let fallback = -1;
    for (const [key, modern] of Object.entries(minecraftData.legacy.pc.blocks)) {
      const m = parseStateString(modern);
      if (m.name !== name) continue;
      const [id, meta] = key.split(':').map(Number);
      if (Object.entries(props).every(([k, v]) => m.props[k] === undefined || m.props[k] === v))
        return (id << 4) | meta;
      if (fallback < 0) fallback = (id << 4) | meta;
    }
    return Math.max(0, fallback);
  }
  const block = minecraftData(version).blocksByName[name] as MdBlockLike | undefined;
  return block ? encodeState(block, props) : 0;
}

function noise(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function buildScene(version: string): ViewScene {
  const S = (spec: string) => stateId(version, spec);
  const GRASS = S('grass_block[snowy=false]');
  const DIRT = S('dirt');
  const STONE = S('stone');
  const SAND = S('sand');
  const WATER = S('water[level=0]');
  const LOG = S('oak_log[axis=y]');
  const LEAVES = S('oak_leaves[distance=1,persistent=true]');
  const TALL = S(
    isPreFlattening(version) || !minecraftData(version).blocksByName.short_grass
      ? 'grass'
      : 'short_grass',
  );
  const POPPY = S('poppy');
  const DANDELION = S('dandelion');
  const STAIRS = S('oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]');
  const SLAB = S(
    isPreFlattening(version)
      ? 'stone_slab[type=bottom]'
      : 'smooth_stone_slab[type=bottom,waterlogged=false]',
  );
  const TORCH = S('torch');
  const COBBLE = S('cobblestone');
  const PLANKS = S('oak_planks');
  const GLASS = S('glass');

  const sizeX = 128;
  const sizeY = 96;
  const sizeZ = 128;
  const originX = -64;
  const originY = 30;
  const originZ = -64;
  const states = new Uint16Array(sizeX * sizeY * sizeZ);
  const set = (x: number, y: number, z: number, s: number): void => {
    const lx = x - originX;
    const ly = y - originY;
    const lz = z - originZ;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= sizeX || ly >= sizeY || lz >= sizeZ) return;
    states[(ly * sizeZ + lz) * sizeX + lx] = s;
  };
  const height = (x: number, z: number): number =>
    Math.round(
      64 +
        2.5 * Math.sin(x / 11) +
        2 * Math.cos(z / 14) +
        2 * Math.sin((x + z) / 23) +
        noise(x, z) * 0.6,
    );
  // The camera stands on the highest ground of a patch south-west of the scene, facing the tree.
  let [camBX, camBZ] = camFlag ? camFlag.split(',').map(Number) : [0, -10];
  if (!camFlag) {
    let best = -Infinity;
    for (let x = -4; x <= 6; x++) {
      for (let z = -16; z <= -8; z++) {
        if (height(x, z) > best) {
          best = height(x, z);
          camBX = x;
          camBZ = z;
        }
      }
    }
  }
  const yaw =
    yawFlag !== undefined
      ? Number(yawFlag)
      : (Math.atan2(-(8 - camBX), 14 - camBZ) * 180) / Math.PI;
  const pond = (x: number, z: number): boolean => (x - 14) ** 2 / 60 + (z - 20) ** 2 / 30 < 1;
  const waterLevel = 64;
  for (let x = originX; x < originX + sizeX; x++) {
    for (let z = originZ; z < originZ + sizeZ; z++) {
      let h = height(x, z);
      const inPond = pond(x, z);
      if (inPond) h = Math.min(h, waterLevel - 2);
      for (let y = originY; y <= h; y++)
        set(
          x,
          y,
          z,
          y < h - 3
            ? STONE
            : y < h
              ? DIRT
              : inPond || pond(x + 1, z) || pond(x - 1, z)
                ? SAND
                : GRASS,
        );
      if (inPond) for (let y = h + 1; y <= waterLevel; y++) set(x, y, z, WATER);
      else {
        const r = (x - camBX) ** 2 + (z - camBZ) ** 2 < 9 ? 1 : noise(x * 3, z * 7);
        if (r < 0.12) set(x, h + 1, z, TALL);
        else if (r < 0.135) set(x, h + 1, z, POPPY);
        else if (r < 0.15) set(x, h + 1, z, DANDELION);
      }
    }
  }
  // A tree ahead and to the left.
  const tx = 5;
  const tz = 12;
  const th = height(tx, tz);
  for (let y = th + 1; y <= th + 5; y++) set(tx, y, tz, LOG);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = 3; dy <= 6; dy++) {
        const r = dy >= 5 ? 1 : 2;
        if (Math.abs(dx) > r || Math.abs(dz) > r) continue;
        if (Math.abs(dx) === r && Math.abs(dz) === r && (dy === 6 || noise(dx + 9, dz + dy) < 0.5))
          continue;
        if (dx === 0 && dz === 0 && dy <= 5) continue;
        set(tx + dx, th + dy, tz + dz, LEAVES);
      }
    }
  }
  // A little build near the camera: a cobble platform with stairs, a slab, a torch, a window.
  const bx = -3;
  const bz = 5;
  const bh = height(bx, bz);
  for (let x = bx; x < bx + 4; x++) for (let z = bz; z < bz + 3; z++) set(x, bh + 1, z, COBBLE);
  set(bx + 1, bh + 1, bz - 1, STAIRS);
  set(bx + 2, bh + 2, bz + 1, SLAB);
  set(bx + 3, bh + 2, bz + 2, TORCH);
  for (let y = bh + 2; y <= bh + 4; y++) {
    set(bx, y, bz + 2, PLANKS);
    set(bx + 1, y, bz + 2, y === bh + 3 ? GLASS : PLANKS);
  }

  const camX = camBX + 0.5;
  const camZ = camBZ + 0.5;
  const camY = height(camBX, camBZ) + 1 + 1.62;
  const px = 3.5;
  const pz = 9.5;
  return {
    version,
    width: outW,
    height: outH,
    camera: { x: camX, y: camY, z: camZ, yaw, pitch, fov: 70 },
    region: { originX, originY, originZ, sizeX, sizeY, sizeZ, states },
    entities: [
      {
        kind: 'player',
        name: 'player',
        x: px,
        y: height(3, 9) + 1,
        z: pz,
        yaw: 200,
        pitch: 10,
        width: 0.6,
        height: 1.8,
        label: 'Steve',
      },
      {
        kind: 'mob',
        name: 'cow',
        x: 9.5,
        y: height(9, 6) + 1,
        z: 6.5,
        yaw: 60,
        pitch: 0,
        width: 0.9,
        height: 1.4,
      },
    ],
    timeOfDay: time,
    raining: false,
    dimension: 'overworld',
    hud: {
      health: 17,
      food: 20,
      hotbar: [
        { name: 'diamond_sword', count: 1 },
        { name: 'cobblestone', count: 64 },
        { name: 'oak_planks', count: 23 },
        { name: 'torch', count: 16 },
        null,
        { name: 'bread', count: 7 },
        null,
        { name: 'golden_apple', count: 2 },
        { name: 'oak_log', count: 5 },
      ],
      selectedSlot: slot,
      caption: `Posse ${version} - ${camBX}, ${Math.floor(camY)}, ${camBZ}`,
    },
  };
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  // --palette renders without assets: an empty cache and no downloads.
  const renderer = new ViewRenderer({
    cacheDir: paletteOnly ? join(outDir, '.no-assets') : cacheDir,
    workers,
    allowDownload: !paletteOnly,
  });
  try {
    for (const version of versions) {
      const t0 = performance.now();
      await renderer.prepare(version);
      const prep = performance.now() - t0;
      const scene = buildScene(version);
      const first = await renderer.render(scene);
      const times: number[] = [];
      let last = first;
      for (let i = 0; i < 3; i++) {
        last = await renderer.render(scene);
        times.push(last.ms);
      }
      const file = join(outDir, `${version}${paletteOnly ? '-palette' : ''}.png`);
      writeFileSync(file, last.png);
      console.log(
        `${version}: ${last.quality}, prepare ${prep.toFixed(0)} ms, first ${first.ms.toFixed(0)} ms, then ${times.map((t) => t.toFixed(0)).join('/')} ms → ${file}`,
      );
    }
  } finally {
    await renderer.close();
  }
}

void main();
