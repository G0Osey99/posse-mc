// Binary cache file of a built pack, so later runs skip the jar: `PVPK`, u32 format, u32 header
// length, a JSON header (scalars plus the type/offset/length of every typed array and image), then
// the 4-byte aligned blobs. The whole file is deflated.
import { deflateSync, inflateSync } from 'node:zlib';
import type { RgbaImage } from '../png.js';
import type { KernelImage, KernelPack } from '../kernelTypes.js';
import { PACK_FORMAT, type ViewPack } from './pack.js';

type ArrayKind = 'u8' | 'u16' | 'u32' | 'i32' | 'f32';
type Typed = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array;

interface BlobRef {
  kind: ArrayKind;
  offset: number;
  length: number;
}

interface ImageRef {
  width: number;
  height: number;
  blob: BlobRef;
}

interface Header {
  version: string;
  quality: ViewPack['quality'];
  kernel: Record<string, unknown>;
  arrays: Record<string, BlobRef>;
  mips: BlobRef[];
  images: Record<string, ImageRef>;
  sprites: Record<string, ImageRef>;
  items: Record<string, ImageRef>;
  font?: ImageRef;
  fontWidths?: number[];
  blockItems?: string[];
}

const MAGIC = 0x4b505650; // 'PVPK' little-endian
const ARRAY_FIELDS = [
  'texFlags',
  'stateModel',
  'stateFlags',
  'stateLight',
  'stateTint',
  'models',
  'biomeGrass',
  'biomeFoliage',
  'biomeWater',
  'biomeSky',
  'biomeFog',
] as const;
const IMAGE_FIELDS = ['sun', 'moon', 'clouds', 'steve', 'alex'] as const;

const kindOf = (a: Typed): ArrayKind =>
  a instanceof Uint8Array
    ? 'u8'
    : a instanceof Uint16Array
      ? 'u16'
      : a instanceof Uint32Array
        ? 'u32'
        : a instanceof Int32Array
          ? 'i32'
          : 'f32';

export function serializePack(pack: ViewPack): Buffer {
  const blobs: Buffer[] = [];
  let offset = 0;
  const put = (a: Typed): BlobRef => {
    const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    const ref = { kind: kindOf(a), offset, length: a.length };
    blobs.push(b);
    offset += b.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      blobs.push(Buffer.alloc(pad));
      offset += pad;
    }
    return ref;
  };
  const img = (i: RgbaImage | KernelImage): ImageRef => ({
    width: i.width,
    height: i.height,
    blob: put(i.data),
  });
  const k = pack.kernel;
  const header: Header = {
    version: pack.version,
    quality: pack.quality,
    kernel: {
      key: k.key,
      atlasCols: k.atlasCols,
      atlasRows: k.atlasRows,
      waterTex: k.waterTex,
      lavaTex: k.lavaTex,
    },
    arrays: {},
    mips: k.mips.map(put),
    images: {},
    sprites: {},
    items: {},
  };
  for (const f of ARRAY_FIELDS) header.arrays[f] = put(k[f]);
  for (const f of IMAGE_FIELDS) {
    const i = k[f];
    if (i) header.images[f] = img(i);
  }
  for (const [n, i] of Object.entries(pack.hud.sprites)) header.sprites[n] = img(i);
  for (const [n, i] of Object.entries(pack.hud.items)) header.items[n] = img(i);
  if (pack.hud.font) header.font = img(pack.hud.font);
  if (pack.hud.fontWidths) header.fontWidths = pack.hud.fontWidths;
  if (pack.hud.blockItems) header.blockItems = pack.hud.blockItems;
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const head = Buffer.alloc(12);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(PACK_FORMAT, 4);
  head.writeUInt32LE(json.length, 8);
  return deflateSync(Buffer.concat([head, json, ...blobs]), { level: 6 });
}

/** Reads a cached pack; undefined when the file is not a pack of the current format. */
export function deserializePack(file: Buffer): ViewPack | undefined {
  let buf: Buffer;
  try {
    buf = inflateSync(file);
  } catch {
    return undefined;
  }
  if (buf.length < 12 || buf.readUInt32LE(0) !== MAGIC || buf.readUInt32LE(4) !== PACK_FORMAT)
    return undefined;
  const jsonLen = buf.readUInt32LE(8);
  const header = JSON.parse(buf.toString('utf8', 12, 12 + jsonLen)) as Header;
  const base = 12 + jsonLen;
  const get = (r: BlobRef): Typed => {
    const bytes = r.length * (r.kind === 'u8' ? 1 : r.kind === 'u16' ? 2 : 4);
    // Copy, so every typed array is aligned and owns its buffer (cheap to post to workers).
    const ab = buf.buffer.slice(
      buf.byteOffset + base + r.offset,
      buf.byteOffset + base + r.offset + bytes,
    );
    switch (r.kind) {
      case 'u8':
        return new Uint8Array(ab);
      case 'u16':
        return new Uint16Array(ab);
      case 'u32':
        return new Uint32Array(ab);
      case 'i32':
        return new Int32Array(ab);
      default:
        return new Float32Array(ab);
    }
  };
  const img = (r: ImageRef): RgbaImage => ({
    width: r.width,
    height: r.height,
    data: get(r.blob) as Uint8Array,
  });
  const kernel = {
    ...(header.kernel as Pick<
      KernelPack,
      'key' | 'atlasCols' | 'atlasRows' | 'waterTex' | 'lavaTex'
    >),
    mips: header.mips.map((m) => get(m) as Uint8Array),
  } as KernelPack;
  const writable = kernel as unknown as Record<string, unknown>;
  for (const f of ARRAY_FIELDS) writable[f] = get(header.arrays[f]);
  for (const f of IMAGE_FIELDS) if (header.images[f]) writable[f] = img(header.images[f]);
  const sprites: Record<string, RgbaImage> = {};
  for (const [n, r] of Object.entries(header.sprites)) sprites[n] = img(r);
  const items: Record<string, RgbaImage> = {};
  for (const [n, r] of Object.entries(header.items)) items[n] = img(r);
  return {
    version: header.version,
    quality: header.quality,
    kernel,
    hud: {
      sprites,
      items,
      ...(header.font ? { font: img(header.font) } : {}),
      ...(header.fontWidths ? { fontWidths: header.fontWidths } : {}),
      ...(header.blockItems ? { blockItems: header.blockItems } : {}),
    },
  };
}
