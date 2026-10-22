import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  Framer,
  decompressFrame,
  entityIdFilter,
  entityIdPackets,
  hasConsumers,
  installDemandDecoding,
  packetNames,
  readVarInt,
} from '../src/decode.js';

const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};

describe('readVarInt', () => {
  it('reads one- and multi-byte values', () => {
    expect(readVarInt(Buffer.from([0x05]), 0)).toEqual({ value: 5, end: 1 });
    expect(readVarInt(Buffer.from([0xff, 0x01]), 0)).toEqual({ value: 255, end: 2 });
    expect(readVarInt(Buffer.from([0x00, ...varint(300)]), 1)).toEqual({ value: 300, end: 3 });
  });

  it('returns null on a truncated varint', () => {
    expect(readVarInt(Buffer.from([0x80]), 0)).toBeNull();
  });
});

describe('protocol tables', () => {
  it('maps clientbound play ids to names', () => {
    const names = packetNames('1.18.2', 'play');
    expect(names).toContain('map_chunk');
    expect(names).toContain('rel_entity_move');
  });

  it('finds packets that start with a varint entity id, in old and new versions', () => {
    for (const version of ['1.8.8', '1.18.2', '1.21.4']) {
      const set = entityIdPackets(version);
      expect(set.has('rel_entity_move')).toBe(true);
      expect(set.has('entity_status')).toBe(false); // i32 entity id
    }
  });
});

describe('entityIdFilter', () => {
  it('lets through tracked ids only', () => {
    const filter = entityIdFilter(new Set([42]));
    expect(filter(Buffer.from([0x10, ...varint(42), 0, 0]), 1)).toBe(true);
    expect(filter(Buffer.from([0x10, ...varint(7), 0, 0]), 1)).toBe(false);
  });
});

/** The parts of a minecraft-protocol Client the decoder touches. */
class FakeClient extends EventEmitter {
  version = '1.18.2';
  state = 'play';
  decompressor: unknown = null;
  parsed = 0;
  delivered: string[] = [];
  splitter = { _transform: (_c: Buffer, _e: string, cb: () => void) => cb() };
  deserializer = this.makeDeserializer();
  makeDeserializer() {
    const d = new EventEmitter() as EventEmitter & { parsePacketBuffer(b: Buffer): unknown };
    d.parsePacketBuffer = (buffer: Buffer) => {
      this.parsed++;
      return { data: { name: 'decoded', params: {} }, metadata: { size: buffer.length }, buffer };
    };
    return d;
  }
  setSerializer(state: string): void {
    this.state = state;
    this.deserializer = this.makeDeserializer();
  }
}

const names = packetNames('1.18.2', 'play');
const packet = (name: string, ...body: number[]) => Buffer.from([...varint(names.indexOf(name)), ...body]);
const frame = (buf: Buffer) => Buffer.concat([Buffer.from(varint(buf.length)), buf]);

describe('installDemandDecoding', () => {
  it('skips packets nobody listens to and decodes the rest', () => {
    const client = new FakeClient();
    const decoding = installDemandDecoding(client as never);
    decoding.handlePacket(packet('rel_entity_move', 1, 2, 3));
    client.on('rel_entity_move', () => client.delivered.push('decoded'));
    decoding.handlePacket(packet('rel_entity_move', 1, 2, 3));
    expect(client.parsed).toBe(1);
    expect(client.delivered).toEqual(['decoded']);
    expect(decoding.stats.byName.get('rel_entity_move')).toMatchObject({ decoded: 1, skipped: 1 });
  });

  it('applies peek filters before decoding', () => {
    const client = new FakeClient();
    const decoding = installDemandDecoding(client as never);
    client.on('rel_entity_move', () => undefined);
    decoding.setFilter('rel_entity_move', entityIdFilter(new Set([9])));
    decoding.handlePacket(packet('rel_entity_move', ...varint(3), 0));
    decoding.handlePacket(packet('rel_entity_move', ...varint(9), 0));
    expect(client.parsed).toBe(1);
  });

  it('follows state changes (new deserializer, new id table)', () => {
    const client = new FakeClient();
    client.state = 'login';
    const decoding = installDemandDecoding(client as never);
    client.setSerializer('play');
    client.on('map_chunk', () => client.delivered.push('decoded'));
    decoding.handlePacket(packet('map_chunk', 0));
    expect(client.delivered).toEqual(['decoded']);
  });

  it('frames socket chunks split anywhere, through the replaced splitter', () => {
    const client = new FakeClient();
    installDemandDecoding(client as never);
    client.on('keep_alive', () => client.delivered.push('decoded'));
    const bytes = Buffer.concat([frame(packet('keep_alive', 1, 2, 3, 4, 5, 6, 7, 8)), frame(packet('keep_alive', 8, 7, 6, 5, 4, 3, 2, 1))]);
    for (let i = 0; i < bytes.length; i += 3) client.splitter._transform(bytes.subarray(i, i + 3), '', () => undefined);
    expect(client.delivered).toEqual(['decoded', 'decoded']);
  });

  it('inflates compressed frames once compression is on', () => {
    const client = new FakeClient();
    installDemandDecoding(client as never);
    client.decompressor = {};
    client.on('keep_alive', () => client.delivered.push('decoded'));
    const raw = packet('keep_alive', ...new Array(300).fill(7));
    const compressed = Buffer.concat([Buffer.from(varint(raw.length)), zlib.deflateSync(raw)]);
    client.splitter._transform(frame(compressed), '', () => undefined);
    client.splitter._transform(frame(Buffer.concat([Buffer.from([0]), packet('keep_alive', 1)])), '', () => undefined);
    expect(client.delivered).toEqual(['decoded', 'decoded']);
  });

  it('emits packet/raw only when someone listens to them', () => {
    const client = new FakeClient();
    const decoding = installDemandDecoding(client as never);
    const seen: string[] = [];
    client.on('packet', (_d: unknown, meta: { name: string; state: string }) => seen.push(`${meta.state}.${meta.name}`));
    decoding.handlePacket(packet('map_chunk', 0));
    expect(seen).toEqual(['play.map_chunk']);
  });

  it('treats generic packet listeners as consumers of everything', () => {
    const client = new FakeClient();
    expect(hasConsumers(client as never, 'map_chunk')).toBe(false);
    client.on('packet', () => undefined);
    expect(hasConsumers(client as never, 'map_chunk')).toBe(true);
  });

  it('decodes everything with decodeAll', () => {
    const client = new FakeClient();
    const decoding = installDemandDecoding(client as never);
    decoding.decodeAll = true;
    decoding.handlePacket(packet('map_chunk', 0));
    expect(client.parsed).toBe(1);
  });
});

describe('Framer and decompressFrame', () => {
  it('keeps a partial tail until the rest arrives', () => {
    const frames: number[] = [];
    const framer = new Framer((f) => frames.push(f.length));
    framer.push(Buffer.from([0x03, 1]));
    framer.push(Buffer.from([2, 3, 0x01]));
    framer.push(Buffer.from([9]));
    expect(frames).toEqual([3, 1]);
  });

  it('passes uncompressed bodies through', () => {
    expect([...decompressFrame(Buffer.from([0, 5, 6]))]).toEqual([5, 6]);
  });
});
