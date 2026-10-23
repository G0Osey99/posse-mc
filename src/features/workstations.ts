// Enchanting tables, plus furnaces and plain containers (chests, barrels, shulker boxes…): open the
// block's window and work its slots. Follows mineflayer's enchantment_table, furnace and chest
// plugins (MIT); window-property listeners are attached only while the window is open.
import type { PosseBot } from '../bot.js';
import type { Block, Entity, Item } from '../types.js';
import { nextEvent, type OpenWindow } from './inventory.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets and prismarine-windows are untyped */

const READY_TIMEOUT = 5000;

export interface EnchantmentOption {
  /** XP levels the option needs (-1 until known, 0 when the slot is empty). */
  level: number;
  /** The enchantment the table hints at and its level (-1 when unknown). */
  expected: { enchant: number; level: number };
}

export interface EnchantmentTable extends OpenWindow {
  enchantments: EnchantmentOption[];
  xpseed: number;
  targetItem(): Item | null;
  /** Applies option 0–2 and resolves with the enchanted item. */
  enchant(choice: number): Promise<Item | null>;
  takeTargetItem(): Promise<Item>;
  putTargetItem(item: Item): Promise<void>;
  putLapis(item: Item): Promise<void>;
}

export interface Furnace extends OpenWindow {
  fuel: number | null;
  fuelSeconds: number | null;
  totalFuel: number | null;
  totalFuelSeconds: number | null;
  progress: number | null;
  progressSeconds: number | null;
  totalProgress: number | null;
  totalProgressSeconds: number | null;
  inputItem(): Item | null;
  fuelItem(): Item | null;
  outputItem(): Item | null;
  takeInput(): Promise<Item>;
  takeFuel(): Promise<Item>;
  takeOutput(): Promise<Item>;
  putInput(itemType: number, metadata: number | null, count: number): Promise<void>;
  putFuel(itemType: number, metadata: number | null, count: number): Promise<void>;
}

/** Window types that are plain storage (prefix match: `minecraft:generic_9x3`, `minecraft:shulker_box`…). */
const CONTAINER_TYPES = ['minecraft:generic', 'minecraft:chest', 'minecraft:dispenser', 'minecraft:ender_chest', 'minecraft:shulker_box', 'minecraft:hopper', 'minecraft:container', 'minecraft:dropper', 'minecraft:trapped_chest', 'minecraft:barrel', 'minecraft:crafter'];
const FURNACE_TYPES = ['minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker'];

export const isContainerWindow = (type: string): boolean => CONTAINER_TYPES.some((t) => type.startsWith(t)) || type.endsWith('shulker_box');

export interface WorkstationApi {
  openContainer(target: Block | (Pick<Entity, 'id' | 'position'> & { type?: string })): Promise<OpenWindow>;
  openFurnace(block: Block): Promise<Furnace>;
  openEnchantmentTable(block: Block): Promise<EnchantmentTable>;
}

