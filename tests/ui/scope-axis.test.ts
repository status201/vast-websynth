import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Scope,
  SPECTRUM_F_MIN,
  SPECTRUM_F_MAX,
  SPECTRUM_TICKS_HZ,
  SPECTRUM_ZONES,
  TICK_CHAR_W,
  columnBinEdges,
  formatHz,
  formatHzFull,
  fracToFreq,
  freqToFrac,
  visibleTicks,
} from '../../src/ui/components/scope';

/**
 * The Spectrum's log frequency axis and its scale — scope.md
 * REQ-the-frequency-axis-is-logarithmic through scope.md REQ-hovering-reads-out-a-frequency.
 *
 * The axis used to be linear in bin index, which put 100/500/1k inside the leftmost
 * 7% of the panel and made the whole "mud" band about five pixels wide — a scale
 * drawn on that would have been decoration. These cases pin the mapping every
 * consumer reads from, the pruning that keeps the ruler legible on a narrow panel,
 * and the column→bin rule that stops the bass drawing as three flat plateaus.
 */

describe('freqToFrac / fracToFreq — the log mapping (REQ-the-frequency-axis-is-logarithmic)', () => {
  it('pins the ends of the range to 0 and 1', () => {
    expect(freqToFrac(SPECTRUM_F_MIN)).toBe(0);
    expect(freqToFrac(SPECTRUM_F_MAX)).toBeCloseTo(1, 10);
  });

  it('gives every octave the same width — the whole point of the change', () => {
    const oct1 = freqToFrac(200) - freqToFrac(100);
    const oct2 = freqToFrac(2000) - freqToFrac(1000);
    const oct3 = freqToFrac(8000) - freqToFrac(4000);
    expect(oct2).toBeCloseTo(oct1, 10);
    expect(oct3).toBeCloseTo(oct1, 10);
  });

  it('puts the requested markers where a reader can tell them apart', () => {
    // The linear axis had these at 0.7% / 3.5% / 6.9% / 34.7% of the width.
    const at = (hz: number) => Math.round(freqToFrac(hz) * 1000) / 10;
    expect(at(100)).toBeCloseTo(23.3, 1);
    expect(at(500)).toBeCloseTo(46.6, 1);
    expect(at(1000)).toBeCloseTo(56.6, 1);
    expect(at(5000)).toBeCloseTo(79.9, 1);
    expect(at(10000)).toBeCloseTo(90.0, 1);
  });

  it('clamps rather than escaping [0,1], including at 0 Hz and NaN', () => {
    expect(freqToFrac(1)).toBe(0);
    expect(freqToFrac(0)).toBe(0);
    expect(freqToFrac(-5)).toBe(0);
    expect(freqToFrac(96000)).toBe(1);
    expect(freqToFrac(Number.NaN)).toBe(0);
    expect(fracToFreq(-1)).toBe(SPECTRUM_F_MIN);
    expect(fracToFreq(2)).toBeCloseTo(SPECTRUM_F_MAX, 6);
    expect(fracToFreq(Number.NaN)).toBe(SPECTRUM_F_MIN);
  });

  it('round-trips: fracToFreq inverts freqToFrac (drives the hover readout)', () => {
    for (const hz of [25, 100, 437, 1000, 6300, 19000]) {
      expect(fracToFreq(freqToFrac(hz))).toBeCloseTo(hz, 6);
    }
  });

  it('honours a lower fMax, so a low-rate context simply shows less at the top', () => {
    // 44.1kHz needs no clamp at all (Nyquist 22.05k is above F_MAX); a 32kHz
    // context is the case that does, and there the range above 1k is shorter, so
    // 1k sits further right.
    const nyquist = 32000 / 2;
    expect(freqToFrac(nyquist, nyquist)).toBeCloseTo(1, 10);
    expect(freqToFrac(1000, nyquist)).toBeGreaterThan(freqToFrac(1000));
    expect(Math.min(SPECTRUM_F_MAX, 44100 / 2)).toBe(SPECTRUM_F_MAX);
  });
});

