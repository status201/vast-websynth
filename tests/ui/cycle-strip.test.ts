import { describe, it, expect, afterEach, vi } from 'vitest';
import { CycleStrip, cycleStripBars, barHeightFrac } from '../../src/ui/components/cycle-strip';

/**
 * The geometry is exported canvas-free so it can be pinned under jsdom, which
 * has no 2D backend — the same split as `scopeRegions` / `motionGraphPoints`.
 * The component tests only assert it survives a null context.
 */
describe('cycleStripBars', () => {
  it('returns nothing for an empty library or a zero-width strip', () => {
    expect(cycleStripBars(0, 300)).toEqual([]);
    expect(cycleStripBars(10, 0)).toEqual([]);
  });

  it('fills the width once there are enough cycles', () => {
    const bars = cycleStripBars(64, 320);
    expect(bars).toHaveLength(64);
    expect(bars[0]!.x).toBeLessThanOrEqual(2); // at most the inter-bar gap
    const last = bars[63]!;
    expect(last.x + last.w).toBeCloseTo(320, 6);
  });

  it('spans the strip at any count, with "now" flush right', () => {
    for (const count of [1, 3, 12, 64]) {
      const bars = cycleStripBars(count, 320);
      expect(bars).toHaveLength(count);
      const last = bars[count - 1]!;
      expect(last.x + last.w, `count ${count}`).toBeCloseTo(320, 6);
    }
  });

  it('gets finer as depth widens the window', () => {
    const shallow = cycleStripBars(8, 640)[0]!.w;
    const deep = cycleStripBars(64, 640)[0]!.w;
    expect(deep).toBeLessThan(shallow);
  });

  it('never produces a zero or negative width', () => {
    for (const count of [1, 7, 100, 512]) {
      for (const width of [40, 320, 1200]) {
        for (const bar of cycleStripBars(count, width)) {
          expect(bar.w).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('barHeightFrac', () => {
  it('is silent at zero and full at unity', () => {
    expect(barHeightFrac(0)).toBe(0);
    expect(barHeightFrac(1)).toBe(1);
  });

  it('keeps a typical bus level clearly visible', () => {
    // ~0.05 is what a held note actually measures post-voice-bus; linear would
    // give a 3px stub on a 58px strip.
    expect(barHeightFrac(0.05)).toBeGreaterThan(0.35);
    expect(barHeightFrac(0.05)).toBeLessThan(0.6);
  });

  it('is monotone, so a decaying tail ramps down', () => {
    const steps = [1, 0.5, 0.2, 0.05, 0.01, 0.002];
    for (let i = 1; i < steps.length; i++) {
      expect(barHeightFrac(steps[i]!)).toBeLessThan(barHeightFrac(steps[i - 1]!));
    }
  });

  it('clamps out of range rather than overflowing the strip', () => {
    expect(barHeightFrac(4)).toBe(1);
    expect(barHeightFrac(1e-6)).toBe(0);
    expect(barHeightFrac(-1)).toBe(0);
    expect(barHeightFrac(NaN)).toBe(0);
  });
});

describe('CycleStrip component', () => {
  afterEach(() => vi.restoreAllMocks());

  function meter(count: number, lag = 1) {
    return { peaks: new Float32Array(count).fill(0.5), head: count - 1, lag, count, hz: 220 };
  }

  it('constructs and draws without a 2D context (jsdom)', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const strip = new CycleStrip();
    expect(strip.el.tagName).toBe('CANVAS');
    expect(strip.el.dataset.testid).toBe('zoetrope-strip');
    expect(() => strip.update(meter(8))).not.toThrow();
    expect(() => strip.clear()).not.toThrow();
  });

  it('takes a custom testid', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(new CycleStrip('zoetrope-strip-2').el.dataset.testid).toBe('zoetrope-strip-2');
  });
});
