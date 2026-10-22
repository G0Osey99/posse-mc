// Blockstate and block model resolution (pure): which models a state uses (variants or multipart,
// with x/y rotation and uvlock) and the model's elements after following its parent chain and
// resolving `#texture` references.

/** Face order used everywhere in the renderer. */
export const DIRS = ['down', 'up', 'north', 'south', 'west', 'east'] as const;
export type DirName = (typeof DIRS)[number];

export interface FaceJson {
  texture?: TextureRefJson;
  uv?: number[];
  rotation?: number;
  tintindex?: number;
  cullface?: string;
}

export interface ElementJson {
  from: number[];
  to: number[];
  rotation?: { origin?: number[]; axis?: string; angle?: number; rescale?: boolean };
  shade?: boolean;
  faces?: Partial<Record<string, FaceJson>>;
}

/** A texture reference: a name, `#variable`, or (26.1+) `{ sprite, force_translucent }`. */
export type TextureRefJson = string | { sprite?: string };

export interface ModelJson {
  parent?: string;
  ambientocclusion?: boolean;
  textures?: Record<string, TextureRefJson>;
  elements?: ElementJson[];
}

export interface PlacementJson {
  model?: string;
  x?: number;
  y?: number;
  uvlock?: boolean;
  weight?: number;
}

type WhenJson = Record<string, unknown>;

export interface BlockstateJson {
  variants?: Record<string, PlacementJson | PlacementJson[]>;
  multipart?: Array<{ when?: WhenJson; apply: PlacementJson | PlacementJson[] }>;
}

export interface Placement {
  /** Normalized model name (`block/stone`). */
  model: string;
  /** Rotation in quarter turns (0–3). */
  x: number;
  y: number;
  uvlock: boolean;
}

export interface Alternative {
  weight: number;
  parts: Placement[];
}

export interface ResolvedFace {
  /** Normalized texture name (`block/stone`), or undefined when it does not resolve. */
  texture: string | undefined;
  /** [u0, v0, u1, v1] in texture pixels (0–16). */
  uv: [number, number, number, number];
  /** Quarter turns. */
  rotation: number;
  tintindex: number;
  /** Index into DIRS, or -1. */
  cullface: number;
}

export interface ResolvedElement {
  from: [number, number, number];
  to: [number, number, number];
  /** 0 none, 1 x, 2 y, 3 z. */
  rotAxis: number;
  /** Radians. */
  rotAngle: number;
  rotOrigin: [number, number, number];
  rescale: boolean;
  shade: boolean;
  /** Indexed like DIRS; null when the face is not drawn. */
  faces: Array<ResolvedFace | null>;
}

export interface ResolvedModel {
  elements: ResolvedElement[];
  ambientOcclusion: boolean;
  particle: string | undefined;
}

/** `minecraft:block/stone` / `block/stone` → `block/stone`. Other namespaces stay prefixed. */
export function normalizeName(name: string): string {
  return name.startsWith('minecraft:') ? name.slice(10) : name;
}

const quarter = (deg: number | undefined): number => ((Math.round((deg ?? 0) / 90) % 4) + 4) % 4;

function placement(p: PlacementJson): Placement | undefined {
  if (!p || typeof p.model !== 'string') return undefined;
  return { model: normalizeName(p.model), x: quarter(p.x), y: quarter(p.y), uvlock: !!p.uvlock };
}

/** Does a variant key (`facing=east,half=bottom`, or `` for every state) match the properties? */
export function variantMatches(key: string, props: Record<string, string>): boolean {
  if (key === '' || key === 'normal') return true;
  for (const kv of key.split(',')) {
    const [k, v] = kv.split('=');
    if (props[k] !== v) return false;
  }
  return true;
}

/** Evaluates a multipart `when` (`{prop: "a|b"}`, `{OR: [...]}`, `{AND: [...]}`). */
export function whenMatches(when: WhenJson | undefined, props: Record<string, string>): boolean {
  if (!when) return true;
  if (Array.isArray(when.OR)) return (when.OR as WhenJson[]).some((w) => whenMatches(w, props));
  if (Array.isArray(when.AND)) return (when.AND as WhenJson[]).every((w) => whenMatches(w, props));
  for (const [k, v] of Object.entries(when)) {
    const want = String(v);
    const negate = want.startsWith('!');
    const options = (negate ? want.slice(1) : want).split('|');
    const has = options.includes(props[k] ?? '');
    if (has === negate) return false;
  }
  return true;
}

/**
 * The model alternatives of a block state. Variants with a list give one alternative per entry
 * (Minecraft picks one per block position by weight); multipart gives a single alternative with
 * every matching part (the first entry of a weighted part list).
 */
export function selectAlternatives(
  bs: BlockstateJson | undefined,
  props: Record<string, string>,
): Alternative[] {
  if (!bs) return [];
  if (bs.variants) {
    // The most specific matching key wins (Minecraft requires an exact match; keys listing fewer
    // properties than the state has match too).
    let best: PlacementJson | PlacementJson[] | undefined;
    let bestLen = -1;
    for (const [key, value] of Object.entries(bs.variants)) {
      if (!variantMatches(key, props)) continue;
      const len = key === '' ? 0 : key.split(',').length;
      if (len > bestLen) {
        best = value;
        bestLen = len;
      }
    }
    if (!best) return [];
    const list = Array.isArray(best) ? best : [best];
    const out: Alternative[] = [];
    for (const p of list) {
      const pl = placement(p);
      if (pl) out.push({ weight: Math.max(1, p.weight ?? 1), parts: [pl] });
    }
    return out;
  }
  if (bs.multipart) {
    const parts: Placement[] = [];
    for (const part of bs.multipart) {
      if (!whenMatches(part.when, props)) continue;
      const apply = Array.isArray(part.apply) ? part.apply[0] : part.apply;
      const pl = apply && placement(apply);
      if (pl) parts.push(pl);
    }
    return parts.length ? [{ weight: 1, parts }] : [];
  }
  return [];
}

