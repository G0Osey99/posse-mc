// Schema-driven packet builder for the fake server: walks a version's protodef schema (from
// minecraft-data) and fills every field the caller left out with a neutral default, so one
// "semantic" packet object works across versions. Text values (`txt()`) are written as JSON
// strings or NBT components, whichever the field's type is in that version.
import nbt from 'prismarine-nbt';

type Spec = string | [string, unknown];
type Obj = Record<string, unknown>;

interface Protocol {
  types: Record<string, unknown>;
  play: { toClient: { types: Record<string, unknown> } };
}

/** A chat component that becomes a JSON string or an NBT compound depending on the field type. */
export class Text {
  constructor(readonly json: Obj) {}
}

export const txt = (text: string | Obj): Text =>
  new Text(typeof text === 'string' ? { text } : text);

/** A plain JSON component → prismarine-nbt compound (the 1.20.3+ text format). */
export function componentToNbt(json: unknown): unknown {
  if (typeof json === 'string') return nbt.comp({ text: nbt.string(json) });
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json as Obj)) {
    if (typeof v === 'string') out[k] = nbt.string(v);
    else if (typeof v === 'boolean') out[k] = nbt.byte(v ? 1 : 0);
    else if (typeof v === 'number') out[k] = nbt.int(v);
    else if (Array.isArray(v)) {
      const items = v.map((e) => (componentToNbt(e) as { value: Obj }).value);
      out[k] = nbt.list(nbt.comp(items as never));
    } else if (v && typeof v === 'object') out[k] = componentToNbt(v);
  }
  return nbt.comp(out as never);
}

const NUMERIC = new Set([
  'varint',
  'u8',
  'u16',
  'u32',
  'i8',
  'i16',
  'i32',
  'f32',
  'f64',
  'varlong',
]);
const BIG = new Set(['i64', 'u64']);

export class PacketFiller {
  private readonly playTypes: Record<string, unknown>;
  private readonly types: Record<string, unknown>;

  /** Packet name → its type name (shared packets are `packet_common_*` from 1.20.5). */
  private readonly typeOf = new Map<string, string>();

  constructor(protocol: Protocol) {
    this.playTypes = protocol.play.toClient.types;
    this.types = protocol.types;
    const packet = this.playTypes.packet as [string, Array<{ name: string; type: [string, { fields?: Record<string, string> }] }>] | undefined;
    const fields = packet?.[1]?.find((f) => f.name === 'params')?.type?.[1]?.fields ?? {};
    for (const [name, type] of Object.entries(fields)) this.typeOf.set(name, type);
  }

  private spec(name: string): Spec | undefined {
    return (this.playTypes[this.typeOf.get(name) ?? `packet_${name}`] ?? this.types[this.typeOf.get(name) ?? '']) as Spec | undefined;
  }

  has(name: string): boolean {
    return this.spec(name) !== undefined;
  }

  /** Field names of a packet (top-level), or null when the version has no such packet. */
  fields(name: string): string[] | null {
    const spec = this.spec(name);
    if (!spec) return null;
    const resolved = this.resolve(spec);
    if (!Array.isArray(resolved) || resolved[0] !== 'container') return [];
    return (resolved[1] as Array<{ name?: string }>).flatMap((f) => (f.name ? [f.name] : []));
  }

  /** The resolved type of a packet's top-level field (undefined when absent). */
  fieldType(name: string, field: string): Spec | undefined {
    const spec = this.spec(name);
    if (!spec) return undefined;
    const resolved = this.resolve(spec);
    if (!Array.isArray(resolved) || resolved[0] !== 'container') return undefined;
    const f = (resolved[1] as Array<{ name?: string; type: Spec }>).find((x) => x.name === field);
    return f ? this.resolve(f.type) : undefined;
  }

  fieldIsArray(name: string, field: string): boolean {
    const t = this.fieldType(name, field);
    return Array.isArray(t) && t[0] === 'array';
  }

  /** Fills a play-state clientbound packet. Throws when the version has no such packet. */
  packet(name: string, params: Obj = {}): Obj {
    const spec = this.spec(name);
    if (!spec) throw new Error(`No clientbound packet ${name} in this version`);
    return this.fill(spec, params, []) as Obj;
  }

  private resolve(spec: Spec): Spec {
    let s = spec;
    for (let i = 0; i < 20 && typeof s === 'string'; i++) {
      const next = (this.playTypes[s] ?? this.types[s]) as Spec | undefined;
      if (next === undefined || next === 'native') return s;
      s = next;
    }
    return s;
  }

