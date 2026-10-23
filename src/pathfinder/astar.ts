// A* over moves, run in time slices so a search never blocks the event loop for long (a fleet
// shares one thread). The open set is a binary heap with decrease-key; when the search can't reach
// the goal it returns the best partial path, chosen like Baritone (and minecraft-pathfinding) by
// weighing progress against cost at several ratios.

export interface SearchNode {
  /** Unique per position (see `nodeKey`). */
  key: number;
  /** Cost of the move into this node. */
  cost: number;
  parent: SearchNode | null;
}

export type SearchStatus = 'success' | 'partial' | 'timeout' | 'noPath';

export interface SearchResult<N extends SearchNode> {
  status: SearchStatus;
  /** Moves from the start (excluded) to the end node. */
  path: N[];
  cost: number;
  visitedNodes: number;
  generatedNodes: number;
  time: number;
}

/**
 * A number identifying a block position: x and z wrap every 2²¹ blocks (positions that far apart
 * never meet in one search) and y covers ±1024. The packed value stays below 2⁵³, so it's exact.
 */
export function nodeKey(x: number, y: number, z: number): number {
  return ((x & 0x1fffff) * 0x200000 + (z & 0x1fffff)) * 0x800 + ((y + 1024) & 0x7ff);
}

interface HeapNode<N> {
  data: N;
  g: number;
  h: number;
  f: number;
  parent: HeapNode<N> | null;
  heapIndex: number;
}

class OpenSet<N> {
  private readonly heap: Array<HeapNode<N>> = [];

  get size(): number {
    return this.heap.length;
  }

  push(node: HeapNode<N>): void {
    node.heapIndex = this.heap.length;
    this.heap.push(node);
    this.up(node.heapIndex);
  }

  /** After a node's f decreased. */
  decreased(node: HeapNode<N>): void {
    this.up(node.heapIndex);
  }

  pop(): HeapNode<N> {
    const heap = this.heap;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      last.heapIndex = 0;
      this.down(0);
    }
    top.heapIndex = -1;
    return top;
  }

  private up(i: number): void {
    const heap = this.heap;
    const node = heap[i]!;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = heap[parent]!;
      if (p.f <= node.f) break;
      heap[i] = p;
      p.heapIndex = i;
      i = parent;
    }
    heap[i] = node;
    node.heapIndex = i;
  }

  private down(i: number): void {
    const heap = this.heap;
    const n = heap.length;
    const node = heap[i]!;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && heap[child + 1]!.f < heap[child]!.f) child++;
      const c = heap[child]!;
      if (node.f <= c.f) break;
      heap[i] = c;
      c.heapIndex = i;
      i = child;
    }
    heap[i] = node;
    node.heapIndex = i;
  }
}

export interface SearchOptions<N extends SearchNode> {
  start: N;
  neighbors(node: N): N[];
  /** Estimated cost from a node to the goal (ticks). */
  heuristic(node: N): number;
  isEnd(node: N): boolean;
  /** Total time for the search, ms (partial result after it). */
  timeout: number;
  /** Max time per slice before yielding to the event loop, ms. */
  sliceMs: number;
  /** Stop expanding nodes whose estimated total cost exceeds the start's estimate by this (ticks; ≤0: no limit). */
  searchRadius?: number;
  /** Give up after this many nodes (partial result). */
  maxNodes?: number;
  /** Aborts the search (resolves as 'noPath' with the best path so far). */
  signal?: { aborted: boolean };
}

/** Coefficients weighing cost against progress when picking a partial path (Baritone's). */
const BACKOFF = [1.5, 2, 2.5, 3, 4, 5, 10];
/** A partial path must get at least this much (heuristic) closer, or the plain best node is used. */
const MIN_PROGRESS = 5;

export async function search<N extends SearchNode>(options: SearchOptions<N>): Promise<SearchResult<N>> {
  const startTime = performance.now();
  const open = new OpenSet<N>();
  const byKey = new Map<number, HeapNode<N>>();
  const closed = new Set<number>();
  const h0 = options.heuristic(options.start);
  const startNode: HeapNode<N> = { data: options.start, g: 0, h: h0, f: h0, parent: null, heapIndex: -1 };
  open.push(startNode);
  byKey.set(options.start.key, startNode);
  let best = startNode;
  const bestBy = BACKOFF.map(() => startNode);
  const bestScore = BACKOFF.map(() => h0);
  const maxCost = options.searchRadius && options.searchRadius > 0 ? h0 + options.searchRadius : Infinity;

  const result = (status: SearchStatus, end: HeapNode<N>): SearchResult<N> => {
    const path: N[] = [];
    for (let n: HeapNode<N> | null = end; n && n !== startNode; n = n.parent) {
      n.data.parent = n.parent?.data ?? null;
      path.push(n.data);
    }
    path.reverse();
    return { status, path, cost: end.g, visitedNodes: closed.size, generatedNodes: byKey.size, time: performance.now() - startTime };
  };

  const bestPartial = (): HeapNode<N> => {
    for (let i = BACKOFF.length - 1; i >= 0; i--) {
      if (h0 - bestBy[i]!.h >= MIN_PROGRESS) return bestBy[i]!;
    }
    return best;
  };

  let sliceStart = startTime;
  let counter = 0;
  while (open.size > 0) {
    if ((++counter & 63) === 0) {
      const now = performance.now();
      if (options.signal?.aborted) return result('noPath', bestPartial());
      if (now - startTime > options.timeout) return result('timeout', bestPartial());
      if (options.maxNodes && closed.size > options.maxNodes) return result('timeout', bestPartial());
      if (now - sliceStart > options.sliceMs) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        sliceStart = performance.now();
      }
    }
    const node = open.pop();
    if (options.isEnd(node.data)) return result('success', node);
    byKey.delete(node.data.key);
    closed.add(node.data.key);
    for (const next of options.neighbors(node.data)) {
      if (closed.has(next.key)) continue;
      const g = node.g + next.cost;
      const existing = byKey.get(next.key);
      if (existing && g >= existing.g) continue;
      const h = existing ? existing.h : options.heuristic(next);
      if (g + h > maxCost) continue;
      next.parent = node.data;
      let entry: HeapNode<N>;
      if (existing) {
        existing.data = next;
        existing.g = g;
        existing.f = g + h;
        existing.parent = node;
        open.decreased(existing);
        entry = existing;
      } else {
        entry = { data: next, g, h, f: g + h, parent: node, heapIndex: -1 };
        byKey.set(next.key, entry);
        open.push(entry);
      }
      if (h < best.h) best = entry;
      for (let i = 0; i < BACKOFF.length; i++) {
        const score = h + g / BACKOFF[i]!;
        if (score < bestScore[i]!) {
          bestScore[i] = score;
          bestBy[i] = entry;
        }
      }
    }
  }
  return result('noPath', bestPartial());
}
