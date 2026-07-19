import { describe, it, expect, vi } from 'vitest';
import { UndoHistory } from '../../src/state/undo';

describe('UndoHistory', () => {
  it('pushes and pops LIFO', () => {
    const h = new UndoHistory<number>();
    h.push(1);
    h.push(2);
    expect(h.size).toBe(2);
    expect(h.pop()).toBe(2);
    expect(h.pop()).toBe(1);
    expect(h.pop()).toBeUndefined();
  });

  it('trims to depth, dropping the oldest entry', () => {
    const h = new UndoHistory<number>({ depth: 3 });
    for (let i = 1; i <= 5; i++) h.push(i);
    expect(h.size).toBe(3);
    expect(h.pop()).toBe(5);
    expect(h.pop()).toBe(4);
    expect(h.pop()).toBe(3); // 1 and 2 fell off the bottom
    expect(h.pop()).toBeUndefined();
  });

  it('coalesces same-key pushes within the window (oldest entry wins)', () => {
    const h = new UndoHistory<number>({ coalesceMs: 400 });
    h.push(1, 'cell', 1000);
    h.push(2, 'cell', 1200);
    h.push(3, 'cell', 1400);
    expect(h.size).toBe(1);
    expect(h.pop()).toBe(1);
  });

  it('the coalesce window refreshes per push (a slow drag stays one entry)', () => {
    const h = new UndoHistory<number>({ coalesceMs: 400 });
    h.push(1, 'cell', 1000);
    h.push(2, 'cell', 1350); // within 400 of 1000
    h.push(3, 'cell', 1700); // within 400 of 1350 — refreshed window
    expect(h.size).toBe(1);
  });

  it('an expired window starts a new entry', () => {
    const h = new UndoHistory<number>({ coalesceMs: 400 });
    h.push(1, 'cell', 1000);
    h.push(2, 'cell', 1500);
    expect(h.size).toBe(2);
  });

  it('a different key never coalesces', () => {
    const h = new UndoHistory<number>({ coalesceMs: 400 });
    h.push(1, 'a', 1000);
    h.push(2, 'b', 1001);
    expect(h.size).toBe(2);
  });

  it('an undefined key never coalesces', () => {
    const h = new UndoHistory<number>();
    h.push(1, undefined, 1000);
    h.push(2, undefined, 1001);
    expect(h.size).toBe(2);
  });

  it('pop resets the window — a follow-up same-key push is a fresh entry', () => {
    const h = new UndoHistory<number>({ coalesceMs: 400 });
    h.push(1, 'cell', 1000);
    h.pop();
    h.push(2, 'cell', 1010);
    expect(h.size).toBe(1);
    expect(h.pop()).toBe(2);
  });

  it('clear empties the stack', () => {
    const h = new UndoHistory<number>();
    h.push(1);
    h.push(2);
    h.clear();
    expect(h.size).toBe(0);
    expect(h.pop()).toBeUndefined();
  });

  it('onChange fires on push/pop/clear, not on a coalesced push or empty clear', () => {
    const h = new UndoHistory<number>({ coalesceMs: 400 });
    const fn = vi.fn();
    h.onChange(fn);
    h.push(1, 'k', 1000);       // fires
    h.push(2, 'k', 1100);       // coalesced — no fire
    h.pop();                    // fires
    h.clear();                  // empty — no fire
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
