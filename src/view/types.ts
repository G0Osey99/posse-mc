// The screenshot contract between the Posse world (which builds a scene) and the view renderer
// (which turns it into a picture). See docs/design.md → Screenshots.

/** A dense box of block states around the camera. */
export interface SceneRegion {
  /** World coordinates of the region's minimum corner (block units). */
  originX: number;
  originY: number;
  originZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  /**
   * Block state ids, index `(y * sizeZ + z) * sizeX + x`. From 1.13 these are the version's global
   * state ids; before 1.13 they are `(blockId << 4) | metadata`. 0 is air in every version.
   */
  states: Uint16Array;
  /** Optional biome id per column (`z * sizeX + x`), sampled at the camera's height. */
  biomes?: Uint16Array;
}

export interface SceneEntity {
  kind: 'player' | 'mob' | 'item' | 'other';
  /** Registry entity name (`zombie`, `item`, `player`…). */
  name: string;
  x: number;
  y: number;
  z: number;
  /** Protocol (Notch) degrees: yaw 0 faces +Z (south), 90 faces -X (west); pitch > 0 looks down. */
  yaw: number;
  pitch: number;
  /** Bounding box, in blocks. */
  width: number;
  height: number;
  /** Shown above the entity (player names). */
  label?: string;
  /** http(s) URL of the player's skin (from the tab list textures property). */
  skinUrl?: string;
  /** Slim (Alex) arms. */
  slim?: boolean;
}

export interface SceneHud {
  health: number;
  food: number;
  /** Nine hotbar slots: registry item name and count, or null. */
  hotbar: Array<{ name: string; count: number } | null>;
  selectedSlot: number;
  /** Small caption in a corner (bot label, coordinates). */
  caption?: string;
}

export interface ViewScene {
  /** minecraft-data version string of the connection, e.g. `1.18.2`. */
  version: string;
  width: number;
  height: number;
  camera: {
    /** Eye position. */
    x: number;
    y: number;
    z: number;
    /** Protocol (Notch) degrees, same convention as SceneEntity. */
    yaw: number;
    pitch: number;
    /** Vertical field of view in degrees (default 70). */
    fov?: number;
  };
  region: SceneRegion;
  entities: SceneEntity[];
  /** 0–24000 (0 = sunrise, 6000 = noon). */
  timeOfDay: number;
  raining: boolean;
  /** `overworld`, `the_nether`, `the_end` or a custom dimension name. */
  dimension: string;
  hud?: SceneHud;
}

export interface ViewRenderResult {
  png: Buffer;
  width: number;
  height: number;
  /** Wall time of the render, ms. */
  ms: number;
  /** `textures` when the Mojang assets were used, `palette` for the flat-colour fallback. */
  quality: 'textures' | 'palette';
}

export interface ViewRendererOptions {
  /** Where the downloaded client jars and built packs are cached. */
  cacheDir: string;
  /** Worker threads (default 1). 0 renders on the calling thread. */
  workers?: number;
  /** Allows downloading from Mojang (default true). False uses cached packs or the palette. */
  allowDownload?: boolean;
  /** For tests: replaces global fetch. */
  fetch?: typeof fetch;
}
