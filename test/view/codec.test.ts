import { describe, it, expect } from 'vitest';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VERSION_MANIFEST_URL,
  ensureClientJar,
  sha1,
} from '../../src/view/assets/mojang.js';
import { ZipReader } from '../../src/view/assets/zip.js';
import { crc32, decodePng, encodePng, isPng } from '../../src/view/png.js';

/** A minimal zip writer (stored or deflated entries) for the reader tests. */
function makeZip(files: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const body = f.deflate ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(f.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    // A local extra field the central directory does not have (the reader must use the local one).
    const extra = Buffer.from([0xca, 0xfe, 0x00, 0x00]);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(f.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, extra, body);
    centrals.push(central, name);
    offset += 30 + name.length + extra.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('ZipReader', () => {
  const zip = new ZipReader(
    makeZip([
      {
        name: 'assets/minecraft/blockstates/stone.json',
        data: Buffer.from('{"variants":{"":{"model":"block/stone"}}}'),
        deflate: true,
      },
      { name: 'assets/minecraft/textures/block/raw.bin', data: Buffer.from([1, 2, 3, 4]) },
      { name: 'pack.mcmeta', data: Buffer.from('not json') },
    ]),
  );

  it('lists entries under a prefix', () => {
    expect(zip.list('assets/minecraft/')).toEqual([
      'assets/minecraft/blockstates/stone.json',
      'assets/minecraft/textures/block/raw.bin',
    ]);
  });

  it('inflates deflated entries and copies stored ones', () => {
    expect(zip.readJson('assets/minecraft/blockstates/stone.json')).toEqual({
      variants: { '': { model: 'block/stone' } },
    });
    expect([...zip.read('assets/minecraft/textures/block/raw.bin')!]).toEqual([1, 2, 3, 4]);
  });

  it('returns undefined for missing entries and bad json', () => {
    expect(zip.read('nope')).toBeUndefined();
    expect(zip.readJson('pack.mcmeta')).toBeUndefined();
  });

  it('rejects data that is not a zip', () => {
    expect(() => new ZipReader(Buffer.alloc(100))).toThrow(/Not a zip/);
  });
});

describe('PNG codec', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips RGBA and RGB images', () => {
    const data = new Uint8Array(5 * 3 * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 255;
    const img = { width: 5, height: 3, data };
    const rgba = encodePng(img);
    expect(isPng(rgba)).toBe(true);
    expect(decodePng(rgba)).toEqual({ width: 5, height: 3, data });
    const rgb = decodePng(encodePng(img, false));
    for (let i = 0; i < 15; i++) {
      expect([...rgb.data.subarray(i * 4, i * 4 + 3)]).toEqual([
        ...data.subarray(i * 4, i * 4 + 3),
      ]);
      expect(rgb.data[i * 4 + 3]).toBe(255);
    }
  });

  it('decodes palette images with transparency', () => {
    // 2×1, 8-bit palette: index 0 = red (opaque), 1 = green (alpha 0).
    const chunk = (kind: string, body: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(kind, 4, 'latin1');
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'latin1'), body])), 0);
      return Buffer.concat([head, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 3;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0])),
      chunk('tRNS', Buffer.from([255, 0])),
      chunk('IDAT', deflateSync(Buffer.from([0, 0, 1]))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect([...decodePng(png).data]).toEqual([255, 0, 0, 255, 0, 255, 0, 0]);
  });

  it('rejects non-PNG data', () => {
    expect(() => decodePng(Buffer.from('hello world'))).toThrow();
  });
});

describe('client jar download', () => {
  const jar = Buffer.from('pretend this is a jar');
  const files: Record<string, Buffer> = {};
  const versionJson = Buffer.from(
    JSON.stringify({
      downloads: {
        client: {
          url: 'https://piston-data.mojang.com/v1/objects/abc/client.jar',
          sha1: sha1(jar),
          size: jar.length,
        },
      },
    }),
  );
  files['https://piston-meta.mojang.com/v1/packages/x/1.18.2.json'] = versionJson;
  files[VERSION_MANIFEST_URL] = Buffer.from(
    JSON.stringify({
      versions: [
        {
          id: '1.18.2',
          url: 'https://piston-meta.mojang.com/v1/packages/x/1.18.2.json',
          sha1: sha1(versionJson),
        },
      ],
    }),
  );
  files['https://piston-data.mojang.com/v1/objects/abc/client.jar'] = jar;
  const fetched: string[] = [];
  const fakeFetch = (async (url: string) => {
    fetched.push(url);
    const body = files[url];
    return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;

  it('downloads, verifies and caches the jar; later calls read the cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'posse-jar-'));
    try {
      const [a, b] = await Promise.all([
        ensureClientJar('1.18.2', dir, { fetch: fakeFetch }),
        ensureClientJar('1.18.2', dir, { fetch: fakeFetch }),
      ]);
      expect(a.equals(jar) && b.equals(jar)).toBe(true);
      expect(fetched.filter((u) => u.endsWith('client.jar'))).toHaveLength(1);
      const again = await ensureClientJar('1.18.2', dir, { allowDownload: false });
      expect(again.equals(jar)).toBe(true);
      await expect(ensureClientJar('1.99', dir, { fetch: fakeFetch })).rejects.toThrow(
        /not in Mojang's manifest/,
      );
      await expect(ensureClientJar('1.20', dir, { allowDownload: false })).rejects.toThrow(
        /downloads are off/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a jar whose sha1 does not match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'posse-jar-'));
    const bad = (async (url: string) =>
      url.endsWith('client.jar')
        ? new Response(new Uint8Array(Buffer.from('tampered')))
        : fakeFetch(url)) as unknown as typeof fetch;
    try {
      await expect(ensureClientJar('1.18.2', dir, { fetch: bad })).rejects.toThrow(/sha1 mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
