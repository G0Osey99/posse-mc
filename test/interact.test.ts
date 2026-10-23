/* eslint-disable @typescript-eslint/no-explicit-any -- registries and fake bots are untyped */
import { describe, expect, it } from 'vitest';
import mc from 'minecraft-protocol';
import { Vec3 } from 'vec3';
import { blockPlaceParams, faceCursor, useEntityIsInteractOnly, vectorToDirection } from '../src/features/interact.js';
import { isInteractable, placeCursor } from '../src/features/building.js';
import { facingFace } from '../src/features/digging.js';
import { intersectShapes, targetShapes, traverseVoxels, viewDirection } from '../src/features/raycast.js';
import { unusedGridSlots } from '../src/features/crafting.js';
import { tradePrice } from '../src/features/villager.js';
import { isContainerWindow } from '../src/features/workstations.js';
import { attributeName, normalizeModifiers } from '../src/features/effects.js';
import { enchantsOf } from '../src/items.js';
import { connectionRegistry, versionKit } from '../src/registry.js';

const VERSIONS = ['1.8.9', '1.9.4', '1.12.2', '1.13.2', '1.16.5', '1.19.4', '1.20.4', '1.21.4', '1.21.11', '26.1'];

/** Serializes a serverbound play packet the way the client would, or throws. */
function serialize(version: string, name: string, params: Record<string, unknown>): Buffer {
  const serializer = mc.createSerializer({ state: 'play', isServer: false, version } as unknown as Parameters<typeof mc.createSerializer>[0]);
  return serializer.createPacketBuffer({ name, params });
}

function feature(version: string): (f: string) => boolean {
  const registry = connectionRegistry(version) as unknown as { supportFeature(f: string): boolean };
  return (f) => Boolean(registry.supportFeature(f));
}

describe('interaction packets serialize on every version', () => {
  for (const version of VERSIONS) {
    it(`${version}: block_place, block_dig, arm_animation, use_entity/attack, use_item`, () => {
      const sf = feature(version);
      const kit = versionKit(version);
      const place = blockPlaceParams(sf, {
        location: new Vec3(1, 64, 2),
        direction: 1,
        cursor: { x: 0.5, y: 1, z: 0.5 },
        hand: 0,
        sequence: 3,
        heldItem: kit.Item.toNotch(null),
      });
      expect(() => serialize(version, 'block_place', place)).not.toThrow();
      expect(() => serialize(version, 'block_dig', { status: 0, location: new Vec3(1, 64, 2), face: 1, sequence: 4 })).not.toThrow();
      expect(() => serialize(version, 'arm_animation', { hand: 0 })).not.toThrow();
      if (sf('attackUsesOwnPacket')) expect(() => serialize(version, 'attack', { entityId: 5 })).not.toThrow();
      else expect(() => serialize(version, 'use_entity', { target: 5, mouse: 1, sneaking: false })).not.toThrow();
      if (useEntityIsInteractOnly(version)) {
        expect(() => serialize(version, 'use_entity', { target: 5, hand: 0, location: new Vec3(0, 1, 0), sneaking: false })).not.toThrow();
      } else {
        expect(() => serialize(version, 'use_entity', { target: 5, mouse: 2, x: 0, y: 1, z: 0, hand: 0, sneaking: false })).not.toThrow();
        expect(() => serialize(version, 'use_entity', { target: 5, mouse: 0, hand: 0, sneaking: false })).not.toThrow();
      }
      if (!sf('useItemWithBlockPlace')) expect(() => serialize(version, 'use_item', { hand: 0, sequence: 5, rotation: { x: 0, y: 0 } })).not.toThrow();
    });
  }

  it('only 26.1+ merges the interact actions', () => {
    expect(useEntityIsInteractOnly('1.21.11')).toBe(false);
    expect(useEntityIsInteractOnly('26.1')).toBe(true);
  });

  it('book, enchanting and trading packets serialize', () => {
    for (const version of ['1.13.2', '1.16.5', '1.20.4', '1.21.4', '26.1']) {
      const sf = feature(version);
      const kit = versionKit(version);
      if (sf('editBookPacketUsesNbt')) expect(() => serialize(version, 'edit_book', { new_book: kit.Item.toNotch(null), signing: false, hand: 0 })).not.toThrow();
      else expect(() => serialize(version, 'edit_book', { hand: 0, pages: ['a'], title: 'T' })).not.toThrow();
      expect(() => serialize(version, 'enchant_item', { windowId: 3, enchantment: 1 })).not.toThrow();
      expect(() => serialize(version, 'select_trade', { slot: 0 })).not.toThrow();
    }
  });
});

