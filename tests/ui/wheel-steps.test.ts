import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWheelStepper, WHEEL_IDLE_MS, WHEEL_NOTCH_PX } from '../../src/ui/wheel-steps';

/**
 * wheel-steps.md REQ-a-wheel-gesture-steps-by-distance. Three controls moved a semitone per `wheel`
 * EVENT, which is right for a mouse (one event per notch) and wrong for a
 * touchpad (dozens of small events per swipe): one gentle swipe sent a note or a
 * bar's transpose straight to the clamp.
 */
type Ev = Pick<WheelEvent, 'deltaY' | 'deltaMode'>;
const ev = (deltaY: number, deltaMode = 0): WheelEvent => ({ deltaY, deltaMode } as Ev as WheelEvent);

function stepper() {
  let t = 0;
  const step = createWheelStepper(() => t);
  return {
    /** Feed events `gapMs` apart; returns the steps they produced. */
    run: (deltas: number[], gapMs: number, deltaMode = 0): number[] =>
      deltas.map((d) => { t += gapMs; return step(ev(d, deltaMode)); }),
    wait: (ms: number) => { t += ms; },
  };
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

describe('createWheelStepper (wheel-steps.md)', () => {
  it('a mouse notch moves one step, however small the platform reports it', () => {
    for (const d of [-4, -100]) {
      const s = stepper();
      s.wait(1000);
      expect(s.run([d], 0)).toEqual([1]); // up = +1
    }
    const s = stepper();
    expect(s.run([3], 1000)).toEqual([-1]); // down = -1, lines or pixels alike
  });

  it('a touchpad swipe moves in proportion to its distance, not per event (regression)', () => {
    const s = stepper();
    s.wait(1000);
    const steps = s.run(Array(30).fill(4), 10); // 120 px in 30 small events
    // The bug: 30 events were 30 semitones. First event, then one per 40 px.
    expect(sum(steps)).toBe(-3);
    expect(steps[0]).toBe(-1);
  });

  it('a fast mouse spin steps exactly once per notch (edge)', () => {
    const s = stepper();
    s.wait(1000);
    expect(s.run(Array(6).fill(-100), 20)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('a pause or a reversal starts a new gesture, forgetting the old distance', () => {
    const s = stepper();
    s.wait(1000);
    s.run([-4, -4, -4], 10); // mid-gesture, some distance banked
    s.wait(WHEEL_IDLE_MS + 1);
    expect(s.run([-4], 0)).toEqual([1]); // fresh after the pause
    expect(s.run([4], 10)).toEqual([-1]); // fresh on reversal, at once
  });

  it('normalises lines and pages to pixels', () => {
    const s = stepper();
    s.wait(1000);
    // A line is 16 px: the first steps, then 2 more lines (32 px) do not, a third does.
    expect(s.run([1, 1, 1, 1], 10, 1)).toEqual([-1, 0, 0, -1]);
    expect(WHEEL_NOTCH_PX).toBe(40);
  });
});

// The three call sites, by source: none may count events any more. A new
// stepped wheel control should use createWheelStepper too.
describe('every stepped wheel control uses the stepper (wheel-steps.md)', () => {
  const src = (rel: string): string =>
    readFileSync(fileURLToPath(new URL('../../' + rel, import.meta.url)), 'utf8');
  for (const file of ['src/ui/panels/song-panel.ts', 'src/ui/panels/seq-panel.ts']) {
    it(`${file} drives its semitones through a stepper`, () => {
      const s = src(file);
      expect(s).toContain('createWheelStepper');
      // The old per-event idiom: a step straight from the sign of deltaY.
      expect(s).not.toMatch(/e\.deltaY\s*<\s*0\s*\?/);
    });
  }
});
