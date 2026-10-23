import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { installChat, parseComponent } from '../src/features/chat.js';
import { tpsFrom } from '../src/features/serverHealth.js';
import { chatLoader, connectionRegistry } from '../src/registry.js';
import { clickUsesHashedSlots, normalizeWindowTitle, playerInventorySlotToWindow } from '../src/features/inventory.js';
import { actionNames, deltaYaw, touchesBot, velocityIsLpVec3 } from '../src/features/motion.js';
import { extractSkin } from '../src/features/players.js';
import { spawnTypeFilter } from '../src/features/spawns.js';
import { castAngles, castLanding, isBiteParticle } from '../src/features/fishing.js';
import { findBlocks, stateIdsOf } from '../src/features/findBlocks.js';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
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

describe('fishing', () => {
  const names = new Map([[4, 'bubble'], [29, 'fishing'], [5, 'splash']]);
  const nameOf = (p: { particleId?: number; particle?: { type: string } }) => (p.particle ? p.particle.type : names.get(p.particleId!));
  const bobber = { x: 10.5, z: -3.2 };

  it('sees the six-particle burst at the bobber, in both packet shapes', () => {
    expect(isBiteParticle({ particleId: 4, particles: 6, x: 10.9, z: -3.0 }, nameOf, bobber)).toBe(true);
    expect(isBiteParticle({ particle: { type: 'fishing' }, amount: 6, x: 10.2, z: -3.9 }, nameOf, bobber)).toBe(true);
  });

  it('ignores trails, splashes and other bobbers', () => {
    expect(isBiteParticle({ particleId: 29, particles: 2, x: 10.5, z: -3.2 }, nameOf, bobber)).toBe(false);
    expect(isBiteParticle({ particleId: 5, particles: 6, x: 10.5, z: -3.2 }, nameOf, bobber)).toBe(false);
    expect(isBiteParticle({ particleId: 4, particles: 6, x: 13.5, z: -3.2 }, nameOf, bobber)).toBe(false);
  });
});

describe('findBlocks', () => {
  const registry = minecraftData('1.18.2');
  const diamond = registry.blocksByName.diamond_ore!.minStateId!;
  const stone = registry.blocksByName.stone!.minStateId!;
  const placed = new Map([['3,10,0', diamond], ['-1,11,1', diamond], ['0,10,9', diamond]]);
  const world = {
    stateIdAt: (x: number, y: number, z: number) => (Math.abs(x) > 20 ? null : (placed.get(`${x},${y},${z}`) ?? (y < 10 ? stone : 0))),
    blockAt: (x: number, y: number, z: number) => ({ name: placed.has(`${x},${y},${z}`) ? 'diamond_ore' : 'stone', position: new Vec3(x, y, z) }) as never,
  };
  const bounds = { minY: -64, maxY: 319 };

  it('returns the nearest matches first within the radius', () => {
    const found = findBlocks(world, registry, new Vec3(0.5, 10, 0.5), { matching: 'diamond_ore', count: 5, maxDistance: 8 }, bounds);
    expect(found.map(String)).toEqual(['(-1, 11, 1)', '(3, 10, 0)']);
  });

  it('takes a test function and covers every state of a block', () => {
    const found = findBlocks(world, registry, new Vec3(0, 10, 0), { matching: (b) => b.name === 'diamond_ore', count: 3, maxDistance: 10 }, bounds);
    expect(found).toHaveLength(3);
    expect(stateIdsOf(minecraftData('1.8.9'), ['diamond_ore']).size).toBe(16);
    expect(findBlocks(world, registry, new Vec3(0, 10, 0), { matching: 'nope' }, bounds)).toEqual([]);
  });
});

describe('cast aiming', () => {
  it('lands where it aims', () => {
    const eye = new Vec3(0.5, 65.62, 0.5);
    for (const legacy of [false, true]) {
      for (const target of [new Vec3(0.5, 64.9, 4.5), new Vec3(7.5, 63.9, -3.5), new Vec3(-9.5, 64.9, 2.5)]) {
        const look = castAngles(eye, target, legacy)!;
        expect(look).not.toBeNull();
        const pitchDeg = (-look.pitch * 180) / Math.PI;
        const landing = castLanding(pitchDeg, target.y - eye.y, legacy)!;
        expect(Math.abs(landing - Math.hypot(target.x - eye.x, target.z - eye.z))).toBeLessThanOrEqual(0.3);
      }
    }
  });

  it('prefers the high arc when both reach', () => {
    const look = castAngles(new Vec3(0.5, 65.62, 0.5), new Vec3(0.5, 64.9, 9.5), true)!;
    expect(look.pitch).toBeGreaterThan(0);
  });

  it('refuses targets out of reach', () => {
    expect(castAngles(new Vec3(0, 65.62, 0), new Vec3(0, 64, 40), false)).toBeNull();
  });
});
