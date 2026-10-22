// Inventory and container windows: clicks with per-version bookkeeping (action numbers and
// `transaction` confirmations ≤1.16, state ids 1.17+), held item, equip, use item.
import nbt from 'prismarine-nbt';
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import * as conv from '../conv.js';
import type { Item, Window } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- prismarine-windows/items and packets are loosely typed */

const WINDOW_TIMEOUT = 5000;
const QUICK_BAR_START = 36;
const QUICK_BAR_COUNT = 9;

type Destination = 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand';

export interface InventoryApi {
  setQuickBarSlot(slot: number): void;
  activateItem(offHand?: boolean): void;
  deactivateItem(): void;
  clickWindow(slot: number, mouseButton: number, mode: number): Promise<void>;
  closeWindow(window: Window): Promise<void>;
  moveSlotItem(sourceSlot: number, destSlot: number): Promise<void>;
  equip(item: Item | number, destination: Destination | null): Promise<void>;
  unequip(destination: Destination): Promise<void>;
}

/** Window-0 slot for a `set_player_inventory` (1.21.9+) index. */
/** 1.20.3+ sends window titles as NBT; turn them into the JSON text component older versions send. */
export function normalizeWindowTitle(title: unknown): unknown {
  if (title && typeof title === 'object' && 'type' in title && 'value' in title) {
    const plain = nbt.simplify(title as never) as unknown;
    return typeof plain === 'string' ? JSON.stringify({ text: plain }) : JSON.stringify(plain);
  }
  return title;
}

export function playerInventorySlotToWindow(slotId: number): number {
  if (slotId <= 8) return slotId + 36;
  if (slotId >= 36 && slotId <= 39) return 44 - slotId;
  if (slotId === 40) return 45;
  return slotId;
}

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

  let sequence = 0;
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

  // ── Server → client ──
  const prepareWindow = (window: any): void => {
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
    prepareWindow(bot.currentWindow);
  });
  client.on('open_horse_window', (packet: any) => {
    bot.currentWindow = windows.createWindow(packet.windowId, 'HorseWindow', 'Horse', packet.nbSlots);
    prepareWindow(bot.currentWindow);
  });
  client.on('close_window', () => {
    const old = bot.currentWindow;
    bot.currentWindow = null;
    bot.emit('windowClose', old);
  });
  const resetWindows = (): void => {
    bufferedItems = null;
    lastClosedWindow = null;
    const old = bot.currentWindow;
    if (!old) return;
    bot.currentWindow = null;
    bot.emit('windowClose', old);
  };
  client.on('login', resetWindows);
  client.on('respawn', () => {
    bufferedItems = null;
    lastClosedWindow = null;
  });

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
  client.on('held_item_slot', (packet: any) => setQuickBarSlot(packet.slot, false));

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
    return changed.map((location) => ({ location, item: Item.toNotch(window.slots[location]) }));
  };

  const clickWindow = async (slot: number, mouseButton: number, mode: number): Promise<void> => {
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
      const response = new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => {
          bot.removeListener(`confirmTransaction${actionId}`, onConfirm);
          reject(new Error(`Server didn't respond to transaction for clicking on slot ${slot} on window with id ${window.id}.`));
        }, WINDOW_TIMEOUT);
        const onConfirm = (ok: boolean): void => {
          clearTimeout(timer);
          resolve(ok);
        };
        bot.once(`confirmTransaction${actionId}`, onConfirm);
      });
      if (!window.transactionRequiresConfirmation(click)) confirmTransaction(window.id, actionId, true);
      if (!(await response)) throw new Error(`Server rejected transaction for clicking on slot ${slot}, on window with id ${window.id}.`);
      return;
    }

    const changedSlots = changedSlotsOf(window, click);
    client.write('window_click', {
      windowId: window.id,
      ...(sf('stateIdUsed') ? { stateId } : {}),
      slot,
      mouseButton,
      mode,
      changedSlots,
      cursorItem: Item.toNotch(window.selectedItem),
    });
  };

  const closeWindow = (window: Window): Promise<void> => {
    const w = window as any;
    client.write('close_window', { windowId: w.id });
    // Copy the container's inventory region back into the player inventory.
    if (w.id !== 0) {
      const shift = w.inventoryStart - (bot.inventory as any).inventoryStart;
      for (let i = w.inventoryStart; i < w.inventoryEnd; i++) (bot.inventory as any).updateSlot(i - shift, w.slots[i]);
    }
    lastClosedWindow = w;
    bot.currentWindow = null;
    bot.emit('windowClose', window);
    if (sf('stateIdUsed')) return Promise.resolve();
    return clickWindow(-999, 0, 0).catch(() => undefined);
  };

  const setQuickBarSlot = (slot: number, send = true): void => {
    if (slot < 0 || slot >= QUICK_BAR_COUNT) throw new Error(`Invalid quick bar slot ${slot}`);
    if (bot.quickBarSlot === slot) return;
    bot.quickBarSlot = slot;
    if (send) client.write('held_item_slot', { slotId: slot });
    bot.updateHeldItem();
  };

  const activateItem = (offHand = false): void => {
    sequence++;
    if (sf('useItemWithBlockPlace')) {
      client.write('block_place', {
        location: new Vec3(-1, 255, -1),
        direction: -1,
        heldItem: Item.toNotch(bot.heldItem),
        cursorX: -1,
        cursorY: -1,
        cursorZ: -1,
      });
    } else {
      client.write('use_item', {
        hand: offHand ? 1 : 0,
        sequence,
        rotation: { x: conv.toNotchianYaw(bot.entity?.yaw ?? 0), y: conv.toNotchianPitch(bot.entity?.pitch ?? 0) },
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
  };

  const moveSlotItem = async (sourceSlot: number, destSlot: number): Promise<void> => {
    await clickWindow(sourceSlot, 0, 0);
    await clickWindow(destSlot, 0, 0);
    bot.updateHeldItem();
    if ((bot.inventory as any).selectedItem) await clickWindow(sourceSlot, 0, 0);
  };

  const destSlotFor = (destination: Destination): number => {
    if (destination === 'hand') return QUICK_BAR_START + bot.quickBarSlot;
    const slot = armorSlots[destination];
    if (slot === undefined) throw new Error(`invalid destination: ${destination}`);
    return slot;
  };

  const equip = async (itemOrType: Item | number, destination: Destination | null): Promise<void> => {
    const inv = bot.inventory as any;
    const item: any = typeof itemOrType === 'number' ? inv.findInventoryItem(itemOrType) : itemOrType;
    if (!item || typeof item !== 'object') throw new Error('Invalid item object in equip');
    const dest = destination ?? 'hand';
    const sourceSlot = item.slot as number;
    let destSlot = destSlotFor(dest);
    if (sourceSlot === destSlot) return;
    if (dest !== 'hand') {
      await moveSlotItem(sourceSlot, destSlot);
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
    await moveSlotItem(sourceSlot, destSlot);
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
    const slot = destSlotFor(destination);
    const empty = inv.firstEmptySlotRange(inv.inventoryStart, inv.inventoryEnd);
    if (empty === null) throw new Error('No room in the inventory');
    await moveSlotItem(slot, empty);
  };

  return { setQuickBarSlot, activateItem, deactivateItem, clickWindow, closeWindow, moveSlotItem, equip, unequip };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
