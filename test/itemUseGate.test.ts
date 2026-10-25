// Using an item right after the server updated the inventory: anticheats (Grim's
// reset-item-usage-on-item-update) stop the use once the update is acknowledged.
import { describe, expect, it } from 'vitest';
import { ItemUseGate } from '../src/features/inventory.js';

describe('item use after an inventory update', () => {
  const gate = () => {
    let t = 1000;
    const g = new ItemUseGate(() => t);
    return { g, at: (ms: number) => (t = ms) };
  };

  it('is open with no update', () => {
    expect(gate().g.ready()).toBe(true);
  });

  it('waits for the answer to the next transaction, then a tick', () => {
    const { g, at } = gate();
    g.transaction();
    g.inventoryUpdated();
    at(1050);
    expect(g.ready()).toBe(false); // the set_slot isn't acknowledged yet
    at(1060);
    g.transaction();
    expect(g.ready()).toBe(false);
    at(1159);
    expect(g.ready()).toBe(false);
    at(1160);
    expect(g.ready()).toBe(true);
  });

  it('waits a few ticks on servers that send no transactions', () => {
    const { g, at } = gate();
    g.inventoryUpdated();
    at(1100);
    expect(g.ready()).toBe(false);
    at(1150);
    expect(g.ready()).toBe(true);
  });

  it('gives up waiting after a second', () => {
    const { g, at } = gate();
    g.transaction();
    g.inventoryUpdated();
    at(2000);
    expect(g.ready()).toBe(true);
  });

  it('counts only transactions after the latest update', () => {
    const { g, at } = gate();
    g.transaction();
    g.inventoryUpdated();
    at(1010);
    g.transaction();
    at(1200);
    g.inventoryUpdated();
    at(1350);
    expect(g.ready()).toBe(false);
    g.transaction();
    at(1450);
    expect(g.ready()).toBe(true);
  });
});
