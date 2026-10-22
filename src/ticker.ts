// One 50 ms game-tick timer for every bot in the process, instead of one interval per bot.
// Subscribers run in order each tick; a throwing subscriber is isolated from the rest.

export const TICK_MS = 50;
/** Ticks run back-to-back after a stall before the clock is resynced (like mineflayer's catch-up). */
const MAX_CATCHUP_TICKS = 4;
/**
 * A tick due within this many ms runs now: the timer fires on a whole-ms clock, so without slack a
 * callback at 49.8 ms runs nothing and the next one runs two ticks back to back.
 */
const SLACK_MS = 2;

export type TickHandler = () => void;

export class FleetTicker {
  private readonly handlers = new Set<TickHandler>();
  private timer: NodeJS.Timeout | null = null;
  private next = 0;
  /** Total ms spent inside tick handlers (fleet-wide cost, for stats). */
  busyMs = 0;
  ticks = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Adds a handler; returns its unsubscribe function. The timer runs only while there are handlers. */
  subscribe(handler: TickHandler): () => void {
    this.handlers.add(handler);
    if (!this.timer) this.start();
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) this.stop();
    };
  }

  get size(): number {
    return this.handlers.size;
  }

  private start(): void {
    this.next = this.now() + TICK_MS;
    this.timer = setInterval(() => this.run(), TICK_MS);
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs every tick that is due. Exposed for tests. */
  run(): void {
    const start = this.now();
    let ran = 0;
    while (this.next <= start + SLACK_MS && ran < MAX_CATCHUP_TICKS) {
      this.tickOnce();
      this.next += TICK_MS;
      ran++;
    }
    if (this.next <= start) this.next = start + TICK_MS;
    this.busyMs += this.now() - start;
  }

  private tickOnce(): void {
    this.ticks++;
    for (const handler of this.handlers) {
      try {
        handler();
      } catch {
        // A bot's tick failure must not stop the others; handlers report their own errors.
      }
    }
  }
}

/** The process-wide ticker. */
export const fleetTicker = new FleetTicker();
