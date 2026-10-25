// Inventory and container windows: clicks with per-version bookkeeping (action numbers and
// `transaction` confirmations ≤1.16, state ids 1.17+), held item, equip, use item, and the
// window helpers the crafting, trading and container features build on (transfer, putAway,
// open/withdraw/deposit). Logic follows mineflayer's inventory plugins (MIT).
import minecraftData from 'minecraft-data';
import nbt from 'prismarine-nbt';
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import type { Block, Entity, Item, Window } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- prismarine-windows/items and packets are loosely typed */

const WINDOW_TIMEOUT = 5000;
/** Waits this long after digging before clicking the hotbar, so the server has sent tool damage. */
const DIG_CLICK_TIMEOUT = 500;
/** Ticks the longest consumable takes (honey bottles: 40; food: 32), plus slack for latency. */
const CONSUME_TICKS = 40;
const CONSUME_SLACK_MS = 1500;
/** After an inventory update: the answer to the server's next transaction, then this long (a tick for the anticheat's reset). */
const USE_AFTER_ANSWER_MS = 100;
/** Without transactions (no anticheat): a few ticks. */
const USE_AFTER_UPDATE_MS = 150;
const USE_SETTLE_MAX_MS = 1000;

/**
 * When an item may be used after the server updated the inventory: once a transaction (or 1.17+
 * ping) that came after the update has been answered, plus USE_AFTER_ANSWER_MS; on a server that
 * sends none, USE_AFTER_UPDATE_MS after it; never later than USE_SETTLE_MAX_MS after it.
 */
export class ItemUseGate {
  private updatedAt = -Infinity;
  private answeredAt = -Infinity;
  private seenTransactions = false;

  constructor(private readonly now: () => number = Date.now) {}

  inventoryUpdated(): void {
    this.updatedAt = this.now();
  }

  /** A transaction or ping from the server (Posse answers each at once). */
  transaction(): void {
    this.seenTransactions = true;
    if (this.answeredAt < this.updatedAt) this.answeredAt = this.now();
  }

  ready(): boolean {
    const now = this.now();
    if (now >= this.updatedAt + USE_SETTLE_MAX_MS) return true;
    if (!this.seenTransactions) return now >= this.updatedAt + USE_AFTER_UPDATE_MS;
    return this.answeredAt >= this.updatedAt && now >= this.answeredAt + USE_AFTER_ANSWER_MS;
  }
}
/** Items that can be used with a full hunger bar. */
const ALWAYS_CONSUMABLES = new Set(['potion', 'milk_bucket', 'enchanted_golden_apple', 'golden_apple', 'chorus_fruit', 'honey_bottle', 'ominous_bottle']);

/** Whether `window_click` slots are HashedSlots (1.21.5+). */
export function clickUsesHashedSlots(version: string): boolean {
  const types = (minecraftData(version)?.protocol as any)?.play?.toServer?.types;
  return JSON.stringify(types?.packet_window_click ?? '').includes('HashedSlot');
}
/** Items used over time (they slow the player while held up), besides food. */
const USED_OVER_TIME = /^(bow|crossbow|shield|trident|spyglass|goat_horn|brush|potion|milk_bucket|honey_bottle|ominous_bottle)$/;
/** True for items held up while used (they slow the player): food, potions, bows, shields… */
export function isUsedOverTime(name: string, metadata: number, food: boolean): boolean {
  // A splash potion before 1.9 is a potion with bit 0x4000 of the data value: thrown at once.
  if (name === 'potion' && (metadata & 0x4000) !== 0) return false;
  return food || USED_OVER_TIME.test(name);
}

const QUICK_BAR_START = 36;
const QUICK_BAR_COUNT = 9;

type Destination = 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand';

/** What to move with `transfer`: `count` items of a type from one slot range to another. */
export interface TransferOptions {
  window?: Window;
  itemType: number;
  metadata?: number | null;
  /** Default 1. */
  count?: number | null;
  nbt?: unknown;
  sourceStart: number;
  /** Default `sourceStart + 1`. */
  sourceEnd?: number | null;
  /** -999 drops the items. */
  destStart: number;
  /** Default `destStart + 1`. */
  destEnd?: number | null;
}

/** A window opened by `openBlock` / `openEntity`, with the helpers mineflayer adds. */
export interface OpenWindow extends Window {
  close(): Promise<void>;
  /** Takes items from the container into the inventory. */
  withdraw(itemType: number, metadata: number | null, count: number | null, nbt?: unknown): Promise<void>;
  /** Puts items from the inventory into the container. */
  deposit(itemType: number, metadata: number | null, count: number | null, nbt?: unknown): Promise<void>;
}

