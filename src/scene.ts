// Builds a screenshot scene (./view/types.ts) from what a bot currently knows: the blocks around
// its eyes, nearby tracked entities, time, weather and its HUD.
import type { PosseBot } from './bot.js';
import * as conv from './conv.js';
import type { SceneEntity, ViewScene } from './view/types.js';

export interface SceneOptions {
  width?: number;
  height?: number;
  fov?: number;
  /** Horizontal half-size of the block region, in blocks (default 64). */
  radius?: number;
  /** Blocks below / above the eyes (default 40 / 48). */
  below?: number;
  above?: number;
  /** Caption drawn on the HUD. */
  caption?: string;
}

const KINDS: Record<string, SceneEntity['kind']> = { player: 'player', mob: 'mob', hostile: 'mob', animal: 'mob', passive: 'mob' };

/** Null until the bot has spawned somewhere. */
export function buildScene(bot: PosseBot, options: SceneOptions = {}): ViewScene | null {
  const self = bot.entity;
  if (!self?.position || !bot.world) return null;
  const clamp = (v: number | undefined, d: number, max: number): number =>
    Math.max(1, Math.min(max, Math.round(Number.isFinite(v) ? v! : d)));
  const radius = clamp(options.radius, 64, 160);
  const below = clamp(options.below, 40, 160);
  const above = clamp(options.above, 48, 160);
  const eye = { x: self.position.x, y: self.position.y + 1.62, z: self.position.z };

  const originX = Math.floor(eye.x) - radius;
  const originY = Math.floor(eye.y) - below;
  const originZ = Math.floor(eye.z) - radius;
  const sizeX = radius * 2;
  const sizeY = below + above;
  const sizeZ = radius * 2;
  const { states, biomes } = bot.world.copyRegion(originX, originY, originZ, sizeX, sizeY, sizeZ, Math.floor(eye.y));

  const entities: SceneEntity[] = [];
  for (const entity of Object.values(bot.entities)) {
    if (entity === self || !entity.position) continue;
    const dx = entity.position.x - eye.x;
    const dz = entity.position.z - eye.z;
    if (dx * dx + dz * dz > radius * radius) continue;
    const player = entity.username ? bot.players[entity.username] : undefined;
    entities.push({
      kind: KINDS[entity.type] ?? (entity.name === 'item' ? 'item' : 'other'),
      name: entity.name ?? 'unknown',
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      yaw: conv.toNotchianYaw(entity.yaw ?? 0),
      pitch: conv.toNotchianPitch(entity.pitch ?? 0),
      width: entity.width ?? 0.6,
      height: entity.height ?? 1.8,
      ...(entity.username ? { label: entity.username } : {}),
      ...(player?.skinData?.url ? { skinUrl: player.skinData.url, slim: player.skinData.model === 'slim' } : {}),
    });
  }

  const hotbar: NonNullable<ViewScene['hud']>['hotbar'] = [];
  for (let i = 0; i < 9; i++) {
    const item = bot.inventory?.slots[bot.QUICK_BAR_START + i] as { name: string; count: number } | null | undefined;
    hotbar.push(item ? { name: item.name, count: item.count } : null);
  }

  return {
    version: bot.version,
    width: options.width ?? 640,
    height: options.height ?? 360,
    camera: { ...eye, yaw: conv.toNotchianYaw(self.yaw), pitch: conv.toNotchianPitch(self.pitch), fov: options.fov ?? 70 },
    region: { originX, originY, originZ, sizeX, sizeY, sizeZ, states, biomes },
    entities,
    timeOfDay: bot.time.timeOfDay,
    raining: bot.isRaining,
    dimension: bot.game.dimension,
    hud: {
      health: bot.health,
      food: bot.food,
      hotbar,
      selectedSlot: bot.quickBarSlot,
      ...(options.caption ? { caption: options.caption } : {}),
    },
  };
}
