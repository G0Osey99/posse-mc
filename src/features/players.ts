// The tab list (`bot.players`) and entity tracking (docs/design.md → Entities). Only the
// tracked kinds are created; movement packets for anything else are dropped before decoding.
import type { PosseBot } from '../bot.js';
import * as conv from '../conv.js';
import { entityIdFilter } from '../decode.js';
import { spawnTypeFilter, type SpawnWatch } from './spawns.js';
import type { Entity, EntityTracking, Player } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */

const PLAYER_HEIGHT = 1.8;
const PLAYER_WIDTH = 0.6;
const PLAYER_EYE_HEIGHT = 1.62;

/** Reads skin data from a profile's `textures` property (base64 JSON). */
export function extractSkin(properties: Array<{ name: string; value: string }> | undefined): Player['skinData'] {
  const textures = properties?.find((p) => p.name === 'textures');
  if (!textures?.value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(textures.value, 'base64').toString('utf8')) as {
      textures?: { SKIN?: { url?: string; metadata?: { model?: string } }; CAPE?: { url?: string } };
    };
    const url = decoded.textures?.SKIN?.url;
    if (!url) return undefined;
    return { url, model: decoded.textures?.SKIN?.metadata?.model, capeUrl: decoded.textures?.CAPE?.url };
  } catch {
    return undefined;
  }
}

