import { describe, expect, it } from 'vitest';
import prismarineBlock from 'prismarine-block';
import prismarineRegistry from 'prismarine-registry';
import { hasLegacyShape, legacyShapes, stairBoxes, stairShape, type LegacyNeighbor } from '../src/legacyShapes.js';

/** Which of the 16³ sub-voxels the boxes fill (to compare shapes however they're split). */
function voxels(boxes: number[][]): string {
  const out: number[] = [];
  for (let x = 0; x < 16; x++)
    for (let y = 0; y < 16; y++)
      for (let z = 0; z < 16; z++) {
        const [px, py, pz] = [(x + 0.5) / 16, (y + 0.5) / 16, (z + 0.5) / 16];
        out.push(boxes.some((b) => px > b[0]! && px < b[3]! && py > b[1]! && py < b[4]! && pz > b[2]! && pz < b[5]!) ? 1 : 0);
      }
  return out.join('');
}

const Block = prismarineBlock(prismarineRegistry('1.13.2') as never) as unknown as { fromProperties(name: string, props: Record<string, unknown>, biome: number): { shapes: number[][] } };

describe('legacy (1.8–1.12) neighbour shapes', () => {
  it('builds every stair shape like the game', () => {
    for (const facing of ['north', 'south', 'east', 'west'] as const)
      for (const top of [false, true])
        for (const shape of ['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right'] as const) {
          const modern = Block.fromProperties('oak_stairs', { facing, half: top ? 'top' : 'bottom', shape, waterlogged: false }, 0).shapes;
          expect(voxels(stairBoxes(facing, top, shape)), `${facing} ${top ? 'top' : 'bottom'} ${shape}`).toBe(voxels(modern));
        }
  });

  it('works out stair corners from the neighbours', () => {
    const stair = (meta: number): LegacyNeighbor => ({ name: 'oak_stairs', metadata: meta, shapes: [] });
    // A north-facing stair (3) with an east-facing one (0) behind it (north): an outer corner.
    expect(stairShape({ facing: 'north', top: false }, (dx, _dy, dz) => (dx === 0 && dz === -1 ? stair(0) : null))).toBe('outer_right');
    // ...with a west-facing one in front of it (south): an inner corner.
    expect(stairShape({ facing: 'north', top: false }, (dx, _dy, dz) => (dx === 0 && dz === 1 ? stair(1) : null))).toBe('inner_left');
    // Different halves never join.
    expect(stairShape({ facing: 'north', top: true }, (dx, _dy, dz) => (dx === 0 && dz === -1 ? stair(0) : null))).toBe('straight');
  });

  it('joins fences, panes and walls to their neighbours', () => {
    const stone: LegacyNeighbor = { name: 'stone', metadata: 0, shapes: [[0, 0, 0, 1, 1, 1]] };
    const glass: LegacyNeighbor = { name: 'glass', metadata: 0, shapes: [[0, 0, 0, 1, 1, 1]] };
    const eastStone = (dx: number, _dy: number, dz: number) => (dx === 1 && dz === 0 ? stone : null);
    expect(legacyShapes('fence', 0, eastStone)).toEqual([[0.375, 0, 0.375, 1, 1.5, 0.625]]);
    expect(legacyShapes('fence', 0, () => null)).toEqual([[0.375, 0, 0.375, 0.625, 1.5, 0.625]]);
    // Fences don't join glass; panes do.
    expect(legacyShapes('fence', 0, (dx, _y, dz) => (dx === 1 && dz === 0 ? glass : null))).toEqual([[0.375, 0, 0.375, 0.625, 1.5, 0.625]]);
    expect(legacyShapes('glass_pane', 0, (dx, _y, dz) => (dx === 1 && dz === 0 ? glass : null))).toEqual([[0.5, 0, 0.4375, 1, 1, 0.5625]]);
    // A lone pane is a cross.
    expect(legacyShapes('iron_bars', 0, () => null)).toEqual([[0, 0, 0.4375, 1, 1, 0.5625], [0.4375, 0, 0, 0.5625, 1, 1]]);
    expect(legacyShapes('cobblestone_wall', 0, eastStone)).toEqual([[0.25, 0, 0.25, 1, 1.5, 0.75]]);
    expect(hasLegacyShape('stone')).toBe(false);
    expect(hasLegacyShape('spruce_stairs')).toBe(true);
  });
});
