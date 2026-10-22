// Angle and velocity conversions between the protocol (Notch degrees / bytes) and mineflayer's
// convention (radians, yaw 0 = north), which prismarine-physics and mineflayer code use.
import { Vec3 } from 'vec3';

const PI = Math.PI;
const PI_2 = Math.PI * 2;
const TO_RAD = PI / 180;
const FROM_NOTCH_BYTE = 360 / 256;
const FROM_NOTCH_VEL = 1 / 8000;

export const euclideanMod = (n: number, m: number): number => ((n % m) + m) % m;
export const toRadians = (degrees: number): number => degrees * TO_RAD;
export const toDegrees = (radians: number): number => radians / TO_RAD;

export const fromNotchianYaw = (yaw: number): number => euclideanMod(PI - toRadians(yaw), PI_2);
export const fromNotchianPitch = (pitch: number): number => euclideanMod(toRadians(-pitch) + PI, PI_2) - PI;
export const toNotchianYaw = (yaw: number): number => toDegrees(PI - yaw);
export const toNotchianPitch = (pitch: number): number => toDegrees(-pitch);
export const fromNotchianYawByte = (yaw: number): number => fromNotchianYaw(yaw * FROM_NOTCH_BYTE);
export const fromNotchianPitchByte = (pitch: number): number => fromNotchianPitch(pitch * FROM_NOTCH_BYTE);
export const fromNotchVelocity = (v: { x: number; y: number; z: number }): Vec3 =>
  new Vec3(v.x * FROM_NOTCH_VEL, v.y * FROM_NOTCH_VEL, v.z * FROM_NOTCH_VEL);