export function installPlayers(bot: PosseBot, tracking: EntityTracking, spawns: SpawnWatch): void {
  const client = bot._client as any;
  const sf = bot.supportFeature;
  const { Entity } = bot.kit;
  const registry = bot.registry as any;
  const byUuid = new Map<string, Player>();
  const ChatMessage = bot.ChatMessage;

  const entityData: Record<number, any> = {};
  for (const e of registry.entitiesArray ?? []) entityData[e.internalId ?? e.id] = e;
  const playerType = registry.entitiesByName?.player;
  const playerTypeId: number | undefined = playerType?.internalId ?? playerType?.id;

  const tracked = { has: (id: number): boolean => bot.entities[id] !== undefined };
  const moveFilter = entityIdFilter(tracked);
  for (const name of ['rel_entity_move', 'entity_move_look', 'entity_look', 'entity_teleport', 'sync_entity_position', 'entity_head_rotation']) {
    bot.decoding.setFilter(name, moveFilter);
  }
  // spawn_entity carries players from 1.20.2; watched types (spawns.ts) pass too.
  const playersInSpawnEntity = tracking !== 'none' && bot.registry.version['>=']('1.20.2');
  if (tracking !== 'all') {
    bot.decoding.setFilter(
      'spawn_entity',
      spawnTypeFilter((type) => (playersInSpawnEntity && type === playerTypeId) || spawns.wantsObject(type), spawns.layout),
    );
  }

  const nameOf = (username: string): any => new ChatMessage({ text: '', extra: [{ text: username }] });
  const fromNotch = (value: unknown): any => {
    try {
      return ChatMessage.fromNotch(value);
    } catch {
      return new ChatMessage({ text: String(value) });
    }
  };

  const setPos = (entity: Entity, pos: { x: number; y: number; z: number; yaw?: number; pitch?: number }): void => {
    if (sf('fixedPointPosition')) entity.position.set(pos.x / 32, pos.y / 32, pos.z / 32);
    else entity.position.set(pos.x, pos.y, pos.z);
    if (pos.yaw !== undefined) entity.yaw = conv.fromNotchianYawByte(pos.yaw);
    if (pos.pitch !== undefined) entity.pitch = conv.fromNotchianPitchByte(pos.pitch);
  };
  // 1.21.2+ entity_teleport: degrees as floats, and each coordinate/angle may be relative.
  const teleportInDegrees = bot.registry.version['>=']('1.21.2');
  const teleport = (entity: Entity, packet: any): void => {
    if (!teleportInDegrees) return setPos(entity, packet);
    const rel = (name: string): boolean => Boolean(packet.flags?.[name]);
    const p = entity.position;
    p.set(rel('x') ? p.x + packet.x : packet.x, rel('y') ? p.y + packet.y : packet.y, rel('z') ? p.z + packet.z : packet.z);
    const yaw = (rel('yaw') ? conv.toNotchianYaw(entity.yaw) : 0) + packet.yaw;
    const pitch = (rel('pitch') ? conv.toNotchianPitch(entity.pitch) : 0) + packet.pitch;
    entity.yaw = conv.fromNotchianYaw(yaw);
    entity.pitch = conv.fromNotchianPitch(pitch);
  };

  const linkPlayerEntity = (player: Player): void => {
    for (const e of Object.values(bot.entities)) {
      if (e.type === 'player' && e.username === player.username) {
        player.entity = e;
        return;
      }
    }
  };

  const addPlayerEntity = (entityId: number, uuid: string, packet: any): Entity => {
    const entity: Entity = bot.entities[entityId] ?? (bot.entities[entityId] = new Entity(entityId));
    entity.type = 'player';
    entity.name = 'player';
    entity.uuid = uuid;
    entity.username = bot.uuidToUsername[uuid];
    entity.height = PLAYER_HEIGHT;
    entity.width = PLAYER_WIDTH;
    (entity as any).eyeHeight = PLAYER_EYE_HEIGHT;
    setPos(entity, packet);
    const player = entity.username ? bot.players[entity.username] : undefined;
    if (player && !player.entity) player.entity = entity;
    return entity;
  };

  const addOtherEntity = (entityId: number, uuid: string | undefined, type: number, packet: any, kind?: string): Entity => {
    const entity: Entity = bot.entities[entityId] ?? (bot.entities[entityId] = new Entity(entityId));
    const data = entityData[type];
    entity.type = (kind ?? data?.type ?? 'other') as Entity['type'];
    entity.name = data?.name ?? 'unknown';
    entity.displayName = data?.displayName ?? 'unknown';
    entity.entityType = type;
    entity.height = data?.height ?? 0.5;
    entity.width = data?.width ?? 0.5;
    if (uuid) entity.uuid = uuid;
    setPos(entity, packet);
    return entity;
  };

  /** An existing entity, or an untracked stand-in (never added to bot.entities). */
  const peekEntity = (id: number): Entity => bot.entities[id] ?? new Entity(id);

  // ── Own entity ──
  client.on('login', (packet: any) => {
    bot.players = {};
    bot.uuidToUsername = {};
    bot.entities = {};
    byUuid.clear();
    const self: Entity = new Entity(packet.entityId);
    self.username = client.username;
    self.type = 'player';
    self.name = 'player';
    self.height = PLAYER_HEIGHT;
    self.width = PLAYER_WIDTH;
    (self as any).eyeHeight = PLAYER_EYE_HEIGHT;
    bot.entity = self;
    bot.entities[packet.entityId] = self;
    dimension = bot.game.dimension;
  });
  // A new world (a dimension change, or a proxy's server switch, which hops dimensions): the game
  // drops every other entity, and the old server never sends their removal.
  let dimension = '';
  client.on('respawn', () => {
    if (bot.game.dimension === dimension) return;
    dimension = bot.game.dimension;
    const gone = bot.listenerCount('entityGone') > 0;
    for (const [id, entity] of Object.entries(bot.entities)) {
      if (entity === bot.entity) continue;
      delete bot.entities[Number(id)];
      if (gone) bot.emit('entityGone', entity);
    }
    for (const player of Object.values(bot.players)) player.entity = null;
  });
  bot.on('spawn', () => bot.emit('entitySpawn', bot.entity));

  client.on('collect', (packet: any) => {
    bot.emit('playerCollect', peekEntity(packet.collectorEntityId), peekEntity(packet.collectedEntityId));
  });

  // ── Spawns ──
  if (tracking !== 'none') {
    client.on('named_entity_spawn', (packet: any) => {
      if (!(packet.playerUUID in bot.uuidToUsername)) return;
      bot.emit('entitySpawn', addPlayerEntity(packet.entityId, packet.playerUUID, packet));
    });
  }
  // ≤1.20.1: objects/vehicles; 1.20.2+: every entity including players. Always listened to (the
  // filter above keeps it to what's tracked or watched).
  client.on('spawn_entity', (packet: any) => {
    const name = spawns.objectName(packet.type);
    if (name) spawns.report(name, packet, packet.objectUUID);
  });
  if (tracking !== 'none') {
    if (tracking === 'all' || playersInSpawnEntity) {
      client.on('spawn_entity', (packet: any) => {
        const isPlayer = packet.type === playerTypeId && playersInSpawnEntity;
        if (!isPlayer && tracking !== 'all') return;
        const entity = isPlayer
          ? addPlayerEntity(packet.entityId, packet.objectUUID, packet)
          : addOtherEntity(packet.entityId, packet.objectUUID, packet.type, packet);
        // Before 1.14 the type is an object id, not a registry id.
        if (!isPlayer && spawns.layout !== 'varint') entity.name = spawns.objectName(packet.type) ?? entity.name;
        bot.emit('entitySpawn', entity);
      });
    }
    if (tracking === 'all') {
      client.on('spawn_entity_living', (packet: any) => {
        const entity = addOtherEntity(packet.entityId, packet.entityUUID, packet.type, packet, 'mob');
        const mob = registry.mobs?.[packet.type];
        if (mob) {
          entity.name = mob.name;
          entity.displayName = mob.displayName;
          entity.height = mob.height;
          entity.width = mob.width;
        }
        spawns.report(entity.name ?? 'unknown', packet, packet.entityUUID);
        bot.emit('entitySpawn', entity);
      });
    }
  }
  // Watched mobs (≤1.18 they come in spawn_entity_living): listened to only while watched.
  if (tracking !== 'all') {
    const onLiving = (packet: any): void => {
      const name = registry.mobs?.[packet.type]?.name ?? entityData[packet.type]?.name;
      if (name) spawns.report(name, packet, packet.entityUUID);
    };
    let living = false;
    spawns.onChange = () => {
      if (spawns.watchesMobs && !living) client.on('spawn_entity_living', onLiving);
      else if (!spawns.watchesMobs && living) client.removeListener('spawn_entity_living', onLiving);
      living = spawns.watchesMobs;
    };
  }

  const destroy = (id: number): void => {
    const entity = bot.entities[id];
    if (!entity || entity === bot.entity) return;
    bot.emit('entityGone', entity);
    entity.isValid = false;
    if (entity.username && bot.players[entity.username]) bot.players[entity.username]!.entity = null;
    delete bot.entities[id];
  };
  client.on('entity_destroy', (packet: any) => packet.entityIds.forEach(destroy));
  client.on('destroy_entity', (packet: any) => destroy(packet.entityId)); // 1.17.0 only

  // ── Movement (filtered to tracked entities) ──
  const moved = (entity: Entity): void => {
    if (bot.listenerCount('entityMoved') > 0) bot.emit('entityMoved', entity);
  };
  const delta = sf('fixedPointDelta') ? 32 : 128 * 32;
  client.on('rel_entity_move', (packet: any) => {
    const entity = bot.entities[packet.entityId];
    if (!entity) return;
    entity.position.translate(packet.dX / delta, packet.dY / delta, packet.dZ / delta);
    moved(entity);
  });
  client.on('entity_move_look', (packet: any) => {
    const entity = bot.entities[packet.entityId];
    if (!entity) return;
    entity.position.translate(packet.dX / delta, packet.dY / delta, packet.dZ / delta);
    entity.yaw = conv.fromNotchianYawByte(packet.yaw);
    entity.pitch = conv.fromNotchianPitchByte(packet.pitch);
    moved(entity);
  });
  client.on('entity_look', (packet: any) => {
    const entity = bot.entities[packet.entityId];
    if (!entity) return;
    entity.yaw = conv.fromNotchianYawByte(packet.yaw);
    entity.pitch = conv.fromNotchianPitchByte(packet.pitch);
    moved(entity);
  });
  client.on('entity_teleport', (packet: any) => {
    const entity = bot.entities[packet.entityId];
    if (!entity) return;
    teleport(entity, packet);
    moved(entity);
  });
  client.on('sync_entity_position', (packet: any) => {
    const entity = bot.entities[packet.entityId];
    if (!entity) return;
    entity.position.set(packet.x, packet.y, packet.z);
    entity.yaw = conv.fromNotchianYaw(packet.yaw);
    entity.pitch = conv.fromNotchianPitch(packet.pitch);
    moved(entity);
  });
  client.on('entity_head_rotation', (packet: any) => {
    const entity = bot.entities[packet.entityId];
    if (entity) (entity as any).headYaw = conv.fromNotchianYawByte(packet.headYaw);
  });

  // ── Tab list ──
  const remember = (player: Player): void => {
    bot.players[player.username] = player;
    bot.uuidToUsername[player.uuid] = player.username;
    byUuid.set(player.uuid, player);
  };
  const forget = (player: Player): void => {
    if (player.entity && player.entity === bot.entity) return;
    player.entity = null;
    delete bot.players[player.username];
    delete bot.uuidToUsername[player.uuid];
    byUuid.delete(player.uuid);
    bot.emit('playerLeft', player);
  };

  const onBitfield = (packet: any): void => {
    const action = packet.action;
    for (const item of packet.data) {
      let player = byUuid.get(item.uuid);
      const isNew = !player;
      if (!player) player = { uuid: item.uuid, username: '', displayName: nameOf('') };
      if (action.add_player) {
        player.username = item.player.name;
        player.displayName = nameOf(item.player.name);
        player.skinData = extractSkin(item.player.properties);
      }
      if (action.update_game_mode) player.gamemode = item.gamemode;
      if (action.update_listed) player.listed = item.listed;
      if (action.update_latency) player.ping = item.latency;
      if (action.update_display_name) {
        player.displayName = item.displayName ? fromNotch(item.displayName) : nameOf(player.username);
      }
      if (isNew) {
        if (!player.username) continue;
        remember(player);
        linkPlayerEntity(player);
        bot.emit('playerJoined', player);
      } else {
        bot.emit('playerUpdated', player);
      }
    }
  };

  const onLegacy = (packet: any): void => {
    for (const item of packet.data) {
      let player = byUuid.get(item.uuid);
      switch (packet.action) {
        case 'add_player': {
          const isNew = !player;
          if (!player) {
            player = { uuid: item.uuid, username: item.name, displayName: nameOf(item.name) };
            remember(player);
          }
          player.ping = item.ping;
          player.gamemode = item.gamemode;
          player.displayName = item.displayName ? fromNotch(item.displayName) : nameOf(item.name);
          if (item.properties) player.skinData = extractSkin(item.properties);
          linkPlayerEntity(player);
          bot.emit(isNew ? 'playerJoined' : 'playerUpdated', player);
          break;
        }
        case 'update_game_mode':
          if (player) {
            player.gamemode = item.gamemode;
            bot.emit('playerUpdated', player);
          }
          break;
        case 'update_latency':
          if (player) {
            player.ping = item.ping;
            bot.emit('playerUpdated', player);
          }
          break;
        case 'update_display_name':
          if (player) {
            player.displayName = item.displayName ? fromNotch(item.displayName) : nameOf(player.username);
            bot.emit('playerUpdated', player);
          }
          break;
        case 'remove_player':
          if (player) forget(player);
          break;
      }
    }
  };

  client.on('player_info', sf('playerInfoActionIsBitfield') ? onBitfield : onLegacy);
  client.on('player_remove', (packet: any) => {
    for (const uuid of packet.players) {
      const player = byUuid.get(uuid);
      if (player) forget(player);
    }
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
