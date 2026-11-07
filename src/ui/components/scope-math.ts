// The scope's pure half — regions, the dB and frequency axes, peak hold, wave
// normalisation, ticks and zones (scope.md). No DOM, no canvas, no AudioContext:
// the drawing component (`scope.ts`) and the EQ graph read the same axis from here.

export type ScopeMode = 'wave' | 'spectrum';
export type ScopeChannels = 'mono' | 'stereo';

/** At/above this canvas width (CSS px) stereo splits side-by-side; below it stacks. */
export const STEREO_SIDE_BY_SIDE_MIN_W = 480;

/** Centre gutter (CSS px) between the side-by-side L/R halves so they read apart. */
export const STEREO_GAP = 16;

/** Which analyser feeds a region, and where/how big it draws (CSS px, layout box). */
export interface ScopeRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  tag: 'mono' | 'left' | 'right';
  label: string;
}

/**
 * Pure split geometry for the scope (canvas-free, so it is unit-testable). Mono is
 * one full-panel region. Stereo tiles the panel into two equal halves — side-by-side
 * (L left / R right) on a wide panel, stacked (L top / R bottom) on small screens —
 * decided from the panel width so it tracks the space actually available.
 */
export function scopeRegions(channels: ScopeChannels, w: number, h: number): ScopeRegion[] {
  if (channels === 'mono') {
    return [{ x: 0, y: 0, w, h, tag: 'mono', label: '' }];
  }
  if (w >= STEREO_SIDE_BY_SIDE_MIN_W) {
    // Inset each half by half the gutter so a STEREO_GAP-wide gap sits dead centre.
    const half = (w - STEREO_GAP) / 2;
    return [
      { x: 0, y: 0, w: half, h, tag: 'left', label: 'L' },
      { x: half + STEREO_GAP, y: 0, w: half, h, tag: 'right', label: 'R' },
    ];
  }
  const half = h / 2;
  return [
    { x: 0, y: 0, w, h: half, tag: 'left', label: 'L' },
    { x: 0, y: half, w, h: half, tag: 'right', label: 'R' },
  ];
}

/** dB shown at the very top of a spectrum region — i.e. "clip" (REQ-zero-db-is-the-top-of-the-graph). */
export const SPECTRUM_DB_TOP = 0;

/**
 * dB span from the top of a region to its bottom. 70 matches the AnalyserNode's
 * default `getByteFrequencyData` range (−100…−30 dB), so the displayed scale is a
 * pure +30 re-label of the existing bars — bar heights are untouched (REQ-zero-db-is-the-top-of-the-graph).
 */
export const SPECTRUM_DB_RANGE = 70;

/** Peak-hold fall rate. Deliberately very slow ("real slow"); single tunable knob. */
export const PEAK_DECAY_DB_PER_SEC = 3;

/** How long the held peak stays pinned at a new max before it starts falling. */
export const PEAK_HOLD_SEC = 1.5;

/**
 * Map an analyser frequency byte (0..255) onto the displayed dB scale: 0 dB at the
 * top of the graph (byte 255) down to −SPECTRUM_DB_RANGE at the bottom (byte 0).
 * Pure (canvas-free) so it is unit-testable. (REQ-zero-db-is-the-top-of-the-graph)
 */
export function byteToDisplayDb(byte: number): number {
  return SPECTRUM_DB_TOP - SPECTRUM_DB_RANGE * (1 - byte / 255);
}

/**
 * Inverse of `byteToDisplayDb` as a 0..1 fraction of region height (0 = bottom,
 * 1 = top), clamped — places the peak line on the same vertical scale as the bars.
 */
export function dbToFrac(db: number): number {
  const frac = (db - SPECTRUM_DB_TOP + SPECTRUM_DB_RANGE) / SPECTRUM_DB_RANGE;
  return frac < 0 ? 0 : frac > 1 ? 1 : frac;
}

/**
 * Slow fall: the held value drops at `PEAK_DECAY_DB_PER_SEC`, never below the
 * current maximum. Frame-rate independent via `dtSec`.
 */
