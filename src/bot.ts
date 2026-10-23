// A Posse bot: one connection, a mineflayer-compatible API, at a fraction of the
// per-bot cost (docs/design.md). Feature logic lives in ./features; version branches follow
// mineflayer's (MIT), which these were ported from.
import { EventEmitter } from 'node:events';
import mc, { type Client } from 'minecraft-protocol';
import nbt from 'prismarine-nbt';
import type { Registry } from 'prismarine-registry';
import { Vec3 } from 'vec3';
import { installDemandDecoding, packetNames, type DemandDecoding } from './decode.js';
import { installBooks, type BooksApi } from './features/books.js';
import { installBuilding, type BuildingApi, type PlaceOptions } from './features/building.js';
import { installChat } from './features/chat.js';
import { installCrafting, type CraftingApi } from './features/crafting.js';
import { installDigging, type DigFace, type DiggingApi } from './features/digging.js';
import { installEffects } from './features/effects.js';
import { installInteract, type InteractApi } from './features/interact.js';
import { installInventory, type InventoryApi, type OpenWindow, type TransferOptions } from './features/inventory.js';
import { installRaycast, type RaycastApi, type RaycastBlock } from './features/raycast.js';
import { installVillager, type Villager, type VillagerApi } from './features/villager.js';
import { installWorkstations, type EnchantmentTable, type Furnace, type WorkstationApi } from './features/workstations.js';
import type { Recipe } from './recipes.js';
import { Pathfinder } from './pathfinder/pathfinder.js';
import { Simulator } from './physics/simulator.js';
import { installMotion, type MotionApi } from './features/motion.js';
import { installPlayers } from './features/players.js';
import { installScoreboard } from './features/scoreboard.js';
import { createSpawnWatch, type SpawnWatch } from './features/spawns.js';
import { installHealthStats, type HealthStats } from './features/serverHealth.js';
import { installCookies } from './features/cookies.js';
import { installWorld } from './features/world.js';
import { chatLoader, connectionRegistry, versionKit, type VersionKit } from './registry.js';
import type {
  Block,
  ChatMessage,
  ControlState,
  Entity,
  GameState,
  Item,
  Player,
  PosseBotEvents,
  PosseOptions,
  PosseStats,
  Scoreboard,
  SpawnInfo,
  SpawnWatchOptions,
  Team,
  Window,
} from './types.js';
import { LazyWorld } from './world.js';

const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];
const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'];
const LEGACY_DIMENSIONS: Record<string, string> = { '-1': 'the_nether', '0': 'overworld', '1': 'the_end' };
const VIEW_DISTANCES = { far: 12, normal: 10, short: 8, tiny: 6 } as const;

