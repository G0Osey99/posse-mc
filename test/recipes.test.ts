/* eslint-disable @typescript-eslint/no-explicit-any -- registries and fake bots are untyped */
import { describe, expect, it } from 'vitest';
import { computeDelta, recipeBook, requiresTable } from '../src/recipes.js';
import { versionKit } from '../src/registry.js';

describe('recipes', () => {
  it('computes the inventory change, out-shape included', () => {
    const milk = { id: 1, metadata: null, count: 1 };
    const bucket = { id: 2, metadata: null, count: 1 };
    const wheat = { id: 3, metadata: null, count: 1 };
    const cake = { id: 4, metadata: null, count: 1 };
    const inShape = [[milk, milk, milk], [wheat, wheat, wheat]];
    const outShape = [[bucket, bucket, bucket], [{ id: -1, metadata: null, count: 1 }, { id: -1, metadata: null, count: 1 }, { id: -1, metadata: null, count: 1 }]];
    const delta = computeDelta(cake, inShape, outShape, null);
    expect(delta).toEqual([
      { id: 1, metadata: null, count: -3 },
      { id: 3, metadata: null, count: -3 },
      { id: 2, metadata: null, count: 3 },
      { id: 4, metadata: null, count: 1 },
    ]);
  });

  it('needs a table beyond 2×2', () => {
    const c = { id: 1, metadata: null, count: 1 };
    expect(requiresTable([[c], [c]], null)).toBe(false);
    expect(requiresTable([[c, c, c]], null)).toBe(true);
    expect(requiresTable(null, [c, c, c, c])).toBe(false);
    expect(requiresTable(null, [c, c, c, c, c])).toBe(true);
  });

  it('finds recipes per version, kept apart between versions', () => {
    const modern = versionKit('1.21.4');
    const old = versionKit('1.12.2');
    const modernBook = recipeBook(modern.registry);
    const oldBook = recipeBook(old.registry);
    const stick = (modern.registry as any).itemsByName.stick.id;
    const oldStick = (old.registry as any).itemsByName.stick.id;
    expect(modernBook.find(stick).length).toBeGreaterThan(0);
    expect(oldBook.find(oldStick)[0]!.result).toEqual({ id: oldStick, metadata: 0, count: 4 });
    // Old planks recipes accept any wood variant.
    expect(oldBook.find(oldStick)[0]!.inShape![0]![0]!.metadata).toBeNull();
    expect(recipeBook(modern.registry)).toBe(modernBook);
    const table = (modern.registry as any).itemsByName.crafting_table.id;
    expect(modernBook.find(table).every((r) => !r.requiresTable)).toBe(true);
    const pickaxe = (modern.registry as any).itemsByName.wooden_pickaxe.id;
    expect(modernBook.find(pickaxe).every((r) => r.requiresTable)).toBe(true);
  });
});
