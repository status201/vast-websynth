import { describe, it, expect, vi } from 'vitest';
import {
  sweetSpots,
  sweetSpotsInRange,
  noteToHz,
  syncedRateHz,
  SYNC_LABELS,
  DIVISIONS,
} from '../../src/utils/tempo';
import { renderTempoSync } from '../../src/ui/onboarding/help-widgets';
import { ParamBus, registerDefaults } from '../../src/state/params';

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe('tempo-sync math', () => {
  it('resolves the straight quarter note at 120 BPM to 0.5 s / 2 Hz', () => {
    const q = sweetSpots(120).find((s) => s.label === '1/4')!;
    expect(near(q.seconds, 0.5)).toBe(true);
    expect(near(q.hz, 2)).toBe(true);
  });

  it('applies dotted (×1½) and triplet (×⅔) at 120 BPM', () => {
    const spots = sweetSpots(120);
    expect(near(spots.find((s) => s.label === '1/8 D')!.seconds, 0.375)).toBe(true);
    expect(near(spots.find((s) => s.label === '1/8 T')!.seconds, (0.5 * 2) / 3 / 2)).toBe(true);
    // 1/8 T = 0.5 beats × ⅔ = 0.3333 beats → 0.16667 s at 120 BPM
    expect(near(spots.find((s) => s.label === '1/8 T')!.seconds, 0.16666666, 1e-6)).toBe(true);
  });

  it('scales with BPM: at 90 BPM a quarter note is 0.6667 s', () => {
    const q = sweetSpots(90).find((s) => s.label === '1/4')!;
    expect(near(q.seconds, 60 / 90, 1e-9)).toBe(true);
  });

  it('filters to the delay range [0.01, 1.5] s at 120 BPM (drops 1/1, keeps 1/32)', () => {
    const inRange = sweetSpotsInRange(120, 0.01, 1.5, 'time');
    const labels = inRange.map((s) => s.label);
    expect(labels).not.toContain('1/1'); // 4 beats = 2.0 s, out of range
    expect(labels).toContain('1/32'); // 0.125 beats = 62.5 ms, in range
    // sorted ascending by seconds
    for (let i = 1; i < inRange.length; i++) {
      expect(inRange[i]!.seconds).toBeGreaterThanOrEqual(inRange[i - 1]!.seconds);
    }
  });

  it('filters by Hz for a rate knob and sorts ascending', () => {
    const inRange = sweetSpotsInRange(120, 0.05, 20, 'freq');
    // 1/4 at 120 BPM = 2 Hz
    expect(inRange.some((s) => s.label === '1/4' && near(s.hz, 2))).toBe(true);
    for (let i = 1; i < inRange.length; i++) {
      expect(inRange[i]!.hz).toBeGreaterThanOrEqual(inRange[i - 1]!.hz);
    }
  });

  it('noteToHz maps A4 (69) to 440 Hz and one octave up to 880', () => {
    expect(near(noteToHz(69), 440)).toBe(true);
    expect(near(noteToHz(81), 880, 1e-9)).toBe(true);
  });
});

describe('renderTempoSync (delay time)', () => {
  it('lists in-range divisions with ms values at 120 BPM', () => {
    const b = bus();
    b.set('transport.bpm', 120);
    const root = renderTempoSync({ bus: b, close: () => {} }, 'fx.delay.time', 'time');

    const eighth = root.querySelector<HTMLButtonElement>('[data-testid="sweet-fx.delay.time-18"]');
    expect(eighth).not.toBeNull();
    expect(eighth!.textContent).toContain('1/8');
    expect(eighth!.textContent).toContain('250 ms'); // 0.25 s

    // 1/1 (2.0 s) is out of the 0.01–1.5 s range → no button
    expect(root.querySelector('[data-testid="sweet-fx.delay.time-11"]')).toBeNull();
  });

  it('clicking a division snaps the knob and closes the modal', () => {
    const b = bus();
    b.set('transport.bpm', 120);
    const close = vi.fn();
    const root = renderTempoSync({ bus: b, close }, 'fx.delay.time', 'time');

    const eighth = root.querySelector<HTMLButtonElement>('[data-testid="sweet-fx.delay.time-18"]')!;
    eighth.click();
    expect(b.get('fx.delay.time')).toBeCloseTo(0.25, 6);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('marks the row nearest the current value with the global .on class', () => {
    const b = bus();
    b.set('transport.bpm', 120);
    b.set('fx.delay.time', 0.25); // exactly a 1/8 note
    const root = renderTempoSync({ bus: b, close: () => {} }, 'fx.delay.time', 'time');
    const eighth = root.querySelector<HTMLButtonElement>('[data-testid="sweet-fx.delay.time-18"]')!;
    expect(eighth.classList.contains('on')).toBe(true);
  });

  it('rate knobs show Hz (lfo.rate) and snap on click', () => {
    const b = bus();
    b.set('transport.bpm', 120);
    const root = renderTempoSync({ bus: b, close: () => {} }, 'lfo.rate', 'freq');
    const quarter = root.querySelector<HTMLButtonElement>('[data-testid="sweet-lfo.rate-14"]')!;
    expect(quarter.textContent).toContain('2.00 Hz');
    quarter.click();
    expect(b.get('lfo.rate')).toBeCloseTo(2, 6);
  });
});

/**
 * `lfo.sync` resolution — lfo.md REQ-9. The same division table the advisory
 * badges recommend from, now driving a real rate, which is why the module had to
 * leave `src/ui/onboarding/` (the audio layer may not import from the UI).
 */
describe('syncedRateHz', () => {
  it('returns null for free-running, so the caller keeps the knob value', () => {
    expect(syncedRateHz(0, 120)).toBeNull();
  });

  it('resolves a division against the tempo', () => {
    // 1/4 at 120 BPM is 0.5 s → 2 Hz.
    const quarter = SYNC_LABELS.indexOf('1/4');
    expect(syncedRateHz(quarter, 120)).toBeCloseTo(2, 10);
    // Half the tempo, half the rate.
    expect(syncedRateHz(quarter, 60)).toBeCloseTo(1, 10);
    // 1/8 at 120 → 0.25 s → 4 Hz.
    expect(syncedRateHz(SYNC_LABELS.indexOf('1/8'), 120)).toBeCloseTo(4, 10);
  });

  it('handles dotted and triplet divisions', () => {
    // 1/8 D is 1.5x an eighth = 0.375 s at 120 → 2.667 Hz.
    expect(syncedRateHz(SYNC_LABELS.indexOf('1/8 D'), 120)).toBeCloseTo(1 / 0.375, 10);
    // 1/4 T is 2/3 of a quarter = 0.3333 s at 120 → 3 Hz.
    expect(syncedRateHz(SYNC_LABELS.indexOf('1/4 T'), 120)).toBeCloseTo(3, 10);
  });

  it('refuses an out-of-range index or a nonsense tempo', () => {
    expect(syncedRateHz(999, 120)).toBeNull();
    expect(syncedRateHz(-1, 120)).toBeNull();
    // A song payload drives this param directly, and 1/0 would reach an
    // AudioParam (untrusted-input.md REQ-6).
    expect(syncedRateHz(1, 0)).toBeNull();
    expect(syncedRateHz(1, NaN)).toBeNull();
    expect(syncedRateHz(1, Infinity)).toBeNull();
  });

  it('keeps index 0 as "free" — the label list is append-only', () => {
    expect(SYNC_LABELS[0]).toBe('free');
    expect(SYNC_LABELS).toHaveLength(DIVISIONS.length + 1);
  });
});
