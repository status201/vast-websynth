import { describe, it, expect } from 'vitest';
import { createTuneMatcher, HOOK_INTERVALS, HOOK_MAX_GAP_MS } from '../../src/state/tune-matcher';

// rickroll-easter-egg.md — the phrase matcher. A♭3 B♭3 D♭4 B♭3 F4 F4 E♭4.
const HOOK = [56, 58, 61, 58, 65, 65, 63];

/** Feed notes `gap` ms apart from `t0`; returns each feed's result. */
function play(m: ReturnType<typeof createTuneMatcher>, notes: number[], gap = 200, t0 = 0): boolean[] {
  return notes.map((n, i) => m.feed(n, t0 + i * gap));
}

const fresh = () => createTuneMatcher(HOOK_INTERVALS, HOOK_MAX_GAP_MS);

describe('tune matcher', () => {
  it('matches the hook in the record\'s key on its seventh note (REQ-the-hook-is-matched-by-intervals)', () => {
    expect(play(fresh(), HOOK)).toEqual([false, false, false, false, false, false, true]);
  });

  it('matches in any key and octave (REQ-the-hook-is-matched-by-intervals)', () => {
    for (const shift of [-17, 5, 24]) {
      expect(play(fresh(), HOOK.map((n) => n + shift)).at(-1)).toBe(true);
    }
  });

  it('a wrong interval does not match (REQ-the-hook-is-matched-by-intervals)', () => {
    const wrong = [...HOOK];
    wrong[4] = wrong[4]! + 1;
    expect(play(fresh(), wrong)).not.toContain(true);
  });

  it('the phrase can follow other notes (REQ-the-hook-is-matched-by-intervals)', () => {
    const m = fresh();
    play(m, [60, 62, 64, 65, 67, 69, 71, 72, 48, 50]);
    expect(play(m, HOOK, 200, 2000).at(-1)).toBe(true);
  });

  it('a slow player matches; a longer pause breaks the phrase (REQ-the-hook-allows-a-slow-player)', () => {
    expect(play(fresh(), HOOK, HOOK_MAX_GAP_MS).at(-1)).toBe(true);

    const m = fresh();
    const res = HOOK.map((n, i) => m.feed(n, i < 4 ? i * 200 : 600 + HOOK_MAX_GAP_MS + 1 + (i - 4) * 200));
    expect(res).not.toContain(true);
    // The notes after the pause start a new phrase: the whole hook then matches.
    expect(play(m, HOOK, 200, 10_000).at(-1)).toBe(true);
  });

  it('a match consumes its notes (REQ-a-match-consumes-the-phrase)', () => {
    // The hook never overlaps itself, so this needs a pattern that does: three
    // equal notes. Without consumption the fourth note would match again on
    // the last two of the first phrase.
    const m = createTuneMatcher([0, 0], HOOK_MAX_GAP_MS);
    expect(play(m, [60, 60, 60])).toEqual([false, false, true]);
    expect(m.feed(60, 600)).toBe(false);
    expect(m.feed(60, 800)).toBe(false);
    expect(m.feed(60, 1000)).toBe(true);   // a full new phrase does
    // And the hook itself matches again after a match.
    const h = fresh();
    expect(play(h, HOOK).at(-1)).toBe(true);
    expect(play(h, HOOK, 200, 1600).at(-1)).toBe(true);
  });

  it('reset forgets the notes fed so far', () => {
    const m = fresh();
    play(m, HOOK.slice(0, 6));
    m.reset();
    expect(m.feed(HOOK[6]!, 1200)).toBe(false);
  });
});
