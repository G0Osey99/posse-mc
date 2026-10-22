// Public types of a Posse bot: a mineflayer-compatible API slice, plus Posse's own
// options and stats. Field names follow mineflayer so code ports without changes.
import type { Client, MicrosoftDeviceAuthorizationResponse } from 'minecraft-protocol';
import type { Block } from 'prismarine-block';
import type { ChatMessage } from 'prismarine-chat';
import type { Entity } from 'prismarine-entity';
import type { Item } from 'prismarine-item';
import type { Window } from 'prismarine-windows';
import type { Vec3 } from 'vec3';

export type { Block, ChatMessage, Entity, Item, Window, Client };

export type EntityTracking = 'none' | 'players' | 'all';

export interface PosseOptions {
  host: string;
  port?: number;
  username: string;
  auth?: 'microsoft' | 'mojang' | 'offline';
  /** minecraft-data version string. Omitted: detected by pinging the server. */
  version?: string;
  hideErrors?: boolean;
  checkTimeoutInterval?: number;
  /** Client view distance setting (`tiny` = 6, `short` = 8, `normal` = 10, `far` = 12, or a number). */
  viewDistance?: 'tiny' | 'short' | 'normal' | 'far' | number;
  onMsaCode?: (data: MicrosoftDeviceAuthorizationResponse) => void;
  profilesFolder?: string | false;
  brand?: string;
  /** Respawn automatically on death (default true, like mineflayer). */
  respawn?: boolean;
  /** Accept server resource packs without downloading them (default true). */
  acceptResourcePacks?: boolean;
  /** Which other entities to track (default `players`). */
  entities?: EntityTracking;
  /** Keep raw chunks within this many chunks of the bot (default 4; 0 keeps none). */
  worldRadius?: number;
  /** Simulate physics while settling after a teleport and while moving (default true). */
  physics?: boolean;
  /** Decode every packet, like mineflayer (debugging / compatibility). */
  decodeAll?: boolean;
  /**
   * How long chat and commands sent while the bot isn't in the game (before it joins, or while a
   * 1.20.2+ server or proxy has it in the configuration state) are held and sent once it's back, in
   * ms (default 30 000). Older ones are dropped, like 0 drops them all.
   */
  holdChatMs?: number;
  /** Set on a connection that follows a transfer (see `bot.transferOptions()`). */
  transfer?: { cookies?: Record<string, Buffer | Uint8Array> };
  /** For tests: a custom minecraft-protocol client factory. */
  createClient?: (options: Record<string, unknown>) => Client;
}

/** A spawn reported by `bot.watchSpawns` (the entity itself isn't tracked). */
export interface SpawnInfo {
  id: number;
  /** Modern entity name (`tnt`, `falling_block`, `item`…), in every version. */
  name: string;
  position: Vec3;
  uuid?: string;
  /** Blocks per tick, when the packet carries it. */
  velocity?: Vec3;
  /** The spawn's data field (falling block state, item frame direction…). */
  data?: number;
}

export interface SpawnWatchOptions {
  /** Only spawns within this many blocks of the bot (default: any distance). */
  within?: number;
}

export interface ExplosionInfo {
  position: Vec3;
  /** ≤1.21.1 and 26.1+. */
  radius?: number;
  /** Blocks the explosion destroyed, when the packet says (≤1.21.1 lists them). */
  blockCount?: number;
}

export interface Player {
  uuid: string;
  username: string;
  displayName: ChatMessage;
  gamemode?: number;
  ping?: number;
  listed?: boolean;
  entity?: Entity | null;
  skinData?: { url: string; model?: string; capeUrl?: string };
}

export interface ScoreboardItem {
  name: string;
  value: number;
  /** Team prefix + name + suffix, or the 1.20.3+ display name override. */
  readonly displayName: ChatMessage;
}

export interface Scoreboard {
  name: string;
  title: string;
  itemsMap: Record<string, ScoreboardItem>;
  /** Highest score first. */
  readonly items: ScoreboardItem[];
}

export interface Team {
  team: string;
  name: ChatMessage;
  prefix: ChatMessage;
  suffix: ChatMessage;
  color: string;
  members: string[];
  displayName(member: string): ChatMessage;
}

export interface GameState {
  levelType?: string;
  hardcore?: boolean;
  gameMode?: string;
  dimension: string;
  minY: number;
  height: number;
  difficulty?: string;
  maxPlayers?: number;
  serverViewDistance?: number;
  serverBrand?: string;
}

export interface ControlStates {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  sneak: boolean;
}

export type ControlState = keyof ControlStates;

export interface PosseStats {
  packets: { decoded: number; skipped: number; bytes: number };
  /** Top packet names by count. */
  top: Array<{ name: string; decoded: number; skipped: number; bytes: number }>;
  world: { columns: number; decoded: number; bytes: number };
  entities: number;
  players: number;
  physicsTicks: number;
  /** The server's ticks per second (null until known) and the last round trip in ms. */
  server: { tps: number | null; latency: number | null };
}

export interface PosseBotEvents {
  login: () => void;
  spawn: () => void;
  respawn: () => void;
  game: () => void;
  death: () => void;
  health: () => void;
  kicked: (reason: string | object, loggedIn: boolean) => void;
  end: (reason: string) => void;
  error: (err: Error) => void;
  message: (message: ChatMessage, position: string, sender?: string | null, verified?: boolean) => void;
  messagestr: (message: string, position: string, jsonMsg: ChatMessage, sender?: string | null, verified?: boolean) => void;
  actionBar: (message: ChatMessage) => void;
  title: (text: string, type: 'title' | 'subtitle') => void;
  title_times: (fadeIn: number, stay: number, fadeOut: number) => void;
  title_clear: () => void;
  windowOpen: (window: Window) => void;
  windowClose: (window: Window | null) => void;
  heldItemChanged: (item: Item | null) => void;
  playerJoined: (player: Player) => void;
  playerUpdated: (player: Player) => void;
  playerLeft: (player: Player) => void;
  entitySpawn: (entity: Entity) => void;
  entityGone: (entity: Entity) => void;
  entityMoved: (entity: Entity) => void;
  playerCollect: (collector: Entity, collected: Entity) => void;
  blockUpdate: (oldBlock: Block | null, newBlock: Block) => void;
  chunkColumnLoad: (point: Vec3) => void;
  chunkColumnUnload: (point: Vec3) => void;
  scoreboardCreated: (scoreboard: Scoreboard) => void;
  scoreboardDeleted: (scoreboard: Scoreboard) => void;
  scoreboardTitleChanged: (scoreboard: Scoreboard) => void;
  scoreUpdated: (scoreboard: Scoreboard, item: ScoreboardItem) => void;
  scoreRemoved: (scoreboard: Scoreboard, item: ScoreboardItem | undefined) => void;
  scoreboardPosition: (position: number, scoreboard: Scoreboard, previous: Scoreboard | undefined) => void;
  teamCreated: (team: Team) => void;
  teamRemoved: (team: Team) => void;
  teamUpdated: (team: Team) => void;
  time: () => void;
  rain: () => void;
  resourcePack: (url: string, hashOrUuid?: string) => void;
  forcedMove: () => void;
  move: () => void;
  physicsTick: () => void;
  /** An explosion the server reported (any size, anywhere in view). */
  explosion: (explosion: ExplosionInfo) => void;
  /** Server-initiated transfer to another server (1.20.5+). */
  transfer: (host: string, port: number) => void;
  [event: `setWindowItems:${number}`]: () => void;
  [event: `confirmTransaction${number}`]: (accepted: boolean) => void;
}
