// Placing blocks: right-click a reference block's face with the held block and wait for the server's
// verdict. Follows mineflayer's place_block and generic_place plugins (MIT); the bot sneaks while
// placing against blocks that would otherwise open or toggle (chests, doors, levers…).
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import type { Block } from '../types.js';

const PLACE_TIMEOUT = 5000;

/** Blocks that react to a right-click instead of letting the held block be placed against them. */
const INTERACTABLE = new RegExp(
  '^(' +
    [
      'chest',
      'trapped_chest',
      'ender_chest',
      'barrel',
      'crafting_table',
      'crafter',
      'furnace',
      'lit_furnace',
      'blast_furnace',
      'smoker',
      '.*anvil',
      'enchanting_table',
      'enchantment_table',
      'brewing_stand',
      'beacon',
      'hopper',
      'dispenser',
      'dropper',
      '.*shulker_box',
      '(?!iron_).*_door',
      'wooden_door',
      '(?!iron_).*trapdoor',
      '.*fence_gate',
      'lever',
      '.*_button',
      '(unpowered_|powered_)?repeater',
      '(unpowered_|powered_)?comparator',
      'note_?block',
      'noteblock',
      'jukebox',
      '.*_bed',
      'bed',
      'cake',
      '.*cake',
      'loom',
      'stonecutter',
      'grindstone',
      'cartography_table',
      'smithing_table',
      'lectern',
      'bell',
      '.*_sign',
      '.*_hanging_sign',
      'standing_sign',
      'wall_sign',
      'daylight_detector(_inverted)?',
      'respawn_anchor',
      'chiseled_bookshelf',
      'command_block',
      'chain_command_block',
      'repeating_command_block',
      'structure_block',
      'jigsaw',
      'composter',
      'flower_pot',
      'beehive',
      'bee_nest',
      'vault',
      'trial_spawner',
      'decorated_pot',
    ].join('|') +
    ')$',
);

/** Whether right-clicking this block does something itself (so placing against it needs sneaking). */
export function isInteractable(name: string): boolean {
  return INTERACTABLE.test(name);
}

export interface PlaceOptions {
  /** For slabs and stairs against a side face: the upper or lower half. */
  half?: 'top' | 'bottom';
  /** Where on the reference block to click (0–1 per axis); overrides the face centre. */
  delta?: Vec3;
  forceLook?: boolean | 'ignore';
  offhand?: boolean;
  /** Swing the arm after placing (default true). */
  swingArm?: boolean;
  /** Sneak while placing: default only against interactable blocks. */
  sneak?: boolean;
}

export interface BuildingApi {
  placeBlock(referenceBlock: Block, faceVector: Vec3, options?: PlaceOptions): Promise<void>;
}

/** Where on the reference block to click for a face (and slab half). */
export function placeCursor(faceVector: { x: number; y: number; z: number }, options: Pick<PlaceOptions, 'half' | 'delta'> = {}): Vec3 {
  if (options.delta) return options.delta.clone();
  const cursor = new Vec3(0.5 + faceVector.x * 0.5, 0.5 + faceVector.y * 0.5, 0.5 + faceVector.z * 0.5);
  if (faceVector.y === 0 && options.half === 'top') cursor.y += 0.25;
  else if (faceVector.y === 0 && options.half === 'bottom') cursor.y -= 0.25;
  return cursor;
}

export function installBuilding(bot: PosseBot): BuildingApi {
  const placeBlock: BuildingApi['placeBlock'] = async (referenceBlock, faceVector, options = {}) => {
    if (options.offhand ? !bot.inventory.slots[45] : !bot.heldItem) throw new Error(`must be holding an item${options.offhand ? ' in the off-hand' : ''} to place`);
    const dest = referenceBlock.position.plus(faceVector);
    const oldBlock = bot.blockAt(dest);
    const sneak = options.sneak ?? isInteractable(referenceBlock.name);
    const wasSneaking = bot.getControlState('sneak');

    try {
      if (sneak && !wasSneaking) bot.setControlState('sneak', true);
      await bot.useOnBlock(referenceBlock, faceVector, placeCursor(faceVector, options), {
        hand: options.offhand ? 1 : 0,
        forceLook: options.forceLook ?? true,
        swing: options.swingArm ?? true,
      });
    } finally {
      if (sneak && !wasSneaking) bot.setControlState('sneak', false);
    }

    // The server answers with a block update for the reference block, then one for the block
    // across the face (watched by position: nothing else gets decoded meanwhile).
    const newBlock = await new Promise<Block>((resolve, reject) => {
      let acked = false;
      const r = referenceBlock.position;
      const done = (err: Error | null, block?: Block): void => {
        clearTimeout(timer);
        unwatchRef();
        unwatchDest();
        bot.removeListener('end', onEnd);
        if (err) reject(err);
        else resolve(block!);
      };
      const unwatchRef = bot.world.watch(r.x, r.y, r.z, () => (acked = true));
      const unwatchDest = bot.world.watch(dest.x, dest.y, dest.z, (stateId) => {
        const block = bot.world.makeBlock(stateId, dest.x, dest.y, dest.z);
        if (oldBlock && block.type === oldBlock.type) {
          if (acked) done(new Error(`Server refused to place ${bot.heldItem?.name ?? 'block'} at ${dest}: the block is still ${block.name}`));
          return;
        }
        done(null, block);
      });
      const onEnd = (): void => done(new Error('Disconnected while placing'));
      const timer = setTimeout(
        () => done(new Error(acked ? `Server refused to place at ${dest}` : `Server did not answer the placement at ${dest}`)),
        PLACE_TIMEOUT,
      );
      bot.on('end', onEnd);
    });
    bot.emit('blockPlaced', oldBlock, newBlock);
  };

  return { placeBlock };
}
