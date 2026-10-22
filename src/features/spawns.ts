// Spawn watching: report spawns of chosen entity types without tracking the entities (no position
// updates are decoded for them). A bot that only tracks players can still count primed TNT, falling
// blocks or dropped items around it; the `spawn_entity` peek filter lets nothing else through.
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import { readVarInt } from '../decode.js';
import type { SpawnInfo, SpawnWatchOptions } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */

/**
 * Object ids of `spawn_entity` before 1.14 (they're not the entity registry ids, and minecraft-data
 * no longer lists them from 1.13), by modern entity name.
 */
export const LEGACY_OBJECT_IDS: Record<string, number> = {
  boat: 1,
  item: 2,
  area_effect_cloud: 3,
  minecart: 10,
  tnt: 50,
  end_crystal: 51,
  arrow: 60,
  snowball: 61,
  egg: 62,
  fireball: 63,
  small_fireball: 64,
  ender_pearl: 65,
  wither_skull: 66,
  shulker_bullet: 67,
  llama_spit: 68,
  falling_block: 70,
  item_frame: 71,
  eye_of_ender: 72,
  potion: 73,
  experience_bottle: 75,
  firework_rocket: 76,
  leash_knot: 77,
  armor_stand: 78,
  evoker_fangs: 79,
  fishing_bobber: 90,
  spectral_arrow: 91,
  dragon_fireball: 93,
  trident: 94,
};

/** How `spawn_entity` lays out the entity type: 1.8 (no UUID, byte), 1.9–1.13 (UUID, byte), 1.14+ (UUID, varint). */
export type SpawnLayout = 'legacy' | 'byte' | 'varint';

/** Peek filter for `spawn_entity`: reads the type without decoding the packet. */
export function spawnTypeFilter(accept: (type: number) => boolean, layout: SpawnLayout = 'varint'): (buffer: Buffer, offset: number) => boolean {
  return (buffer, offset) => {
    const id = readVarInt(buffer, offset);
    if (!id) return true;
    const at = layout === 'legacy' ? id.end : id.end + 16;
    if (layout !== 'varint') return at >= buffer.length || accept(buffer.readInt8(at));
    const type = readVarInt(buffer, at);
    return !type || accept(type.value);
  };
}

interface Watcher {
  names: Set<string>;
  within: number;
  listener: (spawn: SpawnInfo) => void;
}

export interface SpawnWatch {
  layout: SpawnLayout;
  /** Whether a `spawn_entity` of this type id has a watcher. */
  wantsObject(type: number): boolean;
  /** The entity name of a `spawn_entity` type id. */
  objectName(type: number): string | undefined;
  /** Whether anything watches mobs (`spawn_entity_living`, ≤1.18). */
  readonly watchesMobs: boolean;
  /** Reports a decoded spawn to the matching watchers. */
  report(name: string, packet: any, uuid: string | undefined): void;
  watch(names: string[], listener: (spawn: SpawnInfo) => void, options?: SpawnWatchOptions): () => void;
  /** Called when watchers change (players.ts re-installs the living-spawn listener). */
  onChange: (() => void) | null;
}

export function createSpawnWatch(bot: PosseBot): SpawnWatch {
  const registry = bot.registry as any;
  const modern = bot.registry.version['>=']('1.14');
  const layout: SpawnLayout = !bot.registry.version['>=']('1.9') ? 'legacy' : modern ? 'varint' : 'byte';
  const watchers = new Set<Watcher>();
  let objectIds = new Set<number>();
  let mobs = false;

  const nameById = new Map<number, string>();
  if (modern) {
    for (const e of registry.entitiesArray ?? []) nameById.set(e.internalId ?? e.id, e.name);
  } else {
    for (const [name, id] of Object.entries(LEGACY_OBJECT_IDS)) nameById.set(id, name);
  }
  const idsByName = new Map<string, number>();
  for (const [id, name] of nameById) idsByName.set(name, id);

  const refresh = (): void => {
    objectIds = new Set();
    mobs = false;
    for (const w of watchers) {
      for (const name of w.names) {
        const id = idsByName.get(name);
        if (id !== undefined) objectIds.add(id);
        // Before 1.14 a name that isn't an object is a mob (spawn_entity_living until 1.19).
        else mobs = true;
        if (modern && registry.entitiesByName?.[name]?.type === 'mob') mobs = true;
      }
    }
    api.onChange?.();
  };

  const fixed = bot.supportFeature('fixedPointPosition');
  const api: SpawnWatch = {
    layout,
    onChange: null,
    wantsObject: (type) => objectIds.has(type),
    objectName: (type) => nameById.get(type),
    get watchesMobs() {
      return mobs;
    },
    report(name, packet, uuid) {
      if (watchers.size === 0) return;
      const div = fixed ? 32 : 1;
      const position = new Vec3(packet.x / div, packet.y / div, packet.z / div);
      const self = bot.entity?.position;
      const v = packet.velocity ?? (packet.velocityX !== undefined ? { x: packet.velocityX, y: packet.velocityY, z: packet.velocityZ } : undefined);
      const spawn: SpawnInfo = {
        id: packet.entityId,
        name,
        position,
        ...(uuid ? { uuid } : {}),
        ...(v ? { velocity: new Vec3(v.x / 8000, v.y / 8000, v.z / 8000) } : {}),
        ...(packet.objectData !== undefined ? { data: packet.objectData } : packet.data !== undefined ? { data: packet.data } : {}),
      };
      for (const w of watchers) {
        if (!w.names.has(name)) continue;
        if (w.within > 0 && (!self || self.distanceTo(position) > w.within)) continue;
        try {
          w.listener(spawn);
        } catch (err) {
          bot.emit('error', err as Error);
        }
      }
    },
    watch(names, listener, options = {}) {
      const watcher: Watcher = { names: new Set(names.map((n) => n.replace(/^minecraft:/, ''))), within: options.within ?? 0, listener };
      watchers.add(watcher);
      refresh();
      return () => {
        if (watchers.delete(watcher)) refresh();
      };
    },
  };
  return api;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
