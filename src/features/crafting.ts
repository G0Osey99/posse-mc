// Crafting in the 2×2 inventory grid or at a crafting table, by clicking the ingredients into the
// grid and taking the result. Follows mineflayer's craft plugin (MIT).
import type { PosseBot } from '../bot.js';
import { recipeBook, type Recipe } from '../recipes.js';
import type { Block, Window } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- prismarine-windows is loosely typed */

export interface CraftingApi {
  craft(recipe: Recipe, count?: number, craftingTable?: Block | null): Promise<void>;
  /** Recipes for the item that the inventory has the ingredients for (`minResultCount` items' worth). */
  recipesFor(itemType: number, metadata?: number | null, minResultCount?: number | null, craftingTable?: Block | boolean | null): Recipe[];
  /** Every recipe for the item, craftable or not. */
  recipesAll(itemType: number, metadata?: number | null, craftingTable?: Block | boolean | null): Recipe[];
}

/** Grid slots (1-based, row by row) of a w×h crafting grid that a recipe leaves empty. */
export function unusedGridSlots(recipe: Pick<Recipe, 'inShape'>, w: number, h: number): number[] {
  const slot = (x: number, y: number): number => 1 + x + w * y;
  const result: number[] = [];
  if (!recipe.inShape) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) result.push(slot(x, y));
    return result;
  }
  for (let y = 0; y < h; y++) {
    const row = recipe.inShape[y];
    for (let x = 0; x < w; x++) {
      if (!row || x >= row.length || row[x]!.id === -1) result.push(slot(x, y));
    }
  }
  return result;
}

export function installCrafting(bot: PosseBot): CraftingApi {
  const { Item } = bot.kit;
  const book = recipeBook(bot.kit.registry);

  const matches = (window: any, id: number, metadata: number | null): boolean =>
    window.selectedItem && window.selectedItem.type === id && (metadata == null || window.selectedItem.metadata === metadata);

  /** Puts one of an ingredient into a grid slot (picking a stack up first if the cursor holds something else). */
  const placeOne = async (window: any, id: number, metadata: number | null, dest: number, firstSource: { slot: number | null }): Promise<void> => {
    if (!matches(window, id, metadata)) {
      if (window.selectedItem) await bot.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window, firstSource.slot);
      const source = window.findInventoryItem(id, metadata);
      if (!source) throw new Error(`missing ingredient: ${(bot.registry as any).items[id]?.name ?? id}`);
      firstSource.slot ??= source.slot;
      await bot.clickWindow(source.slot, 0, 0);
    }
    await bot.clickWindow(dest, 1, 0);
  };

  const craftOnce = async (recipe: Recipe, window: any, w: number, h: number): Promise<void> => {
    const slot = (x: number, y: number): number => 1 + x + w * y;
    const firstSource = { slot: null as number | null };
    if (recipe.inShape) {
      for (let y = 0; y < recipe.inShape.length; y++) {
        const row = recipe.inShape[y]!;
        for (let x = 0; x < row.length; x++) {
          const cell = row[x]!;
          if (cell.id !== -1) await placeOne(window, cell.id, cell.metadata, slot(x, y), firstSource);
        }
      }
    }
    if (recipe.ingredients) {
      const free = unusedGridSlots(recipe, w, h);
      for (const ingredient of recipe.ingredients) {
        const dest = free.pop();
        if (dest === undefined) throw new Error('crafting grid is too small for this recipe');
        await placeOne(window, ingredient.id, ingredient.metadata, dest, firstSource);
      }
    }
    // Leftovers on the cursor go back to the inventory.
    await bot.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window, firstSource.slot);

    // Take the result: predicted in the result slot, then moved into the inventory.
    window.updateSlot(0, new Item(recipe.result.id, recipe.result.count, recipe.result.metadata ?? undefined));
    await bot.putAway(0);

    // What the recipe leaves in the grid (buckets from cake…) goes back too; the rest was used up.
    const leftover: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cell = recipe.outShape?.[y]?.[x];
        if (cell && cell.id !== -1) {
          window.updateSlot(slot(x, y), new Item(cell.id, cell.count, cell.metadata ?? undefined));
          leftover.push(slot(x, y));
        } else {
          window.updateSlot(slot(x, y), null);
        }
      }
    }
    for (const s of leftover) await bot.putAway(s);
  };

  const craft: CraftingApi['craft'] = async (recipe, count = 1, craftingTable = null) => {
    if (!recipe) throw new Error('craft needs a recipe');
    if (recipe.requiresTable && !craftingTable) throw new Error('This recipe needs a crafting table');
    let table: Window | null = null;
    try {
      let window: any = bot.inventory;
      let w = 2;
      let h = 2;
      if (craftingTable) {
        table = await bot.openBlock(craftingTable);
        if (!(table as any).type.startsWith('minecraft:crafting')) throw new Error(`Not a crafting table window: ${(table as any).type}`);
        window = table;
        w = 3;
        h = 3;
      }
      for (let i = 0; i < count; i++) await craftOnce(recipe, window, w, h);
      if (table) {
        // The last click isn't confirmed on 1.17+; closing on a stale model leaves items the server never placed.
        await bot.syncWindow(table);
        await bot.closeWindow(table);
        table = null;
      }
    } finally {
      if (table) await bot.closeWindow(table).catch(() => undefined);
    }
  };

  const tableAllowed = (craftingTable: Block | boolean | null | undefined): boolean => Boolean(craftingTable);

  const recipesAll: CraftingApi['recipesAll'] = (itemType, metadata = null, craftingTable = null) =>
    book.find(itemType, metadata ?? null).filter((r) => !r.requiresTable || tableAllowed(craftingTable));

  const recipesFor: CraftingApi['recipesFor'] = (itemType, metadata = null, minResultCount = 1, craftingTable = null) => {
    const wanted = minResultCount ?? 1;
    return recipesAll(itemType, metadata, craftingTable).filter((recipe) => {
      const crafts = Math.ceil(wanted / recipe.result.count);
      return recipe.delta.every((d) => (bot.inventory as any).count(d.id, d.metadata) + d.count * crafts >= 0);
    });
  };

  return { craft, recipesFor, recipesAll };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