export function parseGameMode(bits: number): string {
  if (bits < 0 || bits > 0b11) return 'survival';
  return GAME_MODES[bits & 0b11]!;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */
type Packet = any;

// Typed events over EventEmitter (the class adds no conflicting members).
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface PosseBot {
  on<K extends keyof PosseBotEvents>(event: K, listener: PosseBotEvents[K]): this;
  once<K extends keyof PosseBotEvents>(event: K, listener: PosseBotEvents[K]): this;
  off<K extends keyof PosseBotEvents>(event: K, listener: PosseBotEvents[K]): this;
  removeListener<K extends keyof PosseBotEvents>(event: K, listener: PosseBotEvents[K]): this;
  emit<K extends keyof PosseBotEvents>(event: K, ...args: Parameters<PosseBotEvents[K]>): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PosseBot extends EventEmitter {
  readonly options: PosseOptions;
  readonly _client: Client;
  /** Packet decoding control and counters. */
  readonly decoding: DemandDecoding;

  version = '';
  protocolVersion = 0;
  majorVersion = '';
  registry!: Registry;
  kit!: VersionKit;
  supportFeature: (feature: string) => boolean = () => false;
  ChatMessage: any;

  username: string;
  game: GameState = { dimension: 'overworld', minY: 0, height: 256 };
  health = 20;
  food = 20;
  foodSaturation = 5;
  isAlive = true;
  /** The bot's own entity (valid after `login`). */
  entity!: Entity;
  entities: Record<number, Entity> = {};
  players: Record<string, Player> = {};
  uuidToUsername: Record<string, string> = {};
  scoreboards: Record<string, Scoreboard> = {};
  /** Display slots: `sidebar`, `list`, `belowName`, or by number. */
  scoreboard: Record<string | number, Scoreboard | undefined> = {};
  teams: Record<string, Team> = {};
  teamMap: Record<string, Team> = {};
  time = { timeOfDay: 0, day: 0, age: 0, doDaylightCycle: true, isDay: true };
  isRaining = false;
  thunderState = 0;
  rainState = 0;
  world!: LazyWorld;
  settings = { viewDistance: 6, chat: 0, colorsEnabled: true, mainHand: 1, locale: 'en_US' };

  inventory!: Window;
  currentWindow: Window | null = null;
  quickBarSlot = 0;
  readonly QUICK_BAR_START = 36;
  /** Whether an item is being used (eaten, drawn…) since `activateItem`. */
  usingHeldItem = false;
  experience = { level: 0, points: 0, progress: 0 };
  /** The block being dug, and the face (protocol number) it's dug from. */
  targetDigBlock: Block | null = null;
  targetDigFace: number | null = null;
  /** `performance.now()` when the last dig ended (clicks on the hotbar wait a little after it). */
  lastDigTime: number | null = null;

  private inventoryApi!: InventoryApi;
  private interactApi!: InteractApi;
  private raycastApi!: RaycastApi;
  private diggingApi!: DiggingApi;
  private buildingApi!: BuildingApi;
  private craftingApi!: CraftingApi;
  private villagerApi!: VillagerApi;
  private booksApi!: BooksApi;
  private workstationApi!: WorkstationApi;
  private motion!: MotionApi;
  private pathfinderInstance: Pathfinder | null = null;
  private simulatorInstance: Simulator | null = null;
  private chatSend: (message: string) => void = () => undefined;
  private tabCompleteImpl: (text: string, assumeCommand?: boolean, sendBlockInSight?: boolean, timeout?: number) => Promise<string[]> =
    () => Promise.resolve([]);
  private resourcePack: { hash?: string; uuid?: string } = {};
  private ended = false;
  private spawns!: SpawnWatch;
  private serverHealth!: HealthStats;
  /** Cookies the server stored (1.20.5+); a transfer carries them to the next server. */
  readonly cookies = new Map<string, Buffer>();
  /** Where the server transferred this bot (1.20.5+), once it did. */
  transferTarget: { host: string; port: number } | null = null;

  constructor(options: PosseOptions) {
    super();
    this.options = options;
    this.username = options.username;
    const clientOptions: Record<string, unknown> = {
      host: options.host,
      port: options.port ?? 25565,
      username: options.username,
      auth: options.auth ?? 'microsoft',
      version: options.version,
      hideErrors: options.hideErrors ?? true,
      checkTimeoutInterval: options.checkTimeoutInterval ?? 30_000,
      onMsaCode: options.onMsaCode,
      profilesFolder: options.profilesFolder,
      validateChannelProtocol: false,
    };
    this._client = options.createClient ? options.createClient(clientOptions) : mc.createClient(clientOptions as never);
    // Every feature listens to a few lifecycle packets (login, respawn…): above Node's default 10.
    (this._client as unknown as EventEmitter).setMaxListeners(64);
    this.setMaxListeners(64);
    this.decoding = installDemandDecoding(this._client);
    this.decoding.decodeAll = options.decodeAll ?? false;

    this._client.on('error', (err: Error) => {
      this.emit('error', err);
    });
    this._client.on('end', (reason: string) => {
      this.ended = true;
      this.motion?.stop();
      this.world?.clear(); // releases this bot's share of the fleet chunk store
      this.emit('end', reason);
    });
    for (const [k, v] of Object.entries(options.transfer?.cookies ?? {})) this.cookies.set(k, Buffer.from(v));

    const client = this._client as Client & { wait_connect?: boolean };
    // An unsupported version must not leave the connection running unowned.
    const start = (): void => {
      try {
        this.init(client.version);
      } catch (err) {
        this.end('Unsupported version');
        throw err;
      }
    };
    if (client.wait_connect) {
      client.once('connect_allowed', () => {
        try {
          start();
        } catch (err) {
          this.emit('error', err as Error);
        }
      });
    } else start();
  }

  /** Wall-clock ms of the last packet received. */
  get lastPacketAt(): number {
    return this.decoding.lastPacketAt;
  }

  /** The pathfinder (created on first use: bots that never path pay nothing for it). */
  get pathfinder(): Pathfinder {
    this.pathfinderInstance ??= new Pathfinder(this);
    return this.pathfinderInstance;
  }

  /** Forward simulation of the bot's movement (where it would be after some ticks of input). */
  get simulator(): Simulator {
    this.simulatorInstance ??= new Simulator(this);
    return this.simulatorInstance;
  }

  get physicsEnabled(): boolean {
    return this.motion?.enabled ?? false;
  }

  set physicsEnabled(value: boolean) {
    if (this.motion) this.motion.enabled = value;
  }

  get heldItem(): Item | null {
    return (this.inventory?.slots[this.QUICK_BAR_START + this.quickBarSlot] as Item | null) ?? null;
  }

  private init(version: string): void {
    this.registry = connectionRegistry(version);
    const data = this.registry as unknown as {
      version: { version: number; majorVersion: string; minecraftVersion: string };
      supportFeature: (f: string) => boolean;
    };
    if (!data.version) throw new Error(`Server version '${version}' is not supported`);
    this.version = data.version.minecraftVersion;
    this.protocolVersion = data.version.version;
    this.majorVersion = data.version.majorVersion;
    this.supportFeature = (feature) => Boolean(data.supportFeature(feature));
    this.kit = versionKit(this.version);
    this.ChatMessage = chatLoader(this.registry);
    this.world = new LazyWorld(this.kit, () => this.game, this.options.worldRadius ?? 4);

    this.installGame();
    this.installHealth();
    this.installMisc();
    installChat(this, {
      setSend: (fn) => (this.chatSend = fn),
      setTabComplete: (fn) => (this.tabCompleteImpl = fn),
    });
    this.spawns = createSpawnWatch(this);
    installPlayers(this, this.options.entities ?? 'players', this.spawns);
    this.serverHealth = installHealthStats(this);
    installCookies(this);
    installScoreboard(this);
    installEffects(this);
    this.interactApi = installInteract(this);
    this.inventoryApi = installInventory(this);
    installWorld(this);
    this.raycastApi = installRaycast(this);
    this.diggingApi = installDigging(this);
    this.buildingApi = installBuilding(this);
    this.craftingApi = installCrafting(this);
    this.villagerApi = installVillager(this);
    this.booksApi = installBooks(this);
    this.workstationApi = installWorkstations(this);
    this.motion = installMotion(this, this.options.physics ?? true);
    guardWrites(this._client, this.version, this.options.transfer !== undefined);

    // Last, so every feature has reset its state (bot.entity, players, windows…) when it fires.
    const client = this._client as any;
    client.on('login', () => {
      this.emit('login');
      this.emit('game');
      client.writeChannel(this.brandChannel, this.options.brand ?? 'vanilla');
    });
  }

  private get brandChannel(): string {
    return this.supportFeature('customChannelMCPrefixed') ? 'MC|Brand' : 'minecraft:brand';
  }

  // ── Game state ────────────────────────────────────────────────

  private applySpawnInfo(packet: Packet): void {
    const sf = this.supportFeature;
    this.game.levelType = packet.levelType ?? (packet.isFlat ? 'flat' : 'default');
    this.game.hardcore = packet.isHardcore ?? Boolean(packet.gameMode & 0b100);
    this.game.gameMode = sf('spawnRespawnWorldDataField')
      ? packet.gamemode
      : parseGameMode(packet.gamemode ?? packet.gameMode);

    const registry = this.registry as any;
    if (sf('segmentedRegistryCodecData')) {
      if (typeof packet.dimension === 'number') {
        this.game.dimension = String(registry.dimensionsArray?.[packet.dimension]?.name ?? 'overworld').replace('minecraft:', '');
      } else if (typeof packet.dimension === 'string') {
        this.game.dimension = packet.dimension.replace('minecraft:', '');
      }
    } else if (sf('dimensionIsAnInt')) {
      this.game.dimension = LEGACY_DIMENSIONS[String(packet.dimension)] ?? 'overworld';
    } else if (sf('dimensionIsAString')) {
      this.game.dimension = String(packet.dimension).replace('minecraft:', '');
    } else if (sf('dimensionIsAWorld')) {
      if (sf('dimensionDataInCodec')) {
        const type = packet.worldType ?? packet.dimension;
        this.game.dimension = String(typeof type === 'string' ? type : packet.worldName).replace('minecraft:', '');
      } else {
        this.game.dimension = String(packet.worldName).replace('minecraft:', '');
      }
    }

    if (packet.dimensionCodec) registry.loadDimensionCodec(packet.dimensionCodec);

    this.game.minY = 0;
    this.game.height = 256;
    if (sf('dimensionDataInCodec')) {
      const dim = registry.dimensionsByName?.[this.game.dimension];
      if (dim) {
        this.game.minY = dim.minY;
        this.game.height = dim.height;
      }
    } else if (sf('dimensionDataIsAvailable')) {
      const dim = nbt.simplify(packet.dimension) as { min_y?: number; height?: number };
      this.game.minY = dim.min_y ?? 0;
      this.game.height = dim.height ?? 256;
    }
    if (packet.difficulty !== undefined) this.game.difficulty = DIFFICULTIES[packet.difficulty];
  }

  private installGame(): void {
    const client = this._client as any;
    const sf = this.supportFeature;
    const brandChannel = this.brandChannel;
    client.registerChannel(brandChannel, ['string', []]);

    client.on('registry_data', (packet: Packet) => (this.registry as any).loadDimensionCodec(packet.codec || packet));

    client.on('login', (packet: Packet) => {
      this.applySpawnInfo(packet.worldState || packet);
      this.game.maxPlayers = packet.maxPlayers;
      if (packet.viewDistance) this.game.serverViewDistance = packet.viewDistance;
      this.username = client.username;
      this.world.clear();
      this.sendSettings();
    });

    client.on('respawn', (packet: Packet) => {
      const before = this.game.dimension;
      this.applySpawnInfo(packet.worldState || packet);
      if (before !== this.game.dimension) this.world.clear();
      this.emit('game');
    });

    client.on('game_state_change', (packet: Packet) => {
      const reason = packet.reason;
      if ((reason === 4 || reason === 'win_game') && packet.gameMode === 1) {
        client.write('client_command', sf('respawnIsPayload') ? { payload: 0 } : { actionId: 0 });
      } else if (reason === 3 || reason === 'change_game_mode') {
        this.game.gameMode = parseGameMode(packet.gameMode);
        this.emit('game');
      } else if (reason === 1 || reason === 2 || reason === 'start_raining' || reason === 'stop_raining') {
        const raining = reason === 2 || reason === 'start_raining';
        if (this.isRaining !== raining) {
          this.isRaining = raining;
          this.emit('rain');
        }
      } else if (reason === 7 || reason === 'rain_level_change') {
        this.rainState = packet.gameMode;
      } else if (reason === 8 || reason === 'thunder_level_change') {
        this.thunderState = packet.gameMode;
      }
    });

    client.on('difficulty', (packet: Packet) => (this.game.difficulty = DIFFICULTIES[packet.difficulty]));
    client.on(brandChannel, (brand: string) => (this.game.serverBrand = brand));
    // The vanilla 1.17+ client answers pings; some anticheats kick clients that don't.
    client.on('ping', (packet: Packet) => client.write('pong', { id: packet.id }));

    client.on('update_time', (packet: Packet) => {
      const age = Number(packet.age);
      let time = Number(packet.time);
      const cycle = packet.tickDayTime !== undefined ? Boolean(packet.tickDayTime) : time >= 0;
      time = Math.abs(time);
      this.time.age = age;
      this.time.doDaylightCycle = cycle;
      this.time.day = Math.floor(time / 24000);
      this.time.timeOfDay = time % 24000;
      this.time.isDay = this.time.timeOfDay < 13000 || this.time.timeOfDay >= 23000;
      this.emit('time');
    });
  }

  sendSettings(): void {
    const view = this.options.viewDistance ?? 'tiny';
    this.settings.viewDistance = typeof view === 'number' ? view : VIEW_DISTANCES[view];
    this._client.write('settings', {
      locale: this.settings.locale,
      viewDistance: this.settings.viewDistance,
      chatFlags: this.settings.chat,
      chatColors: this.settings.colorsEnabled,
      skinParts: 0x7f,
      mainHand: this.settings.mainHand,
      enableTextFiltering: false,
      enableServerListing: true,
      particleStatus: 'all',
    });
  }

  // ── Health, death, respawn ────────────────────────────────────

  private installHealth(): void {
    const client = this._client as any;
    let spawned = false;
    const spawn = (): void => {
      // 1.21.4+ servers ignore interactions until the client reports it has loaded.
      if (this.supportFeature('sendsPlayerLoadedPacket')) client.write('player_loaded', {});
      this.emit('spawn');
    };
    client.on('login', () => {
      spawned = false;
      this.isAlive = true;
    });
    client.on('respawn', () => {
      this.isAlive = false;
      this.emit('respawn');
    });
    client.on('update_health', (packet: Packet) => {
      this.health = packet.health;
      this.food = packet.food;
      this.foodSaturation = packet.foodSaturation;
      this.emit('health');
      if (!spawned && packet.health > 0) {
        spawned = true;
        this.isAlive = true;
        spawn();
        return;
      }
      if (this.health <= 0) {
        if (this.isAlive) {
          this.isAlive = false;
          this.emit('death');
        }
        if (this.options.respawn ?? true) this.respawn();
      } else if (!this.isAlive) {
        this.isAlive = true;
        spawn();
      }
    });
  }

  respawn(): void {
    if (this.isAlive) return;
    this._client.write('client_command', this.supportFeature('respawnIsPayload') ? { payload: 0 } : { actionId: 0 });
  }

  // ── Kicks, resource packs, transfers ──────────────────────────

  private installMisc(): void {
    const client = this._client as any;
    // 1.20.3+ play kicks are NBT: hand them over as JSON text, like every other version.
    const reasonText = (reason: unknown): string | object =>
      reason && typeof reason === 'object' && 'type' in reason ? JSON.stringify(nbt.simplify(reason as never)) : (reason as string);
    client.on('kick_disconnect', (packet: Packet) => this.emit('kicked', reasonText(packet.reason), true));
    client.on('disconnect', (packet: Packet) => this.emit('kicked', reasonText(packet.reason), false));

    const autoAccept = this.options.acceptResourcePacks ?? true;
    const onPack = (url: string, id: { hash?: string; uuid?: string }): void => {
      this.resourcePack = id;
      this.emit('resourcePack', url, id.uuid ?? id.hash);
      if (autoAccept || client.state === 'configuration') this.acceptResourcePack();
    };
    client.on('resource_pack_send', (packet: Packet) =>
      onPack(packet.url, this.supportFeature('resourcePackUsesUUID') ? { uuid: packet.uuid } : { hash: packet.hash }),
    );
    client.on('add_resource_pack', (packet: Packet) => onPack(packet.url, { uuid: packet.uuid }));

    // 1.20.5+: the server moves us to another server. Like the game, this connection ends; the new
    // one is `followTransfer()` (or `createBot(bot.transferOptions())`), cookies included.
    client.on('transfer', (packet: Packet) => {
      this.transferTarget = { host: packet.host, port: packet.port };
      this.emit('transfer', packet.host, packet.port);
      this.end('Transferred');
    });
  }

  /** Options for connecting to the server this bot was transferred to (null if it wasn't). */
  transferOptions(): PosseOptions | null {
    if (!this.transferTarget) return null;
    const cookies: Record<string, Buffer> = {};
    for (const [k, v] of this.cookies) cookies[k] = v;
    return { ...this.options, host: this.transferTarget.host, port: this.transferTarget.port, transfer: { cookies } };
  }

  /** Connects a new bot to the server this one was transferred to (null if it wasn't). */
  followTransfer(): PosseBot | null {
    const options = this.transferOptions();
    return options ? new PosseBot(options) : null;
  }

  private writePackResult(result: number): void {
    const { uuid, hash } = this.resourcePack;
    if (this.supportFeature('resourcePackUsesUUID')) this._client.write('resource_pack_receive', { uuid, result });
    else if (this.supportFeature('resourcePackUsesHash')) this._client.write('resource_pack_receive', { hash, result });
    else this._client.write('resource_pack_receive', { result });
  }

  /** Reports the last resource pack as accepted and loaded (nothing is downloaded). */
  acceptResourcePack(): void {
    this.writePackResult(3);
    this.writePackResult(0);
  }

  denyResourcePack(): void {
    this.writePackResult(1);
  }

  // ── Chat ──────────────────────────────────────────────────────

  chat(message: string): void {
    if (typeof message !== 'string') message = String(message);
    const limit = this.supportFeature('lessCharsInChat') ? 100 : 256;
    if (message.startsWith('/')) {
      // A command can't be split; over the limit the server kicks, so cut it like the game's chat box.
      this.chatSend(message.split('\n')[0]!.slice(0, limit));
      return;
    }
    for (const line of message.split('\n')) {
      for (let i = 0; i < line.length; i += limit) this.chatSend(line.substring(i, i + limit));
    }
  }

  whisper(username: string, message: string): void {
    this.chat(`/tell ${username} ${message}`);
  }

  tabComplete(text: string, assumeCommand = false, sendBlockInSight = false, timeout = 5000): Promise<string[]> {
    return this.tabCompleteImpl(text, assumeCommand, sendBlockInSight, timeout);
  }

  // ── Inventory and windows ─────────────────────────────────────

  setQuickBarSlot(slot: number): void {
    this.inventoryApi.setQuickBarSlot(slot);
  }

  activateItem(offHand = false): void {
    this.inventoryApi.activateItem(offHand);
  }

  deactivateItem(): void {
    this.inventoryApi.deactivateItem();
  }

  clickWindow(slot: number, mouseButton: number, mode: number): Promise<void> {
    return this.inventoryApi.clickWindow(slot, mouseButton, mode);
  }

  closeWindow(window: Window): Promise<void> {
    return this.inventoryApi.closeWindow(window);
  }

  moveSlotItem(sourceSlot: number, destSlot: number): Promise<void> {
    return this.inventoryApi.moveSlotItem(sourceSlot, destSlot);
  }

  equip(item: Item | number, destination: 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand' | null): Promise<void> {
    return this.inventoryApi.equip(item, destination);
  }

  unequip(destination: 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand'): Promise<void> {
    return this.inventoryApi.unequip(destination);
  }

  updateHeldItem(): void {
    this.emit('heldItemChanged', this.heldItem);
  }

  /** Eats or drinks the held item; resolves when the server says it's done. */
  consume(): Promise<void> {
    return this.inventoryApi.consume();
  }

  /** Puts the cursor stack back into a slot range of `window` (dropping what doesn't fit). */
  putSelectedItemRange(start: number, end: number, window: Window, slot: number | null): Promise<void> {
    return this.inventoryApi.putSelectedItemRange(start, end, window, slot);
  }

  /** Moves a slot's stack of the current window into its inventory part. */
  putAway(slot: number): Promise<void> {
    return this.inventoryApi.putAway(slot);
  }

  /** Moves `count` items of a type between slot ranges of a window. */
  transfer(options: TransferOptions): Promise<void> {
    return this.inventoryApi.transfer(options);
  }

  /** Asks the server for a window's full contents (1.17+; a no-op before). */
  syncWindow(window: Window): Promise<void> {
    return this.inventoryApi.syncWindow(window);
  }

  /** @internal mineflayer's name for `syncWindow`. */
  _syncWindow(window: Window): Promise<void> {
    return this.inventoryApi.syncWindow(window);
  }

  /** Drops `count` items of a type (all of them when `count` is null). */
  toss(itemType: number, metadata: number | null, count: number | null): Promise<void> {
    return this.inventoryApi.toss(itemType, metadata, count ?? (this.inventory as unknown as { count(t: number, m: number | null): number }).count(itemType, metadata));
  }

  /** Drops a whole stack. */
  tossStack(item: Item): Promise<void> {
    return this.inventoryApi.tossStack(item);
  }

  /** The inventory slot of an equipment destination (`hand` is the selected hotbar slot). */
  getEquipmentDestSlot(destination: 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand'): number {
    return this.inventoryApi.equipmentSlot(destination);
  }

  /** @internal */
  equipmentSlot(destination: 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand'): number {
    return this.inventoryApi.equipmentSlot(destination);
  }

  // ── Using blocks and entities ─────────────────────────────────

  /** @internal The block-prediction sequence shared by digging, placing and using items (1.19+). */
  _nextSequence(): number {
    return this.interactApi.nextSequence();
  }

  swingArm(arm: 'right' | 'left' = 'right', showHand = true): void {
    this.interactApi.swingArm(arm, showHand);
  }

  /** Right-clicks a block (a door, a button, a chest…), looking at the clicked face first. */
  activateBlock(block: Block, direction?: Vec3, cursorPos?: Vec3): Promise<void> {
    return this.interactApi.activateBlock(block, direction, cursorPos);
  }

  /** Right-clicks an entity (a villager, a minecart…). */
  activateEntity(entity: Pick<Entity, 'id' | 'position'>): Promise<void> {
    return this.interactApi.activateEntity(entity);
  }

  /** Right-clicks an entity at a point on its hitbox (armour stands). */
  activateEntityAt(entity: Pick<Entity, 'id' | 'position'>, position: Vec3): Promise<void> {
    return this.interactApi.activateEntityAt(entity, position);
  }

  /** Mounts or uses an entity (right-click without looking). */
  useOn(entity: Pick<Entity, 'id' | 'position'>): Promise<void> {
    return this.interactApi.activateEntity(entity);
  }

  attack(entity: Pick<Entity, 'id'>, swing = true): void {
    this.interactApi.attack(entity, swing);
  }

  /** @internal Right-clicks a block face with the held item (placing and activating share it). */
  useOnBlock(block: { position: Vec3 }, face: Vec3, cursor: Vec3, options: { hand?: number; forceLook?: boolean | 'ignore'; swing?: boolean }): Promise<void> {
    return this.interactApi.useOnBlock(block, face, cursor, options);
  }

  /** Opens a block's window (activateBlock + windowOpen). */
  openBlock(block: Block, direction?: Vec3, cursorPos?: Vec3): Promise<OpenWindow> {
    return this.inventoryApi.openBlock(block, direction, cursorPos);
  }

  /** Opens an entity's window (activateEntity + windowOpen). */
  openEntity(entity: Pick<Entity, 'id' | 'position'>): Promise<OpenWindow> {
    return this.inventoryApi.openEntity(entity);
  }

  /** Opens a chest, barrel, shulker box, hopper… (a block) or a storage minecart (an entity). */
  openContainer(target: Block | Pick<Entity, 'id' | 'position'>): Promise<OpenWindow> {
    return this.workstationApi.openContainer(target);
  }

  openChest(target: Block | Pick<Entity, 'id' | 'position'>): Promise<OpenWindow> {
    return this.workstationApi.openContainer(target);
  }

  openFurnace(block: Block): Promise<Furnace> {
    return this.workstationApi.openFurnace(block);
  }

  openEnchantmentTable(block: Block): Promise<EnchantmentTable> {
    return this.workstationApi.openEnchantmentTable(block);
  }

  /** Opens a villager's or wandering trader's trades (track it with `entities: 'all'`, or pass `{ id, position }`). */
  openVillager(entity: Pick<Entity, 'id' | 'position'> & { name?: string }): Promise<Villager> {
    return this.villagerApi.openVillager(entity);
  }

  trade(villager: Villager, index: number, count?: number): Promise<void> {
    return this.villagerApi.trade(villager, index, count);
  }

  // ── Digging and building ──────────────────────────────────────

  /**
   * Digs a block: looks at the face it can see (`digFace`: `auto`, `raycast` or a face vector),
   * waits the dig time and resolves once broken. `forceLook: 'ignore'` skips looking.
   */
  dig(block: Block, forceLook: boolean | 'ignore' = true, digFace: DigFace = 'auto'): Promise<void> {
    return this.diggingApi.dig(block, forceLook, digFace);
  }

  stopDigging(): void {
    this.diggingApi.stopDigging();
  }

  canDigBlock(block: Block): boolean {
    return this.diggingApi.canDigBlock(block);
  }

  /** Ms to dig a block with the held item (Infinity when it can't be dug). */
  digTime(block: Block): number {
    return this.diggingApi.digTime(block);
  }

  /** Places the held block against `referenceBlock`'s face (`faceVector` points from it to the new block). */
  placeBlock(referenceBlock: Block, faceVector: Vec3, options?: PlaceOptions): Promise<void> {
    return this.buildingApi.placeBlock(referenceBlock, faceVector, options);
  }

  // ── Crafting, books ───────────────────────────────────────────

  craft(recipe: Recipe, count = 1, craftingTable: Block | null = null): Promise<void> {
    return this.craftingApi.craft(recipe, count, craftingTable);
  }

  recipesFor(itemType: number, metadata: number | null = null, minResultCount: number | null = 1, craftingTable: Block | boolean | null = null): Recipe[] {
    return this.craftingApi.recipesFor(itemType, metadata, minResultCount, craftingTable);
  }

  recipesAll(itemType: number, metadata: number | null = null, craftingTable: Block | boolean | null = null): Recipe[] {
    return this.craftingApi.recipesAll(itemType, metadata, craftingTable);
  }

  /** Writes pages into the book and quill in an inventory slot. */
  writeBook(slot: number, pages: string[]): Promise<void> {
    return this.booksApi.writeBook(slot, pages);
  }

  /** Writes and signs the book and quill in an inventory slot. */
  signBook(slot: number, pages: string[], author: string, title: string): Promise<void> {
    return this.booksApi.signBook(slot, pages, author, title);
  }

  // ── Movement ──────────────────────────────────────────────────

  setControlState(control: ControlState, state: boolean): void {
    this.motion.setControlState(control, state);
  }

  getControlState(control: ControlState): boolean {
    return this.motion.controls[control];
  }

  clearControlStates(): void {
    this.motion.clearControlStates();
  }

  look(yaw: number, pitch: number, force = true): Promise<void> {
    return this.motion.look(yaw, pitch, force);
  }

  /**
   * Resolves once the next tick has sent the bot's position and rotation (at once if nothing is
   * being sent). Use it after `look` to be sure the server has the rotation before an action.
   */
  afterTick(): Promise<void> {
    return this.motion?.afterTick() ?? Promise.resolve();
  }

  lookAt(point: Vec3, force = true): Promise<void> {
    const eye = this.entity.position.offset(0, 1.62, 0);
    const delta = point.minus(eye);
    const yaw = Math.atan2(-delta.x, -delta.z);
    const pitch = Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z));
    return this.look(yaw, pitch, force);
  }

  // ── Watching and server health ────────────────────────────────

  /**
   * Reports spawns of these entity types (modern names: `tnt`, `falling_block`, `item`…) without
   * tracking the entities: nothing else about them is decoded. Returns the unsubscribe function.
   */
  watchSpawns(names: string[], listener: (spawn: SpawnInfo) => void, options?: SpawnWatchOptions): () => void {
    return this.spawns.watch(names, listener, options);
  }

  /**
   * The server's ticks per second over the last ~10 s (from its time updates), or null until it has
   * sent enough of them. 20 is a healthy server.
   */
  get tps(): number | null {
    return this.serverHealth?.tps() ?? null;
  }

  /** The last measured round trip to the server in ms (see `ping()`), or the tab list's figure. */
  get latency(): number | null {
    return this.serverHealth?.latency() ?? null;
  }

  /**
   * Measures the round trip to the server now (1.20.2+: ping request; older: the server's own
   * keep-alive figure from the tab list). Rejects after `timeout` ms.
   */
  ping(timeout = 10_000): Promise<number> {
    return this.serverHealth.ping(timeout);
  }

  // ── World ─────────────────────────────────────────────────────

  /** The block at a position, or null when its chunk isn't kept (outside `worldRadius`). */
  blockAt(point: { x: number; y: number; z: number }): Block | null {
    return this.world.blockAt(point.x, point.y, point.z);
  }

  /** The first block a ray hits (with `face` and `intersect`), or null within `maxDistance`. */
  raycast(from: Vec3, direction: Vec3, maxDistance: number, matcher?: (block: Block) => boolean): RaycastBlock | null {
    return this.raycastApi.raycast(from, direction, maxDistance, matcher);
  }

  /** The block the bot is looking at. */
  blockAtCursor(maxDistance = 256, matcher?: (block: Block) => boolean): RaycastBlock | null {
    return this.raycastApi.blockAtCursor(maxDistance, matcher);
  }

  /** The block the bot is looking at within `maxSteps * vectorLength` blocks (mineflayer's older call). */
  blockInSight(maxSteps = 256, vectorLength = 5 / 16): RaycastBlock | null {
    return this.raycastApi.blockAtCursor(maxSteps * vectorLength);
  }

  /** The tracked entity at the crosshair, if no block is in front of it. */
  entityAtCursor(maxDistance = 3.5): Entity | null {
    return this.raycastApi.entityAtCursor(maxDistance);
  }

  /** Whether the bot's eyes have a clear line to the block. */
  canSeeBlock(block: Block): boolean {
    return this.raycastApi.canSeeBlock(block);
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  quit(reason = 'disconnect.quitting'): void {
    this.end(reason);
  }

  end(reason?: string): void {
    this.motion?.stop();
    this._client.end(reason);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  stats(): PosseStats {
    const { stats } = this.decoding;
    const top = [...stats.byName.entries()]
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => b.decoded + b.skipped - (a.decoded + a.skipped))
      .slice(0, 12);
    return {
      packets: { decoded: stats.decoded, skipped: stats.skipped, bytes: stats.bytes },
      top,
      world: this.world?.stats() ?? { columns: 0, decoded: 0, bytes: 0 },
      entities: Object.keys(this.entities).length,
      players: Object.keys(this.players).length,
      physicsTicks: this.motion?.physicsTicks ?? 0,
      server: { tps: this.tps, latency: this.latency },
    };
  }

  /** @internal Shared by features: the chat message class bound to this connection. */
  chatMessage(json: unknown): ChatMessage {
    return new this.ChatMessage(json) as ChatMessage;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const serverboundCache = new Map<string, Set<string>>();

/** Serverbound packet names for a version and protocol state. */
export function serverboundNames(version: string, state: string): Set<string> {
  const key = `${version};${state}`;
  let names = serverboundCache.get(key);
  if (!names) {
    names = new Set(packetNames(version, state, 'toServer'));
    serverboundCache.set(key, names);
  }
  return names;
}

/**
 * Drops writes the current protocol state has no packet for. On 1.20.2+ a server can send the bot
 * back to the configuration state at any time (proxies do on every server switch); a play packet
 * written then is serialized as some other configuration packet and the server kicks the bot.
 */
function guardWrites(client: Client, version: string, transfer: boolean): void {
  const write = client.write.bind(client);
  // A transferred connection says so in its handshake (intent 3, 1.20.5+).
  const transferIntent = transfer && packetNames(version, 'play').includes('transfer');
  client.write = (name: string, params: unknown) => {
    const names = serverboundNames(version, client.state);
    if (names.size > 0 && !names.has(name)) return;
    if (transferIntent && name === 'set_protocol') params = { ...(params as object), nextState: 3 };
    write(name, params);
  };
}

export function createBot(options: PosseOptions): PosseBot {
  return new PosseBot(options);
}

export { Vec3 };
