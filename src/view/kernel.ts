// The screenshot kernel: a CPU voxel ray marcher that renders a ViewScene region the way the game
// draws it (Minecraft face shading, smooth light + ambient occlusion, biome tint, cutout and
// translucent textures, sky, sun, clouds and fog, player models with skins).
//
// posseViewKernel is SELF-CONTAINED: no imports and no references to module scope, so its source
// text runs as an eval'd worker (`new Worker(\`(${posseViewKernel})()\`, { eval: true })`) even when
// the engine itself was loaded from memory. Only `import type` is allowed in this file; constants
// from kernelTypes.ts are repeated inline below.
import type {
  KernelEntity,
  KernelHand,
  KernelImage,
  KernelJob,
  KernelPack,
  KernelResult,
} from './kernelTypes.js';

export interface ViewKernel {
  setPack(pack: KernelPack): void;
  hasPack(key: string): boolean;
  dropPack(key: string): void;
  render(job: KernelJob, packKey: string): KernelResult;
}

export function posseViewKernel(): ViewKernel {
  const packs = new Map<string, KernelPack>();

  // Faces in DIRS order: down, up, north, south, west, east.
  const FNX = [0, 0, 0, 0, -1, 1];
  const FNY = [-1, 1, 0, 0, 0, 0];
  const FNZ = [0, 0, -1, 1, 0, 0];
  const EF = 68; // floats per element
  const FF = 8; // floats per face

  // State flags (kernelTypes.ts SF).
  const F_OPAQUE = 1;
  const F_AO = 2;
  const F_WATER = 4;
  const F_LAVA = 8;
  const F_WATERLOGGED = 16;
  const F_CULL_SELF = 32;
  const F_NO_AO = 64;
  const F_FLUID = F_WATER | F_LAVA;

  const dirIndex = (x: number, y: number, z: number): number => {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    if (ay >= ax && ay >= az) return y < 0 ? 0 : 1;
    if (az >= ax) return z < 0 ? 2 : 3;
    return x < 0 ? 4 : 5;
  };

  // INV_FACE[(rx * 4 + ry) * 6 + worldFace] = the model face a variant rotation puts there.
  const INV_FACE = new Int8Array(96);
  for (let rx = 0; rx < 4; rx++) {
    for (let ry = 0; ry < 4; ry++) {
      for (let f = 0; f < 6; f++) {
        let x = FNX[f];
        let y = FNY[f];
        let z = FNZ[f];
        for (let k = 0; k < ry; k++) {
          const t = x;
          x = z;
          z = -t;
        }
        for (let k = 0; k < rx; k++) {
          const t = y;
          y = -z;
          z = t;
        }
        INV_FACE[(rx * 4 + ry) * 6 + f] = dirIndex(x, y, z);
      }
    }
  }

  // ── per-render state ────────────────────────────────────────────────────────────────────────
  let P: KernelPack;
  let SX = 0;
  let SY = 0;
  let SZ = 0;
  let PLANE = 0;
  let ORX = 0;
  let ORY = 0;
  let ORZ = 0;
  let STATES: Uint16Array = new Uint16Array(0);
  let BIOMES: Uint16Array | undefined;
  let NSTATES = 0;
  let light = new Uint8Array(0);
  let queue = new Int32Array(0);
  let hasSky = true;
  let ambient = 0;
  // Lightmap (16×16 sky × block levels, rgb).
  const LM = new Float32Array(16 * 16 * 3);
  let pixAngle = 0.001;

  // Hit registers written by the surface tests.
  let hT = 0;
  let hR = 0;
  let hG = 0;
  let hB = 0;
  let hA = 0;
  let hNX = 0;
  let hNY = 0;
  let hNZ = 0;
  let hShade = true;
  /** World face of an axis-aligned hit (-1 otherwise). */
  let hFace = -1;
  /** The face lies on the cell boundary (AO/light sample the neighbour layer). */
  let hBoundary = false;
  let hTint = 0;
  let hLX = 0;
  let hLY = 0;
  let hLZ = 0;
  // Sample registers.
  let sR = 0;
  let sG = 0;
  let sB = 0;
  let sA = 0;

  const stateAt = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return 0;
    const s = STATES[(y * SZ + z) * SX + x];
    return s < NSTATES ? s : 0;
  };
  const flagsAt = (x: number, y: number, z: number): number => P.stateFlags[stateAt(x, y, z)];

  // ── light ───────────────────────────────────────────────────────────────────────────────────
  function computeLight(): void {
    const n = SX * SY * SZ;
    if (light.length < n) light = new Uint8Array(n);
    else light.fill(0, 0, n);
    if (queue.length < n + 1) queue = new Int32Array(n + 1);
    const SL = P.stateLight;
    const S = STATES;
    const qn = n + 1;
    let head = 0;
    let tail = 0;
    const filterOf = (i: number): number => {
      const s = S[i];
      return s < NSTATES ? SL[s] & 15 : 0;
    };
    if (hasSky) {
      for (let z = 0; z < SZ; z++) {
        for (let x = 0; x < SX; x++) {
          let l = 15;
          for (let y = SY - 1; y >= 0; y--) {
            const i = (y * SZ + z) * SX + x;
            const f = filterOf(i);
            if (f >= 15) break;
            if (f > 0) l = l > f ? l - f : 0;
            if (l === 0) break;
            light[i] = l << 4;
          }
        }
      }
      // Seed the spread with lit cells next to darker, light-passing cells.
      for (let y = 0; y < SY; y++) {
        for (let z = 0; z < SZ; z++) {
          for (let x = 0; x < SX; x++) {
            const i = (y * SZ + z) * SX + x;
            const l = light[i] >> 4;
            if (l < 2) continue;
            const want = l - 1;
            if (
              (x > 0 && light[i - 1] >> 4 < want && filterOf(i - 1) < 15) ||
              (x < SX - 1 && light[i + 1] >> 4 < want && filterOf(i + 1) < 15) ||
              (z > 0 && light[i - SX] >> 4 < want && filterOf(i - SX) < 15) ||
              (z < SZ - 1 && light[i + SX] >> 4 < want && filterOf(i + SX) < 15) ||
              (y > 0 && light[i - PLANE] >> 4 < want && filterOf(i - PLANE) < 15)
            ) {
              queue[tail] = i;
              tail = (tail + 1) % qn;
            }
          }
        }
      }
      while (head !== tail) {
        const i = queue[head];
        head = (head + 1) % qn;
        const l = light[i] >> 4;
        if (l < 2) continue;
        const x = i % SX;
        const z = ((i / SX) | 0) % SZ;
        const y = (i / PLANE) | 0;
        for (let d = 0; d < 6; d++) {
          const nx = x + FNX[d];
          const ny = y + FNY[d];
          const nz = z + FNZ[d];
          if (nx < 0 || ny < 0 || nz < 0 || nx >= SX || ny >= SY || nz >= SZ) continue;
          const j = (ny * SZ + nz) * SX + nx;
          const f = filterOf(j);
          if (f >= 15) continue;
          const nl = l - (f > 1 ? f : 1);
          if (nl > light[j] >> 4) {
            light[j] = (nl << 4) | (light[j] & 15);
            queue[tail] = j;
            tail = (tail + 1) % qn;
          }
        }
      }
    }
    // Block light from emitters.
    head = tail = 0;
    for (let i = 0; i < n; i++) {
      const s = S[i];
      if (s === 0 || s >= NSTATES) continue;
      const e = SL[s] >> 4;
      if (e > 0) {
        light[i] = (light[i] & 0xf0) | e;
        queue[tail] = i;
        tail = (tail + 1) % qn;
      }
    }
    while (head !== tail) {
      const i = queue[head];
      head = (head + 1) % qn;
      const l = light[i] & 15;
      if (l < 2) continue;
      const x = i % SX;
      const z = ((i / SX) | 0) % SZ;
      const y = (i / PLANE) | 0;
      for (let d = 0; d < 6; d++) {
        const nx = x + FNX[d];
        const ny = y + FNY[d];
        const nz = z + FNZ[d];
        if (nx < 0 || ny < 0 || nz < 0 || nx >= SX || ny >= SY || nz >= SZ) continue;
        const j = (ny * SZ + nz) * SX + nx;
        const f = filterOf(j);
        if (f >= 15) continue;
        const nl = l - (f > 1 ? f : 1);
        if (nl > (light[j] & 15)) {
          light[j] = (light[j] & 0xf0) | nl;
          queue[tail] = j;
          tail = (tail + 1) % qn;
        }
      }
    }
  }

  /** Sky and block light of a cell (outside the region: open sky). */
  let lSky = 15;
  let lBlk = 0;
  const lightOf = (x: number, y: number, z: number): boolean => {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) {
      lSky = hasSky && y >= 0 ? 15 : 0;
      lBlk = 0;
      return true;
    }
    const i = (y * SZ + z) * SX + x;
    const s = STATES[i];
    if (s < NSTATES && P.stateFlags[s] & F_OPAQUE) return false;
    const v = light[i];
    lSky = v >> 4;
    lBlk = v & 15;
    return true;
  };

  function buildLightmap(skyDarken: number): void {
    const bright = (l: number): number => {
      const f = l / 15;
      const g = f / (4 - 3 * f);
      return g + ambient * (1 - g);
    };
    const svR = skyDarken + (1 - skyDarken) * 0.35;
    const svB = 1;
    for (let s = 0; s < 16; s++) {
      for (let b = 0; b < 16; b++) {
        const sk = hasSky ? bright(s) * skyDarken : 0;
        const bl = bright(b) * 1.5;
        let r = bl + svR * sk;
        let g = bl * ((bl * 0.6 + 0.4) * 0.6 + 0.4) + svR * sk;
        let bb = bl * (bl * bl * 0.6 + 0.4) + svB * sk;
        if (!hasSky) {
          r += ambient * 0.5;
          g += ambient * 0.5;
          bb += ambient * 0.5;
        }
        r = r * 0.96 + 0.03;
        g = g * 0.96 + 0.03;
        bb = bb * 0.96 + 0.03;
        r = r > 1 ? 1 : r;
        g = g > 1 ? 1 : g;
        bb = bb > 1 ? 1 : bb;
        // Gamma option at its default (0.5): halfway to 1 - (1 - c)^4.
        r = r * 0.5 + (1 - Math.pow(1 - r, 4)) * 0.5;
        g = g * 0.5 + (1 - Math.pow(1 - g, 4)) * 0.5;
        bb = bb * 0.5 + (1 - Math.pow(1 - bb, 4)) * 0.5;
        const o = (s * 16 + b) * 3;
        LM[o] = r * 0.96 + 0.03;
        LM[o + 1] = g * 0.96 + 0.03;
        LM[o + 2] = bb * 0.96 + 0.03;
      }
    }
  }

  let lmR = 1;
  let lmG = 1;
  let lmB = 1;
  /** Bilinear lightmap lookup at fractional light levels. */
  const lightmap = (sky: number, blk: number): void => {
    if (sky < 0) sky = 0;
    if (blk < 0) blk = 0;
    if (sky > 15) sky = 15;
    if (blk > 15) blk = 15;
    const s0 = sky | 0;
    const b0 = blk | 0;
    const s1 = s0 < 15 ? s0 + 1 : 15;
    const b1 = b0 < 15 ? b0 + 1 : 15;
    const fs = sky - s0;
    const fb = blk - b0;
    const o00 = (s0 * 16 + b0) * 3;
    const o01 = (s0 * 16 + b1) * 3;
    const o10 = (s1 * 16 + b0) * 3;
    const o11 = (s1 * 16 + b1) * 3;
    const w00 = (1 - fs) * (1 - fb);
    const w01 = (1 - fs) * fb;
    const w10 = fs * (1 - fb);
    const w11 = fs * fb;
    lmR = LM[o00] * w00 + LM[o01] * w01 + LM[o10] * w10 + LM[o11] * w11;
    lmG = LM[o00 + 1] * w00 + LM[o01 + 1] * w01 + LM[o10 + 1] * w10 + LM[o11 + 1] * w11;
    lmB = LM[o00 + 2] * w00 + LM[o01 + 2] * w01 + LM[o10 + 2] * w10 + LM[o11 + 2] * w11;
  };

  // ── textures ────────────────────────────────────────────────────────────────────────────────
  /** Samples atlas texture `tex` at tile coordinates (u, v) in [0, 1] at a mip level. */
  const sample = (tex: number, u: number, v: number, lod: number): void => {
    const cols = P.atlasCols;
    const ts = 16 >> lod;
    const tx = tex % cols;
    const ty = (tex / cols) | 0;
    let iu = (u * ts) | 0;
    let iv = (v * ts) | 0;
    if (iu < 0) iu = 0;
    else if (iu >= ts) iu = ts - 1;
    if (iv < 0) iv = 0;
    else if (iv >= ts) iv = ts - 1;
    const img = P.mips[lod];
    const o = ((ty * ts + iv) * cols * ts + tx * ts + iu) * 4;
    sR = img[o];
    sG = img[o + 1];
    sB = img[o + 2];
    sA = img[o + 3];
  };

  const lodFor = (t: number, cosInc: number): number => {
    const texels = (t * pixAngle * 16) / (cosInc > 0.25 ? cosInc : 0.25);
    if (texels <= 1.5) return 0;
    const l = Math.floor(Math.log2(texels / 1.5)) + 1;
    return l > 4 ? 4 : l;
  };

  let tintR = 1;
  let tintG = 1;
  let tintB = 1;
  /** Resolves a state's tint (kind or fixed colour) at a column's biome. */
  const tintFor = (state: number, x: number, z: number): void => {
    const k = P.stateTint[state];
    let c = 0xffffff;
    if (k > 0) {
      if (k >= 0x1000000) c = k & 0xffffff;
      else {
        let b = 1;
        if (BIOMES && x >= 0 && z >= 0 && x < SX && z < SZ) b = BIOMES[z * SX + x];
        const tbl = k === 1 ? P.biomeGrass : k === 2 ? P.biomeFoliage : P.biomeWater;
        c = b < tbl.length ? tbl[b] : tbl.length > 1 ? tbl[1] : 0xffffff;
      }
    }
    tintR = (c >> 16) / 255;
    tintG = ((c >> 8) & 255) / 255;
    tintB = (c & 255) / 255;
  };

  // ── surface tests ───────────────────────────────────────────────────────────────────────────
  /**
   * Tests one element's front-facing faces (element space) against the ray; on the nearest
   * opaque-enough texel in (tMin, best) writes the hit registers and returns its t.
   */
  function testElement(
    M: Float32Array,
    e: number,
    tMin: number,
    best: number,
    // world ray in cell-local coordinates (for uvlock and the hit point)
    wox: number,
    woy: number,
    woz: number,
    wdx: number,
    wdy: number,
    wdz: number,
    distScale: number,
    cx: number,
    cy: number,
    cz: number,
  ): number {
    const rx = M[e + 14];
    const ry = M[e + 15];
    // World (cell-local) → model space: inverse Y then inverse X quarter turns about the centre.
    let ox = wox - 0.5;
    let oy = woy - 0.5;
    let oz = woz - 0.5;
    let dx = wdx;
    let dy = wdy;
    let dz = wdz;
    for (let k = 0; k < ry; k++) {
      let t = ox;
      ox = oz;
      oz = -t;
      t = dx;
      dx = dz;
      dz = -t;
    }
    for (let k = 0; k < rx; k++) {
      let t = oy;
      oy = -oz;
      oz = t;
      t = dy;
      dy = -dz;
      dz = t;
    }
    ox += 0.5;
    oy += 0.5;
    oz += 0.5;
    const axis = M[e + 6];
    if (axis !== 0) {
      // Element rotation: undo the rescale, then rotate by -angle about the origin.
      const c = M[e + 7];
      const s = M[e + 8];
      const sc = M[e + 12];
      const px = M[e + 9];
      const py = M[e + 10];
      const pz = M[e + 11];
      let qx = ox - px;
      let qy = oy - py;
      let qz = oz - pz;
      let vx = dx;
      let vy = dy;
      let vz = dz;
      if (axis === 1) {
        qy *= sc;
        qz *= sc;
        vy *= sc;
        vz *= sc;
        let a = qy * c + qz * s;
        qz = -qy * s + qz * c;
        qy = a;
        a = vy * c + vz * s;
        vz = -vy * s + vz * c;
        vy = a;
      } else if (axis === 2) {
        qx *= sc;
        qz *= sc;
        vx *= sc;
        vz *= sc;
        let a = qx * c - qz * s;
        qz = qx * s + qz * c;
        qx = a;
        a = vx * c - vz * s;
        vz = vx * s + vz * c;
        vx = a;
      } else {
        qx *= sc;
        qy *= sc;
        vx *= sc;
        vy *= sc;
        let a = qx * c + qy * s;
        qy = -qx * s + qy * c;
        qx = a;
        a = vx * c + vy * s;
        vy = -vx * s + vy * c;
        vx = a;
      }
      ox = qx + px;
      oy = qy + py;
      oz = qz + pz;
      dx = vx;
      dy = vy;
      dz = vz;
    }
    const x0 = M[e];
    const y0 = M[e + 1];
    const z0 = M[e + 2];
    const x1 = M[e + 3];
    const y1 = M[e + 4];
    const z1 = M[e + 5];
    const EPS = 1e-5;
    let found = best;
    for (let f = 0; f < 6; f++) {
      const fo = e + 20 + f * FF;
      const tex = M[fo];
      if (tex < 0) continue;
      let t: number;
      let s: number;
      let tt: number;
      // Only faces that face the ray are drawn (back-face culling).
      if (f === 0) {
        if (dy <= 0) continue;
        t = (y0 - oy) / dy;
      } else if (f === 1) {
        if (dy >= 0) continue;
        t = (y1 - oy) / dy;
      } else if (f === 2) {
        if (dz <= 0) continue;
        t = (z0 - oz) / dz;
      } else if (f === 3) {
        if (dz >= 0) continue;
        t = (z1 - oz) / dz;
      } else if (f === 4) {
        if (dx <= 0) continue;
        t = (x0 - ox) / dx;
      } else {
        if (dx >= 0) continue;
        t = (x1 - ox) / dx;
      }
      if (!(t > tMin) || t >= found) continue;
      const px = ox + dx * t;
      const py = oy + dy * t;
      const pz = oz + dz * t;
      if (f < 2) {
        if (px < x0 - EPS || px > x1 + EPS || pz < z0 - EPS || pz > z1 + EPS) continue;
      } else if (f < 4) {
        if (px < x0 - EPS || px > x1 + EPS || py < y0 - EPS || py > y1 + EPS) continue;
      } else if (py < y0 - EPS || py > y1 + EPS || pz < z0 - EPS || pz > z1 + EPS) continue;
      const wx = wox + wdx * t;
      const wy = woy + wdy * t;
      const wz = woz + wdz * t;
      // World face of this face (variant rotation applied to its normal).
      let nx = FNX[f];
      let ny = FNY[f];
      let nz = FNZ[f];
      if (axis !== 0) {
        const c = M[e + 7];
        const sn = M[e + 8];
        if (axis === 1) {
          const a = ny * c - nz * sn;
          nz = ny * sn + nz * c;
          ny = a;
        } else if (axis === 2) {
          const a = nx * c + nz * sn;
          nz = -nx * sn + nz * c;
          nx = a;
        } else {
          const a = nx * c - ny * sn;
          ny = nx * sn + ny * c;
          nx = a;
        }
      }
      for (let k = 0; k < rx; k++) {
        const a = ny;
        ny = nz;
        nz = -a;
      }
      for (let k = 0; k < ry; k++) {
        const a = nx;
        nx = -nz;
        nz = a;
      }
      // Axis-aligned faces on the cell boundary are culled against opaque neighbours.
      let face = -1;
      let boundary = false;
      if (Math.abs(nx) > 0.999 || Math.abs(ny) > 0.999 || Math.abs(nz) > 0.999) {
        face = dirIndex(nx, ny, nz);
        const along = face < 2 ? wy : face < 4 ? wz : wx;
        boundary = (face & 1) === 1 ? along > 1 - 1e-4 : along < 1e-4;
        if (boundary && flagsAt(cx + FNX[face], cy + FNY[face], cz + FNZ[face]) & F_OPAQUE)
          continue;
      }
      if (M[e + 16] && (rx || ry)) {
        // uvlock: the texture follows world position.
        const wf = dirIndex(nx, ny, nz);
        if (wf === 0) {
          s = wx;
          tt = 1 - wz;
        } else if (wf === 1) {
          s = wx;
          tt = wz;
        } else if (wf === 2) {
          s = 1 - wx;
          tt = 1 - wy;
        } else if (wf === 3) {
          s = wx;
          tt = 1 - wy;
        } else if (wf === 4) {
          s = wz;
          tt = 1 - wy;
        } else {
          s = 1 - wz;
          tt = 1 - wy;
        }
        s -= Math.floor(s);
        tt -= Math.floor(tt);
      } else {
        const ex = x1 - x0 > 1e-6 ? x1 - x0 : 1;
        const ey = y1 - y0 > 1e-6 ? y1 - y0 : 1;
        const ez = z1 - z0 > 1e-6 ? z1 - z0 : 1;
        if (f === 0) {
          s = (px - x0) / ex;
          tt = (z1 - pz) / ez;
        } else if (f === 1) {
          s = (px - x0) / ex;
          tt = (pz - z0) / ez;
        } else if (f === 2) {
          s = (x1 - px) / ex;
          tt = (y1 - py) / ey;
        } else if (f === 3) {
          s = (px - x0) / ex;
          tt = (y1 - py) / ey;
        } else if (f === 4) {
          s = (pz - z0) / ez;
          tt = (y1 - py) / ey;
        } else {
          s = (z1 - pz) / ez;
          tt = (y1 - py) / ey;
        }
        const rot = M[fo + 5];
        if (rot === 1) {
          const a = s;
          s = tt;
          tt = 1 - a;
        } else if (rot === 2) {
          s = 1 - s;
          tt = 1 - tt;
        } else if (rot === 3) {
          const a = s;
          s = 1 - tt;
          tt = a;
        }
        s = M[fo + 1] + s * (M[fo + 3] - M[fo + 1]);
        tt = M[fo + 2] + tt * (M[fo + 4] - M[fo + 2]);
      }
      const cosInc = Math.abs(nx * wdx + ny * wdy + nz * wdz);
      sample(tex, s, tt, lodFor(t * distScale, cosInc));
      const tflags = P.texFlags[tex];
      if (tflags & 2) {
        if (sA < 8) continue;
      } else if (sA < 128) continue;
      found = t;
      hT = t;
      hR = sR;
      hG = sG;
      hB = sB;
      hA = tflags & 2 ? sA : 255;
      hNX = nx;
      hNY = ny;
      hNZ = nz;
      hShade = M[e + 13] !== 0;
      hTint = M[fo + 6];
      hLX = wx;
      hLY = wy;
      hLZ = wz;
      hFace = face;
      hBoundary = boundary;
    }
    return found;
  }

  /**
   * The nearest visible surface of cell (cx, cy, cz) after tMin along the ray (origin given in
   * cell-local coordinates). `enterFace` is the world face the ray entered through (-1 when it
   * started inside or is continuing behind a translucent surface).
   */
  function cellSurface(
    state: number,
    cx: number,
    cy: number,
    cz: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    tMin: number,
    enterFace: number,
    prevState: number,
    distScale: number,
  ): boolean {
    const flags = P.stateFlags[state];
    let best = Infinity;
    hTint = 0;
    // Fluid: a box from the floor to the surface; faces against the same fluid or opaque blocks
    // are culled.
    const fluidFlags = flags & F_FLUID ? flags & F_FLUID : flags & F_WATERLOGGED ? F_WATER : 0;
    if (fluidFlags) {
      const above = flagsAt(cx, cy + 1, cz);
      const aboveSame =
        (above & F_FLUID ? above & F_FLUID : above & F_WATERLOGGED ? F_WATER : 0) === fluidFlags;
      const level = flags >> 12;
      const h = aboveSame ? 1 : level >= 8 ? 1 : level === 0 ? 8 / 9 : (8 - level) / 9;
      const tex = fluidFlags === F_WATER ? P.waterTex : P.lavaTex;
      for (let f = 0; f < 6; f++) {
        let t: number;
        if (f === 0) {
          if (dy <= 0) continue;
          t = -oy / dy;
        } else if (f === 1) {
          if (dy >= 0) continue;
          t = (h - oy) / dy;
        } else if (f === 2) {
          if (dz <= 0) continue;
          t = -oz / dz;
        } else if (f === 3) {
          if (dz >= 0) continue;
          t = (1 - oz) / dz;
        } else if (f === 4) {
          if (dx <= 0) continue;
          t = -ox / dx;
        } else {
          if (dx >= 0) continue;
          t = (1 - ox) / dx;
        }
        if (!(t > tMin) || t >= best) continue;
        const px = ox + dx * t;
        const py = oy + dy * t;
        const pz = oz + dz * t;
        if (
          px < -1e-5 ||
          px > 1 + 1e-5 ||
          pz < -1e-5 ||
          pz > 1 + 1e-5 ||
          py < -1e-5 ||
          py > h + 1e-5
        )
          continue;
        if (f !== 1 || aboveSame) {
          const nf = flagsAt(cx + FNX[f], cy + FNY[f], cz + FNZ[f]);
          const nFluid = nf & F_FLUID ? nf & F_FLUID : nf & F_WATERLOGGED ? F_WATER : 0;
          if (nFluid === fluidFlags || nf & F_OPAQUE) continue;
        }
        let u: number;
        let v: number;
        if (f < 2) {
          u = px;
          v = pz;
        } else if (f < 4) {
          u = px;
          v = 1 - py;
        } else {
          u = pz;
          v = 1 - py;
        }
        if (tex >= 0)
          sample(
            tex,
            u - Math.floor(u),
            v - Math.floor(v),
            lodFor(t * distScale, Math.abs(f < 2 ? dy : f < 4 ? dz : dx)),
          );
        else if (fluidFlags === F_WATER) {
          sR = sG = sB = 200;
          sA = 170;
        } else {
          sR = 220;
          sG = 90;
          sB = 20;
          sA = 255;
        }
        best = t;
        hT = t;
        hR = sR;
        hG = sG;
        hB = sB;
        hA = fluidFlags === F_WATER ? (sA > 40 ? sA : 40) : 255;
        hNX = FNX[f];
        hNY = FNY[f];
        hNZ = FNZ[f];
        hShade = true;
        hTint = fluidFlags === F_WATER ? -2 : 0;
        hFace = f;
        hBoundary = f !== 1 || h >= 1;
        hLX = px;
        hLY = py;
        hLZ = pz;
      }
    }
    const mo = P.stateModel[state];
    if (mo >= 0) {
      const M = P.models;
      const nAlt = M[mo];
      let alt = M[mo + 3];
      if (nAlt > 1) {
        const wx = cx + ORX;
        const wy = cy + ORY;
        const wz = cz + ORZ;
        let h = Math.imul(wx, 3129871) ^ Math.imul(wz, 116129781) ^ wy;
        h = Math.imul(Math.imul(h, h), 42317861) + Math.imul(h, 11);
        let pick = ((h >>> 16) & 0x7fff) % M[mo + 1];
        for (let i = 0; i < nAlt; i++) {
          pick -= M[mo + 2 + i * 2];
          if (pick < 0) {
            alt = M[mo + 3 + i * 2];
            break;
          }
        }
      }
      const nEl = M[alt];
      const full = M[alt + 1] !== 0;
      if (full && enterFace >= 0) {
        // Fast path: unrotated full cubes are hit on the face the ray entered through.
        if (!(flags & F_CULL_SELF && prevState === state) && tMin < best) {
          const px = ox + dx * tMin;
          const py = oy + dy * tMin;
          const pz = oz + dz * tMin;
          for (let i = nEl - 1; i >= 0; i--) {
            const e = alt + 2 + i * EF;
            const rx = M[e + 14];
            const ry = M[e + 15];
            const mf = INV_FACE[(rx * 4 + ry) * 6 + enterFace];
            const fo = e + 20 + mf * FF;
            const tex = M[fo];
            if (tex < 0) continue;
            // Model-space hit point.
            let mx = px - 0.5;
            let my = py - 0.5;
            let mz = pz - 0.5;
            for (let k = 0; k < ry; k++) {
              const t = mx;
              mx = mz;
              mz = -t;
            }
            for (let k = 0; k < rx; k++) {
              const t = my;
              my = -mz;
              mz = t;
            }
            mx += 0.5;
            my += 0.5;
            mz += 0.5;
            let s: number;
            let tt: number;
            if (M[e + 16] && (rx || ry)) {
              mx = px;
              my = py;
              mz = pz;
            }
            const lf = M[e + 16] && (rx || ry) ? enterFace : mf;
            if (lf === 0) {
              s = mx;
              tt = 1 - mz;
            } else if (lf === 1) {
              s = mx;
              tt = mz;
            } else if (lf === 2) {
              s = 1 - mx;
              tt = 1 - my;
            } else if (lf === 3) {
              s = mx;
              tt = 1 - my;
            } else if (lf === 4) {
              s = mz;
              tt = 1 - my;
            } else {
              s = 1 - mz;
              tt = 1 - my;
            }
            if (!(M[e + 16] && (rx || ry))) {
              const rot = M[fo + 5];
              if (rot === 1) {
                const a = s;
                s = tt;
                tt = 1 - a;
              } else if (rot === 2) {
                s = 1 - s;
                tt = 1 - tt;
              } else if (rot === 3) {
                const a = s;
                s = 1 - tt;
                tt = a;
              }
              s = M[fo + 1] + s * (M[fo + 3] - M[fo + 1]);
              tt = M[fo + 2] + tt * (M[fo + 4] - M[fo + 2]);
            }
            const cosInc = Math.abs(enterFace < 2 ? dy : enterFace < 4 ? dz : dx);
            sample(tex, s, tt, lodFor(tMin * distScale, cosInc));
            const tflags = P.texFlags[tex];
            if (tflags & 2) {
              if (sA < 8) continue;
            } else if (sA < 128) continue;
            hT = tMin;
            hR = sR;
            hG = sG;
            hB = sB;
            hA = tflags & 2 ? sA : 255;
            hNX = FNX[enterFace];
            hNY = FNY[enterFace];
            hNZ = FNZ[enterFace];
            hShade = M[e + 13] !== 0;
            hTint = M[fo + 6];
            hFace = enterFace;
            hBoundary = true;
            hLX = px;
            hLY = py;
            hLZ = pz;
            best = tMin;
            break;
          }
        }
      } else if (!full || enterFace < 0) {
        for (let i = 0; i < nEl; i++) {
          const e = alt + 2 + i * EF;
          best = testElement(M, e, tMin, best, ox, oy, oz, dx, dy, dz, distScale, cx, cy, cz);
        }
      }
    }
    return best < Infinity;
  }

  // ── shading ─────────────────────────────────────────────────────────────────────────────────
  let aoOut = 1;
  let skyOut = 15;
  let blkOut = 0;
  /**
   * Smooth light and ambient occlusion of the current hit: the four vertex values of the face
   * (from the 3×3 cells of the layer in front of it) interpolated at the hit point.
   */
  function smoothLight(cx: number, cy: number, cz: number, useAO: boolean): void {
    const f = hFace;
    if (f < 0) {
      if (lightOf(cx, cy, cz)) {
        skyOut = lSky;
        blkOut = lBlk;
      } else {
        skyOut = 15;
        blkOut = 0;
      }
      aoOut = 1;
      return;
    }
    // The layer in front of the face.
    let lx = cx;
    let ly = cy;
    let lz = cz;
    if (hBoundary) {
      lx += FNX[f];
      ly += FNY[f];
      lz += FNZ[f];
    }
    // Face plane axes (a, b) and the hit's fractional position on them.
    let ax = 0;
    const ay = 0;
    let az = 0;
    const bx = 0;
    let by = 0;
    let bz = 0;
    let fa: number;
    let fb: number;
    if (f < 2) {
      ax = 1;
      bz = 1;
      fa = hLX;
      fb = hLZ;
    } else if (f < 4) {
      ax = 1;
      by = 1;
      fa = hLX;
      fb = hLY;
    } else {
      az = 1;
      by = 1;
      fa = hLZ;
      fb = hLY;
    }
    fa = fa < 0 ? 0 : fa > 1 ? 1 : fa;
    fb = fb < 0 ? 0 : fb > 1 ? 1 : fb;
    let centerSky = 0;
    let centerBlk = 0;
    if (lightOf(lx, ly, lz)) {
      centerSky = lSky;
      centerBlk = lBlk;
    } else if (lightOf(cx, cy, cz)) {
      centerSky = lSky;
      centerBlk = lBlk;
    }
    const centerOcc = useAO && flagsAt(lx, ly, lz) & F_AO ? 0.2 : 1;
    let accAO = 0;
    let accSky = 0;
    let accBlk = 0;
    for (let corner = 0; corner < 4; corner++) {
      const sa = corner & 1 ? 1 : -1;
      const sb = corner & 2 ? 1 : -1;
      const x1 = lx + ax * sa;
      const y1 = ly + ay * sa;
      const z1 = lz + az * sa;
      const x2 = lx + bx * sb;
      const y2 = ly + by * sb;
      const z2 = lz + bz * sb;
      const x3 = x1 + bx * sb;
      const y3 = y1 + by * sb;
      const z3 = z1 + bz * sb;
      let vSky = centerSky;
      let vBlk = centerBlk;
      let cnt = 1;
      const o1 = useAO && flagsAt(x1, y1, z1) & F_AO;
      const o2 = useAO && flagsAt(x2, y2, z2) & F_AO;
      if (lightOf(x1, y1, z1)) {
        vSky += lSky;
        vBlk += lBlk;
        cnt++;
      }
      if (lightOf(x2, y2, z2)) {
        vSky += lSky;
        vBlk += lBlk;
        cnt++;
      }
      let o3: boolean;
      if (o1 && o2) o3 = true;
      else {
        o3 = !!(useAO && flagsAt(x3, y3, z3) & F_AO);
        if (lightOf(x3, y3, z3)) {
          vSky += lSky;
          vBlk += lBlk;
          cnt++;
        }
      }
      const ao = (centerOcc + (o1 ? 0.2 : 1) + (o2 ? 0.2 : 1) + (o3 ? 0.2 : 1)) / 4;
      const w = (sa > 0 ? fa : 1 - fa) * (sb > 0 ? fb : 1 - fb);
      accAO += ao * w;
      accSky += (vSky / cnt) * w;
      accBlk += (vBlk / cnt) * w;
    }
    aoOut = accAO;
    skyOut = accSky;
    blkOut = accBlk;
  }

  // ── sky ─────────────────────────────────────────────────────────────────────────────────────
  let skyR = 0.47;
  let skyG = 0.65;
  let skyB = 1;
  let fogR = 0.75;
  let fogG = 0.85;
  let fogB = 1;
  let sunX = 0;
  let sunY = 1;
  let sunAngle = 0;
  let sunrise = 0;
  let sunriseR = 1;
  let sunriseG = 0.5;
  let sunriseB = 0.2;
  let cloudR = 1;
  let cloudG = 1;
  let cloudB = 1;
  let rainK = 0;
  let starK = 0;
  let celestial = 0;
  let camX = 0;
  let camY = 0;
  let camZ = 0;
  let cloudY = 192;
  let cloudShift = 0;
  let skyFogDist = 160;

  let oR = 0;
  let oG = 0;
  let oB = 0;
  /** Sky colour along a direction (gradient, sunrise glow, sun/moon, clouds). */
  function skyColor(dx: number, dy: number, dz: number): void {
    if (!hasSky) {
      oR = fogR;
      oG = fogG;
      oB = fogB;
      return;
    }
    let r: number;
    let g: number;
    let b: number;
    if (dy > 0) {
      let f = 16 / (dy * skyFogDist);
      if (f > 1) f = 1;
      r = skyR + (fogR - skyR) * f;
      g = skyG + (fogG - skyG) * f;
      b = skyB + (fogB - skyB) * f;
    } else {
      r = fogR;
      g = fogG;
      b = fogB;
    }
    // Stars at night: a fixed random field on the sky sphere, about one pixel each.
    if (starK > 0 && dy > 0) {
      const sx = Math.floor(dx * 300);
      const sy = Math.floor(dy * 300);
      const sz = Math.floor(dz * 300);
      let h = Math.imul(sx, 73856093) ^ Math.imul(sy, 19349663) ^ Math.imul(sz, 83492791);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      if ((h & 1023) < 2) {
        const v = starK * (0.5 + ((h >>> 10) & 255) / 512);
        r += v;
        g += v;
        b += v;
      }
    }
    // Sunrise / sunset glow towards the sun's side of the horizon.
    if (sunrise > 0) {
      const side = sunX > 0 ? dx : -dx;
      if (side > -0.2) {
        const el = dy < 0 ? -dy * 3 : dy;
        let w = sunrise * Math.pow((side + 0.2) / 1.2, 3) * (1 - (el > 0.7 ? 1 : el / 0.7));
        if (w > 0) {
          if (w > 1) w = 1;
          r += (sunriseR - r) * w;
          g += (sunriseG - g) * w;
          b += (sunriseB - b) * w;
        }
      }
    }
    // Sun and moon (additive), on planes 100 blocks out.
    const rainVis = 1 - rainK;
    if (rainVis > 0 && dy > -0.3) {
      const k = dx * sunX + dy * sunY;
      if (k > 0 && P.sun) {
        // Sun plane basis: U = +z, V = (-cos θ, -sin θ, 0).
        const u = (dz / k) * (100 / 30);
        const v = ((-Math.cos(sunAngle) * dx - Math.sin(sunAngle) * dy) / k) * (100 / 30);
        if (u > -1 && u < 1 && v > -1 && v < 1) {
          const img = P.sun;
          const ix = (((u + 1) / 2) * img.width) | 0;
          const iy = (((v + 1) / 2) * img.height) | 0;
          const o = (iy * img.width + ix) * 4;
          const a = (img.data[o + 3] / 255) * rainVis;
          r += (img.data[o] / 255) * a;
          g += (img.data[o + 1] / 255) * a;
          b += (img.data[o + 2] / 255) * a;
        }
      } else if (k < 0 && P.moon) {
        const km = -k;
        const u = (-dz / km) * (100 / 20);
        const v = ((Math.cos(sunAngle) * dx + Math.sin(sunAngle) * dy) / km) * (100 / 20);
        if (u > -1 && u < 1 && v > -1 && v < 1) {
          const img = P.moon;
          // Phase 0 (full moon): the first of a 4×2 grid (one image per phase from 26.1).
          const grid = img.width >= img.height * 2;
          const cw = grid ? img.width / 4 : img.width;
          const ch = grid ? img.height / 2 : img.height;
          const ix = (((u + 1) / 2) * cw) | 0;
          const iy = (((v + 1) / 2) * ch) | 0;
          const o = (iy * img.width + ix) * 4;
          const a = (img.data[o + 3] / 255) * rainVis;
          r += (img.data[o] / 255) * a;
          g += (img.data[o + 1] / 255) * a;
          b += (img.data[o + 2] / 255) * a;
        }
      }
    }
    // Clouds: the vanilla texture, 12 blocks per texel, on a plane.
    if (P.clouds && dy !== 0) {
      const t = (cloudY - camY) / dy;
      if (t > 0) {
        const hx = camX + dx * t;
        const hz = camZ + dz * t + cloudShift;
        const dist = t * Math.sqrt(dx * dx + dz * dz);
        if (dist < 600) {
          const img = P.clouds;
          let ix = Math.floor(hx / 12) % img.width;
          let iz = Math.floor(hz / 12) % img.height;
          if (ix < 0) ix += img.width;
          if (iz < 0) iz += img.height;
          const ca = img.data[(iz * img.width + ix) * 4 + 3];
          if (ca > 0) {
            let a = 0.8 * (dist < 200 ? 1 : 1 - (dist - 200) / 400);
            // Clouds fade into the fog colour with distance.
            const ff = dist / 600;
            const cr = cloudR + (fogR - cloudR) * ff;
            const cg = cloudG + (fogG - cloudG) * ff;
            const cb = cloudB + (fogB - cloudB) * ff;
            a *= ca / 255;
            r += (cr - r) * a;
            g += (cg - g) * a;
            b += (cb - b) * a;
          }
        }
      }
    }
    oR = r > 1 ? 1 : r;
    oG = g > 1 ? 1 : g;
    oB = b > 1 ? 1 : b;
  }

  // ── entities ────────────────────────────────────────────────────────────────────────────────
  interface EBox {
    // Box in part-local pixels.
    x0: number;
    y0: number;
    z0: number;
    x1: number;
    y1: number;
    z1: number;
    /** Skin UV origin and box size (texture pixels). */
    u: number;
    v: number;
    w: number;
    h: number;
    d: number;
    head: boolean;
    mirror: boolean;
    overlay: boolean;
    /** Colour when there is no skin (0xRRGGBB, -1 = the entity's colour). */
    color: number;
  }
  interface EPrep {
    e: KernelEntity;
    skin: KernelImage | undefined;
    cos: number;
    sin: number;
    scale: number;
    pc: number;
    ps: number;
    boxes: EBox[];
    color: number;
    // screen rect
    sx0: number;
    sy0: number;
    sx1: number;
    sy1: number;
    // world AABB
    ax0: number;
    ay0: number;
    az0: number;
    ax1: number;
    ay1: number;
    az1: number;
    sky: number;
    blk: number;
  }

  const MOB_COLORS: Record<string, number> = {
    zombie: 0x4f7a3a,
    husk: 0x8a7b5a,
    drowned: 0x4a8b8b,
    skeleton: 0xbcbcbc,
    stray: 0x9fb1b1,
    creeper: 0x4fa83a,
    spider: 0x3a322c,
    cave_spider: 0x1d3c45,
    enderman: 0x161616,
    cow: 0x4a3a2a,
    pig: 0xeaa0a0,
    sheep: 0xe8e8e8,
    chicken: 0xf2f2f2,
    villager: 0x8a6b4f,
    iron_golem: 0xc9c2b4,
    slime: 0x6fbf5a,
    blaze: 0xe8b32a,
    witch: 0x3b2a4a,
    wolf: 0xd8d2cc,
    horse: 0x7a5232,
    item: 0xd9b23a,
    experience_orb: 0xb8f03a,
  };

  function playerBoxes(slim: boolean, legacy: boolean): EBox[] {
    const out: EBox[] = [];
    const arm = slim ? 3 : 4;
    const add = (
      x0: number,
      y0: number,
      z0: number,
      w: number,
      h: number,
      d: number,
      u: number,
      v: number,
      head: boolean,
      inflate: number,
      mirror: boolean,
      color: number,
    ): void => {
      out.push({
        x0: x0 - inflate,
        y0: y0 - inflate,
        z0: z0 - inflate,
        x1: x0 + w + inflate,
        y1: y0 + h + inflate,
        z1: z0 + d + inflate,
        u,
        v,
        w,
        h,
        d,
        head,
        mirror,
        overlay: inflate > 0,
        color,
      });
    };
    // Player faces +Z; its right side is -X.
    add(-4, 24, -4, 8, 8, 8, 0, 0, true, 0, false, 0xb4846c);
    add(-4, 24, -4, 8, 8, 8, 32, 0, true, 0.5, false, 0xb4846c);
    add(-4, 12, -2, 8, 12, 4, 16, 16, false, 0, false, 0x00a8a8);
    add(-4 - arm, 12, -2, arm, 12, 4, 40, 16, false, 0, false, 0xb4846c);
    add(-4, 0, -2, 4, 12, 4, 0, 16, false, 0, false, 0x463aa5);
    if (legacy) {
      add(4, 12, -2, arm, 12, 4, 40, 16, false, 0, true, 0xb4846c);
      add(0, 0, -2, 4, 12, 4, 0, 16, false, 0, true, 0x463aa5);
    } else {
      add(4, 12, -2, arm, 12, 4, 32, 48, false, 0, false, 0xb4846c);
      add(0, 0, -2, 4, 12, 4, 16, 48, false, 0, false, 0x463aa5);
      add(-4, 12, -2, 8, 12, 4, 16, 32, false, 0.25, false, 0x00a8a8);
      add(-4 - arm, 12, -2, arm, 12, 4, 40, 32, false, 0.25, false, 0xb4846c);
      add(4, 12, -2, arm, 12, 4, 48, 48, false, 0.25, false, 0xb4846c);
      add(-4, 0, -2, 4, 12, 4, 0, 32, false, 0.25, false, 0x463aa5);
      add(0, 0, -2, 4, 12, 4, 0, 48, false, 0.25, false, 0x463aa5);
    }
    return out;
  }

  let entR = 0;
  let entG = 0;
  let entB = 0;
  /** Nearest opaque entity surface along the ray (t, colour in entR/G/B), or Infinity. */
  function traceEntities(
    list: EPrep[],
    px: number,
    py: number,
    dx: number,
    dy: number,
    dz: number,
  ): number {
    let best = Infinity;
    for (let n = 0; n < list.length; n++) {
      const E = list[n];
      if (px < E.sx0 || px > E.sx1 || py < E.sy0 || py > E.sy1) continue;
      // AABB reject.
      let t0 = 0;
      let t1 = Infinity;
      const o = [camX - E.ax0, camY - E.ay0, camZ - E.az0];
      const ext = [E.ax1 - E.ax0, E.ay1 - E.ay0, E.az1 - E.az0];
      const dd = [dx, dy, dz];
      let miss = false;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(dd[a]) < 1e-12) {
          if (o[a] < 0 || o[a] > ext[a]) {
            miss = true;
            break;
          }
          continue;
        }
        let ta = -o[a] / dd[a];
        let tb = (ext[a] - o[a]) / dd[a];
        if (ta > tb) {
          const tmp = ta;
          ta = tb;
          tb = tmp;
        }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) {
          miss = true;
          break;
        }
      }
      if (miss || t0 >= best) continue;
      const e = E.e;
      // Ray into entity-local pixels (yaw undone; uniform scale keeps t).
      const rx = camX - e.x;
      const ry = camY - e.y;
      const rz = camZ - e.z;
      const lox = (rx * E.cos + rz * E.sin) / E.scale;
      const loy = ry / E.scale;
      const loz = (-rx * E.sin + rz * E.cos) / E.scale;
      const ldx = (dx * E.cos + dz * E.sin) / E.scale;
      const ldy = dy / E.scale;
      const ldz = (-dx * E.sin + dz * E.cos) / E.scale;
      for (let bi = 0; bi < E.boxes.length; bi++) {
        const bx = E.boxes[bi];
        const ox = lox;
        let oy = loy;
        let oz = loz;
        const vx = ldx;
        let vy = ldy;
        let vz = ldz;
        if (bx.head && E.ps !== 0) {
          // Head pitch about the neck (y = 24 px): rotate by -pitch about X.
          const qy = oy - 24;
          oy = qy * E.pc + oz * E.ps + 24;
          oz = -qy * E.ps + oz * E.pc;
          const wy = vy * E.pc + vz * E.ps;
          vz = -vy * E.ps + vz * E.pc;
          vy = wy;
        }
        // Slab test, keeping the entry axis.
        let tn = -Infinity;
        let tf = Infinity;
        let face = -1;
        const lo = [bx.x0, bx.y0, bx.z0];
        const hi = [bx.x1, bx.y1, bx.z1];
        const oo = [ox, oy, oz];
        const vv = [vx, vy, vz];
        let skip = false;
        for (let a = 0; a < 3; a++) {
          if (Math.abs(vv[a]) < 1e-12) {
            if (oo[a] < lo[a] || oo[a] > hi[a]) {
              skip = true;
              break;
            }
            continue;
          }
          let ta = (lo[a] - oo[a]) / vv[a];
          let tb = (hi[a] - oo[a]) / vv[a];
          let fa = a === 0 ? 4 : a === 1 ? 0 : 2; // entering the low side
          if (ta > tb) {
            const tmp = ta;
            ta = tb;
            tb = tmp;
            fa += 1;
          }
          if (ta > tn) {
            tn = ta;
            face = fa;
          }
          if (tb < tf) tf = tb;
        }
        if (skip || tn > tf || tn <= 0 || tn >= best || face < 0) continue;
        const hx = ox + vx * tn;
        const hy = oy + vy * tn;
        const hz = oz + vz * tn;
        // Skin UV for the face.
        const w = bx.w;
        const h = bx.h;
        const d = bx.d;
        const fx = (hx - bx.x0) / (bx.x1 - bx.x0);
        const fy = (hy - bx.y0) / (bx.y1 - bx.y0);
        const fz = (hz - bx.z0) / (bx.z1 - bx.z0);
        let uu: number;
        let vvv: number;
        let f = face;
        let sx: number;
        if (bx.mirror && (f === 4 || f === 5)) f = f === 4 ? 5 : 4;
        if (f === 1) {
          sx = bx.mirror ? 1 - fx : fx;
          uu = bx.u + d + sx * w;
          vvv = bx.v + fz * d;
        } else if (f === 0) {
          sx = bx.mirror ? 1 - fx : fx;
          uu = bx.u + d + w + sx * w;
          vvv = bx.v + (1 - fz) * d;
        } else if (f === 3) {
          sx = bx.mirror ? 1 - fx : fx;
          uu = bx.u + d + sx * w;
          vvv = bx.v + d + (1 - fy) * h;
        } else if (f === 2) {
          sx = bx.mirror ? fx : 1 - fx;
          uu = bx.u + d + w + d + sx * w;
          vvv = bx.v + d + (1 - fy) * h;
        } else if (f === 4) {
          sx = bx.mirror ? 1 - fz : fz;
          uu = bx.u + sx * d;
          vvv = bx.v + d + (1 - fy) * h;
        } else {
          sx = bx.mirror ? fz : 1 - fz;
          uu = bx.u + d + w + sx * d;
          vvv = bx.v + d + (1 - fy) * h;
        }
        let cr: number;
        let cg: number;
        let cb: number;
        const skin = E.skin;
        if (skin) {
          // Skin UVs are in 64-wide units (HD skins scale up).
          let iu = ((uu * skin.width) / 64) | 0;
          let iv = ((vvv * skin.width) / 64) | 0;
          if (iu >= skin.width) iu = skin.width - 1;
          if (iv >= skin.height) iv = skin.height - 1;
          const so = (iv * skin.width + iu) * 4;
          if (skin.data[so + 3] < 128) continue;
          cr = skin.data[so] / 255;
          cg = skin.data[so + 1] / 255;
          cb = skin.data[so + 2] / 255;
        } else {
          if (bx.overlay) continue;
          const c = bx.color >= 0 ? bx.color : E.color;
          cr = (c >> 16) / 255;
          cg = ((c >> 8) & 255) / 255;
          cb = (c & 255) / 255;
          // A little variation per face so the box reads as 3D.
          const shadeF = f === 3 ? 1 : 0.92;
          cr *= shadeF;
          cg *= shadeF;
          cb *= shadeF;
        }
        // World normal of the face for shading.
        const nx = FNX[face];
        let ny = FNY[face];
        let nz = FNZ[face];
        if (bx.head && E.ps !== 0) {
          const a = ny * E.pc - nz * E.ps;
          nz = ny * E.ps + nz * E.pc;
          ny = a;
        }
        const wnx = nx * E.cos - nz * E.sin;
        const wnz = nx * E.sin + nz * E.cos;
        const shade = Math.min(1, wnx * wnx * 0.6 + ny * ny * (ny > 0 ? 1 : 0.5) + wnz * wnz * 0.8);
        best = tn;
        lightmap(E.sky, E.blk);
        entR = cr * shade * lmR;
        entG = cg * shade * lmG;
        entB = cb * shade * lmB;
      }
    }
    return best;
  }

  // ── first-person hand ───────────────────────────────────────────────────────────────────────
  // Affine 3×4 matrices (row-major, [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz]) composed like
  // the game's PoseStack: each call post-multiplies, so the last transform acts first on a vertex.
  const mIdent = (): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const mMul = (a: number[], b: number[]): number[] => {
    const o = new Array<number>(12);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        o[r * 4 + c] =
          a[r * 4] * b[c] +
          a[r * 4 + 1] * b[4 + c] +
          a[r * 4 + 2] * b[8 + c] +
          (c === 3 ? a[r * 4 + 3] : 0);
      }
    }
    return o;
  };
  const mT = (m: number[], x: number, y: number, z: number): number[] =>
    mMul(m, [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]);
  const mS = (m: number[], s: number): number[] => mMul(m, [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0]);
  /** Right-handed rotation about an axis (0 x, 1 y, 2 z), degrees. */
  const mR = (m: number[], axis: number, deg: number): number[] => {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    if (axis === 0) return mMul(m, [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]);
    if (axis === 1) return mMul(m, [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]);
    return mMul(m, [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]);
  };
  const mInv = (m: number[]): number[] => {
    const [a, b, c, , d, e, f, , g, h, i] = m;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    const k = 1 / det;
    const r = [
      A * k,
      -(b * i - c * h) * k,
      (b * f - c * e) * k,
      0,
      B * k,
      (a * i - c * g) * k,
      -(a * f - c * d) * k,
      0,
      C * k,
      -(a * h - b * g) * k,
      (a * e - b * d) * k,
      0,
    ];
    r[3] = -(r[0] * m[3] + r[1] * m[7] + r[2] * m[11]);
    r[7] = -(r[4] * m[3] + r[5] * m[7] + r[6] * m[11]);
    r[11] = -(r[8] * m[3] + r[9] * m[7] + r[10] * m[11]);
    return r;
  };

  /**
   * Draws the held item or the bare right arm over the frame, with the game's first-person
   * transforms (ItemInHandRenderer, the model's firstperson_righthand display) at its fixed 70°
   * hand FOV, lit by the light at the eyes.
   */
  function renderHand(
    hand: KernelHand,
    out: Uint8Array,
    W: number,
    H: number,
    camSky: number,
    camBlk: number,
  ): void {
    let m = mIdent();
    // Model space of the target: arm = model-part pixels (y down); item/block = 0–1 model units.
    let x0 = 0;
    let y0 = 0;
    let z0 = 0;
    let x1 = 1;
    let y1 = 1;
    let z1 = 1;
    const slim = !!hand.slim;
    const skin = hand.skin ?? (slim ? P.alex : P.steve) ?? P.steve;
    if (hand.kind === 'arm') {
      if (!skin) return;
      m = mT(m, 0.64, -0.6, -0.72);
      m = mR(m, 1, 45);
      m = mT(m, -1, 3.6, 3.5);
      m = mR(m, 2, 120);
      m = mR(m, 0, 200);
      m = mR(m, 1, -135);
      m = mT(m, 5.6, 0, 0);
      m = mT(m, -5 / 16, (slim ? 2.5 : 2) / 16, 0);
      m = mS(m, 1 / 16);
      x0 = slim ? -2 : -3;
      y0 = -2;
      z0 = -2;
      x1 = 1;
      y1 = 10;
      z1 = 2;
    } else {
      m = mT(m, 0.56, -0.52, -0.72);
      if (hand.kind === 'item') {
        m = mT(m, 1.13 / 16, 3.2 / 16, 1.13 / 16);
        // Quaternion(x, y, z) = Rx · Ry · Rz.
        // The display rotation [0, -90, 25]; Quaternion(x, y, z, degrees) turns the other way round
        // from Vector3f.XP/YP/ZP.rotationDegrees.
        m = mR(m, 0, 0);
        m = mR(m, 1, 90);
        m = mR(m, 2, -25);
        m = mS(m, 0.68);
        z0 = 7.5 / 16;
        z1 = 8.5 / 16;
      } else {
        // block.json: rotation [0, 45, 0], scale 0.4.
        m = mR(m, 1, -45);
        m = mS(m, 0.4);
      }
      m = mT(m, -0.5, -0.5, -0.5);
    }
    const inv = mInv(m);
    // Screen rect of the box (hand FOV is always 70°).
    const th = Math.tan((70 * Math.PI) / 360);
    const aspect = W / H;
    let sx0 = Infinity;
    let sy0 = Infinity;
    let sx1 = -Infinity;
    let sy1 = -Infinity;
    for (let c = 0; c < 8; c++) {
      const px = c & 1 ? x1 + 0.5 : x0 - 0.5;
      const py = c & 2 ? y1 + 0.5 : y0 - 0.5;
      const pz = c & 4 ? z1 + 0.5 : z0 - 0.5;
      const vx = m[0] * px + m[1] * py + m[2] * pz + m[3];
      const vy = m[4] * px + m[5] * py + m[6] * pz + m[7];
      const vz = m[8] * px + m[9] * py + m[10] * pz + m[11];
      if (vz > -0.01) {
        sx0 = sy0 = -Infinity;
        sx1 = sy1 = Infinity;
        break;
      }
      const sx = (vx / -vz / (th * aspect) + 1) * 0.5 * W;
      const sy = (1 - vy / -vz / th) * 0.5 * H;
      if (sx < sx0) sx0 = sx;
      if (sx > sx1) sx1 = sx;
      if (sy < sy0) sy0 = sy;
      if (sy > sy1) sy1 = sy;
    }
    const px0 = Math.max(0, Math.floor(sx0));
    const px1 = Math.min(W - 1, Math.ceil(sx1));
    const py0 = Math.max(0, Math.floor(sy0));
    const py1 = Math.min(H - 1, Math.ceil(sy1));
    lightmap(camSky, camBlk);
    const lr = lmR;
    const lg = lmG;
    const lb = lmB;
    // Entity-style lighting: two fixed lights in view space.
    const shadeOf = (nx: number, ny: number, nz: number): number => {
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const a = Math.max(0, (0.2 * nx + 0.95 * ny - 0.3 * nz) / l);
      const b = Math.max(0, (-0.2 * nx + 0.95 * ny + 0.3 * nz) / l);
      return Math.min(1, 0.4 + 0.6 * Math.max(a, b) + 0.25 * Math.max(0, -nz / l));
    };
    let blockAlt = -1;
    if (hand.kind === 'block') {
      const st = hand.state ?? 0;
      const mo = st > 0 && st < P.stateModel.length ? P.stateModel[st] : -1;
      if (mo < 0) return;
      blockAlt = P.models[mo + 3];
    }
    for (let py = py0; py <= py1; py++) {
      for (let px = px0; px <= px1; px++) {
        const dxc = ((2 * (px + 0.5)) / W - 1) * th * aspect;
        const dyc = (1 - (2 * (py + 0.5)) / H) * th;
        const dzc = -1;
        // Ray in model space (origin = the eye).
        const ox = inv[3];
        const oy = inv[7];
        const oz = inv[11];
        const dx = inv[0] * dxc + inv[1] * dyc + inv[2] * dzc;
        const dy = inv[4] * dxc + inv[5] * dyc + inv[6] * dzc;
        const dz = inv[8] * dxc + inv[9] * dyc + inv[10] * dzc;
        let r = 0;
        let g = 0;
        let b = 0;
        let hit = false;
        let nX = 0;
        let nY = 0;
        let nZ = 0;
        if (hand.kind === 'block') {
          const M = P.models;
          const nEl = M[blockAlt];
          let best = Infinity;
          for (let i = 0; i < nEl; i++)
            best = testElement(
              M,
              blockAlt + 2 + i * EF,
              0,
              best,
              ox,
              oy,
              oz,
              dx,
              dy,
              dz,
              0,
              -99,
              -99,
              -99,
            );
          if (best < Infinity) {
            hit = true;
            r = hR / 255;
            g = hG / 255;
            b = hB / 255;
            if (hTint > 0) {
              // Items use the default grass / foliage colours.
              const k = P.stateTint[hand.state ?? 0];
              const c =
                k >= 0x1000000 ? k & 0xffffff : k === 2 ? 0x48b518 : k === 3 ? 0x3f76e4 : 0x7cbd6b;
              r *= (c >> 16) / 255;
              g *= ((c >> 8) & 255) / 255;
              b *= (c & 255) / 255;
            }
            nX = hNX;
            nY = hNY;
            nZ = hNZ;
          }
        } else {
          // Slab test against the box, keeping the entry face.
          let tn = -Infinity;
          let tf = Infinity;
          let face = -1;
          const lo = [x0, y0, z0];
          const hi = [x1, y1, z1];
          const oo = [ox, oy, oz];
          const vv = [dx, dy, dz];
          let miss = false;
          for (let a = 0; a < 3; a++) {
            if (Math.abs(vv[a]) < 1e-12) {
              if (oo[a] < lo[a] || oo[a] > hi[a]) miss = true;
              continue;
            }
            let ta = (lo[a] - oo[a]) / vv[a];
            let tb = (hi[a] - oo[a]) / vv[a];
            let fa = a === 0 ? 4 : a === 1 ? 0 : 2;
            if (ta > tb) {
              const t = ta;
              ta = tb;
              tb = t;
              fa += 1;
            }
            if (ta > tn) {
              tn = ta;
              face = fa;
            }
            if (tb < tf) tf = tb;
          }
          if (miss || tn > tf || tf <= 0 || face < 0) continue;
          if (hand.kind === 'arm' && skin) {
            const hx = ox + dx * tn;
            const hy = oy + dy * tn;
            const hz = oz + dz * tn;
            // ModelPart.Cube face UVs (model space is y-down), right arm at (40, 16).
            const w = x1 - x0;
            const d = z1 - z0;
            const u0 = 40;
            const v0 = 16;
            let u: number;
            let v: number;
            if (face === 0) {
              u = u0 + d + (hx - x0);
              v = v0 + (z1 - hz);
            } else if (face === 1) {
              u = u0 + d + w + (hx - x0);
              v = v0 + (z1 - hz);
            } else if (face === 4) {
              u = u0 + (z1 - hz);
              v = v0 + d + (hy - y0);
            } else if (face === 2) {
              u = u0 + d + (hx - x0);
              v = v0 + d + (hy - y0);
            } else if (face === 5) {
              u = u0 + d + w + (hz - z0);
              v = v0 + d + (hy - y0);
            } else {
              u = u0 + d + w + d + (x1 - hx);
              v = v0 + d + (hy - y0);
            }
            const iu = Math.min(skin.width - 1, Math.max(0, Math.floor((u * skin.width) / 64)));
            const iv = Math.min(skin.height - 1, Math.max(0, Math.floor((v * skin.width) / 64)));
            const so = (iv * skin.width + iu) * 4;
            if (skin.data[so + 3] < 128) continue;
            hit = true;
            r = skin.data[so] / 255;
            g = skin.data[so + 1] / 255;
            b = skin.data[so + 2] / 255;
            nX = FNX[face];
            nY = FNY[face];
            nZ = FNZ[face];
          } else if (hand.kind === 'item' && hand.icon) {
            // Extruded sprite: walk the 16×16 texel columns inside the slab.
            const icon = hand.icon;
            let t = Math.max(tn, 0);
            const tEnd = tf;
            let lastFace = face;
            for (let k = 0; k < 40 && t <= tEnd; k++) {
              const hx = ox + dx * (t + 1e-6);
              const hy = oy + dy * (t + 1e-6);
              const cx = Math.min(15, Math.max(0, Math.floor(hx * 16)));
              const cy = Math.min(15, Math.max(0, Math.floor(hy * 16)));
              const iu = Math.floor((cx * icon.width) / 16);
              const iv = Math.floor(((15 - cy) * icon.height) / 16);
              const so = (iv * icon.width + iu) * 4;
              if (icon.data[so + 3] >= 128) {
                hit = true;
                r = icon.data[so] / 255;
                g = icon.data[so + 1] / 255;
                b = icon.data[so + 2] / 255;
                nX = FNX[lastFace];
                nY = FNY[lastFace];
                nZ = FNZ[lastFace];
                break;
              }
              // Next texel boundary in x or y.
              const tx =
                dx > 0 ? ((cx + 1) / 16 - ox) / dx : dx < 0 ? (cx / 16 - ox) / dx : Infinity;
              const ty =
                dy > 0 ? ((cy + 1) / 16 - oy) / dy : dy < 0 ? (cy / 16 - oy) / dy : Infinity;
              if (tx < ty) {
                t = tx;
                lastFace = dx > 0 ? 4 : 5;
              } else {
                t = ty;
                lastFace = dy > 0 ? 0 : 1;
              }
            }
          }
        }
        if (!hit) continue;
        // Normal to view space for the lighting.
        const vx = m[0] * nX + m[1] * nY + m[2] * nZ;
        const vy = m[4] * nX + m[5] * nY + m[6] * nZ;
        const vz = m[8] * nX + m[9] * nY + m[10] * nZ;
        const sh = shadeOf(vx, vy, vz);
        const o = (py * W + px) * 4;
        out[o] = Math.min(255, r * sh * lr * 255 + 0.5) | 0;
        out[o + 1] = Math.min(255, g * sh * lg * 255 + 0.5) | 0;
        out[o + 2] = Math.min(255, b * sh * lb * 255 + 0.5) | 0;
      }
    }
  }

  // ── compositing ─────────────────────────────────────────────────────────────────────────────
  let accR = 0;
  let accG = 0;
  let accB = 0;
  let trans = 1;
  let rayH = 1;
  let rayY = 0;
  let camWater = false;
  let fogStart = 0;
  let fogEnd = 64;
  let uwStart = 0;
  let uwEnd = 48;
  /** Fogs a surface colour at distance t and accumulates it under the current transmittance. */
  function addSurface(r: number, g: number, b: number, a: number, t: number): void {
    let f: number;
    if (camWater) f = (t - uwStart) / (uwEnd - uwStart);
    else {
      // Cylindrical fog distance (vanilla 1.18).
      const h = t * rayH;
      const v = Math.abs(t * rayY);
      f = ((h > v ? h : v) - fogStart) / (fogEnd - fogStart);
    }
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    r += (fogR - r) * f;
    g += (fogG - g) * f;
    b += (fogB - b) * f;
    accR += trans * a * r;
    accG += trans * a * g;
    accB += trans * a * b;
    trans *= 1 - a;
  }

  // ── render ──────────────────────────────────────────────────────────────────────────────────
  function render(job: KernelJob, packKey: string): KernelResult {
    const t0 = Date.now();
    const pack = packs.get(packKey);
    if (!pack) throw new Error(`Pack ${packKey} not loaded`);
    P = pack;
    const W = job.width | 0;
    const H = job.height | 0;
    const out = new Uint8Array(W * H * 4);
    const R = job.region;
    SX = R.sizeX;
    SY = R.sizeY;
    SZ = R.sizeZ;
    PLANE = SX * SZ;
    ORX = Math.floor(R.originX);
    ORY = Math.floor(R.originY);
    ORZ = Math.floor(R.originZ);
    STATES = R.states.length >= SX * SY * SZ ? R.states : new Uint16Array(SX * SY * SZ);
    BIOMES = R.biomes && R.biomes.length >= SX * SZ ? R.biomes : undefined;
    NSTATES = P.stateModel.length;
    const dim = job.dimension.replace(/^minecraft:/, '');
    hasSky = dim !== 'the_nether' && dim !== 'the_end';
    ambient = dim === 'the_nether' ? 0.1 : 0;
    computeLight();

    // Time of day → celestial angle (vanilla formula), sky darkening, colours.
    const day = (((job.timeOfDay % 24000) + 24000) % 24000) / 24000;
    let d = day - 0.25;
    d -= Math.floor(d);
    const e = 0.5 - Math.cos(d * Math.PI) / 2;
    celestial = (d * 2 + e) / 3;
    sunAngle = celestial * Math.PI * 2;
    sunX = -Math.sin(sunAngle);
    sunY = Math.cos(sunAngle);
    rainK = job.raining ? 1 : 0;
    let dayK = Math.cos(sunAngle) * 2 + 0.5;
    dayK = dayK < 0 ? 0 : dayK > 1 ? 1 : dayK;
    let sd = 1 - (Math.cos(sunAngle) * 2 + 0.2);
    sd = sd < 0 ? 0 : sd > 1 ? 1 : sd;
    sd = 1 - sd;
    sd *= 1 - (rainK * 5) / 16;
    const skyDarken = sd * 0.8 + 0.2;
    buildLightmap(hasSky ? skyDarken : 1);

    camX = job.camera.x;
    camY = job.camera.y;
    camZ = job.camera.z;
    cloudY = job.cloudHeight;
    cloudShift = (job.timeOfDay % 24000) * 0.03;
    // Biome at the camera column sets sky and fog colours.
    const ccx = Math.floor(camX) - ORX;
    const ccz = Math.floor(camZ) - ORZ;
    let biome = 1;
    if (BIOMES && ccx >= 0 && ccz >= 0 && ccx < SX && ccz < SZ) biome = BIOMES[ccz * SX + ccx];
    const skyC = biome < P.biomeSky.length ? P.biomeSky[biome] : 0x78a7ff;
    const fogC = biome < P.biomeFog.length ? P.biomeFog[biome] : 0xc0d8ff;
    if (hasSky) {
      skyR = ((skyC >> 16) / 255) * dayK;
      skyG = (((skyC >> 8) & 255) / 255) * dayK;
      skyB = ((skyC & 255) / 255) * dayK;
      fogR = ((fogC >> 16) / 255) * (dayK * 0.94 + 0.06);
      fogG = (((fogC >> 8) & 255) / 255) * (dayK * 0.94 + 0.06);
      fogB = ((fogC & 255) / 255) * (dayK * 0.91 + 0.09);
      // The fog colour leans towards the sky colour (render distance 8+).
      const k = 1 - Math.pow(0.25 + 0.75 * (8 / 32), 0.25);
      fogR += (skyR - fogR) * k;
      fogG += (skyG - fogG) * k;
      fogB += (skyB - fogB) * k;
      if (rainK > 0) {
        const ls = (skyR * 0.3 + skyG * 0.59 + skyB * 0.11) * 0.6;
        skyR = skyR * 0.25 + ls * 0.75;
        skyG = skyG * 0.25 + ls * 0.75;
        skyB = skyB * 0.25 + ls * 0.75;
        fogR *= 0.5;
        fogG *= 0.5;
        fogB *= 0.6;
      }
      // Sunrise / sunset colour (vanilla getSunriseColor).
      const cs = Math.cos(sunAngle);
      sunrise = 0;
      if (cs >= -0.4 && cs <= 0.4) {
        const i = (cs / 0.4) * 0.5 + 0.5;
        let j = 1 - (1 - Math.sin(i * Math.PI)) * 0.99;
        j *= j;
        sunriseR = i * 0.3 + 0.7;
        sunriseG = i * i * 0.7 + 0.2;
        sunriseB = 0.2;
        sunrise = j * (1 - rainK * 0.7);
      }
      // Vanilla getStarBrightness, dimmed by rain.
      let sb = 1 - (Math.cos(sunAngle) * 2 + 0.25);
      sb = sb < 0 ? 0 : sb > 1 ? 1 : sb;
      starK = sb * sb * 0.5 * (1 - rainK);
      cloudR = dayK * 0.9 + 0.1;
      cloudG = dayK * 0.9 + 0.1;
      cloudB = dayK * 0.85 + 0.15;
      if (rainK > 0) {
        cloudR *= 0.6;
        cloudG *= 0.6;
        cloudB *= 0.6;
      }
    } else {
      starK = 0;
      fogR = skyR = (fogC >> 16) / 255;
      fogG = skyG = ((fogC >> 8) & 255) / 255;
      fogB = skyB = (fogC & 255) / 255;
      sunrise = 0;
    }

    // Camera basis (Notch yaw/pitch: yaw 0 faces +Z, 90 faces -X; pitch > 0 looks down).
    const yaw = (job.camera.yaw * Math.PI) / 180;
    const pitch = (job.camera.pitch * Math.PI) / 180;
    const fwX = -Math.sin(yaw) * Math.cos(pitch);
    const fwY = -Math.sin(pitch);
    const fwZ = Math.cos(yaw) * Math.cos(pitch);
    const rtX = -Math.cos(yaw);
    const rtY = 0;
    const rtZ = -Math.sin(yaw);
    const upX = rtY * fwZ - rtZ * fwY;
    const upY = rtZ * fwX - rtX * fwZ;
    const upZ = rtX * fwY - rtY * fwX;
    const fov = ((job.camera.fov || 70) * Math.PI) / 180;
    const th = Math.tan(fov / 2);
    const aspect = W / H;
    pixAngle = (2 * th) / H;

    // Fog distances: the region's horizontal reach from the camera stands in for the render
    // distance.
    const lcx = camX - ORX;
    const lcy = camY - ORY;
    const lcz = camZ - ORZ;
    const inside = lcx >= 0 && lcz >= 0 && lcx <= SX && lcz <= SZ;
    const reach = Math.max(
      8,
      inside ? Math.min(lcx, SX - lcx, lcz, SZ - lcz) : Math.min(SX, SZ) / 2,
    );
    fogEnd = reach;
    fogStart = job.modernFog ? fogEnd - Math.min(64, Math.max(4, fogEnd / 10)) : fogEnd * 0.75;
    skyFogDist = 160;
    camWater = false;
    {
      const cs = stateAt(Math.floor(lcx), Math.floor(lcy), Math.floor(lcz));
      const cf = P.stateFlags[cs];
      if (cf & (F_WATER | F_WATERLOGGED)) camWater = true;
    }
    if (camWater) {
      const wc = biome < P.biomeWater.length ? P.biomeWater[biome] : 0x3f76e4;
      fogR = ((wc >> 16) / 255) * 0.25 * dayK + 0.02;
      fogG = (((wc >> 8) & 255) / 255) * 0.3 * dayK + 0.03;
      fogB = ((wc & 255) / 255) * 0.45 * dayK + 0.05;
      uwStart = -8;
      uwEnd = 48;
    }

    // Highest non-air cell, so rays above the terrain stop (or jump) early.
    let maxY = -1;
    for (let y = SY - 1; y >= 0 && maxY < 0; y--) {
      const base = y * PLANE;
      for (let i = 0; i < PLANE; i++) {
        if (STATES[base + i] !== 0) {
          maxY = y;
          break;
        }
      }
    }

    // Entities: per-entity transforms, screen rects and light.
    const ents: EPrep[] = [];
    for (const en of job.entities) {
      const dxE = en.x - camX;
      const dzE = en.z - camZ;
      if (dxE * dxE + dzE * dzE > fogEnd * fogEnd) continue;
      const player = en.kind === 'player';
      const scale = player ? (0.9375 / 16) * (en.height > 0 ? en.height / 1.8 : 1) : 1;
      const yawR = (en.yaw * Math.PI) / 180;
      let boxes: EBox[];
      let skin: KernelImage | undefined;
      if (player) {
        skin = en.skin ?? (en.slim ? P.alex : P.steve) ?? P.steve;
        boxes = playerBoxes(!!en.slim, !!skin && skin.height < skin.width);
      } else {
        // Mobs and items: one box of the entity's size, in pixels at scale 1/16.
        const w = Math.max(0.15, en.width || 0.6) * 16;
        const h = Math.max(0.15, en.height || 0.6) * 16;
        const it = en.kind === 'item';
        const bw = it ? 4 : w;
        const bh = it ? 4 : h;
        boxes = [
          {
            x0: -bw / 2,
            y0: it ? 1 : 0,
            z0: -bw / 2,
            x1: bw / 2,
            y1: (it ? 1 : 0) + bh,
            z1: bw / 2,
            u: 0,
            v: 0,
            w: bw,
            h: bh,
            d: bw,
            head: false,
            mirror: false,
            overlay: false,
            color: -1,
          },
        ];
      }
      let hash = 0;
      for (let i = 0; i < en.name.length; i++)
        hash = (Math.imul(hash, 31) + en.name.charCodeAt(i)) | 0;
      const nm = en.name.replace(/^minecraft:/, '');
      const color = MOB_COLORS[nm] ?? ((hash & 0x7f7f7f) | 0x303030) >>> 0;
      const sc = player ? scale : 1 / 16;
      const half = (Math.max(en.width || 0.6, 0.6) / 2 + 0.3) * (player ? 1.2 : 1);
      const top = en.y + Math.max(en.height || 1.8, 0.3) + 0.3;
      const prep: EPrep = {
        e: en,
        skin,
        cos: Math.cos(yawR),
        sin: Math.sin(yawR),
        scale: sc,
        pc: Math.cos(((player ? en.pitch : 0) * Math.PI) / 180),
        ps: Math.sin(((player ? en.pitch : 0) * Math.PI) / 180),
        boxes,
        color,
        sx0: 0,
        sy0: 0,
        sx1: W,
        sy1: H,
        ax0: en.x - half,
        ay0: en.y - 0.1,
        az0: en.z - half,
        ax1: en.x + half,
        ay1: top,
        az1: en.z + half,
        sky: 15,
        blk: 0,
      };
      // Screen rect of the AABB (whole screen when a corner is behind the camera).
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxYs = -Infinity;
      let behind = false;
      for (let c = 0; c < 8; c++) {
        const px = (c & 1 ? prep.ax1 : prep.ax0) - camX;
        const py = (c & 2 ? prep.ay1 : prep.ay0) - camY;
        const pz = (c & 4 ? prep.az1 : prep.az0) - camZ;
        const zf = px * fwX + py * fwY + pz * fwZ;
        if (zf < 0.05) {
          behind = true;
          break;
        }
        const sx = ((px * rtX + py * rtY + pz * rtZ) / zf / (th * aspect) + 1) * 0.5 * W;
        const sy = (1 - (px * upX + py * upY + pz * upZ) / zf / th) * 0.5 * H;
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxYs) maxYs = sy;
      }
      if (!behind) {
        if (maxX < 0 || minX > W || maxYs < 0 || minY > H) continue;
        prep.sx0 = minX - 1;
        prep.sx1 = maxX + 1;
        prep.sy0 = minY - 1;
        prep.sy1 = maxYs + 1;
      }
      if (lightOf(Math.floor(en.x) - ORX, Math.floor(en.y + 0.5) - ORY, Math.floor(en.z) - ORZ)) {
        prep.sky = lSky;
        prep.blk = lBlk;
      }
      ents.push(prep);
    }

    // ── per pixel ──
    for (let py = 0; py < H; py++) {
      const ny = (1 - (2 * (py + 0.5)) / H) * th;
      for (let px = 0; px < W; px++) {
        const nx = ((2 * (px + 0.5)) / W - 1) * th * aspect;
        let dx = fwX + rtX * nx + upX * ny;
        let dy = fwY + rtY * nx + upY * ny;
        let dz = fwZ + rtZ * nx + upZ * ny;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx *= inv;
        dy *= inv;
        dz *= inv;
        const hlen = Math.sqrt(dx * dx + dz * dz);
        const entT = ents.length ? traceEntities(ents, px, py, dx, dy, dz) : Infinity;
        const eR = entR;
        const eG = entG;
        const eB = entB;

        accR = 0;
        accG = 0;
        accB = 0;
        trans = 1;
        let done = false;
        let layers = 0;
        rayH = hlen;
        rayY = dy;

        // DDA through the region.
        let ix = Math.floor(lcx);
        let iy = Math.floor(lcy);
        let iz = Math.floor(lcz);
        const stepX = dx > 0 ? 1 : -1;
        const stepY = dy > 0 ? 1 : -1;
        const stepZ = dz > 0 ? 1 : -1;
        const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
        const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
        const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
        let tEnter = 0;
        let enterFace = -1;
        // March inside the content box [0, SX] × [0, maxY + 1] × [0, SZ]: a ray from outside it (or
        // from above the highest non-air layer) jumps to where it enters; one that misses sees sky.
        const topY = maxY + 1;
        if (lcx < 0 || lcy < 0 || lcz < 0 || lcx >= SX || lcy >= topY || lcz >= SZ) {
          let t0 = 0;
          let t1 = Infinity;
          let face = -1;
          let miss = false;
          for (let a = 0; a < 3 && !miss; a++) {
            const o = a === 0 ? lcx : a === 1 ? lcy : lcz;
            const d = a === 0 ? dx : a === 1 ? dy : dz;
            const hi = a === 0 ? SX : a === 1 ? topY : SZ;
            if (Math.abs(d) < 1e-12) {
              if (o < 0 || o > hi) miss = true;
              continue;
            }
            let ta = -o / d;
            let tb = (hi - o) / d;
            let f = a === 0 ? 4 : a === 1 ? 0 : 2;
            if (ta > tb) {
              const tmp = ta;
              ta = tb;
              tb = tmp;
              f += 1;
            }
            if (ta > t0) {
              t0 = ta;
              face = f;
            }
            if (tb < t1) t1 = tb;
          }
          if (miss || face < 0 || t0 > t1 || topY <= 0) ix = -1;
          else {
            tEnter = t0;
            enterFace = face;
            const clampI = (v: number, n: number): number => (v < 0 ? 0 : v >= n ? n - 1 : v);
            ix = face === 4 ? 0 : face === 5 ? SX - 1 : clampI(Math.floor(lcx + dx * t0), SX);
            iy = face === 0 ? 0 : face === 1 ? topY - 1 : clampI(Math.floor(lcy + dy * t0), topY);
            iz = face === 2 ? 0 : face === 3 ? SZ - 1 : clampI(Math.floor(lcz + dz * t0), SZ);
          }
        }
        const ex = lcx + dx * tEnter;
        const ey = lcy + dy * tEnter;
        const ez = lcz + dz * tEnter;
        let tmx = dx !== 0 ? tEnter + (dx > 0 ? ix + 1 - ex : ex - ix) * tdx : Infinity;
        let tmy = dy !== 0 ? tEnter + (dy > 0 ? iy + 1 - ey : ey - iy) * tdy : Infinity;
        let tmz = dz !== 0 ? tEnter + (dz > 0 ? iz + 1 - ez : ez - iz) * tdz : Infinity;
        const maxDist = (camWater ? uwEnd : fogEnd) + 2;
        let prevState = 0;
        while (ix >= 0 && iy >= 0 && iz >= 0 && ix < SX && iy < SY && iz < SZ) {
          if (tEnter * (hlen > Math.abs(dy) ? hlen : Math.abs(dy)) > maxDist) {
            // Fully fogged.
            if (entT < Infinity) {
              addSurface(eR, eG, eB, 1, entT);
            } else {
              accR += trans * fogR;
              accG += trans * fogG;
              accB += trans * fogB;
              trans = 0;
            }
            done = true;
            break;
          }
          let state = STATES[(iy * SZ + iz) * SX + ix];
          if (state >= NSTATES) state = 0;
          if (state !== 0) {
            const flags = P.stateFlags[state];
            {
              // Faces on the entry boundary sit exactly at tEnter.
              let tm = enterFace >= 0 ? tEnter - 1e-6 : tEnter;
              let ef = enterFace;
              const ox = lcx - ix;
              const oy = lcy - iy;
              const oz = lcz - iz;
              for (let k = 0; k < 4 && !done; k++) {
                if (!cellSurface(state, ix, iy, iz, ox, oy, oz, dx, dy, dz, tm, ef, prevState, 1))
                  break;
                if (entT < hT) {
                  addSurface(eR, eG, eB, 1, entT);
                  done = true;
                  break;
                }
                // Shade the surface.
                let r = hR / 255;
                let g = hG / 255;
                let b = hB / 255;
                if (hTint === -2) {
                  tintFor(state, ix, iz);
                  // Water: tinted by the biome water colour.
                  const wc =
                    BIOMES && ix >= 0 && iz >= 0
                      ? (P.biomeWater[BIOMES[iz * SX + ix]] ?? 0x3f76e4)
                      : (P.biomeWater[1] ?? 0x3f76e4);
                  r *= (wc >> 16) / 255;
                  g *= ((wc >> 8) & 255) / 255;
                  b *= (wc & 255) / 255;
                } else if (hTint > 0) {
                  tintFor(state, ix, iz);
                  r *= tintR;
                  g *= tintG;
                  b *= tintB;
                }
                const shade = hShade
                  ? Math.min(1, hNX * hNX * 0.6 + hNY * hNY * (hNY > 0 ? 1 : 0.5) + hNZ * hNZ * 0.8)
                  : 1;
                if (flags & F_LAVA && hTint === 0) {
                  lightmap(15, 15);
                  aoOut = 1;
                } else {
                  smoothLight(ix, iy, iz, !(flags & F_NO_AO));
                  lightmap(skyOut, blkOut);
                }
                const k2 = shade * aoOut;
                r *= k2 * lmR;
                g *= k2 * lmG;
                b *= k2 * lmB;
                addSurface(r, g, b, hA / 255, hT);
                layers++;
                if (hA >= 255 || trans < 0.02 || layers > 6) {
                  done = true;
                  break;
                }
                tm = hT + 1e-5;
                ef = -1;
              }
              if (done) break;
            }
          }
          prevState = state;
          // Step to the next cell.
          if (tmx < tmy) {
            if (tmx < tmz) {
              ix += stepX;
              tEnter = tmx;
              tmx += tdx;
              enterFace = stepX > 0 ? 4 : 5;
            } else {
              iz += stepZ;
              tEnter = tmz;
              tmz += tdz;
              enterFace = stepZ > 0 ? 2 : 3;
            }
          } else if (tmy < tmz) {
            iy += stepY;
            tEnter = tmy;
            tmy += tdy;
            enterFace = stepY > 0 ? 0 : 1;
            if (iy > maxY && dy > 0) break;
          } else {
            iz += stepZ;
            tEnter = tmz;
            tmz += tdz;
            enterFace = stepZ > 0 ? 2 : 3;
          }
        }
        if (!done) {
          if (entT < Infinity) addSurface(eR, eG, eB, 1, entT);
          else {
            if (camWater) {
              oR = fogR;
              oG = fogG;
              oB = fogB;
            } else skyColor(dx, dy, dz);
            accR += trans * oR;
            accG += trans * oG;
            accB += trans * oB;
          }
        }
        const o = (py * W + px) * 4;
        out[o] = accR >= 1 ? 255 : accR <= 0 ? 0 : (accR * 255 + 0.5) | 0;
        out[o + 1] = accG >= 1 ? 255 : accG <= 0 ? 0 : (accG * 255 + 0.5) | 0;
        out[o + 2] = accB >= 1 ? 255 : accB <= 0 ? 0 : (accB * 255 + 0.5) | 0;
        out[o + 3] = 255;
      }
    }
    let cs = hasSky ? 15 : 0;
    let cb = 0;
    if (lightOf(Math.floor(lcx), Math.floor(lcy), Math.floor(lcz))) {
      cs = lSky;
      cb = lBlk;
    }
    if (job.hand) renderHand(job.hand, out, W, H, cs, cb);
    // Level.getBrightness at the eyes: max(sky light - skyDarken, block light) on the light curve.
    const fDay = 0.5 + 2 * Math.max(-0.25, Math.min(0.25, Math.cos(sunAngle)));
    const skyDarkenInt = Math.floor((1 - fDay * (1 - (rainK * 5) / 16)) * 11);
    const raw = Math.max(hasSky ? cs - skyDarkenInt : 0, cb) / 15;
    const eyeBrightness = raw / (4 - 3 * raw) + ambient * (1 - raw / (4 - 3 * raw));
    return { rgba: out, width: W, height: H, ms: Date.now() - t0, eyeBrightness };
  }

  return {
    setPack(pack: KernelPack): void {
      packs.set(pack.key, pack);
    },
    hasPack(key: string): boolean {
      return packs.has(key);
    },
    dropPack(key: string): void {
      packs.delete(key);
    },
    render,
  };
}
