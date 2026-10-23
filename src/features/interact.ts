// Using blocks and entities: right-clicks (activateBlock / activateEntity), attacks, arm swings and
// the block-prediction sequence shared with digging, placing and using items. Packet shapes follow
// mineflayer's inventory and entities plugins (MIT), with 26.1's interact-only use_entity added.
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import type { Block, Entity } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */

/** Block faces as the protocol numbers them. */
export const BlockFace = { BOTTOM: 0, TOP: 1, NORTH: 2, SOUTH: 3, WEST: 4, EAST: 5 } as const;

/** Face vectors by protocol face number. */
export const FACE_VECTORS: readonly Vec3[] = [
  new Vec3(0, -1, 0),
  new Vec3(0, 1, 0),
  new Vec3(0, 0, -1),
  new Vec3(0, 0, 1),
  new Vec3(-1, 0, 0),
  new Vec3(1, 0, 0),
];

/** The protocol face number of a unit face vector. */
export function vectorToDirection(v: { x: number; y: number; z: number }): number {
  if (v.y < 0) return BlockFace.BOTTOM;
  if (v.y > 0) return BlockFace.TOP;
  if (v.z < 0) return BlockFace.NORTH;
  if (v.z > 0) return BlockFace.SOUTH;
  if (v.x < 0) return BlockFace.WEST;
  if (v.x > 0) return BlockFace.EAST;
  throw new Error(`Invalid direction vector ${String(v)}`);
}

export interface BlockPlaceOptions {
  location: Vec3;
  /** Protocol face number. */
  direction: number;
  /** Where on the clicked face, 0–1 within the block. */
  cursor: { x: number; y: number; z: number };
  /** 0 main hand, 1 off hand. */
  hand: number;
  sequence: number;
  /** ≤1.8 sends the held item with the click. */
  heldItem: unknown;
}

/** `block_place` (use item on block) parameters for this version's packet shape. */
export function blockPlaceParams(supportFeature: (f: string) => boolean, o: BlockPlaceOptions): Record<string, unknown> {
  if (supportFeature('blockPlaceHasHeldItem')) {
    return {
      location: o.location,
      direction: o.direction,
      heldItem: o.heldItem,
      cursorX: Math.floor(o.cursor.x * 16),
      cursorY: Math.floor(o.cursor.y * 16),
      cursorZ: Math.floor(o.cursor.z * 16),
    };
  }
  if (supportFeature('blockPlaceHasHandAndIntCursor')) {
    return {
      location: o.location,
      direction: o.direction,
      hand: o.hand,
      cursorX: Math.floor(o.cursor.x * 16),
      cursorY: Math.floor(o.cursor.y * 16),
      cursorZ: Math.floor(o.cursor.z * 16),
    };
  }
  return {
    location: o.location,
    direction: o.direction,
    hand: o.hand,
    cursorX: o.cursor.x,
    cursorY: o.cursor.y,
    cursorZ: o.cursor.z,
    insideBlock: false, // 1.14+
    sequence: o.sequence, // 1.19+
    worldBorderHit: false, // 1.21.2+
  };
}

