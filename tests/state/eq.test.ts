import { describe, it, expect } from 'vitest';
import {
  EQ_BANDS, EQ_BAND_COUNT, EQ_GAIN_MAX, EQ_HP_REF, EQ_LP_REF, EQ_WIDTH_DEFAULT,
  detuneCents, eqIsFlat, eqResponseDb, eqStageCoeffs, readEqSettings,
  EQ_FILTER_Q_DB, type EqSettings,
} from '../../src/state/eq';
import { SPECTRUM_ZONES } from '../../src/ui/components/scope';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { isPatchParam } from '../../src/state/preset-session';

const SR = 48000;
const PREFIXES = ['fx.eq', 'fx.drum.eq', 'fx.sampler.eq'];

const flat = (over: Partial<EqSettings> = {}): EqSettings => ({
  gains: new Array<number>(EQ_BAND_COUNT).fill(0),
  width: EQ_WIDTH_DEFAULT,
  hp: EQ_HP_REF,
  lp: EQ_LP_REF,
  ...over,
});

const withBand = (i: number, db: number, width = EQ_WIDTH_DEFAULT): EqSettings => {
  const gains = new Array<number>(EQ_BAND_COUNT).fill(0);
  gains[i] = db;
  return flat({ gains, width });
};

describe('band layout (equalizer.md REQ-eight-fixed-eq-bands)', () => {
  it('puts a band inside every problem zone the Spectrum names', () => {
    // This is the feature's musical claim: you read a problem off the analyser
    // and the band above it is the one that fixes it. If a centre ever moves out
    // of a zone — or a zone moves — the De-… presets stop meaning anything.
    for (const z of SPECTRUM_ZONES) {
      const inside = EQ_BANDS.filter(
        (b) => b.type === 'peaking' && b.hz >= z.from && b.hz <= z.to,
      );
      expect(inside.length, `no band inside ${z.name} (${z.from}-${z.to} Hz)`)
        .toBeGreaterThan(0);
    }
  });

  it('is a low shelf, six peaks and a high shelf, ascending', () => {
    expect(EQ_BANDS).toHaveLength(8);
    expect(EQ_BANDS[0]!.type).toBe('lowshelf');
    expect(EQ_BANDS[EQ_BAND_COUNT - 1]!.type).toBe('highshelf');
    expect(EQ_BANDS.slice(1, -1).every((b) => b.type === 'peaking')).toBe(true);
    for (let i = 1; i < EQ_BAND_COUNT; i++) {
      expect(EQ_BANDS[i]!.hz).toBeGreaterThan(EQ_BANDS[i - 1]!.hz);
    }
  });

  it('spans the audible range the graph draws', () => {
    expect(EQ_BANDS[0]!.hz).toBeGreaterThan(20);
    expect(EQ_BANDS[EQ_BAND_COUNT - 1]!.hz).toBeLessThan(20000);
  });
});

