// Demand-driven packet decoding (docs/design.md → Demand-driven decoding).
//
// minecraft-protocol reads packets through three streams (splitter → decompressor → deserializer),
// throws a PartialReadError at the end of every socket read, and fully deserializes every packet
// before emitting it four times. Profiling 30 mineflayer bots put ~75% of the CPU in that path.
// Here the splitter is replaced by a framer that hands each frame straight to decompression, a
// gate and the compiled reader: a packet is only decoded when something listens for it (and passes
// its peek filter); otherwise it is dropped without any emit.
import zlib from 'node:zlib';
import minecraftData from 'minecraft-data';
import type { Client } from 'minecraft-protocol';

/** Returns false to skip decoding. `offset` is where the packet body starts in `buffer`. */
export type PeekFilter = (buffer: Buffer, offset: number) => boolean;

export interface DecodeStats {
  decoded: number;
  skipped: number;
  bytes: number;
  /** Decoded/skipped counts by packet name (computed when read). */
  readonly byName: Map<string, { decoded: number; skipped: number; bytes: number }>;
}

/** Reads a protocol varint; returns the value and the offset after it, or null if incomplete. */
export function readVarInt(buffer: Buffer, offset: number): { value: number; end: number } | null {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < buffer.length) {
    const byte = buffer[i++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value | 0, end: i };
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

type ProtocolTypes = Record<string, unknown>;

type Direction = 'toClient' | 'toServer';

function protocolTypes(version: string, state: string, direction: Direction = 'toClient'): ProtocolTypes | null {
  const data = minecraftData(version);
  const protocol = data?.protocol as unknown as Record<string, Record<Direction, { types?: ProtocolTypes } | undefined>> | undefined;
  return protocol?.[state]?.[direction]?.types ?? null;
}

const nameCache = new Map<string, string[]>();

/** Packet names by id for a version and protocol state (clientbound unless asked). */
export function packetNames(version: string, state: string, direction: Direction = 'toClient'): string[] {
  const key = `${version};${state};${direction}`;
  const cached = nameCache.get(key);
  if (cached) return cached;
  const names: string[] = [];
  const packet = protocolTypes(version, state, direction)?.packet as [string, Array<{ name: string; type: unknown }>] | undefined;
  const field = packet?.[1]?.find((f) => f.name === 'name');
  const mapper = Array.isArray(field?.type) ? (field.type[1] as { mappings?: Record<string, string> }) : undefined;
  for (const [id, name] of Object.entries(mapper?.mappings ?? {})) names[Number(id)] = name;
  nameCache.set(key, names);
  return names;
}

const entityIdCache = new Map<string, Set<string>>();

/** Clientbound play packets whose first field is `entityId: varint` (the peekable ones). */
export function entityIdPackets(version: string): Set<string> {
  const cached = entityIdCache.get(version);
  if (cached) return cached;
  const result = new Set<string>();
  const types = protocolTypes(version, 'play') ?? {};
  for (const [typeName, def] of Object.entries(types)) {
    if (!typeName.startsWith('packet_') || !Array.isArray(def) || def[0] !== 'container') continue;
    const first = (def[1] as Array<{ name?: string; type?: unknown }>)[0];
    if (first?.name === 'entityId' && first.type === 'varint') result.add(typeName.slice('packet_'.length));
  }
  entityIdCache.set(version, result);
  return result;
}

/** A filter that only lets through packets for entity ids in `tracked`. */
export function entityIdFilter(tracked: { has(id: number): boolean }): PeekFilter {
  return (buffer, offset) => {
    const id = readVarInt(buffer, offset);
    return id === null || tracked.has(id.value);
  };
}

/** True when anyone would observe a decoded `name` packet. */
export function hasConsumers(client: Pick<Client, 'listenerCount'>, name: string): boolean {
  return (
    client.listenerCount(name) > 0 ||
    client.listenerCount(`raw.${name}`) > 0 ||
    client.listenerCount('packet') > 0 ||
    client.listenerCount('raw') > 0
  );
}

/** The protocol's frame limit: a length prefix is at most 3 bytes (2^21 - 1). */
export const MAX_FRAME = (1 << 21) - 1;
/** The vanilla client's limit on a decompressed packet. */
export const MAX_PACKET = 1 << 23;

export class FrameError extends Error {}

/**
 * Splits a byte stream into length-prefixed frames without throwing on partial data. Feed it
 * socket chunks; it calls `onFrame` for every complete frame, in order. A corrupt length (negative,
 * over 2^21, or a prefix longer than 3 bytes) throws a FrameError: the stream can't be resynced.
 */
export class Framer {
  private pending: Buffer | null = null;

  constructor(private readonly onFrame: (frame: Buffer) => void) {}

  push(chunk: Buffer): void {
    let buffer = this.pending ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = null;
    let offset = 0;
    while (offset < buffer.length) {
      const length = readVarInt(buffer, offset);
      if (!length) {
        if (buffer.length - offset >= 3) throw new FrameError('Bad frame length prefix');
        break;
      }
      if (length.value < 0 || length.value > MAX_FRAME) throw new FrameError(`Bad frame length ${length.value}`);
      if (length.end + length.value > buffer.length) break;
      this.onFrame(buffer.subarray(length.end, length.end + length.value));
      offset = length.end + length.value;
      // A frame handler may have replaced the pipeline (e.g. compression turned on): keep going.
    }
    if (offset < buffer.length) {
      // Copy, so a small tail doesn't pin the whole socket chunk.
      buffer = buffer.subarray(offset);
      this.pending = Buffer.from(buffer);
    }
  }
}

/** Undoes minecraft-protocol's compression envelope (varint uncompressed length, then zlib). */
export function decompressFrame(frame: Buffer): Buffer {
  const length = readVarInt(frame, 0);
  if (!length) throw new Error('Truncated compressed frame');
  const body = frame.subarray(length.end);
  if (length.value === 0) return body;
  if (length.value < 0 || length.value > MAX_PACKET) throw new Error(`Bad uncompressed length ${length.value}`);
  // Never inflate past the declared size (a small frame must not inflate to gigabytes).
  return zlib.inflateSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: length.value });
}

