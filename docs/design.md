# Design: Posse, the fleet-optimized Minecraft client

Status: implemented (2026-10-22); verified against the local fake server for 1.8.9–26.1, not yet against a live server.

## Problem

mineflayer is built for one capable bot, not a fleet. Running 20–30+ accounts in one Node process
(the case Posse was written for: BanditBot, a factions bot fleet)
hits its per-bot costs:

- **Every packet is fully deserialized** by protodef, whether or not anything listens. Entity
  movement, light updates, particles, sounds and chunk data dominate the stream.
- **Every chunk is decoded** into a prismarine-chunk column and kept for the whole view distance,
  light included (CPU on arrival, tens of MB per bot).
- **Physics ticks every 50 ms per bot** (one `setInterval` each), even for a bot standing still.
- **Every entity is tracked**, with an `entityMoved` emit per movement packet.
- 40+ plugins load per bot (crafting, villagers, books, enchanting…).

Measured: prismarine-registry is already shared per version (30 registries cost ~0.1 MB beyond the
first), so the registry is not a bottleneck.

## Goals

- A mineflayer-compatible API for what bot fleets typically use: chat (`messagestr`, `chat`,
  `tabComplete`), windows (`windowOpen`, `currentWindow`, `clickWindow`, `closeWindow`), the
  inventory (`slots`, `items()`, `equip`, `setQuickBarSlot`, `activateItem`), `title`, `players`,
  `scoreboard`, `entitySpawn`/`entityGone`/`playerCollect`, `blockUpdate`, `blockAt`, `registry`,
  movement controls and the lifecycle events — **1.8.9 through the latest version
  minecraft-protocol supports**.
- Per-bot cost close to "socket + keepalive" when idle; work scales with what code listens to.
- **Screenshots**: a first-person picture of what a bot sees that looks like the game.
- Features mineflayer lacks or leaves to addons: per-bot packet stats, resource-pack auto-accept,
  transfer events, the 1.20.3+ sidebar, screenshots.

Non-goals: pathfinding, crafting, villagers, books, enchanting, digging/building (possible later as
opt-in plugins). Replacing minecraft-protocol (auth, encryption and compression stay; they are
battle-tested, and Microsoft auth is the riskiest part to rewrite).

## Architecture (`src/`)

```
createBot(options) ─► PosseBot (typed EventEmitter, mineflayer-compatible slice)
   │
   ├─ minecraft-protocol Client (auth, encryption, framing, compression, keepalive)
   │     └─ demand-driven deserializer (decode.ts)
   ├─ features (one file each, version-aware): game, chat, health, inventory/windows,
   │     players (tab list), entities, scoreboard, title, tabComplete, resourcePack, misc
   ├─ world (world.ts): raw chunk store + block-change deltas, decoded on demand
   ├─ motion (motion.ts): idle heartbeat / settle-after-teleport physics on the fleet ticker
   └─ fleet ticker (ticker.ts): ONE 50 ms timer for every bot in the process

src/view/: screenshots (asset pack from the Mojang client jar, worker raycaster, HUD, PNG)
```

### Demand-driven decoding

minecraft-protocol reads packets through three streams (splitter → decompressor → deserializer),
throws a `PartialReadError` at the end of every socket read, fully deserializes every packet and
emits it four times. Posse replaces the splitter's transform with a framer that never throws and
hands each frame straight to decompression, a gate and the compiled protodef reader. The gate reads
the packet id varint, maps it to a name (from the version's protocol mapper, per protocol state)
and only decodes when someone listens to that name (or to `raw.<name>`, `packet` or `raw`).
Skipped packets cost no emit at all; a decoded packet is emitted once by name, and `packet` / `raw`
only when they have listeners. Listener tables are read per packet, so the set adapts as code
subscribes and unsubscribes. Bundles are not held back: their packets are emitted in order.

Hot entity packets (movement, look, velocity…) start with the entity id; a **peek filter** reads
that varint from the raw buffer and skips the decode when the entity is not tracked. `map_chunk`
is filtered the same way by its chunk coordinates.

Avoid listening to the generic `'packet'` event (it forces every packet to be decoded); the
last-packet time is `bot.lastPacketAt`.

### World

`map_chunk` payloads are kept raw and deflated (only within `worldRadius` chunks of the bot,
default 4, plus a 2-chunk margin so a short walk doesn't leave holes the server won't refill),
together with the block changes since. A column is decoded with prismarine-chunk only
when something asks (`blockAt`, physics, a screenshot, `blockUpdate` listeners) and the decoded
column is cached until it is evicted (LRU of 16); screenshots decode columns for the copy only. `blockUpdate` is only computed when it has listeners.
Light packets are never decoded.

Kept payloads live in a process-wide chunk store (`chunkStore.ts`), keyed by version and a SHA-1 of
the payload, with a reference count: bots parked in the same base receive byte-identical chunks, so
each is hashed (cheaper than deflating) and stored once. Block changes stay per bot. A bot's
references are released when its columns are evicted, unloaded or cleared, and when it ends.

### Motion

No per-bot physics loop. The fleet ticker drives every bot:
- **idle**: a position/onGround packet every 20 ticks (what the vanilla client sends while still);
- **settling**: after spawn, a teleport, velocity on the bot or a block change around it (its floor
  blown up), prismarine-physics runs each tick
  until the bot is on the ground and still, so it never floats and gets kicked for flying;
- **moving**: while a control state is set (`setControlState`), physics runs each tick.

### Entities

`entities: 'players' | 'all' | 'none'` (default `'players'`). Other players are tracked with
position/yaw (for proximity alerts and screenshots); with `'all'`, mobs and items within the world radius.
`playerCollect` is emitted for the bot itself in every mode.

### Versions

Features branch on minecraft-data `supportFeature` / version comparisons, never on string
equality. Shared per-version objects (registry, prismarine-chunk/item/windows/chat classes) are
cached in `registry.ts`. Covered differences include: chat (`chat` ≤1.18, signed `player_chat`
1.19–1.19.2, `player_chat`/`system_chat`/`profileless_chat` 1.19.3+, NBT components 1.20.3+),
titles (`title` ≤1.16, `set_title_*` 1.17+), windows (action numbers + `transaction` ≤1.16, state
ids 1.17+, hashed slots 1.21.5+, sent without component hashes so the server resyncs changed slots), tab list (`player_info` actions ≤1.19.2, bitset + `player_remove`
1.19.3+), tab complete (≤1.12 vs transaction ids 1.13+), positions (teleport ids 1.9+, 1.21.2
format), chunk batches (1.20.2+ must be acknowledged), configuration re-entry (1.20.2+), resource
packs (uuid 1.20.3+), `player_loaded` (1.21.4+).

### Watching, server health, transfers

- `watchSpawns(names, listener)` reports spawns of chosen types without tracking them: the
  `spawn_entity` peek filter lets through what's tracked or watched (type id read as a varint from
  1.14, a byte before, without the UUID on 1.8), so a players-only bot can still count primed TNT.
  Before 1.14 objects have their own ids (`spawns.ts` → `LEGACY_OBJECT_IDS`). Watched mobs (≤1.18
  `spawn_entity_living`) are listened to only while watched.
