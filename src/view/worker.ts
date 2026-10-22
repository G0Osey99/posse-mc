// Runs the kernel off the calling thread. The desktop app loads the engine from memory, so there is
// no worker file on disk: the worker is the kernel's own source text, eval'd. Each worker renders
// one job at a time; packs are posted once per worker and version.
import { Worker } from 'node:worker_threads';
import { posseViewKernel, type ViewKernel } from './kernel.js';
import type { KernelJob, KernelPack, KernelResult } from './kernelTypes.js';

/**
 * A function body that returns a new kernel, built from the kernel's source text. A bundler with
 * keepNames (tsup here) wraps the kernel's nested functions in a name helper that lives in the
 * bundle's module scope, not in the kernel; its (possibly minified) name is read from the call it
 * emits for the `computeLight` declaration and defined in front.
 */
export function kernelSource(): string {
  const src = posseViewKernel.toString();
  const helper = /([A-Za-z_$][\w$]*)\(\s*[A-Za-z_$][\w$]*\s*,\s*["']computeLight["']\s*\)/.exec(
    src,
  )?.[1];
  const prelude = helper
    ? `var ${helper} = (t, n) => { try { Object.defineProperty(t, "name", { value: n, configurable: true }); } catch {} return t; };\n`
    : '';
  return `${prelude}return (${src})();`;
}

/** The worker's source: the kernel plus a message loop. */
export function workerSource(): string {
  return [
    'const { parentPort } = require("node:worker_threads");',
    `const kernel = (() => { ${kernelSource()} })();`,
    'parentPort.on("message", (m) => {',
    '  if (m.type === "pack") { kernel.setPack(m.pack); return; }',
    '  if (m.type === "drop") { kernel.dropPack(m.key); return; }',
    '  try {',
    '    const r = kernel.render(m.job, m.key);',
    '    parentPort.postMessage({ id: m.id, result: r }, [r.rgba.buffer]);',
    '  } catch (err) {',
    '    parentPort.postMessage({ id: m.id, error: String((err && err.stack) || err) });',
    '  }',
    '});',
  ].join('\n');
}

/** A kernel the renderer can call: in a worker, or on the calling thread. */
export interface KernelRunner {
  render(job: KernelJob, pack: KernelPack): Promise<KernelResult>;
  close(): Promise<void>;
}

type Pending = { resolve: (r: KernelResult) => void; reject: (e: Error) => void };

export class WorkerRunner implements KernelRunner {
  private worker: Worker | null = null;
  private readonly sent = new Set<string>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(workerSource(), { eval: true });
    w.unref();
    w.on('message', (m: { id: number; result?: KernelResult; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.result) p.resolve(m.result);
      else p.reject(new Error(m.error ?? 'render failed'));
    });
    const fail = (err: Error): void => {
      // A dead worker loses its packs; the next job starts a new one.
      if (this.worker === w) {
        this.worker = null;
        this.sent.clear();
      }
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    w.on('error', fail);
    w.on('exit', (code) => fail(new Error(`Render worker exited (${code})`)));
    this.worker = w;
    return w;
  }

  render(job: KernelJob, pack: KernelPack): Promise<KernelResult> {
    const w = this.ensure();
    if (!this.sent.has(pack.key)) {
      w.postMessage({ type: 'pack', pack });
      this.sent.add(pack.key);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.ref();
      w.postMessage({ type: 'render', id, job, key: pack.key });
    }).finally(() => {
      if (!this.pending.size) this.worker?.unref();
    }) as Promise<KernelResult>;
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.sent.clear();
    if (w) await w.terminate();
  }
}

export class InlineRunner implements KernelRunner {
  private readonly kernel: ViewKernel = posseViewKernel();

  async render(job: KernelJob, pack: KernelPack): Promise<KernelResult> {
    if (!this.kernel.hasPack(pack.key)) this.kernel.setPack(pack);
    return this.kernel.render(job, pack.key);
  }

  async close(): Promise<void> {}
}
