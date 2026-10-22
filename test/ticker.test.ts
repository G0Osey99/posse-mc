import { describe, expect, it } from 'vitest';
import { FleetTicker, TICK_MS } from '../src/ticker.js';

describe('FleetTicker', () => {
  it('runs every due tick, catching up at most 4 after a stall', () => {
    let now = 0;
    const ticker = new FleetTicker(() => now);
    let ticks = 0;
    const off = ticker.subscribe(() => ticks++);
    now = TICK_MS;
    ticker.run();
    expect(ticks).toBe(1);
    now += TICK_MS * 10;
    ticker.run();
    expect(ticks).toBe(5);
    off();
    expect(ticker.size).toBe(0);
  });

  it('isolates a throwing subscriber', () => {
    let now = 0;
    const ticker = new FleetTicker(() => now);
    let ok = 0;
    const a = ticker.subscribe(() => {
      throw new Error('boom');
    });
    const b = ticker.subscribe(() => ok++);
    now = TICK_MS;
    ticker.run();
    expect(ok).toBe(1);
    a();
    b();
  });
});
