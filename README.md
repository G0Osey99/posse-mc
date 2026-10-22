# Posse

A fleet-optimized Minecraft bot client for Node.js. Posse speaks a mineflayer-compatible API (same
`createBot`, method and event names) for **Minecraft 1.8.9 through the latest release**, and is
built to run dozens of bots in one process. It can also render **first-person screenshots** of what
each bot sees, with the game's own textures.

> Early release (0.x): verified against a local test server on 1.8.9, 1.12.2, 1.16.5, 1.18.2,
> 1.19.4, 1.20.4, 1.21.4 and 26.1. Reports from live servers are welcome.

## Why

mineflayer decodes every packet, keeps every chunk (with light) decoded, runs physics every 50 ms
for every bot and tracks every entity. That's right for one capable bot; for a fleet it adds up.
Posse only does work someone asked for:

- **Demand-driven decoding**: a packet is only deserialized when something listens for it.
  Entity and chunk packets are filtered by peeking at their ids/coordinates before decoding.
- **A leaner read path**: no exception per socket read, no stream hops, one emit per packet.
- **A lazy world**: chunks are stored raw and deflated, decoded only when read.
- **Physics only when needed** (settling after a teleport or knockback, or moving), on one shared
  50 ms ticker for every bot in the process.

Measured on the bundled fake server (1.18.2, 30 bots, 60 moving players, 60 s):

| | mineflayer 4.39 | Posse |
|---|---|---|
| CPU (% of one core) | 20.1% | 6.6% |
| Event-loop delay p99 | 2.64 ms | 0.73 ms |
| Heap after GC | 261 MB | 42 MB |
| RSS after GC | 1,946 MB | 529 MB |
| CPU while 30 bots join | 93% | 33% |

Details and the profile behind these numbers: [docs/design.md](docs/design.md).

## Install

```bash
npm install posse-mc
```

Node 22 or newer. `@napi-rs/canvas` is an optional dependency (only used for text in the offline
screenshot fallback).

## Quick start

```ts
import { createBot } from 'posse-mc';

const bot = createBot({
  host: 'play.example.net',
  username: 'you@example.com',
  auth: 'microsoft',
  version: '1.18.2',
});

bot.on('spawn', () => bot.chat('/home'));
bot.on('messagestr', (line) => console.log(line));
bot.on('windowOpen', async (window) => {
  console.log('opened', window.title);
  await bot.clickWindow(13, 0, 0);
});
bot.on('kicked', (reason) => console.log('kicked', reason));
bot.on('end', (reason) => console.log('disconnected', reason));
```

## Options

Besides minecraft-protocol's connection options (`host`, `port`, `username`, `auth`, `version`,
`profilesFolder`, `onMsaCode`, `checkTimeoutInterval`, `hideErrors`, `viewDistance`):

| Option | Default | |
|---|---|---|
| `entities` | `'players'` | Which entities to track: `'none'`, `'players'` or `'all'`. Movement packets for untracked entities are never decoded. |
| `worldRadius` | `4` | Keep chunks within this many chunks of the bot (`0` keeps none; `blockAt` then returns null). |
| `physics` | `true` | Simulate physics while settling or moving. |
| `respawn` | `true` | Respawn automatically on death. |
| `acceptResourcePacks` | `true` | Answer resource-pack requests as accepted and loaded (nothing is downloaded). |
| `decodeAll` | `false` | Decode every packet, like mineflayer (debugging). |

## API

The mineflayer-compatible slice:

- **State**: `username`, `version`, `registry`, `game` (dimension, minY, height, gameMode…),
  `entity`, `entities`, `players`, `health`, `food`, `isAlive`, `time`, `isRaining`,
  `scoreboard` (`sidebar`, `list`, `belowName`), `scoreboards`, `teams`, `inventory`,
  `currentWindow`, `heldItem`, `quickBarSlot`, `physicsEnabled`.
- **Methods**: `chat`, `whisper`, `tabComplete`, `clickWindow`, `closeWindow`, `moveSlotItem`,
  `equip`, `unequip`, `setQuickBarSlot`, `activateItem`, `deactivateItem`, `blockAt`, `look`,
  `lookAt`, `setControlState`, `getControlState`, `clearControlStates`, `respawn`,
  `acceptResourcePack`, `denyResourcePack`, `quit`, `end`.
- **Events**: `login`, `spawn`, `respawn`, `game`, `death`, `health`, `kicked`, `end`, `error`,
  `message`, `messagestr`, `actionBar`, `title`, `title_times`, `title_clear`, `windowOpen`,
  `windowClose`, `heldItemChanged`, `playerJoined`, `playerUpdated`, `playerLeft`, `entitySpawn`,
  `entityGone`, `entityMoved`, `playerCollect`, `blockUpdate`, `chunkColumnLoad`,
  `chunkColumnUnload`, `scoreboardCreated`, `scoreUpdated`, `scoreRemoved`, `scoreboardPosition`,
  `teamCreated`, `teamUpdated`, `teamRemoved`, `time`, `rain`, `resourcePack`, `forcedMove`,
  `move`, `physicsTick`, `transfer`.

Posse extras:

- `bot.stats()`: packets decoded vs skipped (overall and per packet), bytes, kept chunks, tracked
  entities, physics ticks.
- `bot.lastPacketAt`: when the last packet arrived (for your own stale-connection checks).
- `bot._client`: the underlying minecraft-protocol client, as in mineflayer.
- Window titles are normalized to JSON text components in every version, and the 1.20.3+
  scoreboard (scores without an action, per-score display names) is supported.

Not included (yet): pathfinding, digging and building, crafting, villagers, books, enchanting.

## Screenshots

```ts
import { createBot, buildScene } from 'posse-mc';
import { ViewRenderer } from 'posse-mc/view';
import { writeFile } from 'node:fs/promises';

const renderer = new ViewRenderer({ cacheDir: './posse-cache', workers: 1 });
const scene = buildScene(bot, { width: 640, height: 360, caption: bot.username });
if (scene) {
  const { png, ms, quality } = await renderer.render(scene);
  await writeFile('view.png', png);
}
```

- A CPU raycaster on a worker thread: no GPU needed; ~100–250 ms for 640×360.
- Real block models and textures, biome tints, sky and fog by time of day, players with their
  skins and nametags, the HUD (hotbar, hearts, food, crosshair) and the held item.
- **No Mojang assets ship with Posse.** On first use the renderer downloads the version's client
  jar from Mojang's servers (checked against its sha1) to `cacheDir` and builds a texture pack from
  it. Without network access it falls back to flat colours (`quality: 'palette'`).
- `buildScene` covers 64 blocks around the bot by default (`radius`); a bot only knows the chunks
  within its `worldRadius`.

## Development

```bash
npm test            # unit tests
npm run verify      # connect to the bundled fake server on every tested version
npm run bench -- --client posse --bots 30 --version 1.18.2 --seconds 60
npm run bench -- --client mineflayer --bots 30 --version 1.18.2 --seconds 60
npx tsx bench/view-demo.ts ./out 1.18.2   # render a synthetic scene
npx tsx bench/shot.ts 1.18.2 ./shot.png   # a bot on the fake server, rendered
```

`bench/` holds the fake server (minecraft-protocol `createServer`, offline auth), the per-version
verifier and the benchmark (CPU, event-loop delay, memory, optional CPU profile).

## License

MIT. Parts of the per-version protocol handling are ported from
[mineflayer](https://github.com/PrismarineJS/mineflayer) (MIT); see [LICENSE](LICENSE).
Minecraft is a trademark of Mojang Synergies AB; Posse is not affiliated with Mojang or Microsoft.
