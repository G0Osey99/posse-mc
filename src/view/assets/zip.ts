// A minimal ZIP reader for the Mojang client jar: the central directory is read once, entries are
// inflated on demand (stored or deflate only, which is all a jar uses). No zip64: client jars are
// well under 4 GB and 65535 entries.
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the local file header. */
  offset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export class ZipReader {
  readonly entries = new Map<string, ZipEntry>();

  constructor(private readonly buf: Buffer) {
    // The end-of-central-directory record is in the last 22 + 65535 (comment) bytes.
    const min = Math.max(0, buf.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = buf.length - 22; i >= min; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a zip file (no end of central directory)');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG)
        throw new Error('Corrupt zip central directory');
      const method = buf.readUInt16LE(p + 10);
      const compressedSize = buf.readUInt32LE(p + 20);
      const size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const offset = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      if (!name.endsWith('/'))
        this.entries.set(name, { name, method, compressedSize, size, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  /** Entry names under a directory prefix (`assets/minecraft/models/block/`). */
  list(prefix: string): string[] {
    const out: string[] = [];
    for (const name of this.entries.keys()) if (name.startsWith(prefix)) out.push(name);
    return out;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** The entry's bytes, or undefined when it does not exist. */
  read(name: string): Buffer | undefined {
    const e = this.entries.get(name);
    if (!e) return undefined;
    const b = this.buf;
    if (b.readUInt32LE(e.offset) !== LOCAL_SIG)
      throw new Error(`Corrupt zip local header: ${name}`);
    // The local header's own name/extra lengths can differ from the central directory's.
    const start = e.offset + 30 + b.readUInt16LE(e.offset + 26) + b.readUInt16LE(e.offset + 28);
    const data = b.subarray(start, start + e.compressedSize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return inflateRawSync(data);
    throw new Error(`Unsupported zip compression method ${e.method}: ${name}`);
  }

  readText(name: string): string | undefined {
    return this.read(name)?.toString('utf8');
  }

  readJson<T = unknown>(name: string): T | undefined {
    const text = this.readText(name);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }
}