describe('faces and cursors', () => {
  it('maps face vectors to protocol directions', () => {
    expect(vectorToDirection(new Vec3(0, -1, 0))).toBe(0);
    expect(vectorToDirection(new Vec3(0, 1, 0))).toBe(1);
    expect(vectorToDirection(new Vec3(0, 0, -1))).toBe(2);
    expect(vectorToDirection(new Vec3(0, 0, 1))).toBe(3);
    expect(vectorToDirection(new Vec3(-1, 0, 0))).toBe(4);
    expect(vectorToDirection(new Vec3(1, 0, 0))).toBe(5);
    expect(() => vectorToDirection(new Vec3(0, 0, 0))).toThrow();
  });

  it('puts the cursor on the clicked face (and slab halves)', () => {
    expect(faceCursor(new Vec3(0, 1, 0))).toEqual(new Vec3(0.5, 1, 0.5));
    expect(placeCursor(new Vec3(1, 0, 0))).toEqual(new Vec3(1, 0.5, 0.5));
    expect(placeCursor(new Vec3(1, 0, 0), { half: 'top' })).toEqual(new Vec3(1, 0.75, 0.5));
    expect(placeCursor(new Vec3(0, 1, 0), { half: 'top' })).toEqual(new Vec3(0.5, 1, 0.5));
  });

  it('digs the face pointing at the eyes', () => {
    expect(facingFace({ x: 0.5, y: 3, z: 0.5 }, { x: 0, y: 0, z: 0 })).toEqual(new Vec3(0, 1, 0));
    expect(facingFace({ x: 3, y: 0.6, z: 0.5 }, { x: 0, y: 0, z: 0 })).toEqual(new Vec3(1, 0, 0));
    expect(facingFace({ x: 0.5, y: 0.6, z: -4 }, { x: 0, y: 0, z: 0 })).toEqual(new Vec3(0, 0, -1));
  });

  it('knows which blocks react to a right-click', () => {
    for (const name of ['chest', 'crafting_table', 'oak_door', 'spruce_fence_gate', 'lever', 'stone_button', 'red_bed', 'barrel', 'white_shulker_box', 'anvil', 'oak_sign']) {
      expect(isInteractable(name), name).toBe(true);
    }
    for (const name of ['stone', 'dirt', 'iron_door', 'iron_trapdoor', 'glass', 'oak_planks']) expect(isInteractable(name), name).toBe(false);
  });
});