describe('formatHz / formatHzFull (REQ-the-scale-is-a-permanent-ruler/31)', () => {
  it('formats the ruler compactly', () => {
    expect(formatHz(100)).toBe('100');
    expect(formatHz(500)).toBe('500');
    expect(formatHz(1000)).toBe('1k');
    expect(formatHz(5000)).toBe('5k');
    expect(formatHz(10000)).toBe('10k');
    expect(formatHz(1500)).toBe('1.5k');
  });

  it('formats the cursor readout with its unit', () => {
    expect(formatHzFull(437)).toBe('437 Hz');
    expect(formatHzFull(1200)).toBe('1.2 kHz');
    expect(formatHzFull(12000)).toBe('12 kHz');
  });

  it('returns empty rather than "NaN" for nonsense', () => {
    expect(formatHz(Number.NaN)).toBe('');
    expect(formatHzFull(Number.NaN)).toBe('');
    expect(formatHz(-1)).toBe('');
  });
});

describe('visibleTicks — the bottom ruler (REQ-the-scale-is-a-permanent-ruler)', () => {
  it('returns every requested marker on a wide plot, in ascending order', () => {
    const ticks = visibleTicks(636);
    expect(ticks.map((t) => t.hz)).toEqual([...SPECTRUM_TICKS_HZ]);
    expect(ticks.map((t) => t.x)).toEqual([...ticks.map((t) => t.x)].sort((a, b) => a - b));
  });

  it('places each tick exactly where the shared mapping says', () => {
    const plotW = 636;
    for (const t of visibleTicks(plotW)) {
      expect(t.x).toBeCloseTo(freqToFrac(t.hz) * plotW, 10);
    }
  });

  it('keeps every label inside the plot', () => {
    for (const plotW of [80, 200, 636, 1400]) {
      for (const t of visibleTicks(plotW)) {
        const half = (t.label.length * TICK_CHAR_W) / 2;
        expect(t.labelX - half).toBeGreaterThanOrEqual(-0.001);
        expect(t.labelX + half).toBeLessThanOrEqual(plotW + 0.001);
      }
    }
  });

  it('drops crowded ticks instead of overlapping them', () => {
    const narrow = visibleTicks(90);
    expect(narrow.length).toBeLessThan(SPECTRUM_TICKS_HZ.length);
    // Whatever survives must not collide.
    for (let i = 1; i < narrow.length; i++) {
      const a = narrow[i - 1]!;
      const b = narrow[i]!;
      const gap = b.labelX - a.labelX;
      const halves = (a.label.length * TICK_CHAR_W) / 2 + (b.label.length * TICK_CHAR_W) / 2;
      expect(gap).toBeGreaterThanOrEqual(halves);
    }
  });

  it('keeps the ends of the scale longest — they are what establish the range', () => {
    // Acceptance runs outwards-in, so the middle of the set is the first to lose a
    // fight. It survives here only because it happens not to clash with either end.
    expect(visibleTicks(90).map((t) => t.hz)).toEqual([100, 1000, 10000]);
    // Squeeze harder and only the two ends are left.
    expect(visibleTicks(50).map((t) => t.hz)).toEqual([100, 10000]);
  });

  it('spans the whole region — no width is reserved for the Zones button', () => {
    // The ruler runs edge to edge; on a panel narrow enough for the two to meet the
    // top label goes behind the button, which is the accepted trade (REQ-a-zones-toggle).
    const regionW = 700;
    const top = visibleTicks(regionW).at(-1)!;
    expect(top.x).toBeCloseTo(freqToFrac(10000) * regionW, 10);
    expect(top.labelX).toBeGreaterThan(regionW * 0.85);
  });

  it('never widens the ruler when the plot shrinks', () => {
    const wide = visibleTicks(636).length;
    const narrow = visibleTicks(160).length;
    expect(narrow).toBeLessThanOrEqual(wide);
  });
});

