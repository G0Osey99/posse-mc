// A Posse bot: one connection, a mineflayer-compatible API, at a fraction of the
// per-bot cost (docs/design.md). Feature logic lives in ./features; version branches follow
// mineflayer's (MIT), which these were ported from.
import { EventEmitter } from 'node:events';
import mc, { type Client } from 'minecraft-protocol';
import nbt from 'prismarine-nbt';
import type { Registry } from 'prismarine-registry';
import { Vec3 } from 'vec3';
import { installDemandDecoding, type DemandDecoding } from './decode.js';
import { installChat } from './features/chat.js';
import { installInventory, type InventoryApi } from './features/inventory.js';
import { installMotion, type MotionApi } from './features/motion.js';
import { installPlayers } from './features/players.js';
import { installScoreboard } from './features/scoreboard.js';
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

  private inventoryApi!: InventoryApi;
  private motion!: MotionApi;
  private chatSend: (message: string) => void = () => undefined;
  private tabCompleteImpl: (text: string, assumeCommand?: boolean, sendBlockInSight?: boolean, timeout?: number) => Promise<string[]> =
    () => Promise.resolve([]);
  private resourcePack: { hash?: string; uuid?: string } = {};
  private ended = false;

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
    this.decoding = installDemandDecoding(this._client);
    this.decoding.decodeAll = options.decodeAll ?? false;

    this._client.on('error', (err: Error) => {
      this.emit('error', err);
    });
    this._client.on('end', (reason: string) => {
      this.ended = true;
      this.motion?.stop();
      this.emit('end', reason);
    });

    const client = this._client as Client & { wait_connect?: boolean };
    if (client.wait_connect) client.once('connect_allowed', () => this.init(client.version));
    else this.init(client.version);
  }

  /** Wall-clock ms of the last packet received. */
  get lastPacketAt(): number {
    return this.decoding.lastPacketAt;
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
    installPlayers(this, this.options.entities ?? 'players');
    installScoreboard(this);
    this.inventoryApi = installInventory(this);
    installWorld(this);
    this.motion = installMotion(this, this.options.physics ?? true);
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
    const brandChannel = sf('customChannelMCPrefixed') ? 'MC|Brand' : 'minecraft:brand';
    client.registerChannel(brandChannel, ['string', []]);

    client.on('registry_data', (packet: Packet) => (this.registry as any).loadDimensionCodec(packet.codec || packet));

    client.on('login', (packet: Packet) => {
      this.applySpawnInfo(packet.worldState || packet);
      this.game.maxPlayers = packet.maxPlayers;
      if (packet.viewDistance) this.game.serverViewDistance = packet.viewDistance;
      this.username = client.username;
      this.world.clear();
      this.sendSettings();
      this.emit('login');
      this.emit('game');
      client.writeChannel(brandChannel, this.options.brand ?? 'vanilla');
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
    client.on('kick_disconnect', (packet: Packet) => this.emit('kicked', packet.reason, true));
    client.on('disconnect', (packet: Packet) => this.emit('kicked', packet.reason, false));

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

    // 1.20.5+: the server may move us to another server; minecraft-protocol doesn't follow it.
    client.on('transfer', (packet: Packet) => this.emit('transfer', packet.host, packet.port));
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
    if (message.startsWith('/')) {
      this.chatSend(message);
      return;
    }
    const limit = this.supportFeature('lessCharsInChat') ? 100 : 256;
    for (const line of message.split('\n')) {
      for (let i = 0; i < line.length; i += limit) this.chatSend(line.substring(i, i + limit));
    }
  }

  whisper(username: string, message: string): void {
    this.chatSend(`/tell ${username} ${message}`);
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

  lookAt(point: Vec3, force = true): Promise<void> {
    const eye = this.entity.position.offset(0, 1.62, 0);
    const delta = point.minus(eye);
    const yaw = Math.atan2(-delta.x, -delta.z);
    const pitch = Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z));
    return this.look(yaw, pitch, force);
  }

  // ── World ─────────────────────────────────────────────────────

  /** The block at a position, or null when its chunk isn't kept (outside `worldRadius`). */
  blockAt(point: { x: number; y: number; z: number }): Block | null {
    return this.world.blockAt(point.x, point.y, point.z);
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
    };
  }

  /** @internal Shared by features: the chat message class bound to this connection. */
  chatMessage(json: unknown): ChatMessage {
    return new this.ChatMessage(json) as ChatMessage;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function createBot(options: PosseOptions): PosseBot {
  return new PosseBot(options);
}

export { Vec3 };
