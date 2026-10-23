// Live checks of digging, placing, crafting, containers, furnaces, books, enchanting, trading,
// eating and ray casts against a vanilla server (see liveHarness.ts).
//
//   tsx bench/live-features.ts --accept-eula [--versions 1.21.4] [--only dig,craft] [--verbose]
import { Vec3 } from 'vec3';
import { enchantsOf } from '../src/items.js';
import type { Item } from '../src/index.js';
import { main, type LiveContext, type Scenario } from './liveHarness.js';

const up = new Vec3(0, 1, 0);

async function giveAndWait(ctx: LiveContext, name: string, count = 1, data = 0): Promise<Item> {
  const id = ctx.item(name);
  const before = (ctx.bot.inventory as unknown as { count(t: number, m: null): number }).count(id, null);
  ctx.cmd.give(name, count, data);
  await ctx.waitFor(() => (ctx.bot.inventory as unknown as { count(t: number, m: null): number }).count(id, null) >= before + count, 5000, `${count} ${name}`);
  return ctx.bot.inventory.items().find((i) => i.type === id)!;
}

async function setAndWait(ctx: LiveContext, pos: Vec3, block: string, state = ''): Promise<void> {
  ctx.cmd.setblock(pos, `${block}${state}`);
  await ctx.waitFor(() => ctx.bot.blockAt(pos)?.name === block, 5000, `${block} at ${pos}`);
}

const legacy = (ctx: LiveContext): boolean => !ctx.cmd.modern;
const itemName = (ctx: LiveContext, modern: string, old: string): string => (legacy(ctx) ? old : modern);

