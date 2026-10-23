// The bot's own status effects, movement-speed attribute and experience. Physics reads them (speed,
// jump boost, slow falling, levitation) and so does dig time (haste, mining fatigue). Effect and
// attribute packets of other entities are dropped before decoding.
import type { PosseBot } from '../bot.js';
import { readVarInt } from '../decode.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol packets are untyped JSON */

export interface Effect {
  id: number;
  amplifier: number;
  duration: number;
}

export interface AttributeModifier {
  uuid: string;
  amount: number;
  /** 0 add, 1 multiply base, 2 multiply total. */
  operation: number;
}

/** The sprint modifier the game adds to movement speed (prismarine-physics adds its own). */
const SPRINT_UUID = '662a6b8d-da3e-4c1c-8813-96ea6097278d';
const OPERATIONS: Record<string, number> = { add_value: 0, add_multiplied_base: 1, add_multiplied_total: 2 };

/** Normalizes an attribute key across versions (`generic.movementSpeed`, `minecraft:movement_speed`…). */
export function attributeName(key: unknown): string {
  return String(key ?? '')
    .replace(/^minecraft:/, '')
    .replace(/^(generic|player)\./, '')
    .replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Modifiers in prismarine-physics' shape, without the sprint modifier (physics applies its own). */
export function normalizeModifiers(modifiers: any[] | undefined): AttributeModifier[] {
  const out: AttributeModifier[] = [];
  for (const m of modifiers ?? []) {
    const id = String(m.uuid ?? m.id ?? '');
    if (id === SPRINT_UUID || id.endsWith('sprinting')) continue;
    const operation = typeof m.operation === 'string' ? (OPERATIONS[m.operation] ?? 0) : Number(m.operation ?? 0);
    out.push({ uuid: id, amount: Number(m.amount ?? 0), operation });
  }
  return out;
}

export function installEffects(bot: PosseBot): void {
  const client = bot._client as any;
  const registry = bot.registry as any;
  // prismarine-physics looks the movement speed attribute up under this version's resource name.
  const speedKey: string | undefined = registry.attributesByName?.movementSpeed?.resource;

  const isSelf = (buffer: Buffer, offset: number): boolean => readVarInt(buffer, offset)?.value === bot.entity?.id;
  for (const name of ['entity_effect', 'remove_entity_effect', 'entity_update_attributes', 'update_attributes']) {
    bot.decoding.setFilter(name, isSelf);
  }

  const self = (): any => (bot.entity ? Object.assign(bot.entity as any, { effects: (bot.entity as any).effects ?? {} }) : null);

  client.on('entity_effect', (packet: any) => {
    const entity = self();
    if (!entity || packet.entityId !== entity.id) return;
    const effect: Effect = { id: packet.effectId, amplifier: packet.amplifier, duration: packet.duration };
    entity.effects[effect.id] = effect;
    bot.emit('entityEffect', bot.entity, effect);
  });
  client.on('remove_entity_effect', (packet: any) => {
    const entity = self();
    if (!entity || packet.entityId !== entity.id) return;
    const effect: Effect = entity.effects[packet.effectId] ?? { id: packet.effectId, amplifier: -1, duration: -1 };
    delete entity.effects[packet.effectId];
    bot.emit('entityEffectEnd', bot.entity, effect);
  });

  const onAttributes = (packet: any): void => {
    const entity = self();
    if (!entity || packet.entityId !== entity.id || !speedKey) return;
    for (const prop of packet.properties ?? []) {
      if (attributeName(prop.key ?? prop.name) !== 'movement_speed') continue;
      entity.attributes ??= {};
      entity.attributes[speedKey] = { value: prop.value, modifiers: normalizeModifiers(prop.modifiers) };
    }
  };
  client.on('entity_update_attributes', onAttributes);
  client.on('update_attributes', onAttributes); // 1.8

  client.on('experience', (packet: any) => {
    bot.experience.level = packet.level;
    bot.experience.points = packet.totalExperience;
    bot.experience.progress = packet.experienceBar;
    bot.emit('experience');
  });

  // A respawn (death or new dimension) clears effects, like the game.
  client.on('respawn', () => {
    const entity = bot.entity as any;
    if (entity) entity.effects = {};
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
