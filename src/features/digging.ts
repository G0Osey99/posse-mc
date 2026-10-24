// Digging: start/finish/abort with the game's timing, the face the bot can see, and dig time from
// the held tool, enchantments and effects. Follows mineflayer's digging plugin (MIT); the finish is
// predicted locally (the block turns to air) and corrected by the server if it disagrees.
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import { enchantsOf } from '../items.js';
import type { Block } from '../types.js';
import { faceCursor, vectorToDirection } from './interact.js';
import { targetShapes } from './raycast.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- prismarine-block and packets are loosely typed */

/** Ms between arm swings while digging (the game swings every 6 ticks or so). */
const SWING_MS = 350;
/** Blocks from the eyes to a block's centre the server accepts for digging. */
export const DIG_REACH = 5.1;
/** The game's destroy delay between two blocks (5 ticks), with a little slack. */
const DESTROY_DELAY_MS = 300;

/** `auto`: the face the bot sees (or faces); `raycast`: only a visible face; a vector: that face. */
export type DigFace = 'auto' | 'raycast' | Vec3;

export interface DiggingApi {
  dig(block: Block, forceLook?: boolean | 'ignore', digFace?: DigFace): Promise<void>;
  stopDigging(): void;
  canDigBlock(block: Block): boolean;
  digTime(block: Block): number;
}

/** The face of a block pointing most towards `eye` (by the largest axis of the offset). */
export function facingFace(eye: { x: number; y: number; z: number }, blockPos: { x: number; y: number; z: number }): Vec3 {
  const dx = eye.x - (blockPos.x + 0.5);
  const dy = eye.y - (blockPos.y + 0.5);
  const dz = eye.z - (blockPos.z + 0.5);
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  if (ay >= ax && ay >= az) return new Vec3(0, Math.sign(dy) || 1, 0);
  if (ax >= az) return new Vec3(Math.sign(dx), 0, 0);
  return new Vec3(0, 0, Math.sign(dz) || 1);
}

