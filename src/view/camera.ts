// The camera the kernel renders with, on the calling thread (nametags, tests). Notch angles: yaw 0
// faces +Z (south), 90 faces -X (west); pitch > 0 looks down. The kernel repeats this inline.
import type { ViewScene } from './types.js';

export interface CameraBasis {
  fw: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  /** tan(vertical fov / 2). */
  th: number;
}

export function cameraBasis(cam: ViewScene['camera']): CameraBasis {
  const yaw = (cam.yaw * Math.PI) / 180;
  const pitch = (cam.pitch * Math.PI) / 180;
  const fw: [number, number, number] = [
    -Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  ];
  const right: [number, number, number] = [-Math.cos(yaw), 0, -Math.sin(yaw)];
  const up: [number, number, number] = [
    right[1] * fw[2] - right[2] * fw[1],
    right[2] * fw[0] - right[0] * fw[2],
    right[0] * fw[1] - right[1] * fw[0],
  ];
  return { fw, right, up, th: Math.tan(((cam.fov ?? 70) * Math.PI) / 180 / 2) };
}

/** Screen position (pixels) and view depth of a world point, or null when it is behind the camera. */
export function projectPoint(
  cam: ViewScene['camera'],
  width: number,
  height: number,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; depth: number } | null {
  const b = cameraBasis(cam);
  const px = x - cam.x;
  const py = y - cam.y;
  const pz = z - cam.z;
  const depth = px * b.fw[0] + py * b.fw[1] + pz * b.fw[2];
  if (depth < 0.05) return null;
  const aspect = width / height;
  const sx =
    ((px * b.right[0] + py * b.right[1] + pz * b.right[2]) / depth / (b.th * aspect) + 1) *
    0.5 *
    width;
  const sy = (1 - (px * b.up[0] + py * b.up[1] + pz * b.up[2]) / depth / b.th) * 0.5 * height;
  return { x: sx, y: sy, depth };
}