export interface InventoryApi {
  setQuickBarSlot(slot: number): void;
  activateItem(offHand?: boolean): void;
  deactivateItem(): void;
  consume(): Promise<void>;
  clickWindow(slot: number, mouseButton: number, mode: number): Promise<void>;
  closeWindow(window: Window): Promise<void>;
  moveSlotItem(sourceSlot: number, destSlot: number): Promise<void>;
  equip(item: Item | number, destination: Destination | null): Promise<void>;
  unequip(destination: Destination): Promise<void>;
  putSelectedItemRange(start: number, end: number, window: Window, slot: number | null): Promise<void>;
  putAway(slot: number): Promise<void>;
  transfer(options: TransferOptions): Promise<void>;
  syncWindow(window: Window): Promise<void>;
  toss(itemType: number, metadata: number | null, count: number | null): Promise<void>;
  tossStack(item: Item): Promise<void>;
  openBlock(block: Block, direction?: Vec3, cursorPos?: Vec3): Promise<OpenWindow>;
  openEntity(entity: Pick<Entity, 'id' | 'position'>): Promise<OpenWindow>;
  /** Slot of an equipment destination in the inventory window. */
  equipmentSlot(destination: Destination): number;
}

/** Window-0 slot for a `set_player_inventory` (1.21.9+) index. */
export function playerInventorySlotToWindow(slotId: number): number {
  if (slotId <= 8) return slotId + 36;
  if (slotId >= 36 && slotId <= 39) return 44 - slotId;
  if (slotId === 40) return 45;
  return slotId;
}

/** 1.20.3+ sends window titles as NBT; turn them into the JSON text component older versions send. */
export function normalizeWindowTitle(title: unknown): unknown {
  if (title && typeof title === 'object' && 'type' in title && 'value' in title) {
    const plain = nbt.simplify(title as never) as unknown;
    return typeof plain === 'string' ? JSON.stringify({ text: plain }) : JSON.stringify(plain);
  }
  return title;
}

/** Resolves on the emitter's next `event`, or after `ms` (resolving `null`). */
export function nextEvent<T extends unknown[]>(emitter: NodeJS.EventEmitter, event: string, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, on);
      resolve(null);
    }, ms);
    const on = (...args: unknown[]): void => {
      clearTimeout(timer);
      resolve(args as T);
    };
    emitter.once(event, on);
  });
}

