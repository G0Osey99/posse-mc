// Ray casts through the lazy world: the block (and face) the bot looks at, line of sight to a block,
// and the entity at the crosshair. Voxel stepping and box intersection follow prismarine-world's
// RaycastIterator (MIT).
import { Vec3 } from 'vec3';
import type { PosseBot } from '../bot.js';
import type { Block, Entity } from '../types.js';

/** A block hit by a ray: which face, and where. */
export type RaycastBlock = Block & { face: number; intersect: Vec3 };

type Shape = readonly number[];

/** Blocks without collision that the crosshair still hits (grass, flowers, torches…): a full cube is close enough. */
const FULL_CUBE: Shape[] = [[0, 0, 0, 1, 1, 1]];

/** Shapes a ray can hit: collision shapes, or a cube for solid-looking blocks without collision. */
export function targetShapes(block: Block): Shape[] {
  if (block.shapes.length > 0) return block.shapes as Shape[];
  if (block.type === 0 || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return [];
  if (block.name === 'water' || block.name === 'lava' || block.name === 'bubble_column' || block.name.startsWith('flowing_')) return [];
  if (block.name === 'light' || block.name === 'structure_void' || block.name === 'barrier') return [];
  return FULL_CUBE;
}

/** Faces by step direction: the face a ray enters through. */
const enter = (step: number, positive: number, negative: number): number => (step > 0 ? positive : negative);

/**
 * Intersects a ray with boxes at `offset`. Returns the distance along the ray and the face hit, or
 * null. `dir` must be normalized for the distance to be in blocks.
 */
export function intersectShapes(origin: Vec3, dir: Vec3, shapes: Shape[], offset: { x: number; y: number; z: number }): { t: number; face: number } | null {
  const inv = (d: number): number => (d === 0 ? Number.MAX_VALUE : 1 / d);
  const ix = inv(dir.x);
  const iy = inv(dir.y);
  const iz = inv(dir.z);
  const px = origin.x - offset.x;
  const py = origin.y - offset.y;
  const pz = origin.z - offset.z;
  let best = Number.MAX_VALUE;
  let bestFace = -1;
  for (const s of shapes) {
    let tmin = ((ix > 0 ? s[0]! : s[3]!) - px) * ix;
    let tmax = ((ix > 0 ? s[3]! : s[0]!) - px) * ix;
    let face = enter(Math.sign(dir.x), 4, 5); // west / east
    const tymin = ((iy > 0 ? s[1]! : s[4]!) - py) * iy;
    const tymax = ((iy > 0 ? s[4]! : s[1]!) - py) * iy;
    if (tmin > tymax || tymin > tmax) continue;
    if (tymin > tmin) {
      tmin = tymin;
      face = enter(Math.sign(dir.y), 0, 1); // bottom / top
    }
    if (tymax < tmax) tmax = tymax;
    const tzmin = ((iz > 0 ? s[2]! : s[5]!) - pz) * iz;
    const tzmax = ((iz > 0 ? s[5]! : s[2]!) - pz) * iz;
    if (tmin > tzmax || tzmin > tmax) continue;
    if (tzmin > tmin) {
      tmin = tzmin;
      face = enter(Math.sign(dir.z), 2, 3); // north / south
    }
    if (tzmax < tmax) tmax = tzmax;
    if (tmax < 0) continue; // behind the origin
    if (tmin < best) {
      best = Math.max(tmin, 0);
      bestFace = face;
    }
  }
  return bestFace === -1 ? null : { t: best, face: bestFace };
}

/** Voxels a ray crosses, in order, up to `maxDistance`. */
export function* traverseVoxels(origin: Vec3, dir: Vec3, maxDistance: number): Generator<Vec3> {
  const pos = new Vec3(Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z));
  const stepX = Math.sign(dir.x);
  const stepY = Math.sign(dir.y);
  const stepZ = Math.sign(dir.z);
  const delta = (d: number): number => (d === 0 ? Number.MAX_VALUE : Math.abs(1 / d));
  const first = (p: number, o: number, d: number): number => (d === 0 ? Number.MAX_VALUE : Math.abs((p + (d > 0 ? 1 : 0) - o) / d));
  const dx = delta(dir.x);
  const dy = delta(dir.y);
  const dz = delta(dir.z);
  let tx = first(pos.x, origin.x, dir.x);
  let ty = first(pos.y, origin.y, dir.y);
  let tz = first(pos.z, origin.z, dir.z);
  yield pos.clone();
  while (Math.min(tx, ty, tz) <= maxDistance) {
    if (tx < ty && tx < tz) {
      pos.x += stepX;
      tx += dx;
    } else if (ty < tz) {
      pos.y += stepY;
      ty += dy;
    } else {
      pos.z += stepZ;
      tz += dz;
    }
    yield pos.clone();
  }
}