  private fill(spec: Spec, value: unknown, stack: Obj[]): unknown {
    if (typeof spec === 'string' && (spec === 'string' || spec === 'pstring')) {
      return this.leafString(value);
    }
    if (typeof spec === 'string' && /^(anonymousNbt|nbt)$/.test(spec)) return this.leafNbt(value);
    if (typeof spec === 'string' && /^(anonOptionalNbt|optionalNbt)$/.test(spec)) {
      return value === undefined ? undefined : this.leafNbt(value);
    }
    const s = this.resolve(spec);
    if (typeof s === 'string') return this.leaf(s, value);
    const [head, args] = s as [string, Obj];
    switch (head) {
      case 'container': {
        const out: Obj = {};
        const src = (value ?? {}) as Obj;
        stack.push(out);
        for (const f of args as unknown as Array<{ name?: string; anon?: boolean; type: Spec }>) {
          if (f.anon || !f.name) {
            const merged = this.fill(f.type, src, stack);
            if (merged && typeof merged === 'object') Object.assign(out, merged);
          } else {
            out[f.name] = this.fill(f.type, src[f.name], stack);
          }
        }
        stack.pop();
        return out;
      }
      case 'switch': {
        const key = this.compareValue(args.compareTo as string, stack);
        const fields = args.fields as Record<string, Spec>;
        const branch = key !== undefined && key in fields ? fields[key] : (args.default as Spec);
        if (branch === undefined || branch === 'void') return undefined;
        return this.fill(branch, value, stack);
      }
      case 'option':
        return value === undefined || value === null
          ? undefined
          : this.fill(args as unknown as Spec, value, stack);
      case 'array':
        return Array.isArray(value) ? value.map((v) => this.fill(args.type as Spec, v, stack)) : [];
      case 'mapper': {
        // Numeric values are mapped to their name (the form protodef writes).
        const mappings = args.mappings as Record<string, unknown>;
        if (typeof value === 'number' && String(value) in mappings) return mappings[String(value)];
        if (value !== undefined) return value;
        return Object.values(mappings)[0];
      }
      case 'bitflags':
        return value ?? {};
      case 'bitfield': {
        if (value !== undefined) return value;
        const out: Obj = {};
        for (const f of args as unknown as Array<{ name: string }>) out[f.name] = 0;
        return out;
      }
      case 'pstring':
        return this.leafString(value);
      case 'buffer':
        return value ?? Buffer.alloc(0);
      case 'entityMetadataLoop':
      case 'topBitSetTerminatedArray':
        return value ?? [];
      default:
        // Parametrized custom types (registryEntryHolder…): the caller must provide them.
        return value;
    }
  }

  private leaf(type: string, value: unknown): unknown {
    if (value !== undefined) {
      if (value instanceof Text) return JSON.stringify(value.json);
      // A field that became an enum/number in some version gets a neutral value.
      if (NUMERIC.has(type) && typeof value !== 'number')
        return typeof value === 'boolean' ? +value : 0;
      if (BIG.has(type) && typeof value === 'number') return BigInt(Math.trunc(value));
      return value;
    }
    if (NUMERIC.has(type)) return 0;
    if (BIG.has(type)) return 0n;
    if (type === 'bool') return false;
    if (type === 'UUID') return '00000000-0000-0000-0000-000000000000';
    if (type === 'restBuffer' || type === 'buffer') return Buffer.alloc(0);
    if (type === 'void') return undefined;
    if (type === 'lpVec3') return { x: 0, y: 0, z: 0 };
    return undefined;
  }

  private leafString(value: unknown): string {
    if (value instanceof Text) return JSON.stringify(value.json);
    return (value as string | undefined) ?? '';
  }

  private leafNbt(value: unknown): unknown {
    if (value instanceof Text) return componentToNbt(value.json);
    if (typeof value === 'string') return componentToNbt({ text: value });
    return value ?? nbt.comp({});
  }

  /** Resolves a protodef `compareTo` path (`field`, `../field`, `../field/flag`) to a switch key. */
  private compareValue(path: string, stack: Obj[]): string | undefined {
    if (path.startsWith('$')) return undefined;
    const parts = path.split('/');
    let level = stack.length - 1;
    let i = 0;
    while (parts[i] === '..') {
      level--;
      i++;
    }
    let cur: unknown = stack[Math.max(0, level)];
    for (; i < parts.length; i++) cur = (cur as Obj | undefined)?.[parts[i]];
    if (cur === undefined || cur === null) return undefined;
    return String(cur);
  }
}
