// Per-version objects shared by every bot in the process (docs/design.md → Versions).
//
// minecraft-data and the compiled protodef readers are already cached per version; the
// prismarine-* classes are not, and each bot used to build its own. The registry itself is per
// bot because a server's dimension codec / registry data is loaded into it.
import { createRequire } from 'node:module';
import prismarineRegistry, { type Registry } from 'prismarine-registry';

const require = createRequire(import.meta.url);

/* eslint-disable @typescript-eslint/no-explicit-any -- untyped CommonJS factories */
export interface VersionKit {
  version: string;
  /** Shared registry for static lookups (blocks, items, entities). Never load codecs into it. */
  registry: Registry;
  Chunk: any;
  Block: any;
  Item: any;
  Entity: any;
  windows: any;
  Physics: any;
  PlayerState: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const kits = new Map<string, VersionKit>();

export function versionKit(version: string): VersionKit {
  let kit = kits.get(version);
  if (kit) return kit;
  const registry = prismarineRegistry(version);
  const physics = require('prismarine-physics');
  kit = {
    version,
    registry,
    Chunk: require('prismarine-chunk')(registry),
    Block: require('prismarine-block')(registry),
    Item: require('prismarine-item')(registry),
    Entity: require('prismarine-entity')(version),
    windows: require('prismarine-windows')(version),
    Physics: physics.Physics,
    PlayerState: physics.PlayerState,
  };
  kits.set(version, kit);
  return kit;
}

/** A fresh registry for one connection (cheap: static data is shared by minecraft-data). */
export function connectionRegistry(version: string): Registry {
  return prismarineRegistry(version);
}

/** prismarine-chat bound to a connection's registry (needed for 1.19+ chat types). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- prismarine-chat's loader is untyped here
export function chatLoader(registry: Registry): any {
  return require('prismarine-chat')(registry);
}
