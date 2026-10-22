import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { installChat, parseComponent } from '../src/features/chat.js';
import { tpsFrom } from '../src/features/serverHealth.js';
import { chatLoader, connectionRegistry } from '../src/registry.js';
import { clickUsesHashedSlots, normalizeWindowTitle, playerInventorySlotToWindow } from '../src/features/inventory.js';
import { actionNames, deltaYaw, touchesBot, velocityIsLpVec3 } from '../src/features/motion.js';
import { extractSkin } from '../src/features/players.js';
import { spawnTypeFilter } from '../src/features/spawns.js';
import { colorName, sortScores } from '../src/features/scoreboard.js';
import * as conv from '../src/conv.js';
import { parseGameMode, serverboundNames } from '../src/bot.js';

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

  it('peeks the byte-sized object type before 1.14 (and without a uuid on 1.8)', () => {
    const byte = spawnTypeFilter((type) => type === 50, 'byte');
    expect(byte(Buffer.from([0x00, 0x05, ...new Array(16).fill(0), 50]), 1)).toBe(true);
    expect(byte(Buffer.from([0x00, 0x05, ...new Array(16).fill(0), 70]), 1)).toBe(false);
    const legacy = spawnTypeFilter((type) => type === 50, 'legacy');
    expect(legacy(Buffer.from([0x00, 0x05, 50, 0, 0]), 1)).toBe(true);
    expect(legacy(Buffer.from([0x00, 0x05, 70, 0, 0]), 1)).toBe(false);
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

describe('motion', () => {
  it('notices changes to the floor and the space the bot occupies', () => {
    const pos = { x: 10.5, y: 64, z: -3.5 };
    expect(touchesBot(pos, 10, 63, -4)).toBe(true); // the block under its feet
    expect(touchesBot(pos, 10, 65, -4)).toBe(true); // its head
    expect(touchesBot(pos, 10, 62, -4)).toBe(false); // two below
    expect(touchesBot(pos, 12, 63, -4)).toBe(false); // a neighbouring column
    // Standing on an edge: the 0.6-wide box overlaps the next column too.
    expect(touchesBot({ x: 10.9, y: 64, z: -3.5 }, 11, 63, -4)).toBe(true);
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

describe('version tables', () => {
  it('knows the 1.21.6 entity_action renumbering', () => {
    expect(actionNames('1.21.5').has('start_sneaking')).toBe(true);
    expect(actionNames('1.21.6').has('start_sneaking')).toBe(false);
    expect(actionNames('1.21.6').has('start_sprinting')).toBe(true);
    expect(actionNames('1.8.9').has('start_sprinting')).toBe(true);
  });

  it('knows when velocity is already in blocks', () => {
    expect(velocityIsLpVec3('1.21.8')).toBe(false);
    expect(velocityIsLpVec3('1.21.9')).toBe(true);
  });

  it('knows when clicks carry hashed slots', () => {
    expect(clickUsesHashedSlots('1.21.4')).toBe(false);
    expect(clickUsesHashedSlots('1.21.5')).toBe(true);
  });

  it('has no play packets in the configuration state', () => {
    const config = serverboundNames('1.20.4', 'configuration');
    expect(config.has('settings')).toBe(true);
    expect(config.has('position_look')).toBe(false);
    expect(serverboundNames('1.20.4', 'play').has('position_look')).toBe(true);
  });
});

describe('server health', () => {
  it('reads TPS from the world age over wall time', () => {
    const at = (s: number) => s * 1000;
    expect(tpsFrom([{ age: 0, at: 0 }], at(1))).toBeNull();
    expect(tpsFrom([{ age: 0, at: 0 }, { age: 40, at: at(2) }], at(2))).toBeNull(); // under 3 s
    const healthy = [0, 1, 2, 3, 4].map((s) => ({ age: s * 20, at: at(s) }));
    expect(tpsFrom(healthy, at(4))).toBe(20);
    const laggy = [0, 1, 2, 3, 4].map((s) => ({ age: s * 10, at: at(s) }));
    expect(tpsFrom(laggy, at(4))).toBe(10);
    // Updates stopped (server frozen): measured to now.
    expect(tpsFrom(healthy, at(8))).toBe(10);
  });
});

describe('chat while out of the game', () => {
  const setup = (holdChatMs?: number) => {
    const registry = connectionRegistry('1.20.4');
    const client = Object.assign(new EventEmitter(), { state: 'configuration', ended: false, sent: [] as string[], chat(m: string) { client.sent.push(m); }, write() {} });
    const bot = Object.assign(new EventEmitter(), {
      _client: client,
      version: '1.20.4',
      registry,
      options: { holdChatMs },
      supportFeature: () => false,
      ChatMessage: chatLoader(registry),
    });
    let send: (m: string) => void = () => undefined;
    installChat(bot as never, { setSend: (fn) => (send = fn), setTabComplete: () => undefined });
    return { client, send: (m: string) => send(m) };
  };

  it('holds messages until the bot is back in the game, in order', async () => {
    const { client, send } = setup();
    send('/f home');
    send('hello');
    expect(client.sent).toEqual([]);
    client.state = 'play';
    client.emit('login', {});
    await new Promise((r) => setImmediate(r));
    expect(client.sent).toEqual(['/f home', 'hello']);
    send('again');
    expect(client.sent).toEqual(['/f home', 'hello', 'again']);
  });

  it('drops them with holdChatMs 0, and on end', async () => {
    const off = setup(0);
    off.send('/f home');
    off.client.state = 'play';
    off.client.emit('login', {});
    await new Promise((r) => setImmediate(r));
    expect(off.client.sent).toEqual([]);
    const ended = setup();
    ended.send('/f home');
    ended.client.emit('end');
    ended.client.state = 'play';
    ended.client.emit('login', {});
    await new Promise((r) => setImmediate(r));
    expect(ended.client.sent).toEqual([]);
  });
});