export function installDigging(bot: PosseBot): DiggingApi {
  const client = bot._client as any;
  const isWater = (name: string | undefined): boolean => name === 'water' || name === 'flowing_water';

  const digTime: DiggingApi['digTime'] = (block) => {
    const held = bot.heldItem;
    const head = bot.inventory.slots[bot.equipmentSlot('head')] ?? null;
    // The helmet's Aqua Affinity counts too.
    const enchantments = [...enchantsOf(bot.registry, held), ...enchantsOf(bot.registry, head)];
    const eye = bot.blockAt(bot.entity.position.offset(0, (bot.entity as any).eyeHeight ?? 1.62, 0));
    return (block as any).digTime(
      held ? held.type : null,
      bot.game.gameMode === 'creative',
      isWater(eye?.name) || Boolean((eye as any)?._properties?.waterlogged),
      !bot.entity.onGround,
      enchantments,
      (bot.entity as any).effects ?? {},
    );
  };

  const canDigBlock: DiggingApi['canDigBlock'] = (block) => {
    if (!block || !(block as any).diggable || !bot.entity?.position) return false;
    const eye = bot.entity.position.offset(0, (bot.entity as any).eyeHeight ?? 1.62, 0);
    return block.position.offset(0.5, 0.5, 0.5).distanceTo(eye) <= DIG_REACH;
  };

  /** The face to dig and the point to look at. Null when `raycast` finds no visible face. */
  const chooseFace = (block: Block, digFace: DigFace): { face: number; look: Vec3 } | null => {
    if (typeof digFace === 'object') {
      const v = digFace;
      return { face: vectorToDirection(v), look: block.position.plus(faceCursor(v)) };
    }
    const eye = bot.entity.position.offset(0, (bot.entity as any).eyeHeight ?? 1.62, 0);
    const center = block.position.offset(0.5, 0.5, 0.5);
    const shapes = targetShapes(block);
    // Aim at each face the eyes could see and keep the first one the ray actually reaches.
    const candidates: Vec3[] = [];
    if (Math.abs(eye.y - center.y) > 0.5) candidates.push(new Vec3(0, Math.sign(eye.y - center.y), 0));
    if (Math.abs(eye.x - center.x) > 0.5) candidates.push(new Vec3(Math.sign(eye.x - center.x), 0, 0));
    if (Math.abs(eye.z - center.z) > 0.5) candidates.push(new Vec3(0, 0, Math.sign(eye.z - center.z)));
    let best: { face: number; look: Vec3; dist: number } | null = null;
    for (const v of candidates) {
      const target = block.position.plus(faceCursor(v));
      const hit = bot.raycast(eye, target.minus(eye), eye.distanceTo(target) + 0.5);
      if (!hit || !hit.position.equals(block.position)) continue;
      const dist = hit.intersect.distanceTo(eye);
      if (!best || dist < best.dist) best = { face: hit.face, look: hit.intersect, dist };
    }
    if (best) return best;
    if (shapes.length === 0) return { face: 1, look: center }; // nothing to hit (water, air)
    if (digFace === 'raycast') return null;
    const v = facingFace(eye, block.position);
    return { face: vectorToDirection(v), look: block.position.plus(faceCursor(v)) };
  };

  let current: {
    block: Block;
    face: number;
    timer: NodeJS.Timeout | null;
    swing: NodeJS.Timeout | null;
    unwatch: (() => void) | null;
    reject: (err: Error) => void;
  } | null = null;

  const clearTimers = (): void => {
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    if (current.swing) clearInterval(current.swing);
    current.unwatch?.();
    current.timer = null;
    current.swing = null;
    current.unwatch = null;
  };

  /** Drops the dig without telling the server (it's gone: disconnected, or a new world). */
  const abandon = (reason: string): void => {
    if (!current) return;
    clearTimers();
    const { reject } = current;
    current = null;
    bot.targetDigBlock = null;
    bot.targetDigFace = null;
    reject(new Error(reason));
  };
  const isAir = (stateId: number): boolean => {
    const name = bot.world.makeBlock(stateId, 0, 0, 0).name;
    return name === 'air' || name === 'cave_air' || name === 'void_air';
  };

  const stopDigging: DiggingApi['stopDigging'] = () => {
    if (!current) return;
    const { block, face, reject } = current;
    clearTimers();
    current = null;
    bot.targetDigBlock = null;
    bot.targetDigFace = null;
    bot.lastDigTime = performance.now();
    // Vanilla aborts with the start face; abort actions don't consume a sequence number.
    client.write('block_dig', { status: 1, location: block.position, face, sequence: 0 });
    bot.emit('diggingAborted', block);
    reject(new Error('Digging aborted'));
  };

  const dig: DiggingApi['dig'] = async (block, forceLook = true, digFace = 'auto') => {
    if (!block) throw new Error('dig was called with an undefined or null block');
    const waitTime = digTime(block);
    if (waitTime === Infinity) throw new Error(`dig time for ${block.name} is Infinity`);
    let face = 1;
    if (forceLook !== 'ignore') {
      const chosen = chooseFace(block, digFace);
      if (!chosen) throw new Error('Block not in view');
      face = chosen.face;
      await bot.lookAt(chosen.look, forceLook);
      await bot.afterTick();
    }
    // The game cancels the block it was digging when another one comes under the crosshair.
    if (current) stopDigging();
    // After breaking a block the game waits 5 ticks before it starts on the next (Grim's FastBreak).
    if (bot.lastDigTime !== null) {
      const since = performance.now() - bot.lastDigTime;
      if (since < DESTROY_DELAY_MS) await new Promise((r) => setTimeout(r, DESTROY_DELAY_MS - since));
    }

    await new Promise<void>((resolve, reject) => {
      const record = { block, face, timer: null as NodeJS.Timeout | null, swing: null as NodeJS.Timeout | null, unwatch: null as (() => void) | null, reject };
      current = record;
      bot.targetDigBlock = block;
      bot.targetDigFace = face;
      client.write('block_dig', { status: 0, location: block.position, face, sequence: bot._nextSequence() });
      bot.swingArm();

      const finish = (): void => {
        if (current !== record) return;
        clearTimers();
        current = null;
        bot.targetDigBlock = null;
        bot.targetDigFace = null;
        bot.lastDigTime = performance.now();
        // Predict the break like the game does; the server's block update corrects a refusal.
        const before = bot.blockAt(block.position);
        bot.world.setStateId(block.position.x, block.position.y, block.position.z, 0, false);
        const after = bot.blockAt(block.position);
        if (after && bot.listenerCount('blockUpdate') > 0) bot.emit('blockUpdate', before, after);
        bot.emit('diggingCompleted', after ?? block);
        resolve();
      };

      if (waitTime <= 0) {
        // Instant breaks: the start alone breaks the block.
        finish();
        return;
      }
      record.swing = setInterval(() => bot.swingArm(), SWING_MS);
      // Broken early (another player, an explosion, a faster server): done, with no finish packet.
      const p = block.position;
      record.unwatch = bot.world.watch(p.x, p.y, p.z, (stateId) => {
        if (current === record && isAir(stateId)) finish();
      });
      record.timer = setTimeout(() => {
        if (current !== record) return;
        client.write('block_dig', { status: 2, location: block.position, face, sequence: bot._nextSequence() });
        finish();
      }, waitTime);
    });
  };

  bot.on('death', () => {
    if (current) stopDigging();
  });
  bot.on('end', () => abandon('Disconnected while digging'));
  // A new world (server switch, dimension change): the block is gone with it.
  client.on('login', () => abandon('Digging aborted: changed worlds'));
  client.on('respawn', () => abandon('Digging aborted: changed worlds'));

  return { dig, stopDigging, canDigBlock, digTime };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