export function decayPeak(heldDb: number, currentMaxDb: number, dtSec: number): number {
  return Math.max(currentMaxDb, heldDb - PEAK_DECAY_DB_PER_SEC * dtSec);
}

/** Held peak: the level and how long it stays pinned before decaying. */
export interface PeakState {
  db: number;       // held level in displayed dB; -Infinity = cleared
  holdS: number;    // seconds remaining on the hold plateau
}

/**
 * Peak-hold update (REQ-a-taller-bar-pins-the-peak): a louder bar pushes the held dB up instantly and
 * re-arms a `PEAK_HOLD_SEC` plateau during which the line stays pinned (so the max
 * is readable); once the plateau elapses it falls slowly via `decayPeak`. A
 * `-Infinity` start (just reset) snaps straight to `currentMaxDb`.
 */
export function updatePeak(state: PeakState, currentMaxDb: number, dtSec: number): PeakState {
  if (currentMaxDb >= state.db) return { db: currentMaxDb, holdS: PEAK_HOLD_SEC };
  const holdS = state.holdS - dtSec;
  if (holdS > 0) return { db: state.db, holdS };
  return { db: decayPeak(state.db, currentMaxDb, dtSec), holdS: 0 };
}

/**
 * Wave auto-gain (REQ-the-wave-view-auto-gains). The fixed 1:1 scale only looked like an oscilloscope for
 * material running into clip — a −25 dBFS song drew a flat line ~6% tall. These six
 * constants are the whole knob set; `WAVE_NORM_STRENGTH` is the one that matters.
 */

/** Fraction of a region's half-height a *fully* normalized trace would reach. */
const WAVE_TARGET_PEAK = 0.9;

/**
 * How hard to normalize: 1 = flatten every song to the same height, 0 = no boost.
 * Below 1 the level scale is *compressed*, not erased — in dB the drawn peak is
 * `S·TARGET_dB + (1−S)·peak_dB` — so a loud song still visibly reads louder.
 */
export const WAVE_NORM_STRENGTH = 0.85;

/** Gain ceiling, so a bed of near-silent noise is never blown up to full scale. */
export const WAVE_MAX_GAIN = 32;

/** ~−66 dBFS. At/below this the gain snaps to unity, so silence draws flat. */
export const WAVE_SILENCE_PEAK = 0.0005;

/** Seconds. Gain *dropping* (the signal got louder) — fast, so nothing overshoots. */
const WAVE_GAIN_FALL_TAU = 0.05;

/** Seconds. Gain *rising* (the signal got quieter) — slow, so the trace can't pump. */
const WAVE_GAIN_RISE_TAU = 0.6;

/**
 * The clamped target gain for a frame peak (REQ-the-wave-view-auto-gains). Pure (canvas-free), so it is
 * unit-testable. Three bounds keep it honest: the floor of 1 never *shrinks* a
 * clipping signal, `WAVE_MAX_GAIN` caps the boost, and the silence gate (written as
 * `!(peak > …)` so a NaN peak lands here too) keeps quiet passages flat.
 */
export function waveGainTarget(peak: number): number {
  if (!(peak > WAVE_SILENCE_PEAK)) return 1;
  const g = Math.pow(WAVE_TARGET_PEAK / peak, WAVE_NORM_STRENGTH);
  return g < 1 ? 1 : g > WAVE_MAX_GAIN ? WAVE_MAX_GAIN : g;
}

/**
 * One-pole move toward `waveGainTarget(peak)`, frame-rate independent via `dtSec`
 * and deliberately **asymmetric**: fast down (a transient can't fly off-screen),
 * slow up (no pumping). `dtSec <= 0` — the first frame after the tab-hidden pause,
 * where `lastTs` was reset — leaves the gain alone. (REQ-the-wave-view-auto-gains)
 */
export function updateWaveGain(gain: number, peak: number, dtSec: number): number {
  if (dtSec <= 0) return gain;
  const target = waveGainTarget(peak);
  const tau = target < gain ? WAVE_GAIN_FALL_TAU : WAVE_GAIN_RISE_TAU;
  return gain + (target - gain) * (1 - Math.exp(-dtSec / tau));
}

