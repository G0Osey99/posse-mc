// Feeds the lazy world (../world.ts) from chunk and block packets. Chunks outside the keep radius
// are dropped by a peek at their coordinates, before decoding; light packets are never listened to.
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */

/** `map_chunk` starts with the column's x and z as big-endian i32 in every version. */
export function chunkCoordFilter(wants: (x: number, z: number) => boolean): (buffer: Buffer, offset: number) => boolean {
  return (buffer, offset) => {
    if (buffer.length < offset + 8) return true;
    return wants(buffer.readInt32BE(offset), buffer.readInt32BE(offset + 4));
  };
}

function onesInShort(n: number): number {
  let count = 0;
  for (let i = 0; i < 16; i++) if (n & (1 << i)) count++;
  return count;
}

export function installWorld(bot: PosseBot): void {
  const client = bot._client as any;
  const sf = bot.supportFeature;
  const world = bot.world;

  // 1.20.2+: the server waits for each chunk batch to be acknowledged before sending more.
  let batchStart = 0;
  let average = 2;
  let weight = 1;
  client.on('chunk_batch_start', () => (batchStart = Date.now()));
  client.on('chunk_batch_finished', (packet: any) => {
    const perChunk = (Date.now() - batchStart) / Math.max(1, packet.batchSize);
    const clamped = Math.min(Math.max(perChunk, average / 3), average * 3);
    average = (average * weight + clamped) / (weight + 1);
    weight = Math.min(49, weight + 1);
    client.write('chunk_batch_received', { chunksPerTick: 7 / average });
  });

  if (world.radius <= 0) return;

  bot.decoding.setFilter('map_chunk', chunkCoordFilter((x, z) => world.wants(x, z)));

  const loaded = (x: number, z: number): void => {
    if (bot.listenerCount('chunkColumnLoad') > 0) bot.emit('chunkColumnLoad', new Vec3(x * 16, 0, z * 16));
  };

  client.on('map_chunk', (packet: any) => {
    const added = world.addLoad(packet.x, packet.z, {
      // A copy: the decoded field is a view into the whole packet, light data included.
      data: Buffer.from(packet.chunkData),
      bitMap: packet.bitMap,
      skyLightSent: bot.game.dimension === 'overworld',
      groundUp: packet.groundUp,
      biomes: packet.biomes,
    });
    if (added) loaded(packet.x, packet.z);
  });

  client.on('map_chunk_bulk', (packet: any) => {
    let offset = 0;
    for (const meta of packet.meta) {
      const sections = onesInShort(meta.bitMap);
      const size = (8192 + (packet.skyLightSent ? 2048 : 0)) * sections + 2048 * sections + 256;
      const added = world.addLoad(meta.x, meta.z, {
        data: Buffer.from(packet.data.subarray(offset, offset + size)),
        bitMap: meta.bitMap,
        skyLightSent: packet.skyLightSent,
        groundUp: true,
      });
      if (added) loaded(meta.x, meta.z);
      offset += size;
    }
  });

  client.on('unload_chunk', (packet: any) => {
    world.unload(packet.chunkX, packet.chunkZ);
    if (bot.listenerCount('chunkColumnUnload') > 0) bot.emit('chunkColumnUnload', new Vec3(packet.chunkX * 16, 0, packet.chunkZ * 16));
  });

  const change = (x: number, y: number, z: number, stateId: number): void => {
    const wantsUpdate = bot.listenerCount('blockUpdate') > 0;
    const old = world.setStateId(x, y, z, stateId, wantsUpdate);
    if (!wantsUpdate || old === null) return;
    const oldBlock = old === undefined ? null : world.makeBlock(old, x, y, z);
    bot.emit('blockUpdate', oldBlock, world.makeBlock(stateId, x, y, z));
  };

  client.on('block_change', (packet: any) => change(packet.location.x, packet.location.y, packet.location.z, packet.type));

  client.on('multi_block_change', (packet: any) => {
    const longs = sf('usesMultiblockSingleLong');
    const base = sf('usesMultiblock3DChunkCoords')
      ? { x: packet.chunkCoordinates.x * 16, y: packet.chunkCoordinates.y * 16, z: packet.chunkCoordinates.z * 16 }
      : { x: packet.chunkX * 16, y: 0, z: packet.chunkZ * 16 };
    for (const record of packet.records) {
      if (longs) {
        // Records are varlongs: state << 12 | x << 8 | z << 4 | y. JS bit ops keep the low 32 bits.
        const value = typeof record === 'bigint' ? record : BigInt(record);
        const low = Number(value & 0xfffn);
        change(base.x + ((low >> 8) & 15), base.y + (low & 15), base.z + ((low >> 4) & 15), Number(value >> 12n));
      } else {
        change(base.x + ((record.horizontalPos >> 4) & 15), record.y, base.z + (record.horizontalPos & 15), record.blockId);
      }
    }
  });

  client.on('explosion', (packet: any) => {
    if (bot.listenerCount('explosion') > 0) {
      const c = packet.center ?? packet;
      bot.emit('explosion', {
        position: new Vec3(c.x, c.y, c.z),
        ...(packet.radius !== undefined ? { radius: packet.radius } : {}),
        ...(packet.affectedBlockOffsets ? { blockCount: packet.affectedBlockOffsets.length } : packet.blockCount !== undefined ? { blockCount: packet.blockCount } : {}),
      });
    }
    // ≤1.21.2 lists destroyed blocks; later servers send block changes instead.
    for (const o of packet.affectedBlockOffsets ?? []) {
      change(Math.floor(packet.x) + o.x, Math.floor(packet.y) + o.y, Math.floor(packet.z) + o.z, 0);
    }
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