describe('columnBinEdges — the column→bin mapping (REQ-bars-are-drawn-per-pixel-column)', () => {
  // The three perf tiers (performance-mode.md REQ-analyser-fft-size-follows-the-tier).
  for (const fftSize of [256, 512, 1024]) {
    it(`is monotonic and in range at fftSize ${fftSize}`, () => {
      const sampleRate = 48000;
      const cols = 200;
      const edges = columnBinEdges(cols, fftSize, sampleRate);
      expect(edges.length).toBe(cols + 1);
      for (let i = 1; i < edges.length; i++) {
        expect(edges[i]!).toBeGreaterThan(edges[i - 1]!);
      }
      // Starts at F_MIN and ends at the clamped F_MAX, both expressed in bins.
      const perHz = fftSize / sampleRate;
      expect(edges[0]!).toBeCloseTo(SPECTRUM_F_MIN * perHz, 4);
      expect(edges[cols]!).toBeCloseTo(Math.min(SPECTRUM_F_MAX, sampleRate / 2) * perHz, 3);
      // ...and never addresses a bin that does not exist.
      expect(edges[cols]!).toBeLessThanOrEqual(fftSize / 2);
    });
  }

  it('clamps the top of the range to Nyquist at a lower sample rate', () => {
    const sampleRate = 32000; // Nyquist 16k, below SPECTRUM_F_MAX
    const fftSize = 1024;
    const edges = columnBinEdges(100, fftSize, sampleRate);
    expect(edges[100]!).toBeCloseTo((sampleRate / 2) * (fftSize / sampleRate), 3);
    expect(edges[100]!).toBeLessThanOrEqual(fftSize / 2);
  });

  it('is dense in the bass and sparse in the treble — the reason for the two rules', () => {
    const edges = columnBinEdges(200, 1024, 48000);
    // Low columns are narrower than one bin (interpolate); high ones span several
    // bins (take the max, so a narrow peak survives).
    expect(edges[1]! - edges[0]!).toBeLessThan(1);
    expect(edges[200]! - edges[199]!).toBeGreaterThan(1);
  });

  it('survives a nonsense column count instead of returning an empty array', () => {
    expect(columnBinEdges(0, 1024, 48000).length).toBe(2);
    expect(columnBinEdges(-5, 1024, 48000).length).toBe(2);
  });
});

describe('SPECTRUM_ZONES — the problem bands (REQ-a-zones-toggle)', () => {
  it('names the four bands, ascending and non-overlapping', () => {
    expect(SPECTRUM_ZONES.map((z) => z.name)).toEqual(['MUD', 'BOXY', 'NASAL', 'HARSH']);
    for (let i = 0; i < SPECTRUM_ZONES.length; i++) {
      const z = SPECTRUM_ZONES[i]!;
      expect(z.to).toBeGreaterThan(z.from);
      if (i > 0) expect(z.from).toBeGreaterThanOrEqual(SPECTRUM_ZONES[i - 1]!.to);
    }
  });

  it('gives each band a width you can actually point at', () => {
    // On a 636px plot. The linear axis gave mud ~5px; that was the bug.
    for (const z of SPECTRUM_ZONES) {
      const w = (freqToFrac(z.to) - freqToFrac(z.from)) * 636;
      expect(w).toBeGreaterThan(18);
    }
  });
});

/**
 * Component-level behaviour. Driven over a recording 2D context the way
 * `scope-lifecycle.test.ts` does — the point of the proxy is that a `measureText`
 * would return `undefined` here, which is exactly why `visibleTicks` estimates.
 */
function recordingCtx() {
  const calls: string[] = [];
  const grad = { addColorStop: () => undefined };
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop === 'createLinearGradient') return () => grad;
      if (prop in t) return t[prop];
      return (...args: unknown[]) => { calls.push(prop); return args.length ? undefined : undefined; };
    },
    set(t, prop: string, v) { t[prop] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const fakeAnalyser = (): AnalyserNode => ({
  fftSize: 1024,
  frequencyBinCount: 512,
  smoothingTimeConstant: 0.2,
  getFloatTimeDomainData: () => undefined,
  getByteFrequencyData: () => undefined,
} as unknown as AnalyserNode);

function mountScope(painter = recordingCtx()) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    painter.ctx as unknown as RenderingContext,
  );
  let frame: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => { frame = null; });
  const scope = new Scope({ mono: fakeAnalyser() });
  Object.defineProperty(scope.el, 'clientWidth', { value: 700, configurable: true });
  Object.defineProperty(scope.el, 'clientHeight', { value: 120, configurable: true });
  return { scope, painter, tick: (ts = 1000) => { const f = frame; frame = null; f?.(ts); } };
}

describe('Scope — Zones overlay (REQ-a-zones-toggle)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('defaults off and is mirrored only while Spectrum is showing', () => {
    const { scope } = mountScope();
    expect(scope.zonesOn).toBe(false);
    expect(scope.el.dataset.zones).toBeUndefined(); // Wave: nothing to report

    scope.setMode('spectrum');
    expect(scope.el.dataset.zones).toBe('off');
    scope.setZones(true);
    expect(scope.zonesOn).toBe(true);
    expect(scope.el.dataset.zones).toBe('on');

    scope.setMode('wave');
    expect(scope.el.dataset.zones).toBeUndefined();
    // The setting itself survives the round trip — it is the readout that is view-scoped.
    expect(scope.zonesOn).toBe(true);
    scope.destroy();
  });
});

