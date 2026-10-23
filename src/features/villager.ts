// Villager and wandering-trader trading: open the merchant window, read its offers, and trade.
// Follows mineflayer's villager plugin (MIT); 1.20.5+ trade inputs (item id + count, no slot) are
// read too. The offers listener is attached only while a merchant window is open.
import type { PosseBot } from '../bot.js';
import type { Entity, Item } from '../types.js';
import { nextEvent, type OpenWindow } from './inventory.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets and prismarine-windows are untyped */

const UPDATE_TIMEOUT = 5000;

export interface Trade {
  inputItem1: Item;
  outputItem: Item;
  inputItem2: Item | null;
  hasItem2: boolean;
  inputs: Item[];
  outputs: Item[];
  tradeDisabled: boolean;
  nbTradeUses: number;
  maximumNbTradeUses: number;
  xp?: number;
  specialPrice?: number;
  priceMultiplier?: number;
  demand?: number;
  /** What the first input actually costs after demand and reputation. */
  realPrice: number;
}

export interface Villager extends OpenWindow {
  trades: Trade[];
  selectedTrade: Trade | null;
  trade(index: number, count?: number): Promise<void>;
}

/** The price of a trade's first input after demand and the special price (1.14+). */
export function tradePrice(count: number, stackSize: number, demand?: number, specialPrice?: number, priceMultiplier?: number): number {
  if (demand === undefined || specialPrice === undefined) return count;
  const demandDiff = Math.max(0, Math.floor(count * demand * (priceMultiplier ?? 0)));
  return Math.min(Math.max(count + specialPrice + demandDiff, 1), stackSize);
}

/** The legacy (≤1.13) trade list sent over a plugin channel. */
const LEGACY_TRADE_LIST = [
  'container',
  [
    { type: 'i32', name: 'windowId' },
    {
      name: 'trades',
      type: [
        'array',
        {
          countType: 'i8',
          type: [
            'container',
            [
              { type: 'slot', name: 'inputItem1' },
              { type: 'slot', name: 'outputItem' },
              { type: 'bool', name: 'hasItem2' },
              { name: 'inputItem2', type: ['switch', { compareTo: 'hasItem2', fields: { true: 'slot', false: 'void' } }] },
              { type: 'bool', name: 'tradeDisabled' },
              { type: 'i32', name: 'nbTradeUses' },
              { type: 'i32', name: 'maximumNbTradeUses' },
            ],
          ],
        },
      ],
    },
  ],
];

export interface VillagerApi {
  openVillager(entity: Pick<Entity, 'id' | 'position'> & { name?: string }): Promise<Villager>;
  trade(villager: Villager, index: number, count?: number): Promise<void>;
}

