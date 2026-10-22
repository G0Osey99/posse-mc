import { describe, expect, it } from 'vitest';
import { parseComponent } from '../src/features/chat.js';
import { normalizeWindowTitle, playerInventorySlotToWindow } from '../src/features/inventory.js';
import { deltaYaw } from '../src/features/motion.js';
import { extractSkin, spawnTypeFilter } from '../src/features/players.js';
import { colorName, sortScores } from '../src/features/scoreboard.js';
import * as conv from '../src/conv.js';
import { parseGameMode } from '../src/bot.js';

describe('chat', () => {
  it('parses JSON components and wraps plain text', () => {
    expect(parseComponent('{"text":"hi"}')).toEqual({ text: 'hi' });
    expect(parseComponent('not json')).toEqual({ text: 'not json' });
    expect(parseComponent({ text: 'nbt' })).toEqual({ text: 'nbt' });
  });
});

describe('inventory', () => {
  it('turns NBT window titles into JSON components', () => {
    expect(normalizeWindowTitle({ type: 'compound', value: { text: { type: 'string', value: 'Menu' } } })).toBe('{"text":"Menu"}');
    expect(normalizeWindowTitle({ type: 'string', value: 'Menu' })).toBe('{"text":"Menu"}');
    expect(normalizeWindowTitle('{"text":"Menu"}')).toBe('{"text":"Menu"}');
  });

  it('maps set_player_inventory indices to window slots', () => {
    expect(playerInventorySlotToWindow(0)).toBe(36);
    expect(playerInventorySlotToWindow(8)).toBe(44);
    expect(playerInventorySlotToWindow(39)).toBe(5); // head
    expect(playerInventorySlotToWindow(36)).toBe(8); // feet
    expect(playerInventorySlotToWindow(40)).toBe(45);
    expect(playerInventorySlotToWindow(20)).toBe(20);
  });
});

describe('players', () => {
  it('extracts skin URLs from the textures property', () => {
    const value = Buffer.from(JSON.stringify({ textures: { SKIN: { url: 'http://textures.minecraft.net/texture/abc', metadata: { model: 'slim' } } } })).toString('base64');
    expect(extractSkin([{ name: 'textures', value }])).toEqual({ url: 'http://textures.minecraft.net/texture/abc', model: 'slim', capeUrl: undefined });
    expect(extractSkin([{ name: 'textures', value: '!!!' }])).toBeUndefined();
    expect(extractSkin(undefined)).toBeUndefined();
  });

  it('peeks the entity type of spawn_entity past the id and uuid', () => {
    const filter = spawnTypeFilter((type) => type === 122);
    const packet = (type: number) => Buffer.from([0x00, 0x05, ...new Array(16).fill(0), type]);
    expect(filter(packet(122), 1)).toBe(true);
    expect(filter(packet(5), 1)).toBe(false);
  });
});

describe('scoreboard', () => {
  it('sorts by value, highest first', () => {
    const items = [{ name: 'a', value: 1 }, { name: 'b', value: 3 }, { name: 'c', value: 2 }] as never[];
    expect(sortScores(items).map((i: { name: string }) => i.name)).toEqual(['b', 'c', 'a']);
  });

  it('names team colours', () => {
    expect(colorName(12)).toBe('red');
    expect(colorName(undefined)).toBe('reset');
    expect(colorName(-1)).toBe('reset');
  });
});

describe('conversions', () => {
  it('round-trips yaw and pitch', () => {
    for (const deg of [0, 45, 90, 180, 270]) expect(conv.euclideanMod(conv.toNotchianYaw(conv.fromNotchianYaw(deg)), 360)).toBeCloseTo(deg);
    expect(conv.toNotchianPitch(conv.fromNotchianPitch(30))).toBeCloseTo(30);
  });

  it('wraps yaw deltas into (-π, π]', () => {
    expect(deltaYaw(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(0.2);
  });

  it('parses game modes like mineflayer', () => {
    expect(parseGameMode(1)).toBe('creative');
    expect(parseGameMode(9)).toBe('survival');
  });
});