const AXES: Record<string, number> = { x: 1, y: 2, z: 3 };

/** Default face UVs (when a face has none), from the element bounds. */
export function defaultUv(
  dir: number,
  from: number[],
  to: number[],
): [number, number, number, number] {
  const [x0, y0, z0] = from;
  const [x1, y1, z1] = to;
  switch (dir) {
    case 0:
      return [x0, 16 - z1, x1, 16 - z0];
    case 1:
      return [x0, z0, x1, z1];
    case 2:
      return [16 - x1, 16 - y1, 16 - x0, 16 - y0];
    case 3:
      return [x0, 16 - y1, x1, 16 - y0];
    case 4:
      return [z0, 16 - y1, z1, 16 - y0];
    default:
      return [16 - z1, 16 - y1, 16 - z0, 16 - y0];
  }
}

/** The name of a texture reference (undefined when malformed). */
export function textureRef(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { sprite?: unknown }).sprite === 'string')
    return (v as { sprite: string }).sprite;
  return undefined;
}

/** Merges model texture maps child-over-parent (`chain[0]` is the child). */
export function mergeTextures(chain: ModelJson[]): Record<string, string> {
  const textures: Record<string, string> = {};
  for (let i = chain.length - 1; i >= 0; i--) {
    for (const [k, v] of Object.entries(chain[i].textures ?? {})) {
      const ref = textureRef(v);
      if (ref !== undefined) textures[k] = ref;
    }
  }
  return textures;
}

/** Follows `#name` references through the merged texture map (cycles resolve to undefined). */
export function resolveTexture(
  ref: string | undefined,
  textures: Record<string, string>,
): string | undefined {
  let cur = ref;
  for (let i = 0; i < 16 && cur !== undefined; i++) {
    if (!cur.startsWith('#')) return normalizeName(cur);
    cur = textures[cur.slice(1)];
  }
  return undefined;
}

/**
 * Resolves a model through its parent chain: the nearest model with `elements` provides them,
 * texture maps merge child-over-parent, and `ambientocclusion` comes from the nearest model that
 * sets it. `load` returns the raw json of a normalized model name.
 */
export function resolveModel(
  name: string,
  load: (name: string) => ModelJson | undefined,
): ResolvedModel {
  const chain: ModelJson[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = normalizeName(name);
  while (cur && !seen.has(cur) && chain.length < 32) {
    seen.add(cur);
    const json = load(cur);
    if (!json) break;
    chain.push(json);
    cur = json.parent ? normalizeName(json.parent) : undefined;
  }
  const textures = mergeTextures(chain);
  const elementsJson = chain.find((m) => Array.isArray(m.elements))?.elements ?? [];
  const aoModel = chain.find((m) => m.ambientocclusion !== undefined);
  const elements: ResolvedElement[] = [];
  for (const e of elementsJson) {
    if (!Array.isArray(e.from) || !Array.isArray(e.to)) continue;
    const from = [e.from[0], e.from[1], e.from[2]] as [number, number, number];
    const to = [e.to[0], e.to[1], e.to[2]] as [number, number, number];
    const faces: Array<ResolvedFace | null> = DIRS.map((d, di) => {
      const f = e.faces?.[d];
      if (!f) return null;
      const uv =
        Array.isArray(f.uv) && f.uv.length === 4
          ? (f.uv.slice(0, 4) as [number, number, number, number])
          : defaultUv(di, from, to);
      return {
        texture: resolveTexture(textureRef(f.texture), textures),
        uv,
        rotation: quarter(f.rotation),
        tintindex: typeof f.tintindex === 'number' ? f.tintindex : -1,
        cullface: f.cullface
          ? DIRS.indexOf(f.cullface === 'bottom' ? 'down' : (f.cullface as DirName))
          : -1,
      };
    });
    const r = e.rotation;
    elements.push({
      from,
      to,
      rotAxis: r && r.angle ? (AXES[r.axis ?? ''] ?? 0) : 0,
      rotAngle: r && r.angle ? (r.angle * Math.PI) / 180 : 0,
      rotOrigin: r?.origin ? [r.origin[0], r.origin[1], r.origin[2]] : [8, 8, 8],
      rescale: !!r?.rescale,
      shade: e.shade !== false,
      faces,
    });
  }
  return {
    elements,
    ambientOcclusion: aoModel?.ambientocclusion !== false,
    particle: resolveTexture('#particle', textures),
  };
}

/** True when the model is one or more unrotated 0–16 boxes (the renderer's full-cube fast path). */
export function isFullCubeModel(m: ResolvedModel): boolean {
  if (!m.elements.length) return false;
  return m.elements.every(
    (e) => !e.rotAxis && e.from.every((v) => v === 0) && e.to.every((v) => v === 16),
  );
}

/** True when the first element is a full cube with all six faces drawn. */
export function isSolidCubeModel(m: ResolvedModel): boolean {
  const e = m.elements[0];
  return isFullCubeModel(m) && !!e && e.faces.every((f) => f && f.texture);
}