interface ParsedPacket {
  data: { name: string; params: unknown };
  metadata: { size: number };
  buffer: Buffer;
}

interface Deserializer {
  parsePacketBuffer(buffer: Buffer): ParsedPacket;
  emit(event: string, ...args: unknown[]): boolean;
}

interface ClientInternals {
  deserializer?: Deserializer;
  splitter?: { _transform(chunk: Buffer, enc: string, cb: (err?: Error) => void): void; recognizeLegacyPing?: boolean };
  decompressor?: unknown;
  setSerializer(state: string): void;
  version: string;
  state: string;
}

export interface DemandDecoding {
  stats: DecodeStats;
  /** Wall-clock ms of the last packet of any kind. */
  lastPacketAt: number;
  /** Sets (or clears, with null) the peek filter for a packet name. */
  setFilter(name: string, filter: PeekFilter | null): void;
  /** Decode every packet (debugging / compatibility). */
  decodeAll: boolean;
  /** Handles one decompressed packet (exposed for tests). */
  handlePacket(buffer: Buffer): void;
}

/** Node's EventEmitter listener table (read directly: listenerCount per packet adds up). */
type ListenerTable = Record<string, unknown>;

/**
 * Takes over packet reading on a minecraft-protocol client. Call right after `createClient`
 * (before it connects). Decoded packets are emitted on the client by name, like minecraft-protocol
 * does; `packet` / `raw` are only emitted when someone listens. Bundles are not held back: their
 * packets are emitted in order as they arrive.
 */