- TPS comes from `update_time` (world age, once a second): age gained over wall time across the
  last ~12 samples, measured to now when updates stop. `ping()` uses `ping_request` (1.20.2+).
- Chat sent outside the play state is held (`holdChatMs`) and flushed after the next `login`.
- Writes are checked against the current state's serverbound packets (a play packet written in the
  configuration state would serialize as another packet and get the bot kicked).
- Transfers (1.20.5+): cookies are stored and answered (minecraft-protocol answers neither), the
  connection ends on `transfer`, and a follow-up connection sends handshake intent 3.

## Screenshots (`posse-mc/view`)

A CPU raycaster, so it works anywhere Node runs, with no GPU.

- **Assets**: on first use the renderer downloads the version's client jar from Mojang's piston
  servers (sha1-checked, cached under the `cacheDir` you pass), extracts blockstates,
  models and textures, and builds a texture atlas plus a per-state shape table (model elements with
  face UVs, rotation, tint index, cull faces). No Mojang assets are shipped with Posse. Before
  1.13, states are mapped to modern names with minecraft-data's legacy table and rendered with the
  1.13.2 pack. Offline, a flat-colour palette is used.
- **Scene**: `buildScene(bot)` copies, from the bot's world store, a dense `Uint16Array` of state ids around the camera
  (128×96×128 by default), plus nearby entities, time of day and weather.
- **Render**: a self-contained kernel (no imports, so it runs as an eval'd worker even when the
  library is bundled or loaded from memory) ray-marches the voxels (DDA), intersects model elements for
  non-cube blocks, applies Minecraft's face shading, ambient occlusion, biome tint, fog and sky,
  and draws players with their skins. A HUD (crosshair, hotbar, health) is composed on top.

## Measured (fake server, 1.18.2, 60 moving players, chunk radius 8, 60 s)

| | mineflayer, 30 bots | Posse, 30 bots |
|---|---|---|
| CPU (% of one core) | 20.1% | 6.6% |
| Event-loop delay p99 | 2.64 ms | 0.73 ms |
| Heap after GC | 261 MB | 42 MB |
| RSS after GC | 1,946 MB | 529 MB |
| ArrayBuffers (chunks) | 1,034 MB | 155 MB |
| CPU while 30 bots join | 93% | 33% |

mineflayer's profile: ~74% of busy time in minecraft-protocol's stream read path, 11% in a
PartialReadError thrown at the end of every socket read, 19% in physics (half of it
prismarine-physics looking up minecraft-data every tick). Posse replaces the splitter with a
non-throwing framer that feeds decompression, the gate and the reader directly, and emits a
decoded packet once by name (`packet` / `raw` only when listened to). Kept chunks are stored
deflated (81 columns ≈ 45 KB on the fake terrain). Screenshots render in ~100–230 ms on a worker.

## Verification

- Unit tests for decoding, every version branch (packet fixtures generated from minecraft-data),
  the world store and the view kernel.
- `bench/`: a local fake server (minecraft-protocol `createServer`, offline auth)
  for each tested version that streams chunks, moving entities, chat, tab list, scoreboard and a
  menu window; a benchmark connects N bots of mineflayer or Posse and reports CPU, event-loop delay
  and memory.