describe('response (REQ-the-eq-is-a-no-op-by-default, REQ-the-drawn-curve-is-exact)', () => {
  it('is flat at every default, right across the axis', () => {
    // The other half of ADR-006: not just "the effect is off", but "even
    // engaged, the defaults change nothing".
    for (let hz = 20; hz < 20000; hz *= 1.3) {
      expect(eqResponseDb(flat(), hz, SR), `${hz.toFixed(0)} Hz`).toBeCloseTo(0, 9);
    }
  });

  it('reads a boosted band back at its own centre', () => {
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      const band = EQ_BANDS[i]!;
      const db = eqResponseDb(withBand(i, 12), band.hz, SR);
      // A peak sits exactly at its gain; a shelf reaches half its gain at the
      // corner frequency by construction, and its full gain past it.
      if (band.type === 'peaking') {
        expect(db, `${band.label}`).toBeCloseTo(12, 5);
      } else {
        expect(db, `${band.label}`).toBeCloseTo(6, 1);
      }
    }
  });

  it('falls back toward flat away from a peaking band', () => {
    const i = 4; // 2 kHz, well clear of both shelves
    const centre = EQ_BANDS[i]!.hz;
    const s = withBand(i, 12);
    expect(eqResponseDb(s, centre, SR)).toBeCloseTo(12, 5);
    expect(eqResponseDb(s, centre / 8, SR)).toBeLessThan(1.5);
    expect(eqResponseDb(s, centre * 4, SR)).toBeLessThan(1.5);
  });

  it('narrows the skirt as WIDTH rises, without moving the peak', () => {
    const i = 4;
    const centre = EQ_BANDS[i]!.hz;
    const wide = withBand(i, 12, 0.7);
    const narrow = withBand(i, 12, 6);
    expect(eqResponseDb(wide, centre, SR)).toBeCloseTo(12, 5);
    expect(eqResponseDb(narrow, centre, SR)).toBeCloseTo(12, 5);
    const octave = centre * 2;
    expect(eqResponseDb(narrow, octave, SR)).toBeLessThan(eqResponseDb(wide, octave, SR));
  });

  it('cuts below the highpass and above the lowpass', () => {
    expect(eqResponseDb(flat({ hp: 500 }), 100, SR)).toBeLessThan(-10);
    expect(eqResponseDb(flat({ hp: 500 }), 5000, SR)).toBeCloseTo(0, 1);
    expect(eqResponseDb(flat({ lp: 1000 }), 8000, SR)).toBeLessThan(-10);
    expect(eqResponseDb(flat({ lp: 1000 }), 100, SR)).toBeCloseTo(0, 1);
  });

  it('stays finite for every setting the params allow', () => {
    // ADR-010's *stable*, applied to the drawing rather than the DSP: a NaN here
    // would blow a hole in the canvas path rather than the speakers, but the
    // bound is the same one and the payload reaching it is the same payload.
    const extremes: EqSettings[] = [
      flat({ gains: new Array<number>(EQ_BAND_COUNT).fill(EQ_GAIN_MAX), width: 8 }),
      flat({ gains: new Array<number>(EQ_BAND_COUNT).fill(-EQ_GAIN_MAX), width: 0.4 }),
      flat({ hp: 2000, lp: 1000 }), // knobs crossed — legal, and silent
    ];
    for (const s of extremes) {
      for (let hz = 20; hz < 20000; hz *= 1.5) {
        expect(Number.isFinite(eqResponseDb(s, hz, SR))).toBe(true);
      }
      // …including at and past Nyquist, where the caller's axis can reach on a
      // 44.1k context.
      expect(Number.isFinite(eqResponseDb(s, 22050, 44100))).toBe(true);
      expect(Number.isFinite(eqResponseDb(s, 30000, 44100))).toBe(true);
    }
  });
});

describe('detuneCents (REQ-a-real-highpass-and-lowpass)', () => {
  it('is zero at the reference and an octave per 1200', () => {
    expect(detuneCents(EQ_HP_REF, EQ_HP_REF)).toBe(0);
    expect(detuneCents(40, 20)).toBeCloseTo(1200, 9);
    expect(detuneCents(10000, 20000)).toBeCloseTo(-1200, 9);
  });

  it('refuses to produce a non-finite offset from a degenerate input', () => {
    expect(detuneCents(0, 20)).toBe(0);
    expect(detuneCents(20, 0)).toBe(0);
  });
});

describe('eqIsFlat — the lamp’s middle state (REQ-the-eq-tab-led-only-indicates)', () => {
  it('is true at the defaults and false once anything moves', () => {
    expect(eqIsFlat(flat())).toBe(true);
    expect(eqIsFlat(withBand(2, -6))).toBe(false);
    expect(eqIsFlat(flat({ hp: 200 }))).toBe(false);
    expect(eqIsFlat(flat({ lp: 8000 }))).toBe(false);
    // WIDTH alone changes nothing while every band is at 0 dB, so it is still flat.
    expect(eqIsFlat(flat({ width: 5 }))).toBe(true);
  });
});