/** Like `nextEvent`, but rejects with `message` on timeout. */
export async function expectEvent<T extends unknown[]>(emitter: NodeJS.EventEmitter, event: string, ms: number, message: string): Promise<T> {
  const result = await nextEvent<T>(emitter, event, ms);
  if (!result) throw new Error(message);
  return result;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface PendingClick {
  slot: number;
  mouseButton: number;
  mode: number;
  id: number;
  windowId: number;
  item: Item | null;
}

export function installInventory(bot: PosseBot): InventoryApi {
  const client = bot._client as any;
  const sf = bot.supportFeature;
  const { Item, windows } = bot.kit;

  let nextActionNumber = 0;
  let stateId = -1;
  const clickQueue: PendingClick[] = [];
  let bufferedItems: any = null;
  let lastClosedWindow: any = null;
  let nextQuickBarSlot = 0;

  const armorSlots: Record<string, number> = { head: 5, torso: 6, legs: 7, feet: 8 };
  if (!sf('doesntHaveOffHandSlot')) armorSlots['off-hand'] = 45;

  bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  bot.currentWindow = null;
  (bot.inventory as any).on('updateSlot', (index: number) => {
    if (index === bot.quickBarSlot + QUICK_BAR_START) bot.updateHeldItem();
  });

  if (sf('stateIdUsed')) {
    const track = (packet: any): void => {
      stateId = packet.stateId;
    };
    client.on('window_items', track);
    client.on('set_slot', track);
  }

  const windowFor = (windowId: number): any => (windowId === 0 ? bot.inventory : bot.currentWindow);

  const setSlot = (slotId: number, item: Item | null, window: any = bot.inventory): void => {
    window.updateSlot(slotId, item);
    bot.updateHeldItem();
  };

  /** Ends a window: `windowClose` on the bot, `close` on the window (feature listeners detach on it). */
  const closed = (window: any): void => {
    bot.emit('windowClose', window);
    window?.emit?.('close');
  };

  // ── Server → client ──
  const prepareWindow = (window: any): void => {
    extendWindow(window);
    if (!bufferedItems || window.id !== bufferedItems.windowId) {
      // windowOpen waits for the window's contents.
      bot.once(`setWindowItems:${window.id}`, () => bot.emit('windowOpen', window));
      return;
    }
    bufferedItems.items.forEach((raw: any, i: number) => window.updateSlot(i, Item.fromNotch(raw)));
    bufferedItems = null;
    bot.updateHeldItem();
    bot.emit('windowOpen', window);
  };

  client.on('open_window', (packet: any) => {
    lastClosedWindow = null;
    bot.currentWindow = windows.createWindow(packet.windowId, packet.inventoryType, normalizeWindowTitle(packet.windowTitle), packet.slotCount);
    (bot.currentWindow as any).properties = {};
    prepareWindow(bot.currentWindow);
  });
  // Window properties (furnace progress, enchanting options…): kept on the window from the start,
  // since some arrive with its contents, before anyone could listen for them.
  client.on('craft_progress_bar', (packet: any) => {
    const window: any = bot.currentWindow;
    if (!window || window.id !== packet.windowId) return;
    window.properties[packet.property] = packet.value;
    window.emit('property', packet.property, packet.value);
  });
  client.on('open_horse_window', (packet: any) => {
    bot.currentWindow = windows.createWindow(packet.windowId, 'HorseWindow', 'Horse', packet.nbSlots);
    prepareWindow(bot.currentWindow);
  });
  client.on('close_window', () => {
    const old = bot.currentWindow;
    bot.currentWindow = null;
    closed(old);
  });
  const resetWindows = (): void => {
    bufferedItems = null;
    lastClosedWindow = null;
    const old = bot.currentWindow;
    if (!old) return;
    bot.currentWindow = null;
    closed(old);
  };
  client.on('login', resetWindows);
  client.on('respawn', () => {
    bufferedItems = null;
    lastClosedWindow = null;
  });

  // ── Item use after an inventory update ──
  // Anticheats stop an item use when the server's update of the held item reaches the client:
  // Grim's reset-item-usage-on-item-update runs once the client answers the transaction after a
  // set_slot/window_items, so eating straight after equipping (its set_slot still unanswered) was
  // cancelled two ticks in and timed out. The game's player never uses an item that fast: a use
  // waits for that answer (and a tick for the reset), or a few ticks on servers without them.
  const useGate = new ItemUseGate();
  const noteInventoryUpdate = (): void => useGate.inventoryUpdated();
  const noteTransaction = (): void => useGate.transaction();
  client.on('set_slot', noteInventoryUpdate);
  client.on('window_items', noteInventoryUpdate);
  client.on('set_player_inventory', noteInventoryUpdate);
  client.on('transaction', noteTransaction);
  client.on('ping', noteTransaction);
  /** Resolves once the last inventory update is safe to use an item after. */
  const handSettled = async (): Promise<void> => {
    while (!useGate.ready()) await new Promise((r) => setTimeout(r, 10));
  };

  client.on('set_slot', (packet: any) => {
    const window = windowFor(packet.windowId);
    if (!window || window.id !== packet.windowId) {
      // Trailing sync for a window closed client-side: its inventory region is still ours.
      if (lastClosedWindow && packet.windowId === lastClosedWindow.id &&
        packet.slot >= lastClosedWindow.inventoryStart && packet.slot < lastClosedWindow.inventoryEnd) {
        setSlot(packet.slot - (lastClosedWindow.inventoryStart - (bot.inventory as any).inventoryStart), Item.fromNotch(packet.item));
      }
      return;
    }
    setSlot(packet.slot, Item.fromNotch(packet.item), window);
  });
  client.on('set_player_inventory', (packet: any) => {
    setSlot(playerInventorySlotToWindow(packet.slotId), Item.fromNotch(packet.contents));
  });
  client.on('window_items', (packet: any) => {
    const window = windowFor(packet.windowId);
    if (!window || window.id !== packet.windowId) {
      bufferedItems = packet;
      if (lastClosedWindow && packet.windowId === lastClosedWindow.id && packet.items.length === lastClosedWindow.slots.length) {
        const shift = lastClosedWindow.inventoryStart - (bot.inventory as any).inventoryStart;
        for (let i = lastClosedWindow.inventoryStart; i < lastClosedWindow.inventoryEnd && i < packet.items.length; i++) {
          setSlot(i - shift, Item.fromNotch(packet.items[i]));
        }
      }
      return;
    }
    packet.items.forEach((raw: any, i: number) => window.updateSlot(i, Item.fromNotch(raw)));
    if (packet.carriedItem !== undefined) window.selectedItem = Item.fromNotch(packet.carriedItem);
    bot.updateHeldItem();
    bot.emit(`setWindowItems:${window.id}`);
  });
  client.on('held_item_slot', (packet: any) => {
    if (packet.slot >= 0 && packet.slot < QUICK_BAR_COUNT) setQuickBarSlot(packet.slot, false);
  });

  // ── Clicks ──
  const confirmTransaction = (windowId: number, actionId: number, accepted: boolean): void => {
    if (!clickQueue.some((c) => c.id === actionId)) {
      // Mimic vanilla: acknowledge transactions we didn't start.
      client.write('transaction', { windowId, action: actionId, accepted: true });
      return;
    }
    let click = clickQueue.shift()!;
    const accept = (c: PendingClick): void => {
      const window = windowFor(windowId);
      if (window && window.id === c.windowId) window.acceptClick(c);
      bot.emit(`confirmTransaction${c.id}`, true);
    };
    while (actionId > click.id) {
      accept(click);
      click = clickQueue.shift()!;
    }
    if (accepted) accept(click);
    else {
      client.write('transaction', { windowId: click.windowId, action: click.id, accepted: true });
      bot.emit(`confirmTransaction${click.id}`, false);
    }
    bot.updateHeldItem();
  };
  client.on('transaction', (packet: any) => confirmTransaction(packet.windowId, packet.action, packet.accepted));

  // 1.21.5+ clicks carry HashedSlots: an absent option for an empty slot, and per component a hash
  // of its value. Posse sends no component hashes; the server treats them as a mismatch and resyncs
  // the slot (as it does after any misprediction), which keeps the window consistent.
  const hashedSlots = clickUsesHashedSlots(bot.version);
  const clickSlot = (item: Item | null): unknown => {
    if (!hashedSlots) return Item.toNotch(item);
    if (!item || item.count <= 0) return undefined;
    return { itemId: item.type, itemCount: item.count, components: [], removeComponents: [] };
  };

  const changedSlotsOf = (window: any, click: PendingClick): Array<{ location: number; item: unknown }> => {
    let changed: number[];
    if ([0, 3, 4].includes(click.mode)) {
      changed = window.acceptClick(click);
    } else {
      const before = window.slots.map((s: Item | null) => s);
      window.acceptClick(click);
      changed = [];
      for (let i = 0; i < window.slots.length; i++) if (!Item.equal(before[i], window.slots[i])) changed.push(i);
    }
    return changed.map((location) => ({ location, item: clickSlot(window.slots[location]) }));
  };

  const tradeMatch = (want: any, have: any): boolean => have !== null && want !== null && have?.type === want?.type && have.count >= want.count;

  /**
   * 1.17+ servers don't confirm clicks, but they recompute crafting and trading results after one;
   * waiting for that keeps the next click (or the close) from racing ahead of the result.
   */
  const waitForWindowUpdate = async (window: any, slot: number, changed: Array<{ location: number }>): Promise<void> => {
    const wait = (target: any, s: number): Promise<unknown> => nextEvent(target, `updateSlot:${s}`, WINDOW_TIMEOUT);
    const gridSize = window.type === 'minecraft:inventory' ? 4 : window.type === 'minecraft:crafting' ? 9 : 0;
    // The server only answers clicks that changed the grid or took the result.
    const touchesGrid = changed.some((c) => c.location >= 0 && c.location <= gridSize);
    if (gridSize > 0 && slot >= 0 && slot <= gridSize && touchesGrid) {
      // Taking the result also uses up the grid: wait for those updates too, or the next click is
      // planned on a grid the server is about to overwrite.
      const used = slot === 0 ? Array.from({ length: gridSize }, (_, i) => i + 1).filter((i) => window.slots[i]) : [];
      await Promise.all([wait(window, 0), ...used.map((i) => wait(window, i))]);
    } else if (window.type === 'minecraft:merchant' && window.selectedTrade) {
      const trade = window.selectedTrade;
      // The first input costs the adjusted price (demand, discounts), like the server reckons it.
      const price = { type: trade.inputItem1?.type, count: trade.realPrice ?? trade.inputItem1?.count };
      const satisfied = (): boolean => tradeMatch(price, window.slots[0]) && (!trade.hasItem2 || tradeMatch(trade.inputItem2, window.slots[1]));
      // The result slot is filled exactly while every input is satisfied.
      const expectsResult = (): boolean => !trade.tradeDisabled && Boolean(window.slots[2]) !== satisfied();
      const waits: Array<Promise<unknown>> = [];
      if (slot >= 0 && slot <= 1 && expectsResult()) waits.push(wait(window, 2));
      if (slot === 2) for (const item of window.containerItems()) waits.push(wait(window, item.slot));
      await Promise.all(waits);
      if (slot === 2 && expectsResult()) await wait(window, 2);
    }
  };

  const clickWindow = async (slot: number, mouseButton: number, mode: number): Promise<void> => {
    // Right after digging, give the server time to send the tool's new damage.
    if (slot >= QUICK_BAR_START && bot.lastDigTime !== null) {
      const since = performance.now() - bot.lastDigTime;
      if (since < DIG_CLICK_TIMEOUT) await sleep(DIG_CLICK_TIMEOUT - since);
    }
    const window: any = bot.currentWindow ?? bot.inventory;
    if (mode < 0 || mode > 6) throw new Error(`Invalid click mode ${mode}`);
    nextActionNumber = nextActionNumber === 32767 ? 1 : nextActionNumber + 1;
    const actionId = nextActionNumber;
    const click: PendingClick = { slot, mouseButton, mode, id: actionId, windowId: window.id, item: slot === -999 ? null : window.slots[slot] };

    if (sf('transactionPacketExists')) {
      clickQueue.push(click);
      const sendEmpty = mode === 2 || mode === 4 || (mode === 1 && sf('quickMoveClickSendsEmptyItem'));
      client.write('window_click', {
        windowId: window.id,
        slot,
        mouseButton,
        action: actionId,
        mode,
        item: Item.toNotch(sendEmpty ? null : click.item),
      });
      const response = nextEvent<[boolean]>(bot, `confirmTransaction${actionId}`, WINDOW_TIMEOUT);
      if (!window.transactionRequiresConfirmation(click)) confirmTransaction(window.id, actionId, true);
      const result = await response;
      if (!result) throw new Error(`Server didn't respond to transaction for clicking on slot ${slot} on window with id ${window.id}.`);
      if (!result[0]) throw new Error(`Server rejected transaction for clicking on slot ${slot}, on window with id ${window.id}.`);
      return;
    }

    const changedSlots = changedSlotsOf(window, click);
    const update = waitForWindowUpdate(window, slot, changedSlots);
    client.write('window_click', {
      windowId: window.id,
      ...(sf('stateIdUsed') ? { stateId } : {}),
      slot,
      mouseButton,
      mode,
      changedSlots,
      cursorItem: clickSlot(window.selectedItem),
    });
    await update;
  };

  /**
   * 1.17.1+ servers only answer a click when their copy of the client is stale, so a click they
   * ignored is never reported. A no-op click carrying an impossible state id always gets the whole
   * window back.
   */
  const syncWindow = async (window: Window): Promise<void> => {
    if (!sf('stateIdUsed')) return;
    const w = window as any;
    const synced = nextEvent(bot, `setWindowItems:${w.id}`, WINDOW_TIMEOUT);
    client.write('window_click', {
      windowId: w.id,
      stateId: -1,
      slot: -999,
      mouseButton: 2, // the end of a drag that never started
      mode: 5,
      changedSlots: [],
      cursorItem: clickSlot(w.selectedItem),
    });
    await synced;
  };

  const closeWindow = (window: Window): Promise<void> => {
    const w = window as any;
    client.write('close_window', { windowId: w.id });
    // Copy the container's inventory region back into the player inventory.
    if (w.id !== 0) {
      const shift = w.inventoryStart - (bot.inventory as any).inventoryStart;
      for (let i = w.inventoryStart; i < w.inventoryEnd; i++) {
        const item = w.slots[i];
        if (item) item.slot = i - shift;
        if (!Item.equal((bot.inventory as any).slots[i - shift], item, true)) (bot.inventory as any).updateSlot(i - shift, item);
      }
    }
    lastClosedWindow = w;
    if (bot.currentWindow === window) bot.currentWindow = null;
    closed(window);
    // Pre-1.17 servers keep stale bookkeeping for slots the container touched until a click on it.
    if (sf('stateIdUsed')) return Promise.resolve();
    return clickWindow(-999, 0, 0).catch(() => undefined);
  };

  /** Puts the cursor stack back into `start`–`end` (joining stacks first), dropping what doesn't fit. */
  const putSelectedItemRange = async (start: number, end: number, window: Window, slot: number | null): Promise<void> => {
    const w = window as any;
    while (w.selectedItem) {
      const item = w.findItemRange(start, end, w.selectedItem.type, w.selectedItem.metadata, true, w.selectedItem.nbt);
      if (item && item.stackSize !== item.count) {
        await clickWindow(item.slot, 0, 0);
        continue;
      }
      const empty = w.firstEmptySlotRange(start, end);
      if (empty !== null) {
        await clickWindow(empty, 0, 0);
        continue;
      }
      // No room: put it back where it came from, then drop whatever is left.
      if (slot !== null) await clickWindow(slot, 0, 0);
      if (w.selectedItem) await clickWindow(-999, 0, 0);
    }
  };

  /** Moves a slot's stack into the inventory part of the current window. */
  const putAway = async (slot: number): Promise<void> => {
    const window: any = bot.currentWindow ?? bot.inventory;
    const updated = nextEvent(window, `updateSlot:${slot}`, WINDOW_TIMEOUT);
    const start = window.inventoryStart;
    const end = window.inventoryEnd;
    const item = window.slots[slot];
    // A shift click on a result slot repeats the craft or trade while the inputs cover it.
    const resultSlot = slot === window.craftingResultSlot || (window.type === 'minecraft:merchant' && slot === 2);
    const room = item && (window.findItemRange(start, end, item.type, item.metadata, true, item.nbt) || window.firstEmptySlotRange(start, end) !== null);
    if (room && !resultSlot) {
      await clickWindow(slot, 0, 1);
    } else {
      await clickWindow(slot, 0, 0);
      await putSelectedItemRange(start, end, window, null);
    }
    await updated;
  };

  const transfer = async (options: TransferOptions): Promise<void> => {
    const window: any = options.window ?? bot.currentWindow ?? bot.inventory;
    const { itemType, metadata, nbt: itemNbt } = options;
    let count = options.count ?? 1;
    const sourceStart = options.sourceStart;
    const sourceEnd = options.sourceEnd ?? sourceStart + 1;
    const destStart = options.destStart;
    const destEnd = options.destEnd ?? destStart + 1;
    let firstSourceSlot: number | null = null;
    const holding = (): boolean => {
      const s = window.selectedItem;
      return Boolean(s) && s.type === itemType && (metadata == null || s.metadata === metadata) && (itemNbt == null || s.nbt === itemNbt);
    };

    while (count > 0) {
      if (!holding()) {
        // The cursor holds something else: put it back first.
        if (window.selectedItem) await putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot);
        const source = window.findItemRange(sourceStart, sourceEnd, itemType, metadata, false, itemNbt);
        if (!source) {
          const name = (bot.registry as any).items[itemType]?.name ?? `item ${itemType}`;
          throw new Error(`Can't find ${name} in slots [${sourceStart} - ${sourceEnd}]`);
        }
        firstSourceSlot ??= source.slot;
        await clickWindow(source.slot, 0, 0);
      }
      let destSlot: number;
      let destCount = 0;
      if (destStart === -999) {
        destSlot = -999;
      } else {
        const destItem = window.findItemRange(destStart, destEnd, window.selectedItem.type, window.selectedItem.metadata, true, itemNbt);
        const found = destItem ? destItem.slot : window.firstEmptySlotRange(destStart, destEnd);
        if (found === null) throw new Error('destination full');
        destSlot = found;
        destCount = destItem?.count ?? 0;
      }
      const selected = window.selectedItem;
      // A left click moves as many as fit; a right click moves one.
      const moved = destSlot === -999 ? selected.count : Math.min(selected.stackSize - destCount, selected.count);
      if (moved <= count) {
        await clickWindow(destSlot, 0, 0);
        count -= moved;
      } else {
        await clickWindow(destSlot, 1, 0);
        count -= 1;
      }
    }
    if (window.selectedItem) await putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot);
  };

  const toss = async (itemType: number, metadata: number | null, count: number | null): Promise<void> => {
    const window: any = bot.currentWindow ?? bot.inventory;
    await transfer({ window, itemType, metadata, count, sourceStart: window.inventoryStart, sourceEnd: window.inventoryEnd, destStart: -999 });
  };

  const tossStack = async (item: Item): Promise<void> => {
    if (!item) throw new Error('tossStack needs an item');
    await clickWindow((item as any).slot, 0, 0);
    await clickWindow(-999, 0, 0);
  };

  function extendWindow(window: any): void {
    window.close = () => closeWindow(window);
    window.withdraw = async (itemType: number, metadata: number | null, count: number | null, itemNbt?: unknown) => {
      if ((bot.inventory as any).emptySlotCount() === 0) throw new Error('Unable to withdraw, the inventory is full.');
      await transfer({ window, itemType, metadata, count, nbt: itemNbt, sourceStart: 0, sourceEnd: window.inventoryStart, destStart: window.inventoryStart, destEnd: window.inventoryEnd });
    };
    window.deposit = async (itemType: number, metadata: number | null, count: number | null, itemNbt?: unknown) => {
      await transfer({ window, itemType, metadata, count, nbt: itemNbt, sourceStart: window.inventoryStart, sourceEnd: window.inventoryEnd, destStart: 0, destEnd: window.inventoryStart });
    };
  }

  const waitWindow = async (action: () => Promise<void>, what: string): Promise<OpenWindow> => {
    const opened = nextEvent<[OpenWindow]>(bot, 'windowOpen', WINDOW_TIMEOUT * 2);
    await action();
    const result = await opened;
    if (!result) throw new Error(`${what} didn't open a window`);
    return result[0];
  };

  const openBlock = (block: Block, direction?: Vec3, cursorPos?: Vec3): Promise<OpenWindow> =>
    waitWindow(() => bot.activateBlock(block, direction, cursorPos), `The ${block.name} at ${block.position}`);

  const openEntity = (entity: Pick<Entity, 'id' | 'position'>): Promise<OpenWindow> =>
    waitWindow(() => bot.activateEntity(entity), `Entity ${entity.id}`);

  const setQuickBarSlot = (slot: number, send = true): void => {
    if (slot < 0 || slot >= QUICK_BAR_COUNT) throw new Error(`Invalid quick bar slot ${slot}`);
    if (bot.quickBarSlot === slot) return;
    bot.quickBarSlot = slot;
    if (send) client.write('held_item_slot', { slotId: slot });
    bot.updateHeldItem();
  };

  const usedOverTime = (item: Item | null | undefined): boolean =>
    !!item && isUsedOverTime(item.name, item.metadata, Boolean((bot.registry as unknown as { foodsByName?: Record<string, unknown> }).foodsByName?.[item.name]));

  const activateItem = (offHand = false): void => {
    // Sent with an empty hand too (unlike mineflayer): some servers open menus on any right-click.
    // Only items used over time (food, potions, bows, shields…) slow the player down meanwhile; a
    // bucket, a pearl or a rod is used at once.
    bot.usingHeldItem = usedOverTime(offHand ? bot.inventory.slots[45] : bot.heldItem);
    if (sf('useItemWithBlockPlace')) {
      // The vanilla 1.8 client sends a use in the air at (-1, -1, -1) with the cursor at 0 (Grim's
      // BadPacketsU; y 255 was 1.7's).
      client.write('block_place', {
        location: new Vec3(-1, -1, -1),
        direction: -1,
        heldItem: Item.toNotch(bot.heldItem),
        cursorX: 0,
        cursorY: 0,
        cursorZ: 0,
      });
    } else {
      client.write('use_item', {
        hand: offHand ? 1 : 0,
        sequence: bot._nextSequence(),
        // The rotation the movement packets carry, exactly (anticheats compare them: Grim's BadPacketsJ).
        rotation: (() => {
          const sent = bot.sentRotation();
          return { x: sent.yaw, y: sent.pitch };
        })(),
      });
    }
  };

  const deactivateItem = (): void => {
    const body: Record<string, unknown> = { status: 5, location: new Vec3(0, 0, 0), face: 5 };
    if (sf('useItemWithOwnPacket')) {
      body.face = 0;
      body.sequence = 0;
    }
    client.write('block_dig', body);
    bot.usingHeldItem = false;
  };

  /** Eats or drinks the held item; resolves when the server reports it done. */
  const consume = async (): Promise<void> => {
    const held = bot.heldItem;
    if (!held) throw new Error('Nothing to consume');
    if (bot.game.gameMode !== 'creative' && !ALWAYS_CONSUMABLES.has(held.name) && bot.food >= 20) throw new Error('Food is full');
    await handSettled();
    if (bot.heldItem?.type !== held.type) throw new Error('The held item changed');
    const self = bot.entity.id;
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error): void => {
        clearTimeout(timer);
        client.removeListener('entity_status', onStatus);
        client.removeListener('set_cooldown', onCooldown);
        bot.removeListener('heldItemChanged', onHeld);
        bot.usingHeldItem = false;
        if (err) reject(err);
        else resolve();
      };
      // Status 9: the server finished the item use.
      const onStatus = (packet: any): void => {
        if (packet.entityId === self && packet.entityStatus === 9) done();
      };
      // 1.21.2+ cooldowns name a group (the item id by default) instead of an item id.
      const onCooldown = (packet: any): void => {
        const group = packet.cooldownGroup ?? packet.itemID;
        if (!bot.heldItem || group === bot.heldItem.type || String(group).replace(/^minecraft:/, '') === bot.heldItem.name) done();
      };
      const onHeld = (item: Item | null): void => {
        if (item?.type !== held.type || item.count !== held.count) done();
      };
      // A slow server takes longer to finish: scale by its tick rate.
      const tps = Math.min(20, Math.max(5, bot.tps ?? 20));
      const timer = setTimeout(() => done(new Error('Consuming timed out')), (CONSUME_TICKS * 50 * 20) / tps + CONSUME_SLACK_MS);
      client.on('entity_status', onStatus);
      client.on('set_cooldown', onCooldown);
      bot.on('heldItemChanged', onHeld);
      activateItem();
    });
  };

  const moveSlotItem = async (sourceSlot: number, destSlot: number): Promise<void> => {
    await clickWindow(sourceSlot, 0, 0);
    await clickWindow(destSlot, 0, 0);
    bot.updateHeldItem();
    if ((bot.inventory as any).selectedItem) await clickWindow(sourceSlot, 0, 0);
  };

  const equipmentSlot = (destination: Destination): number => {
    if (destination === 'hand') return QUICK_BAR_START + bot.quickBarSlot;
    const slot = armorSlots[destination];
    if (slot === undefined) throw new Error(`invalid destination: ${destination}`);
    return slot;
  };

  /**
   * Clicks in the player's own inventory happen with its screen open: the game takes no movement
   * keys then, and anticheats flag inventory clicks while moving (Grim's MultiActionsC). Keys held
   * now count as let go for a tick first, and come back after.
   */
  const inInventoryScreen = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (bot.currentWindow) return fn();
    const moving = (['forward', 'back', 'left', 'right', 'jump'] as const).some((k) => bot.getControlState(k));
    // The server knows the keys from the ticks it got: they must have been up for two of them.
    if (!moving && bot.idleInputTicks >= 2) return fn();
    const release = bot.holdInput();
    try {
      for (let i = 0; i < 5 && bot.idleInputTicks < 2; i++) await bot.afterTick();
      return await fn();
    } finally {
      release();
    }
  };

  const equip = async (itemOrType: Item | number, destination: Destination | null): Promise<void> => {
    const inv = bot.inventory as any;
    const item: any = typeof itemOrType === 'number' ? inv.findInventoryItem(itemOrType) : itemOrType;
    if (!item || typeof item !== 'object') throw new Error('Invalid item object in equip');
    const dest = destination ?? 'hand';
    const sourceSlot = item.slot as number;
    let destSlot = equipmentSlot(dest);
    if (sourceSlot === destSlot) return;
    if (dest !== 'hand') {
      await inInventoryScreen(() => moveSlotItem(sourceSlot, destSlot));
      return;
    }
    const inHotbar = (s: number): boolean => s >= QUICK_BAR_START && s < QUICK_BAR_START + QUICK_BAR_COUNT;
    if (inHotbar(sourceSlot)) {
      setQuickBarSlot(sourceSlot - QUICK_BAR_START);
      return;
    }
    destSlot = inv.firstEmptySlotRange(QUICK_BAR_START, QUICK_BAR_START + QUICK_BAR_COUNT) ?? -1;
    if (destSlot < 0) {
      destSlot = QUICK_BAR_START + nextQuickBarSlot;
      nextQuickBarSlot = (nextQuickBarSlot + 1) % QUICK_BAR_COUNT;
    }
    setQuickBarSlot(destSlot - QUICK_BAR_START);
    await inInventoryScreen(() => moveSlotItem(sourceSlot, destSlot));
  };

  const unequip = async (destination: Destination): Promise<void> => {
    const inv = bot.inventory as any;
    if (destination === 'hand') {
      for (let i = 0; i < QUICK_BAR_COUNT; i++) {
        if (!inv.slots[QUICK_BAR_START + i]) {
          setQuickBarSlot(i);
          return;
        }
      }
    }
    const slot = equipmentSlot(destination);
    const empty = inv.firstEmptySlotRange(inv.inventoryStart, inv.inventoryEnd);
    if (empty === null) throw new Error('No room in the inventory');
    await moveSlotItem(slot, empty);
  };

  return {
    setQuickBarSlot,
    activateItem,
    deactivateItem,
    consume,
    clickWindow,
    closeWindow,
    moveSlotItem,
    equip,
    unequip,
    putSelectedItemRange,
    putAway,
    transfer,
    syncWindow,
    toss,
    tossStack,
    openBlock,
    openEntity,
    equipmentSlot,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