/** Unit view direction for a yaw/pitch in mineflayer's convention. */
export function viewDirection(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return new Vec3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

export interface RaycastApi {
  raycast(from: Vec3, direction: Vec3, maxDistance: number, matcher?: (block: Block) => boolean): RaycastBlock | null;
  blockAtCursor(maxDistance?: number, matcher?: (block: Block) => boolean): RaycastBlock | null;
  entityAtCursor(maxDistance?: number): Entity | null;
  canSeeBlock(block: Block): boolean;
}

export function installRaycast(bot: PosseBot): RaycastApi {
  const raycast: RaycastApi['raycast'] = (from, direction, maxDistance, matcher) => {
    const dir = direction.normalize();
    for (const voxel of traverseVoxels(from, dir, maxDistance)) {
      const block = bot.blockAt(voxel);
      if (!block) return null; // the ray left the kept world
      if (matcher && !matcher(block)) continue;
      const hit = intersectShapes(from, dir, targetShapes(block), voxel);
      if (!hit || hit.t > maxDistance) continue;
      const result = block as RaycastBlock;
      result.face = hit.face;
      result.intersect = from.plus(dir.scaled(hit.t));
      return result;
    }
    return null;
  };

  const eye = (): Vec3 => bot.entity.position.offset(0, (bot.entity as Entity & { eyeHeight?: number }).eyeHeight ?? 1.62, 0);

  const blockAtCursor: RaycastApi['blockAtCursor'] = (maxDistance = 256, matcher) => {
    if (!bot.entity?.position) return null;
    return raycast(eye(), viewDirection(bot.entity.yaw, bot.entity.pitch), maxDistance, matcher);
  };

  const entityAtCursor: RaycastApi['entityAtCursor'] = (maxDistance = 3.5) => {
    if (!bot.entity?.position) return null;
    const origin = eye();
    const dir = viewDirection(bot.entity.yaw, bot.entity.pitch);
    const block = blockAtCursor(maxDistance);
    let best = block ? block.intersect.distanceTo(origin) : maxDistance;
    let target: Entity | null = null;
    for (const entity of Object.values(bot.entities)) {
      if (entity === bot.entity || !entity.position) continue;
      const w = (entity.width ?? 0.6) / 2;
      const hit = intersectShapes(origin, dir, [[-w, 0, -w, w, entity.height ?? 1.8, w]], entity.position);
      if (hit && hit.t < best) {
        best = hit.t;
        target = entity;
      }
    }
    return target;
  };

  /** Whether a straight line from the eyes reaches the block without hitting another one first. */
  const canSeeBlock: RaycastApi['canSeeBlock'] = (block) => {
    const origin = eye();
    const center = block.position.offset(0.5, 0.5, 0.5);
    const hit = raycast(origin, center.minus(origin), origin.distanceTo(center) + 1);
    return hit !== null && hit.position.equals(block.position);
  };

  return { raycast, blockAtCursor, entityAtCursor, canSeeBlock };
}