describe('registry (REQ-eq-params-come-from-one-factory)', () => {
  const bus = new ParamBus();
  registerDefaults(bus);

  it.each(PREFIXES)('%s registers on/hp/b0..b7/lp/width', (prefix) => {
    const ids = [`${prefix}.on`, `${prefix}.hp`, `${prefix}.lp`, `${prefix}.width`];
    for (let i = 0; i < EQ_BAND_COUNT; i++) ids.push(`${prefix}.b${i}`);
    for (const id of ids) expect(bus.def(id), id).toBeDefined();
    expect(ids).toHaveLength(12);
  });

  it.each(PREFIXES)('%s defaults to a complete no-op (ADR-006)', (prefix) => {
    expect(bus.get(`${prefix}.on`)).toBe(0);
    expect(bus.get(`${prefix}.hp`)).toBe(EQ_HP_REF);
    expect(bus.get(`${prefix}.lp`)).toBe(EQ_LP_REF);
    expect(bus.def(`${prefix}.hp`)!.min).toBe(EQ_HP_REF);
    expect(bus.def(`${prefix}.lp`)!.max).toBe(EQ_LP_REF);
    for (let i = 0; i < EQ_BAND_COUNT; i++) expect(bus.get(`${prefix}.b${i}`)).toBe(0);
    expect(eqIsFlat(readEqSettings(bus, prefix))).toBe(true);
  });

  it.each(PREFIXES)('%s bounds every band at +/-EQ_GAIN_MAX', (prefix) => {
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      const def = bus.def(`${prefix}.b${i}`)!;
      expect(def.min).toBe(-EQ_GAIN_MAX);
      expect(def.max).toBe(EQ_GAIN_MAX);
    }
  });

  it('splits sound from song by prefix alone, with no new predicate', () => {
    // The prefix was chosen for this: `NON_PATCH_PREFIXES` already carries
    // `fx.drum.` and `fx.sampler.`, so the synth EQ is part of the *sound* and
    // the other two are song-level without a line of new code.
    expect(isPatchParam('fx.eq.b0')).toBe(true);
    expect(isPatchParam('fx.eq.on')).toBe(true);
    expect(isPatchParam('fx.drum.eq.b0')).toBe(false);
    expect(isPatchParam('fx.sampler.eq.b0')).toBe(false);
  });

  it('reads a lane off the bus in the shape the response math wants', () => {
    const b = new ParamBus();
    registerDefaults(b);
    b.set('fx.eq.b3', -7);
    b.set('fx.eq.width', 3);
    b.set('fx.eq.hp', 120);
    const s = readEqSettings(b, 'fx.eq');
    expect(s.gains).toHaveLength(EQ_BAND_COUNT);
    expect(s.gains[3]).toBe(-7);
    expect(s.width).toBe(3);
    expect(s.hp).toBe(120);
    expect(s.lp).toBe(EQ_LP_REF);
  });
});

describe('the magnitude formula describes the filter it claims to (REQ-the-drawn-curve-is-exact)', () => {
  /**
   * `eqResponseDb` is a closed-form expression; the filter is a difference
   * equation. This runs the difference equation from the very same coefficients
   * and recovers the magnitude by DFT of the impulse response — an independent
   * route to the same number, so a sign slip or a mistaken `alpha` shows up as a
   * disagreement rather than as a curve that is confidently wrong.
   *
   * What it deliberately does NOT cover: whether a browser's `BiquadFilterNode`
   * uses these coefficients at all. That is `e2e/equalizer.spec.ts`, because
   * jsdom has no biquads to ask.
   */
  function impulseMagnitudeDb(c: readonly number[], hz: number, sr: number): number {
    const [b0, b1, b2, a0, a1, a2] = c as [number, number, number, number, number, number];
    const N = 8192;
    // Direct Form I, normalised by a0 — the form the coefficients are written in.
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const w = (2 * Math.PI * hz) / sr;
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const x = n === 0 ? 1 : 0;
      const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      re += y * Math.cos(w * n);
      im -= y * Math.sin(w * n);
    }
    return 10 * Math.log10(re * re + im * im);
  }

  it.each([
    ['peaking', 900, 2, 12],
    ['peaking', 2000, 0.7, -15],
    ['peaking', 5000, 6, 9],
    ['lowshelf', 60, EQ_WIDTH_DEFAULT, 10],
    ['highshelf', 12000, EQ_WIDTH_DEFAULT, -10],
    ['lowpass', 3000, EQ_FILTER_Q_DB, 0],
    ['highpass', 300, EQ_FILTER_Q_DB, 0],
  ] as const)('%s at %i Hz', (type, f0, q, gain) => {
    const coeffs = eqStageCoeffs(type, f0, q, gain, SR);
    // Probe an octave below, at, and an octave above the corner — the places a
    // wrong `alpha` or a swapped sign shows up.
    for (const hz of [f0 / 2, f0, f0 * 2]) {
      const viaImpulse = impulseMagnitudeDb(coeffs, hz, SR);
      const viaFormula = magnitudeOf(coeffs, hz, SR);
      expect(viaFormula, `${type} @ ${hz.toFixed(0)} Hz`).toBeCloseTo(viaImpulse, 1);
    }
  });

  /** The closed form, restated over raw coefficients so both routes are comparable. */
  function magnitudeOf(c: readonly number[], hz: number, sr: number): number {
    const [b0, b1, b2, a0, a1, a2] = c as [number, number, number, number, number, number];
    const w = (2 * Math.PI * hz) / sr;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nRe = b0 + b1 * c1 + b2 * c2, nIm = -(b1 * s1 + b2 * s2);
    const dRe = a0 + a1 * c1 + a2 * c2, dIm = -(a1 * s1 + a2 * s2);
    return 10 * Math.log10((nRe * nRe + nIm * nIm) / (dRe * dRe + dIm * dIm));
  }
});
