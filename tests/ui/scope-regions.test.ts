import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  scopeRegions,
  STEREO_SIDE_BY_SIDE_MIN_W,
  STEREO_GAP,
  SPECTRUM_DB_RANGE,
  PEAK_DECAY_DB_PER_SEC,
  PEAK_HOLD_SEC,
  byteToDisplayDb,
  dbToFrac,
  decayPeak,
  updatePeak,
  Scope,
  type ScopeRegion,
} from '../../src/ui/components/scope';

/** Sum of region areas must equal the panel area when regions tile it exactly. */
const area = (rs: ScopeRegion[]): number => rs.reduce((a, r) => a + r.w * r.h, 0);

describe('scopeRegions', () => {
  it('mono is a single full-panel region', () => {
    const rs = scopeRegions('mono', 600, 120);
    expect(rs).toEqual([{ x: 0, y: 0, w: 600, h: 120, tag: 'mono', label: '' }]);
  });

  it('stereo on a wide panel splits side-by-side with a centre gutter', () => {
    const rs = scopeRegions('stereo', 600, 120);
    const half = (600 - STEREO_GAP) / 2; // 292
    expect(rs).toEqual([
      { x: 0, y: 0, w: half, h: 120, tag: 'left', label: 'L' },
      { x: half + STEREO_GAP, y: 0, w: half, h: 120, tag: 'right', label: 'R' },
    ]);
    // The two halves + the centre gutter cover the full width exactly.
    expect(rs[0]!.w + STEREO_GAP + rs[1]!.w).toBe(600);
    // Gap sits dead centre: equal halves, flush to each edge, gutter == STEREO_GAP.
    expect(rs[0]!.w).toBe(rs[1]!.w);
    expect(rs[0]!.x).toBe(0);
    expect(rs[1]!.x + rs[1]!.w).toBe(600);
    expect(rs[1]!.x - (rs[0]!.x + rs[0]!.w)).toBe(STEREO_GAP);
    expect(area(rs)).toBe(600 * 120 - STEREO_GAP * 120); // panel minus the gutter
  });

  it('stereo on a small screen stacks (L top, R bottom)', () => {
    const rs = scopeRegions('stereo', 360, 120);
    expect(rs).toEqual([
      { x: 0, y: 0, w: 360, h: 60, tag: 'left', label: 'L' },
      { x: 0, y: 60, w: 360, h: 60, tag: 'right', label: 'R' },
    ]);
    expect(area(rs)).toBe(360 * 120);
  });

  it('the threshold is inclusive — exactly the min width is side-by-side', () => {
    const rs = scopeRegions('stereo', STEREO_SIDE_BY_SIDE_MIN_W, 100);
    expect(rs.map((r) => r.tag)).toEqual(['left', 'right']);
    expect(rs[0]!.h).toBe(100); // full height = side-by-side (not halved)
    expect(rs[0]!.w).toBe((STEREO_SIDE_BY_SIDE_MIN_W - STEREO_GAP) / 2);
  });

  it('just below the threshold stacks', () => {
    const rs = scopeRegions('stereo', STEREO_SIDE_BY_SIDE_MIN_W - 1, 100);
    expect(rs[0]!.h).toBe(50); // halved by height = stacked
    expect(rs[0]!.w).toBe(STEREO_SIDE_BY_SIDE_MIN_W - 1);
  });
});

describe('byteToDisplayDb (0 dB at the top, -SPECTRUM_DB_RANGE at the bottom)', () => {
  it('maps byte 255 to 0 dB (clip) and byte 0 to -SPECTRUM_DB_RANGE', () => {
    expect(byteToDisplayDb(255)).toBe(0);
    expect(byteToDisplayDb(0)).toBe(-SPECTRUM_DB_RANGE);
  });

  it('maps the mid byte to about -35 dB', () => {
    expect(byteToDisplayDb(128)).toBeCloseTo(-34.86, 2);
  });

  it('dbToFrac is the inverse, clamped to [0,1]', () => {
    // Round-trips the endpoints and the middle.
    expect(dbToFrac(byteToDisplayDb(255))).toBeCloseTo(1, 5);
    expect(dbToFrac(byteToDisplayDb(0))).toBeCloseTo(0, 5);
    expect(dbToFrac(byteToDisplayDb(128))).toBeCloseTo(128 / 255, 5);
    // Out-of-range dB clamps rather than overflowing the region.
    expect(dbToFrac(10)).toBe(1);
    expect(dbToFrac(-200)).toBe(0);
  });
});