describe('ray casts', () => {
  it('walks the voxels a ray crosses', () => {
    const cells = [...traverseVoxels(new Vec3(0.5, 0.5, 0.5), new Vec3(1, 0, 0), 3)].map((v) => v.x);
    expect(cells).toEqual([0, 1, 2, 3]);
  });

  it('intersects boxes and reports the entry face', () => {
    const hit = intersectShapes(new Vec3(0.5, 0.5, -2), new Vec3(0, 0, 1), [[0, 0, 0, 1, 1, 1]], { x: 0, y: 0, z: 0 });
    expect(hit).toEqual({ t: 2, face: 2 }); // north face
    const top = intersectShapes(new Vec3(0.5, 3, 0.5), new Vec3(0, -1, 0), [[0, 0, 0, 1, 0.5, 1]], { x: 0, y: 0, z: 0 });
    expect(top?.face).toBe(1);
    expect(top?.t).toBeCloseTo(2.5);
    expect(intersectShapes(new Vec3(0.5, 3, 0.5), new Vec3(0, 1, 0), [[0, 0, 0, 1, 1, 1]], { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('looks the way mineflayer does (yaw 0 = north, pitch up positive)', () => {
    const north = viewDirection(0, 0);
    expect(north.z).toBeCloseTo(-1);
    expect(viewDirection(0, Math.PI / 2).y).toBeCloseTo(1);
  });

  it('targets plants as cubes but not fluids or air', () => {
    const kit = versionKit('1.20.4');
    const block = (name: string) => kit.Block.fromStateId((kit.registry as any).blocksByName[name].defaultState, 0);
    expect(targetShapes(block('short_grass') ?? block('grass'))).toHaveLength(1);
    expect(targetShapes(block('water'))).toHaveLength(0);
    expect(targetShapes(block('air'))).toHaveLength(0);
    expect(targetShapes(block('stone'))).toEqual([[0, 0, 0, 1, 1, 1]]);
  });
});

describe('crafting, trading, containers', () => {
  it('finds the grid slots a recipe leaves free', () => {
    expect(unusedGridSlots({ inShape: null }, 2, 2)).toEqual([1, 2, 3, 4]);
    // A 1×2 stick shape in a 3×3 grid.
    expect(unusedGridSlots({ inShape: [[{ id: 5, metadata: null, count: 1 }], [{ id: 5, metadata: null, count: 1 }]] }, 3, 3)).toEqual([2, 3, 5, 6, 7, 8, 9]);
  });

  it('prices trades with demand and special prices', () => {
    expect(tradePrice(10, 64)).toBe(10);
    expect(tradePrice(10, 64, 4, -2, 0.05)).toBe(10); // 10 - 2 + floor(10*4*0.05)=2
    expect(tradePrice(1, 64, 0, -5, 0.05)).toBe(1); // never below 1
    expect(tradePrice(60, 64, 10, 0, 0.2)).toBe(64); // capped at the stack size
  });

  it('recognises storage windows', () => {
    for (const t of ['minecraft:generic_9x3', 'minecraft:chest', 'minecraft:shulker_box', 'minecraft:hopper', 'minecraft:red_shulker_box']) expect(isContainerWindow(t), t).toBe(true);
    for (const t of ['minecraft:furnace', 'minecraft:crafting', 'minecraft:merchant']) expect(isContainerWindow(t), t).toBe(false);
  });
});

describe('effects and enchantments', () => {
  it('normalizes attribute names across versions', () => {
    expect(attributeName('generic.movementSpeed')).toBe('movement_speed');
    expect(attributeName('minecraft:generic.movement_speed')).toBe('movement_speed');
    expect(attributeName('minecraft:movement_speed')).toBe('movement_speed');
  });

  it('drops the sprint modifier and maps named operations', () => {
    const mods = normalizeModifiers([
      { uuid: '662a6b8d-da3e-4c1c-8813-96ea6097278d', amount: 0.3, operation: 2 },
      { id: 'minecraft:sprinting', amount: 0.3, operation: 'add_multiplied_total' },
      { id: 'minecraft:effect.speed', amount: 0.2, operation: 'add_multiplied_total' },
    ]);
    expect(mods).toEqual([{ uuid: 'minecraft:effect.speed', amount: 0.2, operation: 2 }]);
  });

  it('reads enchantments from 1.20.5+ components and older NBT', () => {
    const modern = connectionRegistry('1.21.4');
    const kit = versionKit('1.21.4');
    const item = kit.Item.fromNotch({
      itemCount: 1,
      itemId: (modern as any).itemsByName.diamond_pickaxe.id,
      addedComponentCount: 1,
      removedComponentCount: 0,
      components: [{ type: 'enchantments', data: { enchantments: [{ id: (modern as any).enchantmentsByName.efficiency.id, level: 5 }], showTooltip: true } }],
      removeComponents: [],
    });
    expect(enchantsOf(modern, item)).toEqual([{ name: 'efficiency', lvl: 5 }]);
    const old = versionKit('1.12.2');
    const sword = new old.Item((old.registry as any).itemsByName.iron_sword.id, 1);
    sword.enchants = [{ name: 'sharpness', lvl: 2 }];
    expect(enchantsOf(old.registry, sword)).toEqual([{ name: 'sharpness', lvl: 2 }]);
    expect(enchantsOf(old.registry, null)).toEqual([]);
  });
});
