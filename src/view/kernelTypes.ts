// Data shapes the render kernel works on (plain typed arrays, so they cross worker boundaries by
// structured clone). Built by assets/pack.ts, consumed by kernel.ts.

export interface KernelImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** State flag bits (`KernelPack.stateFlags`, the low 12 bits; bits 12–15 hold the fluid level). */
export const SF = {
  /** Solid full cube with opaque textures: stops rays, occludes AO, culls neighbour faces. */
  OPAQUE: 1,
  /** Darkens neighbours' ambient occlusion (full cubes incl. leaves, not glass). */
  AO: 2,
  WATER: 4,
  LAVA: 8,
  /** Also contains water (waterlogged, kelp, seagrass). */
  WATERLOGGED: 16,
  /** Faces against the same block are culled (glass, ice). */
  CULL_SELF: 32,
  /** The model disables ambient occlusion. */
  NO_AO: 64,
} as const;

/** Tint kinds (`KernelPack.stateTint`); other values are 0x1000000 | rgb (a fixed colour). */
export const TINT = { NONE: 0, GRASS: 1, FOLIAGE: 2, WATER: 3 } as const;

/** Texture flags (`KernelPack.texFlags`). */
export const TF = { CUTOUT: 1, TRANSLUCENT: 2 } as const;

/** Floats per element and per face in `KernelPack.models`. */
export const ELEMENT_FLOATS = 68;
export const FACE_FLOATS = 8;

/**
 * Everything the kernel needs from a pack.
 *
 * `models` layout (float32, all indices stored as floats):
 * - model at `stateModel[state]`: `[nAlt, totalWeight, (weight, altOffset) × nAlt]`
 * - alternative at altOffset: `[nElements, fullCube, element × nElements]`
 * - element (ELEMENT_FLOATS): from xyz, to xyz (block units 0–1), rotAxis (0 none, 1 x, 2 y, 3 z),
 *   cos, sin, origin xyz, rescale factor, shade, variant rotX, rotY (quarter turns), uvlock,
 *   3 reserved, then 6 faces (DIRS order) of FACE_FLOATS: texture (-1 none), u0 v0 u1 v1 (0–1),
 *   rotation (quarter turns), tinted (0/1), world cull direction (-1 none).
 */
export interface KernelPack {
  /** Identifies the pack (the worker caches packs by it). */
  key: string;
  /** Atlas width in 16×16 tiles. */
  atlasCols: number;
  atlasRows: number;
  /** RGBA atlas per mip level (tile 16, 8, 4, 2, 1). */
  mips: Uint8Array[];
  texFlags: Uint8Array;
  /** Texture indexes the fluid renderer uses (-1 when missing). */
  waterTex: number;
  lavaTex: number;
  stateModel: Int32Array;
  stateFlags: Uint16Array;
  /** (emitLight << 4) | filterLight. */
  stateLight: Uint8Array;
  stateTint: Uint32Array;
  models: Float32Array;
  /** Per biome id: 0xRRGGBB. */
  biomeGrass: Uint32Array;
  biomeFoliage: Uint32Array;
  biomeWater: Uint32Array;
  biomeSky: Uint32Array;
  biomeFog: Uint32Array;
  sun?: KernelImage;
  moon?: KernelImage;
  clouds?: KernelImage;
  steve?: KernelImage;
  alex?: KernelImage;
}

export interface KernelEntity {
  kind: 'player' | 'mob' | 'item' | 'other';
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  width: number;
  height: number;
  skin?: KernelImage;
  slim?: boolean;
}

/** What the first-person view holds: the bare arm, a flat item sprite, or a block. */
export interface KernelHand {
  kind: 'arm' | 'item' | 'block';
  /** The block's state id (kind `block`). */
  state?: number;
  /** The item's 16×16 sprite (kind `item`). */
  icon?: KernelImage;
  /** The player's skin for the arm (default skin otherwise). */
  skin?: KernelImage;
  slim?: boolean;
}

export interface KernelJob {
  width: number;
  height: number;
  camera: { x: number; y: number; z: number; yaw: number; pitch: number; fov: number };
  region: {
    originX: number;
    originY: number;
    originZ: number;
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    states: Uint16Array;
    biomes?: Uint16Array;
  };
  entities: KernelEntity[];
  timeOfDay: number;
  raining: boolean;
  dimension: string;
  /** Cloud layer height (192 from 1.18, 128 before). */
  cloudHeight: number;
  /** 1.18+ fog (a short band at the render distance) rather than the older 75% start. */
  modernFog: boolean;
  hand?: KernelHand;
}

export interface KernelResult {
  rgba: Uint8Array;
  width: number;
  height: number;
  ms: number;
  /** The game's brightness at the eyes (0–1; daylight-adjusted), which drives the vignette. */
  eyeBrightness: number;
}
