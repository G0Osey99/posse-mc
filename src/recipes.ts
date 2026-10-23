// Crafting recipes from minecraft-data, per version. A port of prismarine-recipe (MIT) that keeps
// its data per registry (prismarine-recipe holds the last-loaded version in module globals, which
// breaks a process with bots on several versions) and computes the out-shape delta correctly.
import type { Registry } from 'prismarine-registry';

/* eslint-disable @typescript-eslint/no-explicit-any -- minecraft-data recipe entries are untyped */

export interface RecipeItem {
  /** Item id, or -1 for an empty grid cell. */
  id: number;
  /** null: any variant. */
  metadata: number | null;
  count: number;
}

export interface Recipe {
  result: RecipeItem;
  /** Rows of the shaped grid (top first), or null for a shapeless recipe. */
  inShape: RecipeItem[][] | null;
  /** What stays in the grid after crafting (buckets from cake…), or null. */
  outShape: RecipeItem[][] | null;
  /** Shapeless ingredients (count -1 each), or null. */
  ingredients: RecipeItem[] | null;
  /** Inventory change per craft: negative for what's used, positive for what's made. */
  delta: RecipeItem[];
  /** Needs a 3×3 grid. */
  requiresTable: boolean;
}

function fromEnum(entry: any): RecipeItem {
  if (entry === null || entry === undefined) return { id: -1, metadata: null, count: 1 };
  if (Array.isArray(entry)) return { id: entry[0], metadata: entry[1] ?? null, count: 1 };
  if (typeof entry === 'number') return { id: entry, metadata: null, count: 1 };
  return { id: entry.id, metadata: entry.metadata ?? null, count: entry.count || 1 };
}

export class RecipeBook {
  private readonly cache = new Map<number, Recipe[]>();

  constructor(private readonly registry: Registry) {}

  /** Recipes making `itemType` (any variant when `metadata` is null). */
  find(itemType: number, metadata: number | null = null): Recipe[] {
    let all = this.cache.get(itemType);
    if (!all) {
      const entries: any[] = (this.registry as any).recipes?.[itemType] ?? [];
      all = entries.map((e) => this.build(e));
      this.cache.set(itemType, all);
    }
    return metadata === null ? all : all.filter((r) => r.result.metadata === null || r.result.metadata === metadata);
  }

  private normalize(item: RecipeItem): RecipeItem {
    if (item.metadata === null || item.id === -1) return item;
    // 32767 is the game's wildcard damage value.
    if (item.metadata >= 32767) return { ...item, metadata: null };
    // Metadata that matches none of the item's variants (block metadata in some recipe data) is a wildcard too.
    const variations = (this.registry as any).items?.[item.id]?.variations as Array<{ metadata: number }> | undefined;
    if (variations && !variations.some((v) => v.metadata === item.metadata)) return { ...item, metadata: null };
    return item;
  }

  private shape(rows: any[][]): RecipeItem[][] {
    return rows.map((row) => row.map((cell) => this.normalize(fromEnum(cell))));
  }

  private build(entry: any): Recipe {
    const result = fromEnum(entry.result);
    const inShape = entry.inShape ? this.shape(entry.inShape) : null;
    const outShape = entry.outShape ? this.shape(entry.outShape) : null;
    const ingredients = entry.ingredients ? (entry.ingredients as any[]).map((i) => ({ ...this.normalize(fromEnum(i)), count: -1 })) : null;
    return { result, inShape, outShape, ingredients, delta: computeDelta(result, inShape, outShape, ingredients), requiresTable: requiresTable(inShape, ingredients) };
  }
}

export function requiresTable(inShape: RecipeItem[][] | null, ingredients: RecipeItem[] | null): boolean {
  let space = 4;
  if (inShape) {
    if (inShape.length > 2) return true;
    for (const row of inShape) {
      if (row.length > 2) return true;
      for (const cell of row) if (cell.id !== -1) space--;
    }
  }
  if (ingredients) space -= ingredients.length;
  return space < 0;
}

export function computeDelta(
  result: RecipeItem,
  inShape: RecipeItem[][] | null,
  outShape: RecipeItem[][] | null,
  ingredients: RecipeItem[] | null,
): RecipeItem[] {
  const delta: RecipeItem[] = [];
  const add = (item: RecipeItem): void => {
    const existing = delta.find((d) => d.id === item.id && d.metadata === item.metadata);
    if (existing) existing.count += item.count;
    else delta.push({ ...item });
  };
  const applyShape = (shape: RecipeItem[][], direction: number): void => {
    for (const row of shape) for (const cell of row) if (cell.id !== -1) add({ ...cell, count: direction * cell.count });
  };
  if (inShape) applyShape(inShape, -1);
  if (outShape) applyShape(outShape, 1);
  if (ingredients) for (const i of ingredients) add(i);
  add(result);
  return delta;
}

const books = new WeakMap<object, RecipeBook>();

/** The recipe book for a registry (shared). */
export function recipeBook(registry: Registry): RecipeBook {
  let book = books.get(registry);
  if (!book) {
    book = new RecipeBook(registry);
    books.set(registry, book);
  }
  return book;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
