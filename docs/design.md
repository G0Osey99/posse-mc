# Design: Posse, the fleet-optimized Minecraft client

Status: implemented (2026-10-22); 0.3 adds digging, building, crafting, trading, books,
enchanting, a physics simulator and a pathfinder (2026-10-22), verified against vanilla servers on
1.8.9, 1.12.2, 1.16.5, 1.20.4, 1.21.4 and 26.1 (`bench/live-*.ts`).

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

- Since 0.3: digging, building, crafting, containers and furnaces, trading, books, enchanting, a
  physics simulator and a pathfinder, without raising the idle cost (see "Actions" and
  "Pathfinding").

Non-goals: elytra flight, anvils, brewing. Replacing minecraft-protocol (auth, encryption and
compression stay; they are battle-tested, and Microsoft auth is the riskiest part to rewrite).

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

## Actions (0.3)

Ported from mineflayer's plugins, one file each in `src/features/`: `interact.ts` (right-clicks,
attacks, arm swings, the 1.19+ block-prediction sequence shared by digging, placing and using
items), `digging.ts`, `building.ts`, `inventory.ts` (transfer, putAway, open/withdraw/deposit),
`crafting.ts` with `src/recipes.ts`, `villager.ts`, `books.ts`, `workstations.ts` (containers,
furnaces, enchanting tables), `raycast.ts`, `effects.ts`.

- **Idle cost unchanged.** Nothing new is decoded until it's used: trade lists, window properties
  and item-use statuses are listened to only while a window or an action needs them. Effect and
  attribute packets are decoded for the bot itself only (a peek filter on the entity id), and the
  pathfinder is created on first access.
- **Look, then click.** `motion.afterTick()` resolves once a tick has sent the rotation; digging,
  placing and activating wait for it, so the server sees the rotation before the action like it
  would from the game (anticheats check this). Placing against blocks that react to a right-click
  sneaks first.
- **Predicted breaks.** A finished dig sets the block to air locally (the game does too); the
  server's block update corrects a refusal. Pillaring predicts the placed block the same way, so
  the bot lands on it.
- **1.17+ window races.** Those servers don't confirm clicks. After a click that changes a crafting
  or trading result, the next click waits for the server's result *and* grid updates; otherwise it
  is planned on a grid the server is about to overwrite (found against vanilla 1.21.4).
- Fixes over the libraries they came from: recipes are kept per version (prismarine-recipe keeps the
  last loaded version in globals, which breaks a multi-version process) and out-shape deltas are
  computed from the out-shape; 1.20.5+ enchantments are read from item components (so Efficiency
  counts in dig time); 1.20.5+ trade inputs (an item id and count, not a slot) are read; 26.1's
  interact-only `use_entity` and separate attack packet are handled; window `close` fires however
  the window closes, so per-window listeners never leak.

## Fishing and block search (0.4)

- **Bites as the game shows them.** `fish()` casts, then waits for the burst of six bubble /
  fishing particles (wake before 1.13) at the bobber, like mineflayer. The bot's own bobber (the
  `fishing_bobber` whose spawn data is the bot's entity id) is put in `bot.entities` while it
  fishes, so its movement is decoded like a tracked entity's; particle packets are only listened to
  (and so decoded) during a cast. The burst may be up to 2 blocks from the tracked bobber, which
  lags a little on older versions. A cast rejects when no bobber appears within 3 s, the bobber is
  destroyed (a hotbar switch, a grounded bobber's 60 s despawn), `timeout` passes (reeling in) or
  the signal aborts.
- **Aimed casts.** `fish({ at })` turns to the angle that lands the bobber on the point:
  `castLanding` replays the bobber's flight (before 1.12: 1.5 blocks/tick along the look, gravity
  0.04 after moving; from 1.12: 0.6·cos(pitch) + 0.5 horizontally from 0.3 blocks ahead, the
  vertical part −tan(pitch) times that, gravity 0.03 before moving; 92 % kept per tick) and
  `castAngles` takes the steepest pitch within ±60° that lands within 0.3 blocks, so it drops into
  small holes. Measured against vanilla, landings agree within a few tenths of a block; casts landed
  in 1×1 holes 4–12 blocks away on 1.8.9, 1.12.2 and 1.21.4. In open water a bobber slides on about
  two blocks after landing (it keeps 30 % of its speed); a hole's walls stop it.
- **Block search without Block objects.** `findBlocks()` turns names or ids into the set of their
  state ids (every version has `minStateId`…`maxStateId`) and reads `world.stateIdAt` over the
  sphere, nearest first; only a matcher function builds Blocks. It sees only kept chunks
  (`worldRadius`).

## Physics simulation (0.3)

`src/physics/simulator.ts` runs prismarine-physics on a copy of the player state: `predict(controls,
ticks)` and `simulateUntil(state, goal, controller)`. Effect levels and armour are read once per
state instead of every tick. mineflayer-physics-util (the more accurate Botcraft port that
minecraft-pathfinding uses) is GPL-3.0, so it is neither copied nor depended on: Posse and the
products built on it stay MIT-compatible.

## Pathfinding (0.3)

`src/pathfinder/`, after minecraft-pathfinding (planning) and mineflayer-pathfinder (API, goals):

