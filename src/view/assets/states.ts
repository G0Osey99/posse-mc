// Block state ids → (block name, properties), from minecraft-data. From 1.13 a state id is the
// version's global palette id (minStateId + the property values, first property most significant);
// before 1.13 it is `(blockId << 4) | metadata`, mapped to 1.13 names with the legacy table and
// rendered with the 1.13.2 pack.
import minecraftData from 'minecraft-data';

export interface StateProps {
  name: string;
  props: Record<string, string>;
}

/** The subset of a minecraft-data block this module reads. */
export interface MdBlockLike {
  id: number;
  name: string;
  minStateId?: number;
  maxStateId?: number;
  defaultState?: number;
  states?: Array<{ name: string; type: string; num_values: number; values?: string[] }>;
}

/** Int properties whose first value is not 0 (older minecraft-data omits `values` for ints). */
const INT_FROM_ONE = new Set(['layers', 'delay', 'eggs', 'pickles', 'candles']);

export function propertyValues(
  blockName: string,
  st: { name: string; type: string; num_values: number; values?: string[] },
): string[] {
  if (st.values && st.values.length === st.num_values) return st.values;
  if (st.type === 'bool') return ['true', 'false'];
  let first = INT_FROM_ONE.has(st.name) ? 1 : 0;
  if (st.name === 'distance' && blockName.endsWith('leaves')) first = 1;
  if (st.name === 'level' && /^(water|powder_snow)_cauldron$/.test(blockName)) first = 1;
  return Array.from({ length: st.num_values }, (_, i) => String(first + i));
}

/** Properties of the state `offset` steps after the block's first state. */
export function decodeState(block: MdBlockLike, offset: number): Record<string, string> {
  const props: Record<string, string> = {};
  const states = block.states ?? [];
  for (let i = states.length - 1; i >= 0; i--) {
    const values = propertyValues(block.name, states[i]);
    props[states[i].name] = values[offset % values.length] ?? values[0];
    offset = Math.floor(offset / values.length);
  }
  return props;
}

/** Inverse of decodeState: the state id of `props` (missing properties take the block default). */
export function encodeState(block: MdBlockLike, props: Record<string, string>): number {
  const states = block.states ?? [];
  const base = block.minStateId ?? 0;
  const defaults = decodeState(block, (block.defaultState ?? base) - base);
  let offset = 0;
  for (const st of states) {
    const values = propertyValues(block.name, st);
    let i = values.indexOf(props[st.name] ?? defaults[st.name]);
    if (i < 0) i = Math.max(0, values.indexOf(defaults[st.name]));
    offset = offset * values.length + i;
  }
  return base + offset;
}

/** `minecraft:oak_stairs[facing=east,half=bottom]` → name and properties. */
export function parseStateString(s: string): StateProps {
  const m = /^(?:minecraft:)?([a-z0-9_]+)(?:\[(.*)\])?$/.exec(s.trim());
  if (!m) return { name: 'air', props: {} };
  const props: Record<string, string> = {};
  if (m[2]) {
    for (const kv of m[2].split(',')) {
      const [k, v] = kv.split('=');
      if (k && v !== undefined) props[k.trim()] = v.trim();
    }
  }
  return { name: m[1], props };
}

/** True when a minecraft-data version is older than the 1.13 flattening. */
export function isPreFlattening(version: string): boolean {
  try {
    return minecraftData(version).isOlderThan('1.13');
  } catch {
    return false;
  }
}

/** The client jar (Mojang version id) whose assets render `version`. */
export function assetVersionFor(version: string): string {
  return isPreFlattening(version) ? '1.13.2' : version;
}

/**
 * Every state of a flattened version: index = state id. Entries for ids no block claims stay
 * undefined.
 */
export function flattenedStateTable(blocks: MdBlockLike[]): Array<StateProps | undefined> {
  let max = 0;
  for (const b of blocks) max = Math.max(max, b.maxStateId ?? 0);
  const table: Array<StateProps | undefined> = new Array(max + 1);
  for (const b of blocks) {
    if (b.minStateId === undefined || b.maxStateId === undefined) continue;
    for (let id = b.minStateId; id <= b.maxStateId; id++)
      table[id] = { name: b.name, props: decodeState(b, id - b.minStateId) };
  }
  return table;
}

/**
 * The pre-1.13 table, index `(id << 4) | meta`, in 1.13 names (with the 1.13.2 defaults filled
 * in). Missing metadata values fall back to metadata 0 of the same id; unknown ids stay undefined.
 */
export function legacyStateTable(
  legacy: Record<string, string>,
  modernBlocks: Map<string, MdBlockLike>,
): Array<StateProps | undefined> {
  const table: Array<StateProps | undefined> = new Array(4096 * 16);
  for (let id = 0; id < 4096; id++) {
    const base = legacy[`${id}:0`];
    for (let meta = 0; meta < 16; meta++) {
      const s = legacy[`${id}:${meta}`] ?? base;
      if (!s) continue;
      const parsed = parseStateString(s);
      const block = modernBlocks.get(parsed.name);
      if (block) {
        const full = decodeState(block, encodeState(block, parsed.props) - (block.minStateId ?? 0));
        table[(id << 4) | meta] = { name: parsed.name, props: full };
      } else table[(id << 4) | meta] = parsed;
    }
  }
  return table;
}

/** The state table of a minecraft-data version (see flattenedStateTable / legacyStateTable). */
export function stateTableFor(version: string): Array<StateProps | undefined> {
  if (isPreFlattening(version)) {
    const modern = minecraftData('1.13.2');
    return legacyStateTable(
      minecraftData.legacy.pc.blocks,
      new Map(modern.blocksArray.map((b) => [b.name, b as MdBlockLike])),
    );
  }
  return flattenedStateTable(minecraftData(version).blocksArray as MdBlockLike[]);
}

/** minecraft-data block facts the renderer uses, keyed by (modern) block name. */
export interface BlockFacts {
  filterLight: number;
  emitLight: number;
  transparent: boolean;
  /** `block` when the collision box is a full cube. */
  boundingBox: string;
}

export function blockFactsFor(version: string): Map<string, BlockFacts> {
  const data = minecraftData(isPreFlattening(version) ? '1.13.2' : version);
  const out = new Map<string, BlockFacts>();
  for (const b of data.blocksArray) {
    out.set(b.name, {
      filterLight: b.filterLight ?? 0,
      emitLight: b.emitLight ?? 0,
      transparent: b.transparent ?? false,
      boundingBox: b.boundingBox ?? 'block',
    });
  }
  return out;
}
