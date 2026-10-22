// V8 .cpuprofile summary: self time per function and per package (mineflayer, minecraft-protocol,
// protodef, prismarine-*, node internals…).
//
//   tsx bench/cpuProfile.ts <file.cpuprofile> [--top 25]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
}

export interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export interface FunctionTime {
  name: string;
  pkg: string;
  location: string;
  selfMs: number;
  percent: number;
}

export interface ProfileSummary {
  totalMs: number;
  /** Time not spent idle (what the process actually burned). */
  busyMs: number;
  packages: Array<{ pkg: string; selfMs: number; percent: number }>;
  functions: FunctionTime[];
}

/** Package a frame belongs to (by URL; protodef's eval'd compiled codecs have no URL). */
export function packageOf(frame: CallFrame): string {
  const { url, functionName } = frame;
  if (functionName === '(idle)') return '(idle)';
  if (functionName === '(garbage collector)') return '(gc)';
  if (functionName === '(program)' || functionName === '(root)') return '(program)';
  if (!url) {
    // Eval'd code with a real position = protodef's compiled readers/writers.
    return frame.lineNumber >= 0 ? 'protodef (compiled)' : 'node internals';
  }
  if (url.startsWith('node:')) return 'node internals';
  const m = url.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g);
  if (m) {
    const last = m[m.length - 1].replace(/^node_modules\//, '').replace(/\/$/, '');
    return last;
  }
  if (url.includes('/src/')) return 'posse';
  if (url.includes('/bench/')) return 'bench harness';
  return 'other';
}

/** Coarser grouping for the report: prismarine-* together, the rest as is. */
export function groupOf(pkg: string): string {
  if (pkg.startsWith('prismarine-')) return 'prismarine-*';
  return pkg;
}

export function summarizeProfile(profile: CpuProfile, top = 25): ProfileSummary {
  const selfUs = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  const byFn = new Map<string, FunctionTime>();
  const byPkg = new Map<string, number>();
  let total = 0;
  let idle = 0;
  for (const node of profile.nodes) {
    const us = selfUs.get(node.id) ?? 0;
    if (!us) continue;
    const f = node.callFrame;
    const pkg = packageOf(f);
    total += us;
    if (pkg === '(idle)') {
      idle += us;
      continue;
    }
    const file = f.url
      ? f.url.replace(/^.*node_modules\//, '').replace(/^file:\/\/.*\/(src|scripts)\//, '$1/')
      : '';
    const location = file
      ? `${file}:${f.lineNumber + 1}`
      : f.lineNumber >= 0
        ? `(eval):${f.lineNumber + 1}`
        : '(native)';
    const key = `${f.functionName}@${location}`;
    const entry = byFn.get(key) ?? {
      name: f.functionName || '(anonymous)',
      pkg,
      location,
      selfMs: 0,
      percent: 0,
    };
    entry.selfMs += us / 1000;
    byFn.set(key, entry);
    byPkg.set(groupOf(pkg), (byPkg.get(groupOf(pkg)) ?? 0) + us / 1000);
  }
  const busyMs = (total - idle) / 1000;
  const pct = (ms: number): number => (busyMs ? (ms / busyMs) * 100 : 0);
  const functions = [...byFn.values()]
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, top)
    .map((f) => ({ ...f, selfMs: round(f.selfMs), percent: round(pct(f.selfMs)) }));
  const packages = [...byPkg.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([pkg, ms]) => ({ pkg, selfMs: round(ms), percent: round(pct(ms)) }));
  return { totalMs: round(total / 1000), busyMs: round(busyMs), packages, functions };
}

const round = (n: number): number => Math.round(n * 10) / 10;

export function formatSummary(s: ProfileSummary): string {
  const lines: string[] = [];
  lines.push(
    `CPU profile: ${s.busyMs} ms busy of ${s.totalMs} ms sampled (percentages are of busy time)`,
  );
  lines.push('');
  lines.push('Self time by package:');
  for (const p of s.packages)
    lines.push(
      `  ${p.percent.toFixed(1).padStart(5)}%  ${String(p.selfMs).padStart(9)} ms  ${p.pkg}`,
    );
  lines.push('');
  lines.push(`Top ${s.functions.length} functions by self time:`);
  s.functions.forEach((f, i) => {
    lines.push(
      `  ${String(i + 1).padStart(2)}. ${f.percent.toFixed(1).padStart(5)}%  ${String(f.selfMs).padStart(8)} ms  [${f.pkg}] ${f.name}  ${f.location}`,
    );
  });
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: tsx bench/cpuProfile.ts <file.cpuprofile> [--top N]');
    process.exit(1);
  }
  const i = process.argv.indexOf('--top');
  const top = i > 0 ? Number(process.argv[i + 1]) : 25;
  const profile = JSON.parse(readFileSync(file, 'utf8')) as CpuProfile;
  console.log(formatSummary(summarizeProfile(profile, top)));
}