export function installWorkstations(bot: PosseBot): WorkstationApi {
  const client = bot._client as any;

  /** Runs `handler` for the window's properties so far, then for each new one until it closes. */
  const onProperties = (window: OpenWindow, handler: (property: number, value: number) => void): void => {
    const w = window as any;
    for (const [property, value] of Object.entries(w.properties ?? {})) handler(Number(property), value as number);
    w.on('property', handler);
    w.once('close', () => w.removeListener('property', handler));
  };

  const openContainer: WorkstationApi['openContainer'] = async (target) => {
    const isBlock = 'name' in target && 'stateId' in (target as object);
    const window = isBlock ? await bot.openBlock(target as Block) : await bot.openEntity(target as Pick<Entity, 'id' | 'position'>);
    if (!isContainerWindow((window as any).type)) {
      await bot.closeWindow(window).catch(() => undefined);
      throw new Error(`Not a container window: ${(window as any).type}`);
    }
    return window;
  };

  const openFurnace: WorkstationApi['openFurnace'] = async (block) => {
    const window = (await bot.openBlock(block)) as Furnace;
    if (!FURNACE_TYPES.some((t) => (window as any).type.startsWith(t))) {
      await bot.closeWindow(window).catch(() => undefined);
      throw new Error(`Not a furnace window: ${(window as any).type}`);
    }
    const w = window as any;
    Object.assign(window, {
      fuel: null,
      fuelSeconds: null,
      totalFuel: null,
      totalFuelSeconds: null,
      progress: null,
      progressSeconds: null,
      totalProgress: null,
      totalProgressSeconds: null,
    });
    window.inputItem = () => w.slots[0];
    window.fuelItem = () => w.slots[1];
    window.outputItem = () => w.slots[2];
    const take = async (item: Item | null): Promise<Item> => {
      if (!item) throw new Error('The slot is empty');
      await bot.putAway((item as any).slot);
      return item;
    };
    window.takeInput = () => take(window.inputItem());
    window.takeFuel = () => take(window.fuelItem());
    window.takeOutput = () => take(window.outputItem());
    const put = (slot: number, itemType: number, metadata: number | null, count: number): Promise<void> =>
      bot.transfer({ window, itemType, metadata, count, sourceStart: w.inventoryStart, sourceEnd: w.inventoryEnd, destStart: slot, destEnd: slot + 1 });
    window.putInput = (itemType, metadata, count) => put(0, itemType, metadata, count);
    window.putFuel = (itemType, metadata, count) => put(1, itemType, metadata, count);
    onProperties(window, (property, value) => {
      if (property === 0) {
        window.fuel = window.totalFuel ? value / window.totalFuel : 0;
        window.fuelSeconds = window.fuel * (window.totalFuelSeconds ?? 0);
      } else if (property === 1) {
        window.totalFuel = value;
        window.totalFuelSeconds = value * 0.05;
      } else if (property === 2) {
        window.progress = window.totalProgress ? value / window.totalProgress : 0;
        window.progressSeconds = (window.totalProgressSeconds ?? 0) - window.progress * (window.totalProgressSeconds ?? 0);
      } else if (property === 3) {
        window.totalProgress = value;
        window.totalProgressSeconds = value * 0.05;
      }
      (window as any).emit('update');
    });
    return window;
  };

  const openEnchantmentTable: WorkstationApi['openEnchantmentTable'] = async (block) => {
    if (block.name !== 'enchanting_table' && block.name !== 'enchantment_table') throw new Error(`${block.name} is not an enchanting table`);
    const table = (await bot.openBlock(block)) as EnchantmentTable;
    const w = table as any;
    if (!w.type.startsWith('minecraft:enchant')) {
      await bot.closeWindow(table).catch(() => undefined);
      throw new Error(`Not an enchanting window: ${w.type}`);
    }
    table.xpseed = -1;
    table.enchantments = [0, 1, 2].map(() => ({ level: -1, expected: { enchant: -1, level: -1 } }));
    const isReady = (): boolean => table.enchantments.every((e) => e.level >= 0);
    onProperties(table, (property, value) => {
      if (property < 3) table.enchantments[property]!.level = value;
      else if (property === 3) table.xpseed = value;
      else if (property < 7) table.enchantments[property - 4]!.expected.enchant = value;
      else if (property < 10) table.enchantments[property - 7]!.expected.level = value;
      if (isReady()) (table as any).emit('ready');
    });
    table.targetItem = () => w.slots[0];
    table.enchant = async (choice) => {
      const option = Math.floor(Number(choice));
      if (option < 0 || option > 2) throw new Error(`Enchantment option ${choice} doesn't exist`);
      // Options arrive after the item is put in; wait for them once if they aren't there yet.
      if (!isReady() || table.enchantments[option]!.level <= 0) await nextEvent(w, 'ready', READY_TIMEOUT);
      if (table.enchantments[option]!.level <= 0) throw new Error(`Enchantment option ${choice} is not available`);
      const updated = nextEvent<[Item | null, Item | null]>(w, 'updateSlot:0', READY_TIMEOUT);
      client.write('enchant_item', { windowId: table.id, enchantment: option });
      const result = await updated;
      if (!result) throw new Error('The server did not enchant the item');
      return result[1];
    };
    table.takeTargetItem = async () => {
      const item = table.targetItem();
      if (!item) throw new Error('Nothing to take');
      await bot.putAway((item as any).slot);
      return item;
    };
    table.putTargetItem = (item) => bot.moveSlotItem((item as any).slot, 0);
    table.putLapis = (item) => bot.moveSlotItem((item as any).slot, 1);
    return table;
  };

  return { openContainer, openFurnace, openEnchantmentTable };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