- **Costs in ticks** (`costs.ts`, Baritone's measured speeds), so walking, digging with the best tool
  in the inventory, placing and falling compare as time. The heuristic uses walking speed: paths are
  at most ~1.3× optimal and far fewer nodes are expanded.
- **Block table** (`blocks.ts`): flags and collision height per block state, computed once per state
  and shared per version (minecraft-pathfinding keeps this in statics, which breaks multi-version
  processes). Slabs, soul sand and farmland count by their real height; fences and walls can't be
  stood on.
- **Moves** (`movements.ts`): walk (and bridge), diagonal (no corner cutting), ascend (with a placed
  step), descend (up to `maxDropDown`, any height into water), down (dig, ladder, water), up
  (ladder, swim, pillar), parkour (1–3 block gaps, also one up or one down), doors and gates. Each
  move carries what to break, place and open; a path's own changes are a linked list on the node,
  so later moves see the blocks earlier ones broke or placed.
- **Search** (`astar.ts`): binary heap with decrease-key, numeric node keys (packed below 2⁵³, x and
  z wrapping every 2²¹ blocks), time slices of `tickTimeout` ms with `setImmediate` in between, and
  Baritone's partial-path choice (best node by progress against cost at several ratios).
- **Execution** (`pathfinder.ts`): on the fleet ticker after the motion tick, so controls set now
  apply to the next physics step. Walking steers at the next block centre (sprinting only on
  straight runs); bridging sneaks to the edge and places against the block underfoot; pillaring
  looks down, jumps, and places once the feet clear the block; parkour simulates "jump now" each
  tick and jumps when the landing reaches the target (or the next tick would leave the ground),
  then chooses forward, coast or brake each tick by simulating the landing. A failed move
  penalizes that edge for 30 s and the path is replanned; so is a block update on the path's body
  space or floor, a forced move, or a moved dynamic goal.
- While pathing, the world keeps more columns decoded (the whole kept area) so searches don't
  re-inflate them; it goes back afterwards.

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

## Anticheat fidelity (0.4)

Run against Paper with GrimAC (`bench/live-pathfinder.ts --grim`: Paper from fill.papermc.io and
GrimAC from Modrinth, both checksum-verified; Grim's verbose output is turned on so every violation
fails a course, not only those past its alert threshold), the pathfinder's courses showed where the
bot's packets differed from the game's. Each is now done the game's way:

- **Tick end (1.21.2+).** The game ends every client tick with `tick_end`; Grim's TickTimer flags
  movement without it. Sent every tick.
- **Actions inside the tick.** Sprint/sneak (`entity_action`), `player_input`, use, dig, place,
  swing, hotbar and interact packets written between ticks wait for the start of the next tick and
  go out before its movement packet (Grim's Post). A click's rotation is held until the movement
  after it has gone out (Grim's RotationPlace checks the rotation after the click before 1.9).
- **Continuous yaw.** The sent yaw never jumps by 360° (forced looks and teleports continue from
  the last sent value; Grim's AimModulo360).
- **Standing still.** A resting bot keeps the game's downward velocity (about −0.078/tick) instead
  of zero; zeroing it made the first tick after every stop miss the ground (GroundSpoof, then a
  Simulation offset fading by the ground friction 0.546 a tick).
- **Sprinting like the game.** The sprint key only asks: the bot sprints while it also moves
  forward and isn't hungry, sneaking, using an item, against a wall or wading, with start/stop
  packets. Before 1.19.4 the air-movement sprint bonus counts from the tick after it changes.
- **Crouching pose (1.14+).** The sneak slowdown starts the tick after the key (it's a pose).
- **Eye height.** Lower while sneaking (1.27 from 1.14, 1.54 before): looks and ray casts aim from
  the real eyes.
- **1.8 physics.** Velocities under 0.005 are zeroed before 1.9 (prismarine-physics uses 0.003).
- **Bridging.** The bot stops past the edge of its block before clicking the side under it, so the
  eyes are beyond the clicked face (Grim's PositionPlace) and the near-vertical look still hits it.

After this every course (walk, around, tunnel, stairs, drop, parkour, bridge, pillar, digdown,
door, swim, ladder, nopath, follow, far) runs without a single Grim violation on Paper 1.8.8 and
1.21.4.

## Verification

- Unit tests for decoding, every version branch (packet fixtures generated from minecraft-data),
  the world store, the view kernel, every new serverbound packet on ten versions (serialized with
  minecraft-protocol), recipes, ray casts, goals, the search and move generation on synthetic
  worlds, and the simulator.
- `bench/live-features.ts` and `bench/live-pathfinder.ts` run against Mojang's vanilla server
  (`bench/vanilla.ts` downloads and runs it; `--accept-eula`): dig, place (also against a chest),
  craft (2×2 and table), chests, furnaces, books, enchanting, trading, eating, ray casts, doors;
  and walking, going around and through walls, stairs, drops, parkour onto 1×1 pillars, bridging,
  pillaring, digging down, doors, swimming, ladders, following, no-path and long trips.
- `bench/`: a local fake server (minecraft-protocol `createServer`, offline auth)
  for each tested version that streams chunks, moving entities, chat, tab list, scoreboard and a
  menu window; a benchmark connects N bots of mineflayer or Posse and reports CPU, event-loop delay
  and memory.