describe('Scope — hover cursor (REQ-hovering-reads-out-a-frequency)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  /** jsdom has no PointerEvent; offsetX/Y are what the handler actually reads. */
  const pointer = (type: string, offsetX: number, offsetY: number, pointerType = 'mouse') =>
    Object.assign(new Event(type), { offsetX, offsetY, pointerType }) as unknown as Event;

  it('binds its listeners only while Spectrum is showing', () => {
    const { scope } = mountScope();
    const add = vi.spyOn(scope.el, 'addEventListener');
    const remove = vi.spyOn(scope.el, 'removeEventListener');

    scope.setMode('spectrum');
    expect(add.mock.calls.filter(([t]) => t === 'pointermove').length).toBe(1);

    scope.setMode('wave');
    expect(remove.mock.calls.filter(([t]) => t === 'pointermove').length).toBe(1);

    // Re-entering must not double-bind.
    scope.setMode('spectrum');
    scope.setMode('spectrum');
    expect(add.mock.calls.filter(([t]) => t === 'pointermove').length).toBe(2);

    scope.destroy();
    expect(remove.mock.calls.filter(([t]) => t === 'pointermove').length).toBe(2);
  });

  it('reads out the frequency under the pointer, and clears on leave', () => {
    const { scope, tick } = mountScope();
    scope.setMode('spectrum');
    // Half way across the region (which is the whole 700px canvas in mono): the
    // log midpoint of 20Hz..20kHz.
    scope.el.dispatchEvent(pointer('pointermove', 700 / 2, 60));
    tick();
    const shown = Number(scope.el.dataset.cursorHz);
    expect(shown).toBeGreaterThan(0);
    // The log midpoint of 20Hz..20kHz is 632Hz — nowhere near the linear 10kHz,
    // which is the whole difference this axis makes.
    expect(shown).toBe(Math.round(fracToFreq(0.5)));

    scope.el.dispatchEvent(pointer('pointerleave', 0, 0));
    expect(scope.el.dataset.cursorHz).toBeUndefined();
    scope.destroy();
  });

  it('ignores touch pointers, so a finger drag cannot strand a cursor', () => {
    const { scope, tick } = mountScope();
    scope.setMode('spectrum');
    scope.el.dispatchEvent(pointer('pointermove', 200, 60, 'touch'));
    tick();
    expect(scope.el.dataset.cursorHz).toBeUndefined();
    scope.destroy();
  });

  it('drops the readout when the view leaves Spectrum', () => {
    const { scope, tick } = mountScope();
    scope.setMode('spectrum');
    scope.el.dispatchEvent(pointer('pointermove', 300, 60));
    tick();
    expect(scope.el.dataset.cursorHz).toBeDefined();
    scope.setMode('wave');
    expect(scope.el.dataset.cursorHz).toBeUndefined();
    scope.destroy();
  });
});

describe('Scope — haloed labels (REQ-every-drawn-string-gets-a-halo)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('strokes every label before it fills it, so a bright bar cannot swallow it', () => {
    const { scope, painter, tick } = mountScope();
    scope.setMode('spectrum');
    scope.setChannels('stereo'); // no L/R analysers -> stays mono, still fine
    tick();
    const strokes = painter.calls.filter((c) => c === 'strokeText').length;
    const fills = painter.calls.filter((c) => c === 'fillText').length;
    expect(strokes).toBeGreaterThan(0);
    // Every fillText is preceded by its own strokeText — never a bare label.
    expect(strokes).toBe(fills);
    expect(painter.calls.indexOf('strokeText')).toBeLessThan(painter.calls.indexOf('fillText'));
    scope.destroy();
  });

  it('draws the ruler in Spectrum and not in Wave', () => {
    const { scope, painter, tick } = mountScope();
    tick(); // Wave
    const waveFills = painter.calls.filter((c) => c === 'fillText').length;
    painter.calls.length = 0;
    scope.setMode('spectrum');
    tick(2000);
    const specFills = painter.calls.filter((c) => c === 'fillText').length;
    expect(waveFills).toBe(0);
    expect(specFills).toBeGreaterThanOrEqual(SPECTRUM_TICKS_HZ.length);
    scope.destroy();
  });
});