/** The point the camera aims at to click `face` of a block at `cursor` (0–1 within the block). */
export function faceCursor(face: { x: number; y: number; z: number }): Vec3 {
  return new Vec3(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
}

/** 26.1 merged the interact actions: use_entity is interact-at only, attacks have their own packet. */
export function useEntityIsInteractOnly(version: string): boolean {
  const fields = (minecraftData(version)?.protocol as any)?.play?.toServer?.types?.packet_use_entity?.[1] as Array<{ name: string }> | undefined;
  return fields !== undefined && !fields.some((f) => f.name === 'mouse');
}

export interface InteractApi {
  nextSequence(): number;
  swingArm(arm?: 'right' | 'left', showHand?: boolean): void;
  activateBlock(block: Block, direction?: Vec3, cursorPos?: Vec3): Promise<void>;
  activateEntity(entity: Pick<Entity, 'id' | 'position'>): Promise<void>;
  activateEntityAt(entity: Pick<Entity, 'id' | 'position'>, position: Vec3): Promise<void>;
  attack(entity: Pick<Entity, 'id'>, swing?: boolean): void;
  /** Writes `block_place` against `block`'s face after looking at it (shared with placeBlock). */
  useOnBlock(block: { position: Vec3 }, face: Vec3, cursor: Vec3, options: { hand?: number; forceLook?: boolean | 'ignore'; swing?: boolean }): Promise<void>;
}

export function installInteract(bot: PosseBot): InteractApi {
  const client = bot._client as any;
  const sf = bot.supportFeature;
  const { Item } = bot.kit;
  const interactOnly = useEntityIsInteractOnly(bot.version);

  // One prediction sequence shared by digging, use-item-on and use-item (1.19+). Abort, release
  // and drop actions send 0 and don't consume a value.
  let sequence = 0;
  const nextSequence = (): number => ++sequence;

  const swingArm = (arm: 'right' | 'left' = 'right', showHand = true): void => {
    client.write('arm_animation', showHand ? { hand: arm === 'right' ? 0 : 1 } : {});
  };

  /** Looks at a point, then waits for the rotation to reach the server. */
  const face = async (point: Vec3, forceLook: boolean | 'ignore' = true): Promise<void> => {
    if (forceLook === 'ignore') return;
    await bot.lookAt(point, forceLook);
    await bot.afterTick();
  };

  const useOnBlock: InteractApi['useOnBlock'] = async (block, faceVector, cursor, options) => {
    const hand = options.hand ?? 0;
    await face(block.position.plus(cursor), options.forceLook ?? true);
    client.write(
      'block_place',
      blockPlaceParams(sf, {
        location: block.position,
        direction: vectorToDirection(faceVector),
        cursor,
        hand,
        sequence: nextSequence(),
        heldItem: Item.toNotch(hand === 1 ? bot.inventory.slots[45] : bot.heldItem),
      }),
    );
    // The swing follows the click, like the game.
    if (options.swing ?? true) swingArm(hand === 1 ? 'left' : 'right');
  };

  const activateBlock: InteractApi['activateBlock'] = async (block, direction = new Vec3(0, 1, 0), cursorPos) => {
    // The cursor lies on the clicked face; the head faces that point, like the game's crosshair.
    await useOnBlock(block, direction, cursorPos ?? faceCursor(direction), { forceLook: true });
  };

  const useEntity = (target: number, mouse: 0 | 2, hit: Vec3 | null): void => {
    const sneaking = bot.getControlState('sneak');
    if (interactOnly) {
      client.write('use_entity', { target, hand: 0, location: hit ?? new Vec3(0, 0, 0), sneaking });
      return;
    }
    if (mouse === 2 && hit) {
      client.write('use_entity', { target, mouse, x: hit.x, y: hit.y, z: hit.z, hand: 0, sneaking });
      return;
    }
    client.write('use_entity', { target, mouse, hand: 0, sneaking });
  };

  const activateEntity: InteractApi['activateEntity'] = async (entity) => {
    await face(entity.position.offset(0, 1, 0));
    // The vanilla client sends interact-at (where on the hitbox) before interact.
    if (!interactOnly) useEntity(entity.id, 2, new Vec3(0, 1, 0));
    useEntity(entity.id, 0, new Vec3(0, 1, 0));
  };

  const activateEntityAt: InteractApi['activateEntityAt'] = async (entity, position) => {
    await face(position);
    const hit = position.minus(entity.position);
    useEntity(entity.id, 2, hit);
    if (!interactOnly) useEntity(entity.id, 0, hit);
  };

  const attack: InteractApi['attack'] = (entity, swing = true) => {
    const hit = (): void => {
      if (sf('attackUsesOwnPacket')) client.write('attack', { entityId: entity.id });
      else client.write('use_entity', { target: entity.id, mouse: 1, sneaking: bot.getControlState('sneak') });
    };
    // 1.8 swings before the attack; later versions after it.
    if (sf('armAnimationBeforeUse')) {
      if (swing) swingArm();
      hit();
    } else {
      hit();
      if (swing) swingArm();
    }
  };

  return { nextSequence, swingArm, activateBlock, activateEntity, activateEntityAt, attack, useOnBlock };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
