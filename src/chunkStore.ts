// The fleet chunk store (docs/design.md → World): kept chunk payloads are shared by every bot in the
// process. Bots parked in the same base receive byte-identical chunks, so each payload is hashed
// and stored (deflated) once, with a reference count.
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

export interface SharedPayload {
  readonly key: string;
  /** Deflated payload. */
  readonly data: Buffer;
  refs: number;
}

export interface ChunkStoreStats {
  payloads: number;
  /** Deflated bytes held once for the whole process. */
  bytes: number;
  /** References from bots' worlds (≥ payloads; the difference is what sharing saves). */
  refs: number;
}

export class ChunkStore {
  private readonly payloads = new Map<string, SharedPayload>();
  private bytes = 0;
  private refs = 0;

  /** Stores a raw payload (or finds the identical one) and takes a reference to it. */
  acquire(version: string, raw: Buffer): SharedPayload {
    const key = `${version}:${createHash('sha1').update(raw).digest('base64')}`;
    let payload = this.payloads.get(key);
    if (!payload) {
      // Chunk sections compress well (palettes, runs of air): ~5–10× less memory.
      payload = { key, data: zlib.deflateSync(raw, { level: 1 }), refs: 0 };
      this.payloads.set(key, payload);
      this.bytes += payload.data.length;
    }
    payload.refs++;
    this.refs++;
    return payload;
  }

  release(payload: SharedPayload): void {
    if (payload.refs <= 0 || this.payloads.get(payload.key) !== payload) return;
    payload.refs--;
    this.refs--;
    if (payload.refs === 0) {
      this.payloads.delete(payload.key);
      this.bytes -= payload.data.length;
    }
  }

  stats(): ChunkStoreStats {
    return { payloads: this.payloads.size, bytes: this.bytes, refs: this.refs };
  }
}

/** The process-wide store. */
export const chunkStore = new ChunkStore();