export function installDemandDecoding(client: Client): DemandDecoding {
  const internals = client as unknown as ClientInternals;
  const events = (): ListenerTable => (client as unknown as { _events: ListenerTable })._events;
  const filters = new Map<string, PeekFilter>();
  let state = internals.state;
  let names = packetNames(internals.version, state);
  let rawNames = names.map((n) => `raw.${n}`);
  // Per state: counters by packet id, folded into stats.byName on read.
  const counters = new Map<string, { decoded: Float64Array; skipped: Float64Array; bytes: Float64Array; names: string[] }>();
  let current = counterFor(state);

  function counterFor(s: string) {
    let c = counters.get(s);
    if (!c) {
      const n = Math.max(1, names.length);
      c = { decoded: new Float64Array(n), skipped: new Float64Array(n), bytes: new Float64Array(n), names };
      counters.set(s, c);
    }
    return c;
  }

  const stats: DecodeStats = {
    decoded: 0,
    skipped: 0,
    bytes: 0,
    get byName() {
      const map = new Map<string, { decoded: number; skipped: number; bytes: number }>();
      for (const c of counters.values()) {
        c.names.forEach((name, id) => {
          if (!c.decoded[id] && !c.skipped[id]) return;
          const entry = map.get(name) ?? { decoded: 0, skipped: 0, bytes: 0 };
          entry.decoded += c.decoded[id]!;
          entry.skipped += c.skipped[id]!;
          entry.bytes += c.bytes[id]!;
          map.set(name, entry);
        });
      }
      return map;
    },
  };

  const control: DemandDecoding = {
    stats,
    lastPacketAt: Date.now(),
    decodeAll: false,
    setFilter(name, filter) {
      if (filter) filters.set(name, filter);
      else filters.delete(name);
    },
    handlePacket(buffer) {
      const deserializer = internals.deserializer;
      if (!deserializer) return;
      const id = readVarInt(buffer, 0);
      const name = id ? names[id.value] : undefined;
      if (!id || !name) return;
      if (name === 'bundle_delimiter') return;
      const table = events();
      const generic = table.packet !== undefined || table.raw !== undefined;
      let wanted = control.decodeAll || generic || table[name] !== undefined || table[rawNames[id.value]!] !== undefined;
      if (wanted && !control.decodeAll) {
        const filter = filters.get(name);
        if (filter && !filter(buffer, id.end)) wanted = false;
      }
      stats.bytes += buffer.length;
      current.bytes[id.value]! += buffer.length;
      if (!wanted) {
        stats.skipped++;
        current.skipped[id.value]!++;
        return;
      }
      stats.decoded++;
      current.decoded[id.value]!++;
      let packet: ParsedPacket;
      try {
        packet = deserializer.parsePacketBuffer(buffer);
      } catch (err) {
        if ((err as { partialReadError?: boolean }).partialReadError) return; // like minecraft-protocol: drop it
        (err as { buffer?: Buffer }).buffer = buffer;
        deserializer.emit('error', err);
        return;
      }
      const metadata = { name, state, size: packet.metadata.size };
      const params = packet.data.params;
      try {
        if (generic) {
          client.emit('packet', params, metadata, buffer, buffer);
          client.emit(name, params, metadata);
          client.emit(`raw.${name}`, buffer, metadata);
          client.emit('raw', buffer, metadata);
        } else {
          client.emit(name, params, metadata);
          if (table[rawNames[id.value]!] !== undefined) client.emit(`raw.${name}`, buffer, metadata);
        }
      } catch (err) {
        // A throwing listener must not break framing of the packets after it.
        process.nextTick(() => client.emit('error', err as Error));
      }
    },
  };

  const setSerializer = internals.setSerializer.bind(internals);
  internals.setSerializer = (next: string) => {
    setSerializer(next);
    state = next;
    names = packetNames(internals.version, next);
    rawNames = names.map((n) => `raw.${n}`);
    current = counterFor(next);
  };

  const onFrame = (frame: Buffer): void => {
    control.lastPacketAt = Date.now();
    let packet: Buffer;
    try {
      packet = internals.decompressor ? decompressFrame(frame) : frame;
    } catch {
      return; // minecraft-protocol also drops frames that fail to inflate
    }
    control.handlePacket(packet);
  };

  const splitter = internals.splitter;
  if (splitter) {
    const framer = new Framer(onFrame);
    // Nothing is pushed downstream any more: the decompressor/deserializer streams stay idle.
    let broken = false;
    splitter._transform = (chunk, _enc, cb) => {
      if (broken) return cb();
      try {
        framer.push(chunk);
      } catch (err) {
        // A corrupt stream can't be resynced: report it and close (minecraft-protocol's splitter
        // would only emit an error and leave the connection hanging until the keepalive timeout).
        broken = true;
        client.emit('error', err as Error);
        client.end(err instanceof FrameError ? 'Corrupt stream' : 'Read error');
      }
      cb();
    };
  }
  return control;
}
