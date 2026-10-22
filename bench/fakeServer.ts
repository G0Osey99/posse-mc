// A local fake Minecraft server for benchmarking clients (mineflayer, Posse): offline auth, a hilly
// world, moving players and mobs (20 Hz, the dominant real-world packet load), tab list, a sidebar
// scoreboard, chat, titles, block changes and a `/menu` chest window. Works from 1.8.9 to the newest
// version minecraft-protocol supports; packets are built through the version's schema (protoFill).
//
//   tsx bench/fakeServer.ts --version 1.18.2 [--port 25565] [--chunk-radius 4] [--entities 20]
//
// Run as a child of bench.ts (IPC), it reports `{ type: 'ready', port }` and answers `stats` /
// `reset` messages.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import mc from 'minecraft-protocol';
import type { Client, Server } from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import type { IndexedData } from 'minecraft-data';
import prismarineItem from 'prismarine-item';
import { PacketFiller, txt } from './protoFill.js';
import { blockStates, chunkPackets, surfaceHeight } from './world.js';

type Params = Record<string, unknown>;
/** Server-side clients carry the id minecraft-protocol's server assigns. */
const idOf = (client: Client): number => (client as Client & { id: number }).id;

export interface FakeServerOptions {
  version: string;
  /** 0 picks a free port. */
  port?: number;
  host?: string;
  /** Chunks sent around spawn: a (2r+1)² square. */
  chunkRadius?: number;
  /** Moving entities (half players, half zombies). */
  entities?: number;
  /** Extra tab-list-only players. */
  tabExtra?: number;
  chatEveryMs?: number;
  blockChangeEveryMs?: number;
  scoreboardEveryMs?: number;
  latencyEveryMs?: number;
  /** Batch each tick's broadcasts into one socket write per client (default true). */
  flushPerTick?: boolean;
  /** Cap the chunk radius at the client's requested view distance (like a vanilla server). */
  honorViewDistance?: boolean;
  log?: (msg: string) => void;
}

export interface FakeServerStats {
  version: string;
  clients: number;
  /** Seconds since the last reset. */
  seconds: number;
  /** Packets sent to all clients, by name. */
  packets: Record<string, number>;
  /** Uncompressed payload bytes sent to all clients, by name (library-written packets excluded). */
  bytes: Record<string, number>;
  /** Packets sent to the first connected client only, by name. */
  perClient: Record<string, number>;
  menuClicks: Array<{ username: string; slot: number }>;
  /** Logins that came in with the transfer intent (1.20.5+). */
  transferLogins: number;
  /** Cookie values the clients sent back, by key. */
  cookies: Record<string, string>;
  pings: number;
  /** Worst lateness of the 50 ms entity tick (server overloaded when this grows). */
  tickLagMaxMs: number;
  serverCpuMs: number;
}

export interface FakeServer {
  port: number;
  version: string;
  stats(): FakeServerStats;
  resetStats(): void;
  close(): Promise<void>;
}

interface FakeEntity {
  id: number;
  uuid: string;
  name: string;
  player: boolean;
  radius: number;
  speed: number;
  angle: number;
  x: number;
  y: number;
  z: number;
  /** Last sent fixed-point position (protocol units). */
  fx: number;
  fy: number;
  fz: number;
}

const DEFAULTS = {
  host: '127.0.0.1',
  chunkRadius: 4,
  entities: 20,
  tabExtra: 30,
  chatEveryMs: 2000,
  blockChangeEveryMs: 500,
  scoreboardEveryMs: 1000,
  latencyEveryMs: 5000,
  flushPerTick: true,
};