/**
 * The Spectrum's **logarithmic** frequency axis (v13, REQ-the-frequency-axis-is-logarithmic..29). The view used
 * to map bin index linearly across the panel, which put 100/500/1k in the leftmost
 * 7% and made the whole "mud" band about five pixels wide — you could see a bump
 * but never say what note it was. A log axis gives every octave the same width, so
 * the bands people actually hunt for become areas you can point at.
 */

/** Hz at the left edge of the plot. */
export const SPECTRUM_F_MIN = 20;

/** Hz at the right edge — clamped to Nyquist at read time (44.1k shows less). */
export const SPECTRUM_F_MAX = 20000;

/** The face every canvas label uses. Matches --mono in theme.css (typography.md). */
export const LABEL_FONT = '10px ui-monospace, monospace';

/** One step down, for the zone names — they are annotation, not readout. */
export const ZONE_FONT = '9px ui-monospace, monospace';

/** Px per drawn column. The bar loop steps in pixels now, not in bins (REQ-bars-are-drawn-per-pixel-column). */
export const SPECTRUM_COL_W = 3;

/**
 * Px per character at the component's 10px monospace — the width *estimate* that
 * decides tick collisions. Deliberately not `ctx.measureText`: the lifecycle suite
 * drives a proxy 2D context whose methods all return `undefined`, so reading
 * `.width` off one throws there. (REQ-the-scale-is-a-permanent-ruler)
 */
export const TICK_CHAR_W = 6;

/** Minimum px between two tick labels before the crowded one is dropped. */
const TICK_MIN_GAP = 6;

/** Region width below which zone *names* are dropped; the bands themselves stay. */
export const ZONE_NAME_MIN_W = 300;

/** Px below a region's top edge where zone names sit — clear of the corner buttons. */
export const ZONE_NAME_TOP = 22;

/** The labelled frequencies on the bottom ruler (REQ-the-scale-is-a-permanent-ruler). */
export const SPECTRUM_TICKS_HZ: readonly number[] = [100, 500, 1000, 5000, 10000];

/** A named problem band — what the Zones overlay shades (REQ-a-zones-toggle). */
export interface SpectrumZone {
  from: number;
  to: number;
  name: string;
}

/** The four bands people mix against, in the order they occur. */
export const SPECTRUM_ZONES: readonly SpectrumZone[] = [
  { from: 100, to: 200, name: 'MUD' },
  { from: 300, to: 500, name: 'BOXY' },
  { from: 800, to: 1000, name: 'NASAL' },
  { from: 4000, to: 6000, name: 'HARSH' },
];

/**
 * Log position of a frequency as a 0..1 fraction of the plot width, clamped. The
 * **single** definition of where a frequency lives — bars, ticks, zones and the
 * hover cursor all read from it, so none of them can drift apart. (REQ-the-frequency-axis-is-logarithmic)
 */
export function freqToFrac(hz: number, fMax: number = SPECTRUM_F_MAX): number {
  const frac = Math.log(hz / SPECTRUM_F_MIN) / Math.log(fMax / SPECTRUM_F_MIN);
  if (!Number.isFinite(frac)) return hz > SPECTRUM_F_MIN ? 1 : 0;
  return frac < 0 ? 0 : frac > 1 ? 1 : frac;
}

/** Exact inverse of `freqToFrac` — turns a pointer position into a frequency. */
export function fracToFreq(frac: number, fMax: number = SPECTRUM_F_MAX): number {
  const f = Number.isFinite(frac) ? (frac < 0 ? 0 : frac > 1 ? 1 : frac) : 0;
  return SPECTRUM_F_MIN * Math.pow(fMax / SPECTRUM_F_MIN, f);
}

/** kHz to one decimal below 10k, whole above — the shared rounding of both labels. */
function toKilo(hz: number): number {
  const k = hz / 1000;
  return k >= 10 ? Math.round(k) : Math.round(k * 10) / 10;
}