const scenarios: Record<string, Scenario> = {
  async dig(ctx) {
    const { bot } = ctx;
    const stone = ctx.base.offset(2, 1, 0);
    await setAndWait(ctx, stone, 'stone');
    await bot.equip(await giveAndWait(ctx, 'diamond_pickaxe'), 'hand');
    const block = bot.blockAt(stone)!;
    const expected = bot.digTime(block);
    const t0 = Date.now();
    await bot.dig(block);
    ctx.log(`stone: ${Date.now() - t0} ms (expected ${expected})`);
    if (bot.blockAt(stone)?.name !== 'air') throw new Error('stone still there');
    await ctx.sleep(800); // the server's verdict
    if (bot.blockAt(stone)?.name !== 'air') throw new Error(`server put the stone back: ${bot.blockAt(stone)?.name}`);
    // By hand, from below eye level (another face).
    const dirt = ctx.base.offset(-2, 1, 1);
    await setAndWait(ctx, dirt, 'dirt');
    await bot.unequip('hand');
    await bot.dig(bot.blockAt(dirt)!);
    await ctx.sleep(800);
    if (bot.blockAt(dirt)?.name !== 'air') throw new Error('dirt still there');
  },

  async place(ctx) {
    const { bot } = ctx;
    await bot.equip(await giveAndWait(ctx, 'dirt', 16), 'hand');
    const ground = bot.blockAt(ctx.base.offset(2, 0, 0))!;
    await bot.placeBlock(ground, up);
    if (bot.blockAt(ctx.base.offset(2, 1, 0))?.name !== 'dirt') throw new Error('dirt not placed on the ground');
    // Against a chest: the bot sneaks so the chest doesn't open.
    const chest = ctx.base.offset(-2, 1, 0);
    await setAndWait(ctx, chest, 'chest');
    let opened = false;
    const onOpen = (): void => {
      opened = true;
    };
    bot.on('windowOpen', onOpen);
    await bot.placeBlock(bot.blockAt(chest)!, up);
    bot.off('windowOpen', onOpen);
    if (opened) throw new Error('the chest opened');
    if (bot.blockAt(chest.offset(0, 1, 0))?.name !== 'dirt') throw new Error('dirt not placed on the chest');
    // Against the side of a block.
    await bot.placeBlock(bot.blockAt(ctx.base.offset(2, 1, 0))!, new Vec3(0, 0, 1));
    if (bot.blockAt(ctx.base.offset(2, 1, 1))?.name !== 'dirt') throw new Error('dirt not placed against a side');
  },

  async craft(ctx) {
    const { bot } = ctx;
    const log = itemName(ctx, 'oak_log', 'log');
    const planks = ctx.item(itemName(ctx, 'oak_planks', 'planks'));
    await giveAndWait(ctx, log, 3);
    const plankRecipes = bot.recipesFor(planks, null, 1, null);
    if (plankRecipes.length === 0) throw new Error('no planks recipe');
    await bot.craft(plankRecipes[0]!, 3, null);
    const inv = bot.inventory as unknown as { count(t: number, m: null): number };
    await ctx.waitFor(() => inv.count(planks, null) >= 12, 3000, '12 planks').catch((err) => {
      throw new Error(`${err.message}; inventory: ${bot.inventory.items().map((i) => `${i.slot}:${i.name}x${i.count}`).join(' ')}`);
    });
    const sticks = bot.recipesFor(ctx.item('stick'), null, 1, null);
    if (sticks.length === 0) throw new Error('no sticks recipe');
    await bot.craft(sticks[0]!, 1, null);
    await ctx.waitFor(() => inv.count(ctx.item('stick'), null) >= 4, 3000, '4 sticks');
    const table = ctx.base.offset(2, 1, 0);
    await setAndWait(ctx, table, 'crafting_table');
    const pickaxe = bot.recipesFor(ctx.item('wooden_pickaxe'), null, 1, true);
    if (pickaxe.length === 0) throw new Error('no pickaxe recipe');
    await bot.craft(pickaxe[0]!, 1, bot.blockAt(table)!);
    await ctx.waitFor(() => inv.count(ctx.item('wooden_pickaxe'), null) === 1, 3000, 'a wooden pickaxe');
    await ctx.sleep(500);
    if (inv.count(planks, null) !== 12 - 2 - 3) throw new Error(`expected 7 planks left, have ${inv.count(planks, null)}`);
    if (inv.count(ctx.item('stick'), null) !== 2) throw new Error(`expected 2 sticks left, have ${inv.count(ctx.item('stick'), null)}`);
  },

  async chest(ctx) {
    const { bot } = ctx;
    const pos = ctx.base.offset(2, 1, 0);
    await setAndWait(ctx, pos, 'chest');
    await giveAndWait(ctx, 'dirt', 20);
    const chest = await bot.openContainer(bot.blockAt(pos)!);
    await chest.deposit(ctx.item('dirt'), null, 12);
    const w = chest as unknown as { containerCount(t: number, m: null): number; count(t: number, m: null): number };
    if (w.containerCount(ctx.item('dirt'), null) !== 12) throw new Error(`chest has ${w.containerCount(ctx.item('dirt'), null)}`);
    await chest.withdraw(ctx.item('dirt'), null, 5);
    if (w.containerCount(ctx.item('dirt'), null) !== 7) throw new Error(`chest has ${w.containerCount(ctx.item('dirt'), null)} after withdrawing`);
    await chest.close();
    await ctx.sleep(500);
    const inv = bot.inventory as unknown as { count(t: number, m: null): number };
    if (inv.count(ctx.item('dirt'), null) !== 13) throw new Error(`inventory has ${inv.count(ctx.item('dirt'), null)} dirt`);
    // The server agrees: reopen.
    const again = await bot.openContainer(bot.blockAt(pos)!);
    const left = (again as unknown as { containerCount(t: number, m: null): number }).containerCount(ctx.item('dirt'), null);
    await again.close();
    if (left !== 7) throw new Error(`reopened chest has ${left}`);
  },

  async furnace(ctx) {
    const { bot } = ctx;
    const pos = ctx.base.offset(2, 1, 0);
    await setAndWait(ctx, pos, 'furnace');
    await giveAndWait(ctx, 'coal', 2);
    await giveAndWait(ctx, 'cobblestone', 2);
    const furnace = await bot.openFurnace(bot.blockAt(pos)!);
    await furnace.putFuel(ctx.item('coal'), null, 1);
    await furnace.putInput(ctx.item('cobblestone'), null, 2);
    await ctx.waitFor(() => (furnace.totalProgress ?? 0) > 0 || (furnace.totalFuel ?? 0) > 0, 5000, 'furnace properties');
    await ctx.waitFor(() => furnace.outputItem() !== null, 15000, 'smelted stone');
    await furnace.takeOutput();
    await furnace.close();
  },

  async book(ctx) {
    const { bot } = ctx;
    await giveAndWait(ctx, 'writable_book', 1);
    const slotOf = (name: string): number => bot.inventory.items().find((i) => i.name === name)!.slot;
    await bot.writeBook(slotOf('writable_book'), ['Hello from Posse', 'page two']);
    await bot.signBook(slotOf('writable_book'), ['Signed'], 'PosseLive', 'Posse');
    await ctx.waitFor(() => bot.inventory.items().some((i) => i.name === 'written_book'), 5000, 'a written book');
  },

  async enchant(ctx) {
    const { bot } = ctx;
    ctx.cmd.levels(30);
    await ctx.waitFor(() => bot.experience.level >= 30, 5000, '30 levels');
    const pos = ctx.base.offset(2, 1, 0);
    await setAndWait(ctx, pos, legacy(ctx) && ctx.version === '1.8.9' ? 'enchanting_table' : 'enchanting_table');
    await giveAndWait(ctx, 'iron_sword', 1);
    const lapisName = legacy(ctx) ? 'dye' : 'lapis_lazuli';
    ctx.cmd.give(lapisName, 8, 4);
    await ctx.sleep(500);
    const table = await bot.openEnchantmentTable(bot.blockAt(pos)!);
    const items = (table as unknown as { items(): Item[] }).items();
    const sword = items.find((i) => i.name === 'iron_sword')!;
    await table.putTargetItem(sword);
    const lapis = (table as unknown as { items(): Item[] }).items().find((i) => i.name === lapisName);
    if (lapis) await table.putLapis(lapis);
    await ctx.waitFor(() => table.enchantments.some((e) => e.level > 0), 5000, 'enchantment options');
    const option = table.enchantments.findIndex((e) => e.level > 0 && e.level <= 30);
    const enchanted = await table.enchant(option);
    const enchants = enchantsOf(bot.registry, enchanted);
    ctx.log(`enchanted: ${JSON.stringify(enchants)}`);
    if (enchants.length === 0) throw new Error('the sword has no enchantments');
    await table.takeTargetItem();
    await table.close();
  },

  async trade(ctx) {
    const { bot, version } = ctx;
    const pos = ctx.base.offset(2, 1, 0);
    const v = (major: number, minor = 0, patch = 0): boolean => {
      const [a = 0, b = 0, c = 0] = version.split('.').map(Number);
      return a > major || (a === major && (b > minor || (b === minor && c >= patch)));
    };
    const count = v(1, 20, 5) ? 'count' : 'Count';
    const recipe = `{buy:{id:"minecraft:emerald",${count}:1},sell:{id:"minecraft:bread",${count}:6},maxUses:12}`;
    const entity = v(1, 11) ? 'villager' : 'Villager';
    const data = v(1, 14) ? 'VillagerData:{profession:"minecraft:farmer",level:2,type:"minecraft:plains"},' : 'Profession:0,Career:1,';
    ctx.cmd.run(`summon ${v(1, 13) ? 'minecraft:' : ''}${entity} ${pos.x + 0.5} ${pos.y} ${pos.z + 0.5} {NoAI:1b,Silent:1b,${data}Offers:{Recipes:[${recipe}]}}`);
    const isVillager = (e: { name?: string; position: Vec3 }): boolean => e.name?.toLowerCase() === 'villager' && e.position.distanceTo(pos) < 3;
    await ctx.waitFor(() => Object.values(bot.entities).some(isVillager), 5000, 'the villager');
    const villagerEntity = Object.values(bot.entities).find(isVillager)!;
    await giveAndWait(ctx, 'emerald', 2);
    const villager = await bot.openVillager(villagerEntity);
    if (!villager.trades?.length) throw new Error('no trades');
    ctx.log(`trades: ${villager.trades.map((t) => `${t.inputItem1.count} ${t.inputItem1.name} -> ${t.outputItem.count} ${t.outputItem.name}`).join(', ')}`);
    await villager.trade(0, 1);
    await villager.close();
    const inv = bot.inventory as unknown as { count(t: number, m: null): number };
    await ctx.waitFor(() => inv.count(ctx.item('bread'), null) === 6, 3000, '6 bread');
    if (inv.count(ctx.item('emerald'), null) !== 1) throw new Error(`expected 1 emerald left, have ${inv.count(ctx.item('emerald'), null)}`);
    ctx.cmd.run(`kill @e[type=${v(1, 11) ? 'minecraft:villager' : 'Villager'}]`);
  },

  async eat(ctx) {
    const { bot } = ctx;
    ctx.cmd.effect('hunger', 3, 120);
    await ctx.waitFor(() => bot.food < 18, 10_000, 'hunger');
    ctx.cmd.run(ctx.cmd.modern ? 'effect clear PosseLive' : 'effect PosseLive clear');
    await ctx.sleep(300);
    await bot.equip(await giveAndWait(ctx, 'bread', 2), 'hand');
    const before = bot.food;
    await bot.consume();
    await ctx.waitFor(() => bot.food > before, 3000, 'food to rise');
  },

  async raycast(ctx) {
    const { bot } = ctx;
    const pos = bot.entity.position.floored().offset(0, 1, -3);
    await setAndWait(ctx, pos, 'stone');
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
    const hit = bot.blockAtCursor(5);
    if (!hit || !hit.position.equals(pos)) throw new Error(`cursor block: ${hit?.name} at ${hit?.position}`);
    if (hit.face !== 3) throw new Error(`expected the south face (3), got ${hit.face}`);
    if (!bot.canSeeBlock(bot.blockAt(pos)!)) throw new Error('canSeeBlock is false');
  },

  async activate(ctx) {
    if (legacy(ctx)) return; // trapdoor states are metadata before 1.13
    const { bot } = ctx;
    const pos = ctx.base.offset(2, 1, 0);
    await setAndWait(ctx, pos, 'oak_trapdoor');
    await bot.activateBlock(bot.blockAt(pos)!);
    await ctx.waitFor(() => (bot.blockAt(pos)?.getProperties() as { open?: boolean }).open === true, 3000, 'the trapdoor to open');
  },
};

await main(scenarios);