export function installVillager(bot: PosseBot): VillagerApi {
  const client = bot._client as any;
  const sf = bot.supportFeature;
  const { Item } = bot.kit;

  let tradeListPacket = 'trade_list';
  let channelsRegistered = false;
  const registerChannels = (): void => {
    if (channelsRegistered) return;
    channelsRegistered = true;
    if (sf('useMCTrList')) {
      tradeListPacket = 'MC|TrList';
      client.registerChannel('MC|TrList', LEGACY_TRADE_LIST);
    } else if (sf('usetraderlist')) {
      tradeListPacket = 'minecraft:trader_list';
      client.registerChannel('minecraft:trader_list', LEGACY_TRADE_LIST);
    }
    if (sf('useMCTrSel')) client.registerChannel('MC|TrSel', 'i32');
  };

  const selectTrade = (choice: number): void => {
    if (sf('useMCTrSel')) client.writeChannel('MC|TrSel', choice);
    else client.write('select_trade', { slot: choice });
  };

  /** A trade input or output as an Item: a slot, or (1.20.5+ inputs) an item id and count. */
  const itemOf = (raw: any): Item | null => {
    if (!raw) return null;
    if (raw.itemId !== undefined && raw.itemCount !== undefined && raw.present === undefined && !('addedComponentCount' in raw)) {
      return raw.itemCount > 0 ? (new Item(raw.itemId, raw.itemCount) as Item) : null;
    }
    return Item.fromNotch(raw) as Item | null;
  };

  const readTrades = (packet: any): Trade[] =>
    (packet.trades ?? []).map((t: any) => {
      const inputItem1 = itemOf(t.inputItem1)!;
      const inputItem2 = itemOf(t.inputItem2);
      const outputItem = itemOf(t.outputItem)!;
      const hasItem2 = Boolean(inputItem2 && inputItem2.type && inputItem2.count);
      return {
        inputItem1,
        outputItem,
        inputItem2: hasItem2 ? inputItem2 : null,
        hasItem2,
        inputs: hasItem2 ? [inputItem1, inputItem2!] : [inputItem1],
        outputs: [outputItem],
        tradeDisabled: Boolean(t.tradeDisabled),
        nbTradeUses: t.nbTradeUses,
        maximumNbTradeUses: t.maximumNbTradeUses,
        xp: t.xp,
        specialPrice: t.specialPrice,
        priceMultiplier: t.priceMultiplier,
        demand: t.demand,
        realPrice: tradePrice(inputItem1?.count ?? 0, (inputItem1 as any)?.stackSize ?? 64, t.demand, t.specialPrice, t.priceMultiplier),
      } satisfies Trade;
    });

  const openVillager: VillagerApi['openVillager'] = async (entity) => {
    if (entity.name && !['villager', 'wandering_trader', 'Villager'].includes(entity.name)) {
      throw new Error(`${entity.name} is not a villager or wandering trader`);
    }
    registerChannels();
    // Offers can arrive before or after the window opens; keep the latest by window id.
    const offers = new Map<number, Trade[]>();
    let villager: Villager | null = null;
    let readyResolve: (() => void) | null = null;
    const onTrades = (packet: any): void => {
      const trades = readTrades(packet);
      offers.set(packet.windowId, trades);
      if (villager && packet.windowId === villager.id) {
        villager.trades = trades;
        readyResolve?.();
      }
    };
    client.on(tradeListPacket, onTrades);
    try {
      const window = (await bot.openEntity(entity)) as Villager;
      if (window.type !== 'minecraft:villager' && window.type !== 'minecraft:merchant') throw new Error(`Expected a merchant window, got ${window.type}`);
      villager = window;
      villager.selectedTrade = null;
      villager.trades = offers.get(window.id) ?? (null as unknown as Trade[]);
      villager.trade = (index, count) => trade(villager!, index, count);
      (window as any).once('close', () => client.removeListener(tradeListPacket, onTrades));
      if (!villager.trades) {
        const ready = new Promise<void>((resolve) => (readyResolve = resolve));
        const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), UPDATE_TIMEOUT));
        if ((await Promise.race([ready, timeout])) === 'timeout') throw new Error('The villager sent no trades');
      }
      return villager;
    } catch (err) {
      client.removeListener(tradeListPacket, onTrades);
      if (villager) await bot.closeWindow(villager).catch(() => undefined);
      throw err;
    }
  };

  const deposit = async (window: Villager, item: Item, count: number, slot: number): Promise<void> => {
    await bot.transfer({
      window,
      itemType: item.type,
      metadata: item.metadata,
      count,
      sourceStart: (window as any).inventoryStart,
      sourceEnd: (window as any).inventoryEnd,
      destStart: slot,
      destEnd: slot + 1,
    });
  };

  const trade: VillagerApi['trade'] = async (villager, index, count) => {
    const choice = Math.floor(Number(index));
    const offer = villager.trades?.[choice];
    if (!offer) throw new Error(`No trade ${index}`);
    const usesLeft = offer.maximumNbTradeUses - offer.nbTradeUses;
    const times = count ?? usesLeft;
    if (usesLeft <= 0 || offer.tradeDisabled) throw new Error('Trade is out of stock');
    if (times > usesLeft) throw new Error(`Only ${usesLeft} trades left`);
    const w = villager as any;
    if (w.count(offer.inputItem1.type, offer.inputItem1.metadata) < offer.realPrice * times) throw new Error('Not enough of the first item to trade');
    if (offer.hasItem2 && w.count(offer.inputItem2!.type, offer.inputItem2!.metadata) < offer.inputItem2!.count * times) {
      throw new Error('Not enough of the second item to trade');
    }

    villager.selectedTrade = offer;
    const moved = sf('selectingTradeMovesItems')
      ? Promise.all([
          nextEvent(w, 'updateSlot:0', UPDATE_TIMEOUT),
          offer.hasItem2 ? nextEvent(w, 'updateSlot:1', UPDATE_TIMEOUT) : null,
          sf('setSlotAsTransaction') ? nextEvent(w, 'updateSlot:2', UPDATE_TIMEOUT) : null,
        ])
      : null;
    selectTrade(choice);
    // 1.14+: selecting a trade makes the server move the inputs into place itself.
    await moved;

    for (let i = 0; i < times; i++) {
      const [slot1, slot2] = w.slots;
      const need1 = slot1 ? Math.max(0, offer.realPrice - slot1.count) : offer.realPrice;
      if (need1) await deposit(villager, offer.inputItem1, need1, 0);
      if (offer.hasItem2) {
        const need2 = slot2 ? Math.max(0, offer.inputItem2!.count - slot2.count) : offer.inputItem2!.count;
        if (need2) await deposit(villager, offer.inputItem2!, need2, 1);
      }
      offer.nbTradeUses++;
      if (offer.maximumNbTradeUses - offer.nbTradeUses === 0) offer.tradeDisabled = true;
      if (!sf('setSlotAsTransaction')) {
        // ≤1.13 servers don't send the result: predict it.
        w.updateSlot(2, Object.assign(Object.create(Object.getPrototypeOf(offer.outputItem)), offer.outputItem));
        const [s1, s2] = w.slots;
        if (s1) w.updateSlot(0, s1.count - offer.realPrice <= 0 ? null : Object.assign(Object.create(Object.getPrototypeOf(s1)), s1, { count: s1.count - offer.realPrice }));
        if (s2 && offer.inputItem2) {
          const left = s2.count - offer.inputItem2.count;
          w.updateSlot(1, left <= 0 ? null : Object.assign(Object.create(Object.getPrototypeOf(s2)), s2, { count: left }));
        }
      }
      if (sf('selectingTradeMovesItems')) await bot.putAway(2);
      // A shift click on the output trades again while the inputs still cover the price.
      else await bot.clickWindow(2, 0, 1);
    }
    // Whatever is left in the input slots goes back.
    for (const s of [0, 1]) if (w.slots[s]) await bot.putAway(s);
  };

  return { openVillager, trade };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