export function offlineUuid(name: string): string {
  const h = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = h.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const byteAngle = (deg: number): number => ((Math.round((deg / 360) * 256) + 128) & 255) - 128;

export async function startFakeServer(options: FakeServerOptions): Promise<FakeServer> {
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const o = { ...DEFAULTS, ...(given as FakeServerOptions) };
  const log = o.log ?? (() => {});
  const mcData = minecraftData(o.version) as IndexedData | undefined;
  if (!mcData) throw new Error(`minecraft-data has no version ${o.version}`);
  const version = mcData.version.minecraftVersion as string;
  const filler = new PacketFiller(mcData.protocol as never);
  const atLeast = (v: string): boolean => mcData.version['>='](v);
  const Item = prismarineItem(version as never);
  const states = blockStates(mcData);

  // 1.18+ worlds start at -64 (overworld from the login packet's dimension codec).
  const tallWorld = atLeast('1.18');
  const minY = tallWorld ? -64 : 0;
  const worldHeight = tallWorld ? 384 : 256;
  const worldCtx = { version, mcData, filler, minY, height: worldHeight };

  const server: Server = mc.createServer({
    'online-mode': false,
    host: o.host,
    port: o.port ?? 25565,
    version,
    motd: 'Posse bench',
    maxPlayers: 1000,
    hideErrors: true,
    // keep the library's default 30 s kick timeout; mineflayer answers keep-alives.
  } as never);
  const serializer = (
    server as unknown as { serializer: { createPacketBuffer(p: object): Buffer } }
  ).serializer;

  // ---- stats ---------------------------------------------------------------------------------
  let packets: Record<string, number> = {};
  let bytes: Record<string, number> = {};
  let perClient: Record<string, number> = {};
  let menuClicks: FakeServerStats['menuClicks'] = [];
  let transferLogins = 0;
  const cookies: Record<string, string> = {};
  let pings = 0;
  let sampleClient: Client | null = null;
  let since = Date.now();
  let cpuSince = process.cpuUsage();
  let tickLagMaxMs = 0;
  const count = (client: Client, name: string, size: number): void => {
    packets[name] = (packets[name] ?? 0) + 1;
    if (size) bytes[name] = (bytes[name] ?? 0) + size;
    if (client === sampleClient) perClient[name] = (perClient[name] ?? 0) + 1;
  };

  // ---- packet helpers ------------------------------------------------------------------------
  const inWorld = new Set<Client>();
  const build = (name: string, params: Params): Buffer =>
    serializer.createPacketBuffer({ name, params: filler.packet(name, params) });
  const sendRaw = (client: Client, name: string, buf: Buffer): void => {
    count(client, name, buf.length);
    client.writeRaw(buf);
  };
  const send = (client: Client, name: string, params: Params): void => {
    if (!filler.has(name)) return;
    sendRaw(client, name, build(name, params));
  };
  // Like a server that flushes once per tick (Paper/Netty consolidation), not once per packet:
  // on loopback, per-packet writes would turn every packet into its own TCP read on the client.
  let corked = false;
  const corkAll = (): void => {
    if (!o.flushPerTick || corked) return;
    corked = true;
    for (const c of inWorld) c.socket.cork();
    setImmediate(() => {
      corked = false;
      for (const c of inWorld) c.socket.uncork();
    });
  };
  const broadcast = (name: string, params: Params): void => {
    if (inWorld.size === 0 || !filler.has(name)) return;
    corkAll();
    const buf = build(name, params);
    for (const c of inWorld) sendRaw(c, name, buf);
  };

  // ---- world ---------------------------------------------------------------------------------
  const spawn = { x: 0.5, y: surfaceHeight(0, 0) + 1, z: 0.5 };
  const chunkCache = new Map<string, Array<[string, Buffer]>>();
  const chunkAt = (cx: number, cz: number): Array<[string, Buffer]> => {
    const key = `${cx},${cz}`;
    let c = chunkCache.get(key);
    if (!c) {
      c = chunkPackets(worldCtx, cx, cz).map(([n, p]) => [n, build(n, p)] as [string, Buffer]);
      chunkCache.set(key, c);
    }
    return c;
  };
  const chunkOrder = (radius: number): Array<[number, number]> => {
    const list: Array<[number, number]> = [];
    for (let x = -radius; x <= radius; x++)
      for (let z = -radius; z <= radius; z++) list.push([x, z]);
    return list.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
  };
  const t0 = Date.now();
  for (const [x, z] of chunkOrder(o.chunkRadius)) chunkAt(x, z);
  log(`[fake ${version}] ${chunkCache.size} chunks generated in ${Date.now() - t0} ms`);

  // ---- entities and tab list -----------------------------------------------------------------
  const entityType = (name: string): number => mcData.entitiesByName[name]?.id ?? 0;
  const entities: FakeEntity[] = [];
  const fixedScale = filler.fieldType('rel_entity_move', 'dX') === 'i8' ? 32 : 4096;
  const absFixed = filler.fieldType('spawn_entity', 'x') === 'i32'; // 1.8: absolute ints ×32
  for (let i = 0; i < o.entities; i++) {
    const player = i % 2 === 0;
    const name = player ? `Raider${String(i).padStart(3, '0')}` : `zombie${i}`;
    const radius = 3 + (i % 12);
    const e: FakeEntity = {
      id: 1000 + i,
      uuid: offlineUuid(name),
      name,
      player,
      radius,
      speed: 0.22 / radius,
      angle: (i * 2.399) % (Math.PI * 2),
      x: 0,
      y: 0,
      z: 0,
      fx: 0,
      fy: 0,
      fz: 0,
    };
    place(e);
    e.fx = Math.round(e.x * fixedScale);
    e.fy = Math.round(e.y * fixedScale);
    e.fz = Math.round(e.z * fixedScale);
    entities.push(e);
  }
  const tabNames = [
    ...entities.filter((e) => e.player).map((e) => e.name),
    ...Array.from({ length: o.tabExtra }, (_, i) => `Member${String(i).padStart(3, '0')}`),
  ];

  function place(e: FakeEntity): void {
    e.x = spawn.x + Math.cos(e.angle) * e.radius;
    e.z = spawn.z + Math.sin(e.angle) * e.radius;
    e.y = Math.max(surfaceHeight(Math.floor(e.x), Math.floor(e.z)), 62) + 1;
  }

  const bitfieldInfo = mcData.supportFeature('playerInfoActionIsBitfield');
  const tabEntry = (name: string, latency = 40): Params => ({
    uuid: offlineUuid(name),
    name,
    properties: [],
    gamemode: 0,
    ping: latency,
    latency,
    listed: 1,
    player: { name, properties: [] },
  });
  const playerInfoAdd = (names: string[]): Params =>
    bitfieldInfo
      ? {
          action: {
            add_player: true,
            update_game_mode: true,
            update_listed: true,
            update_latency: true,
          },
          data: names.map((n) => tabEntry(n)),
        }
      : { action: 0, data: names.map((n) => tabEntry(n)) };
  const playerInfoLatency = (): Params => {
    const data = tabNames.map((n) => ({
      uuid: offlineUuid(n),
      ping: 20 + Math.floor(Math.random() * 120),
    }));
    return bitfieldInfo
      ? { action: { update_latency: true }, data: data.map((d) => ({ ...d, latency: d.ping })) }
      : { action: 2, data };
  };

  const spawnPackets = (e: FakeEntity): Array<[string, Params]> => {
    const pos = absFixed
      ? { x: Math.round(e.x * 32), y: Math.round(e.y * 32), z: Math.round(e.z * 32) }
      : { x: e.x, y: e.y, z: e.z };
    const common = {
      entityId: e.id,
      ...pos,
      yaw: 0,
      pitch: 0,
      headPitch: 0,
      metadata: [],
      velocity: { x: 0, y: 0, z: 0 },
    };
    if (e.player) {
      if (filler.has('named_entity_spawn')) {
        return [['named_entity_spawn', { ...common, playerUUID: e.uuid, currentItem: 0 }]];
      }
      return [
        [
          'spawn_entity',
          { ...common, objectUUID: e.uuid, type: entityType('player'), objectData: 0 },
        ],
      ];
    }
    if (filler.has('spawn_entity_living')) {
      return [
        ['spawn_entity_living', { ...common, entityUUID: e.uuid, type: entityType('zombie') }],
      ];
    }
    return [
      [
        'spawn_entity',
        { ...common, objectUUID: e.uuid, type: entityType('zombie'), objectData: 0 },
      ],
    ];
  };

  // ---- scoreboard ----------------------------------------------------------------------------
  const legacyText = !atLeast('1.13'); // team prefixes/objective titles are plain strings before 1.13
  const label = (s: string): unknown => (legacyText ? s : txt(s));
  const teamPacket = filler.has('teams') ? 'teams' : 'scoreboard_team';
  const OBJECTIVE = 'sidebar';
  const lines = (balance: number): string[] => [
    '§7§m----------',
    '§6§lFaction',
    '§f Bandits',
    '§6§lBalance',
    `§f $${balance.toLocaleString('en-US')}`,
    '§6§lPower',
    '§f 42/50',
    '§6§lOnline',
    `§f ${tabNames.length}`,
    '§7mc.example.net',
  ];
  const entryName = (i: number): string => `§${i.toString(16)}§r`;
  const teamParams = (i: number, text: string, mode: number): Params => {
    const prefix = legacyText ? text.slice(0, 16) : text;
    const suffix = legacyText ? text.slice(16, 32) : '';
    return {
      team: `line${i}`,
      mode,
      name: label(`line${i}`),
      prefix: label(prefix),
      suffix: label(suffix),
      friendlyFire: 0,
      flags: {},
      nameTagVisibility: 'always',
      collisionRule: 'always',
      color: 0,
      formatting: 21,
      players: [entryName(i)],
    };
  };
  const scoreboardPackets = (balance: number): Array<[string, Params]> => {
    const out: Array<[string, Params]> = [
      [
        'scoreboard_objective',
        {
          name: OBJECTIVE,
          action: 0,
          displayText: label('§6§lMC FACTIONS'),
          type: legacyText ? 'integer' : 0,
        },
      ],
      ['scoreboard_display_objective', { position: 1, name: OBJECTIVE }],
    ];
    lines(balance).forEach((text, i) => {
      out.push([teamPacket, teamParams(i, text, 0)]);
      out.push([
        'scoreboard_score',
        { itemName: entryName(i), action: 0, scoreName: OBJECTIVE, value: 15 - i },
      ]);
    });
    return out;
  };
  let balance = 1234;

  // ---- chat ----------------------------------------------------------------------------------
  const signedChatEra = filler.has('system_chat');
  const holderChatType = (() => {
    const t = filler.fieldType('player_chat', 'type');
    return Array.isArray(t) && t[0] === 'registryEntryHolder';
  })();
  const playerChatOk =
    filler.has('player_chat') && filler.fields('player_chat')?.includes('networkName');
  let chatIndex = 0;
  const systemMessage = (text: string, actionBar = false): [string, Params] =>
    signedChatEra
      ? ['system_chat', { content: txt(text), isActionBar: actionBar, type: actionBar ? 2 : 1 }]
      : [
          'chat',
          {
            message: txt(text),
            position: actionBar ? 2 : 1,
            sender: '00000000-0000-0000-0000-000000000000',
          },
        ];
  const factionChat = (name: string, text: string): [string, Params] =>
    signedChatEra
      ? systemMessage(`[F] ${name}: ${text}`)
      : ['chat', { message: txt(`[F] ${name}: ${text}`), position: 0, sender: offlineUuid(name) }];
  const playerChat = (name: string, text: string): [string, Params] => [
    'player_chat',
    {
      globalIndex: chatIndex++,
      senderUuid: offlineUuid(name),
      index: 0,
      plainMessage: text,
      timestamp: BigInt(Date.now()),
      salt: 0n,
      previousMessages: [],
      filterType: 0,
      type: holderChatType ? { chatType: 0 } : 0,
      networkName: txt(name),
    },
  ];

  // ---- windows -------------------------------------------------------------------------------
  const itemId = (...names: string[]): number => {
    for (const n of names) if (mcData.itemsByName[n]) return mcData.itemsByName[n].id;
    return 1;
  };
  const emptySlot = Item.toNotch(null);
  const slot = (id: number, count: number): unknown => Item.toNotch(new Item(id, count));
  const menuItems = (): unknown[] => {
    const items: unknown[] = [];
    const ids = [
      itemId('diamond_sword'),
      itemId('emerald'),
      itemId('paper'),
      itemId('gold_ingot'),
      itemId('tnt'),
    ];
    for (let i = 0; i < 27; i++)
      items.push(i % 4 === 1 ? slot(ids[i % ids.length], 1 + (i % 16)) : emptySlot);
    for (let i = 0; i < 36; i++) items.push(emptySlot);
    return items;
  };
  const openMenu = (client: Client): void => {
    const legacyWindow = JSON.stringify(
      filler.fieldType('open_window', 'inventoryType') ?? '',
    ).includes('pstring');
    send(client, 'open_window', {
      windowId: 1,
      inventoryType: legacyWindow ? 'minecraft:chest' : 2, // generic_9x3
      windowTitle: txt('Menu'),
      slotCount: 27,
    });
    send(client, 'window_items', {
      windowId: 1,
      stateId: 1,
      items: menuItems(),
      carriedItem: emptySlot,
    });
  };

  // ---- join ----------------------------------------------------------------------------------
  const loginParams = (client: Client, viewDistance: number): Params => {
    const base = (mcData as unknown as { loginPacket?: Params }).loginPacket;
    const common = {
      entityId: idOf(client),
      gameMode: 0,
      maxPlayers: 100,
      viewDistance,
      simulationDistance: viewDistance,
      reducedDebugInfo: false,
      enableRespawnScreen: true,
      enforceSecureChat: false,
      enforcesSecureChat: false,
    };
    if (!base)
      return { ...common, dimension: 0, difficulty: 1, levelType: 'default', hashedSeed: 0n };
    const worldState = base.worldState
      ? { ...(base.worldState as Params), gamemode: 'survival' }
      : undefined;
    return { ...base, ...common, ...(worldState ? { worldState } : {}) };
  };

  const onJoin = (client: Client): void => {
    if (!sampleClient) sampleClient = client;
    const requested = Math.max(
      2,
      (client as unknown as { settings?: { viewDistance?: number } }).settings?.viewDistance ??
        o.chunkRadius,
    );
    const radius = o.honorViewDistance ? Math.min(o.chunkRadius, requested) : o.chunkRadius;
    log(`[fake ${version}] ${client.username} joined (id ${idOf(client)})`);

    send(client, 'login', loginParams(client, radius));
    const blockPos = { x: Math.floor(spawn.x), y: Math.floor(spawn.y), z: Math.floor(spawn.z) };
    send(client, 'spawn_position', {
      location: blockPos,
      angle: 0,
      globalPos: { dimensionName: 'minecraft:overworld', location: blockPos },
      yaw: 0,
      pitch: 0,
    });
    send(client, 'abilities', { flags: 0, flyingSpeed: 0.05, walkingSpeed: 0.1 });
    send(client, 'held_item_slot', { slot: 0, slotId: 0 });
    send(client, 'update_view_position', { chunkX: 0, chunkZ: 0 });
    send(client, 'position', {
      ...spawn,
      yaw: 0,
      pitch: 0,
      flags: 0,
      teleportId: 1,
      dx: 0,
      dy: 0,
      dz: 0,
    });
    send(client, 'update_health', { health: 20, food: 20, foodSaturation: 5 });
    send(client, 'update_time', { age: 6000n, time: 6000n, tickDayTime: true });
    const invSlots = atLeast('1.9') ? 46 : 45;
    send(client, 'window_items', {
      windowId: 0,
      stateId: 0,
      items: Array.from({ length: invSlots }, (_, i) =>
        i === 36 ? slot(itemId('diamond_sword'), 1) : emptySlot,
      ),
      carriedItem: emptySlot,
    });

    // Tab list (fake players + this client).
    send(client, 'player_info', playerInfoAdd([...tabNames, client.username]));
    for (const [n, p] of scoreboardPackets(balance)) send(client, n, p);

    // Title.
    if (filler.has('set_title_text')) {
      send(client, 'set_title_time', { fadeIn: 10, stay: 60, fadeOut: 10 });
      send(client, 'set_title_subtitle', { text: txt('Welcome back') });
      send(client, 'set_title_text', { text: txt('§6MC FACTIONS') });
    } else {
      send(client, 'title', { action: atLeast('1.11') ? 3 : 2, fadeIn: 10, stay: 60, fadeOut: 10 });
      send(client, 'title', { action: 1, text: txt('Welcome back') });
      send(client, 'title', { action: 0, text: txt('§6MC FACTIONS') });
    }

    // Chunks (1.20.2+: in acknowledged batches).
    const batched = filler.has('chunk_batch_start');
    const order = chunkOrder(radius);
    for (let i = 0; i < order.length; i += 32) {
      const slice = order.slice(i, i + 32);
      if (batched) send(client, 'chunk_batch_start', {});
      for (const [x, z] of slice) for (const [n, buf] of chunkAt(x, z)) sendRaw(client, n, buf);
      if (batched) send(client, 'chunk_batch_finished', { batchSize: slice.length });
    }

    // Entities.
    for (const e of entities) for (const [n, p] of spawnPackets(e)) send(client, n, p);
    inWorld.add(client);
  };

  const onPlayClient = (client: Client): void => {
    const write = client.write.bind(client);
    client.write = (name: string, params: unknown): void => {
      if (client.state === 'play') count(client, name, 0);
      write(name, params);
    };
    const onCommand = (text: string): void => {
      const cmd = text.replace(/^\//, '').trim().toLowerCase();
      log(`[fake ${version}] ${client.username}: /${cmd}`);
      if (cmd === 'menu') openMenu(client);
      if (cmd === 'tnt') {
        // Primed TNT next to the bot (an object id before 1.14), then its explosion.
        const id = 900_000 + Math.floor(Math.random() * 1000);
        const tntType = atLeast('1.14') ? entityType('tnt') : 50;
        const at = { x: spawn.x + 2, y: spawn.y, z: spawn.z + 2 };
        const pos = absFixed ? { x: Math.round(at.x * 32), y: Math.round(at.y * 32), z: Math.round(at.z * 32) } : at;
        send(client, 'spawn_entity', {
          entityId: id,
          objectUUID: offlineUuid(`tnt${id}`),
          type: tntType,
          ...pos,
          pitch: 0,
          yaw: 0,
          headPitch: 0,
          objectData: 0,
          velocity: { x: 0, y: 0, z: 0 },
          velocityX: 0,
          velocityY: 0,
          velocityZ: 0,
        });
        send(client, 'explosion', { ...at, center: at, radius: 4, affectedBlockOffsets: [], blockCount: 0, sound: { soundId: 1 } });
      }
      if (cmd === 'transfer') {
        send(client, 'store_cookie', { key: 'posse:test', value: Buffer.from('carried') });
        send(client, 'transfer', { host: o.host, port: (server as unknown as { socketServer: { address(): { port: number } } }).socketServer.address().port });
      }
      if (cmd === 'cookie') send(client, 'cookie_request', { cookie: 'posse:test' });
      if (cmd === 'dropfloor') {
        // Removes the 4 blocks under spawn (a cannon blowing out the floor): the bot must fall.
        const x = Math.floor(spawn.x);
        const z = Math.floor(spawn.z);
        for (let dy = 1; dy <= 4; dy++) {
          send(client, 'block_change', { location: { x, y: Math.floor(spawn.y) - dy, z }, type: states.air });
        }
      }
    };
    client.on('chat', (p: { message: string }) => {
      if (p.message.startsWith('/')) onCommand(p.message);
    });
    client.on('chat_command', (p: { command: string }) => onCommand(p.command));
    client.on('chat_command_signed', (p: { command: string }) => onCommand(p.command));
    client.on(
      'window_click',
      (p: { windowId: number; slot: number; action?: number; actionNumber?: number }) => {
        menuClicks.push({ username: client.username, slot: p.slot });
        log(`[fake ${version}] ${client.username} clicked window ${p.windowId} slot ${p.slot}`);
        const action = p.action ?? p.actionNumber;
        if (filler.has('transaction') && action !== undefined) {
          send(client, 'transaction', { windowId: p.windowId, action, accepted: true });
        }
      },
    );
    client.on('ping_request', (p: { id: unknown }) => {
      pings++;
      send(client, 'ping_response', { id: p.id });
    });
    client.on('cookie_response', (p: { key: string; value?: Buffer }) => {
      cookies[p.key] = p.value ? Buffer.from(p.value).toString() : '';
    });
    client.on('end', () => {
      inWorld.delete(client);
      if (sampleClient === client) sampleClient = null;
    });
  };

  // minecraft-protocol's server only knows the status and login intents; a transfer (3) logs in too.
  server.on('connection', (client: Client) => {
    client.once('set_protocol', (p: { nextState: number }) => {
      if (p.nextState !== 3) return;
      transferLogins++;
      client.state = 'login' as never;
    });
  });
  server.on('login', (client: Client) => onPlayClient(client));
  server.on('playerJoin', (client: Client) => {
    try {
      onJoin(client);
    } catch (err) {
      log(`[fake ${version}] join failed: ${(err as Error).stack}`);
      client.end('Fake server error');
    }
  });

  // ---- periodic traffic ----------------------------------------------------------------------
  const timers: NodeJS.Timeout[] = [];
  let tick = 0;
  let nextTickAt = Date.now() + 50;
  const tickEntities = (): void => {
    const now = Date.now();
    tickLagMaxMs = Math.max(tickLagMaxMs, now - nextTickAt);
    nextTickAt = now + 50;
    tick++;
    if (inWorld.size === 0) return;
    for (const e of entities) {
      e.angle += e.speed;
      place(e);
      const fx = Math.round(e.x * fixedScale);
      const fy = Math.round(e.y * fixedScale);
      const fz = Math.round(e.z * fixedScale);
      const delta = { entityId: e.id, dX: fx - e.fx, dY: fy - e.fy, dZ: fz - e.fz, onGround: true };
      e.fx = fx;
      e.fy = fy;
      e.fz = fz;
      const yaw = byteAngle((e.angle * 180) / Math.PI + 180);
      if ((tick + e.id) % 2 === 0) {
        broadcast('entity_move_look', { ...delta, yaw, pitch: 0 });
        broadcast('entity_head_rotation', { entityId: e.id, headYaw: yaw });
      } else {
        broadcast('rel_entity_move', delta);
      }
      if (!e.player && (tick + e.id) % 20 === 0) {
        broadcast('entity_velocity', {
          entityId: e.id,
          velocity: { x: 0, y: -628, z: 0 },
          velocityX: 0,
          velocityY: -628,
          velocityZ: 0,
        });
      }
    }
  };
  timers.push(setInterval(tickEntities, 50));

  let blockToggle = false;
  timers.push(
    setInterval(() => {
      blockToggle = !blockToggle;
      const x = Math.floor(spawn.x) + 3;
      const z = Math.floor(spawn.z) + 3;
      const y = surfaceHeight(x, z) + 1;
      broadcast('block_change', {
        location: { x, y, z },
        type: blockToggle ? states.log : states.air,
      });
    }, o.blockChangeEveryMs),
  );

  let chatStep = 0;
  timers.push(
    setInterval(() => {
      const name = tabNames[chatStep % tabNames.length];
      const kind = chatStep++ % 4;
      if (kind === 0) broadcast(...factionChat(name, 'hello'));
      else if (kind === 1)
        broadcast(
          ...systemMessage(`${name}'s balance: $${(1234 + chatStep).toLocaleString('en-US')}`),
        );
      else if (kind === 2 && playerChatOk) broadcast(...playerChat(name, 'hello'));
      else broadcast(...systemMessage(`§aPower: ${chatStep % 50}/50`, true));
    }, o.chatEveryMs),
  );

  let age = 6000n;
  timers.push(
    setInterval(() => {
      age += 20n;
      broadcast('update_time', { age, time: age, tickDayTime: true });
    }, 1000),
  );

  timers.push(
    setInterval(() => {
      balance += 17;
      broadcast(teamPacket, teamParams(4, lines(balance)[4], 2));
    }, o.scoreboardEveryMs),
  );

  timers.push(setInterval(() => broadcast('player_info', playerInfoLatency()), o.latencyEveryMs));

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = (
    server as unknown as { socketServer: { address(): { port: number } } }
  ).socketServer.address();
  log(`[fake ${version}] listening on ${o.host}:${address.port}`);

  return {
    port: address.port,
    version,
    stats(): FakeServerStats {
      const cpu = process.cpuUsage(cpuSince);
      return {
        version,
        clients: inWorld.size,
        seconds: (Date.now() - since) / 1000,
        packets: { ...packets },
        bytes: { ...bytes },
        perClient: { ...perClient },
        menuClicks: [...menuClicks],
        transferLogins,
        cookies: { ...cookies },
        pings,
        tickLagMaxMs,
        serverCpuMs: (cpu.user + cpu.system) / 1000,
      };
    },
    resetStats(): void {
      packets = {};
      bytes = {};
      perClient = {};
      menuClicks = [];
      tickLagMaxMs = 0;
      since = Date.now();
      cpuSince = process.cpuUsage();
    },
    close(): Promise<void> {
      for (const t of timers) clearInterval(t);
      return new Promise((resolve) => {
        server.close();
        (server as unknown as NodeJS.EventEmitter).once('close', () => resolve());
        setTimeout(resolve, 1000).unref();
      });
    },
  };
}

// ---- CLI / child-process entry -----------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = 'true';
      else out[key] = argv[++i];
    }
  }
  return out;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const num = (k: string): number | undefined => (a[k] !== undefined ? Number(a[k]) : undefined);
  const server = await startFakeServer({
    version: a.version ?? '1.18.2',
    port: num('port') ?? 25565,
    chunkRadius: num('chunk-radius'),
    entities: num('entities'),
    tabExtra: num('tab-extra'),
    chatEveryMs: num('chat-every-ms'),
    honorViewDistance: a['honor-view-distance'] === 'true',
    flushPerTick: a['flush-per-packet'] !== 'true',
    log: a.quiet === 'true' ? undefined : (m) => console.log(m),
  });
  if (process.send) {
    process.send({ type: 'ready', port: server.port, version: server.version });
    process.on('message', (msg: { type: string }) => {
      if (msg.type === 'stats') process.send?.({ type: 'stats', stats: server.stats() });
      if (msg.type === 'reset') server.resetStats();
      if (msg.type === 'close') void server.close().then(() => process.exit(0));
    });
    process.on('disconnect', () => process.exit(0));
  }
  const stop = (): void => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