describe('decayPeak (peak-hold update)', () => {
  it('a louder current maximum snaps the held value up immediately', () => {
    expect(decayPeak(-40, -10, 0.016)).toBe(-10);
  });

  it('otherwise the held value falls by PEAK_DECAY_DB_PER_SEC * dt', () => {
    const dt = 0.5;
    // Current max (-50) is below the held value (-10), so it decays.
    expect(decayPeak(-10, -50, dt)).toBeCloseTo(-10 - PEAK_DECAY_DB_PER_SEC * dt, 6);
  });

  it('never falls below the current maximum', () => {
    // A big dt would overshoot, but the current max is the floor.
    expect(decayPeak(-10, -12, 100)).toBe(-12);
  });

  it('a -Infinity start (just reset) snaps to the current maximum', () => {
    expect(decayPeak(-Infinity, -30, 0.016)).toBe(-30);
  });
});

describe('updatePeak (push up, hold plateau, then decay)', () => {
  it('a louder bar snaps the peak up and re-arms the full hold plateau', () => {
    const s = updatePeak({ db: -40, holdS: 0.2 }, -10, 0.1);
    expect(s.db).toBe(-10);
    expect(s.holdS).toBe(PEAK_HOLD_SEC);
  });

  it('holds the line steady (no decay) while the plateau has time left', () => {
    const s = updatePeak({ db: -10, holdS: 1.0 }, -50, 0.1);
    expect(s.db).toBe(-10); // unchanged
    expect(s.holdS).toBeCloseTo(0.9, 6); // plateau counts down
  });

  it('falls slowly once the plateau has elapsed', () => {
    const dt = 0.1;
    const s = updatePeak({ db: -10, holdS: 0.05 }, -50, dt); // holdS - dt = -0.05 <= 0
    expect(s.holdS).toBe(0);
    expect(s.db).toBeCloseTo(-10 - PEAK_DECAY_DB_PER_SEC * dt, 6);
  });

  it('a -Infinity start (just reset) snaps to the current max and arms the hold', () => {
    const s = updatePeak({ db: -Infinity, holdS: 0 }, -30, 0.016);
    expect(s.db).toBe(-30);
    expect(s.holdS).toBe(PEAK_HOLD_SEC);
  });
});

describe('Scope.setChannels (defensive fallback)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const fakeAnalyser = (): AnalyserNode => ({
    fftSize: 2048,
    frequencyBinCount: 1024,
    getByteTimeDomainData: () => {},
    getByteFrequencyData: () => {},
  } as unknown as AnalyserNode);

  it('stays mono when stereo is requested without per-channel analysers', () => {
    // jsdom has no canvas 2d context nor rAF; stub both so the Scope constructs.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const scope = new Scope({ mono: fakeAnalyser() }); // no left/right
    expect(scope.channelMode).toBe('mono');
    expect(() => scope.setChannels('stereo')).not.toThrow();
    expect(scope.channelMode).toBe('mono'); // falls back — no broken split
    scope.destroy();
  });

  it('switches to stereo when both channel analysers are supplied', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const scope = new Scope({ mono: fakeAnalyser(), left: fakeAnalyser(), right: fakeAnalyser() });
    scope.setChannels('stereo');
    expect(scope.channelMode).toBe('stereo');
    scope.setChannels('mono');
    expect(scope.channelMode).toBe('mono');
    scope.destroy();
  });

  it('resetPeak clears the dataset peak mirror and does not throw', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const scope = new Scope({ mono: fakeAnalyser(), left: fakeAnalyser(), right: fakeAnalyser() });
    // Simulate held peaks having been mirrored onto the canvas dataset.
    scope.el.dataset.peak = '-12.3';
    scope.el.dataset.peakL = '-9.0';
    scope.el.dataset.peakR = '-15.5';
    expect(() => scope.resetPeak()).not.toThrow();
    expect(scope.el.dataset.peak).toBeUndefined();
    expect(scope.el.dataset.peakL).toBeUndefined();
    expect(scope.el.dataset.peakR).toBeUndefined();
    scope.destroy();
  });
});