/** Compact ruler label: `100`, `500`, `1k`, `5k`, `10k`. (REQ-the-scale-is-a-permanent-ruler) */
export function formatHz(hz: number): string {
  if (!Number.isFinite(hz) || hz < 0) return '';
  return hz < 1000 ? `${Math.round(hz)}` : `${toKilo(hz)}k`;
}

/** Spoken form for the hover cursor: `437 Hz`, `1.2 kHz`. (REQ-hovering-reads-out-a-frequency) */
export function formatHzFull(hz: number): string {
  if (!Number.isFinite(hz) || hz < 0) return '';
  return hz < 1000 ? `${Math.round(hz)} Hz` : `${toKilo(hz)} kHz`;
}

/** One entry on the bottom ruler. */
export interface SpectrumTick {
  hz: number;
  /** True position of the tick mark, px from the plot's left edge. */
  x: number;
  /** Where the centred label is drawn — clamped so it cannot overflow the plot. */
  labelX: number;
  label: string;
}

/**
 * The ruler for a given plot width, with crowded entries pruned (REQ-the-scale-is-a-permanent-ruler). Ticks
 * are accepted in order of **distance from the middle of the set**, so on a panel
 * too narrow for all five the ends of the scale — the ones that establish the
 * range — are the last to go. Pure and canvas-free; `Scope` caches the result per
 * width, because this allocates and the redraw loop must not (REQ-no-per-frame-layout-read).
 */
export function visibleTicks(regionW: number, fMax: number = SPECTRUM_F_MAX): SpectrumTick[] {
  const all: SpectrumTick[] = SPECTRUM_TICKS_HZ.map((hz) => {
    const label = formatHz(hz);
    const x = freqToFrac(hz, fMax) * regionW;
    const half = (label.length * TICK_CHAR_W) / 2;
    const labelX = x < half ? half : x > regionW - half ? regionW - half : x;
    return { hz, x, labelX, label };
  });
  const mid = (all.length - 1) / 2;
  const order = all
    .map((_, i) => i)
    .sort((a, b) => Math.abs(b - mid) - Math.abs(a - mid) || a - b);
  const kept: SpectrumTick[] = [];
  for (const i of order) {
    const t = all[i]!;
    const half = (t.label.length * TICK_CHAR_W) / 2;
    let clash = false;
    for (const k of kept) {
      const kHalf = (k.label.length * TICK_CHAR_W) / 2;
      if (Math.abs(k.labelX - t.labelX) < half + kHalf + TICK_MIN_GAP) { clash = true; break; }
    }
    if (!clash) kept.push(t);
  }
  return kept.sort((a, b) => a.x - b.x);
}

/**
 * The first index `i` in `1..limit` where the signal crosses zero going up
 * (`data[i-1] < 0 <= data[i]`), or `-1` when there is none — silence, or a period
 * longer than the search (scope.md REQ-the-wave-trace-is-triggered). Pure and
 * allocation-free: it runs every Wave frame.
 */
export function findRisingZeroCrossing(data: Float32Array, limit: number): number {
  const end = Math.min(limit, data.length - 1);
  for (let i = 1; i <= end; i++) {
    if (data[i - 1]! < 0 && data[i]! >= 0) return i;
  }
  return -1;
}

/**
 * Fractional bin index at each column's left edge (length `cols + 1`, monotonic).
 * This is the whole of the log mapping the bar loop needs: a column whose span
 * covers a whole bin takes the max over those bins, one narrower than a bin
 * interpolates between its neighbours. (REQ-bars-are-drawn-per-pixel-column)
 *
 * Pure, but allocating — `Scope` caches it per `(cols, fftSize, sampleRate)` and
 * drops the cache exactly where it drops the gradient cache.
 */
export function columnBinEdges(cols: number, fftSize: number, sampleRate: number): Float32Array {
  const n = cols > 0 ? Math.floor(cols) : 1;
  const fMax = Math.min(SPECTRUM_F_MAX, sampleRate / 2);
  const edges = new Float32Array(n + 1);
  const perHz = fftSize / sampleRate;
  for (let c = 0; c <= n; c++) edges[c] = fracToFreq(c / n, fMax) * perHz;
  return edges;
}
