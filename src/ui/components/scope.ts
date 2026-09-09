import styles from '../styles/scope.module.css';

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

/** dB shown at the very top of a spectrum region — i.e. "clip" (REQ-11). */
export const SPECTRUM_DB_TOP = 0;

/**
 * dB span from the top of a region to its bottom. 70 matches the AnalyserNode's
 * default `getByteFrequencyData` range (−100…−30 dB), so the displayed scale is a
 * pure +30 re-label of the existing bars — bar heights are untouched (REQ-11).
 */
export const SPECTRUM_DB_RANGE = 70;

/** Peak-hold fall rate. Deliberately very slow ("real slow"); single tunable knob. */
export const PEAK_DECAY_DB_PER_SEC = 3;

/** How long the held peak stays pinned at a new max before it starts falling. */
export const PEAK_HOLD_SEC = 1.5;

/**
 * Map an analyser frequency byte (0..255) onto the displayed dB scale: 0 dB at the
 * top of the graph (byte 255) down to −SPECTRUM_DB_RANGE at the bottom (byte 0).
 * Pure (canvas-free) so it is unit-testable. (REQ-11)
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
 * Peak-hold update (REQ-12): a louder bar pushes the held dB up instantly and
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
 * Wave auto-gain (REQ-17). The fixed 1:1 scale only looked like an oscilloscope for
 * material running into clip — a −25 dBFS song drew a flat line ~6% tall. These six
 * constants are the whole knob set; `WAVE_NORM_STRENGTH` is the one that matters.
 */

/** Fraction of a region's half-height a *fully* normalized trace would reach. */
export const WAVE_TARGET_PEAK = 0.9;

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
export const WAVE_GAIN_FALL_TAU = 0.05;

/** Seconds. Gain *rising* (the signal got quieter) — slow, so the trace can't pump. */
export const WAVE_GAIN_RISE_TAU = 0.6;

/**
 * The clamped target gain for a frame peak (REQ-17). Pure (canvas-free), so it is
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
 * where `lastTs` was reset — leaves the gain alone. (REQ-17)
 */
export function updateWaveGain(gain: number, peak: number, dtSec: number): number {
  if (dtSec <= 0) return gain;
  const target = waveGainTarget(peak);
  const tau = target < gain ? WAVE_GAIN_FALL_TAU : WAVE_GAIN_RISE_TAU;
  return gain + (target - gain) * (1 - Math.exp(-dtSec / tau));
}

/**
 * The Spectrum's **logarithmic** frequency axis (v13, REQ-26..29). The view used
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
const LABEL_FONT = '10px ui-monospace, monospace';

/** One step down, for the zone names — they are annotation, not readout. */
const ZONE_FONT = '9px ui-monospace, monospace';

/** Px per drawn column. The bar loop steps in pixels now, not in bins (REQ-27). */
export const SPECTRUM_COL_W = 3;

/**
 * Px per character at the component's 10px monospace — the width *estimate* that
 * decides tick collisions. Deliberately not `ctx.measureText`: the lifecycle suite
 * drives a proxy 2D context whose methods all return `undefined`, so reading
 * `.width` off one throws there. (REQ-28)
 */
export const TICK_CHAR_W = 6;

/** Minimum px between two tick labels before the crowded one is dropped. */
export const TICK_MIN_GAP = 6;

/** Region width below which zone *names* are dropped; the bands themselves stay. */
export const ZONE_NAME_MIN_W = 300;

/** Px below a region's top edge where zone names sit — clear of the corner buttons. */
export const ZONE_NAME_TOP = 22;

/** The labelled frequencies on the bottom ruler (REQ-28). */
export const SPECTRUM_TICKS_HZ: readonly number[] = [100, 500, 1000, 5000, 10000];

/** A named problem band — what the Zones overlay shades (REQ-29). */
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
 * hover cursor all read from it, so none of them can drift apart. (REQ-26)
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

/** Compact ruler label: `100`, `500`, `1k`, `5k`, `10k`. (REQ-28) */
export function formatHz(hz: number): string {
  if (!Number.isFinite(hz) || hz < 0) return '';
  return hz < 1000 ? `${Math.round(hz)}` : `${toKilo(hz)}k`;
}

/** Spoken form for the hover cursor: `437 Hz`, `1.2 kHz`. (REQ-31) */
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
 * The ruler for a given plot width, with crowded entries pruned (REQ-28). Ticks
 * are accepted in order of **distance from the middle of the set**, so on a panel
 * too narrow for all five the ends of the scale — the ones that establish the
 * range — are the last to go. Pure and canvas-free; `Scope` caches the result per
 * width, because this allocates and the redraw loop must not (REQ-16).
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
 * Fractional bin index at each column's left edge (length `cols + 1`, monotonic).
 * This is the whole of the log mapping the bar loop needs: a column whose span
 * covers a whole bin takes the max over those bins, one narrower than a bin
 * interpolates between its neighbours. (REQ-27)
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

/**
 * The analyser's sample rate, defensively. `AnalyserNode.context` is non-optional
 * in the DOM types but absent on the unit suites' stubs, and an unguarded read
 * would take both of them down.
 */
function sampleRateOf(analyser: AnalyserNode): number {
  const sr = (analyser as { context?: { sampleRate?: number } }).context?.sampleRate;
  return typeof sr === 'number' && sr > 0 ? sr : 48000;
}

export interface ScopeAnalysers {
  /** Mono down-mix (the default view). */
  mono: AnalyserNode;
  /** Left/right channel taps — required for the stereo view. */
  left?: AnalyserNode;
  right?: AnalyserNode;
}

export interface ScopeOptions {
  /**
   * Target redraw rate (frames per second). The loop throttles to this via a
   * timestamp accumulator, so it stays correct on high-refresh displays;
   * `fps >= 60` means "draw every frame". Lower fps cuts main-thread work that
   * contends with the audio callback on weaker devices. Default 60.
   * (perf-mode REQ-6)
   */
  fps?: number;
}

/** Target redraw rate when none is given, and the fallback for a nonsense one. */
const DEFAULT_FPS = 60;

/** Min ms between drawn frames for a target fps; 0 = draw every frame. */
function fpsToInterval(fps: number): number {
  // A non-finite or non-positive rate would give NaN/Infinity here — a loop that
  // spins and never draws, which is the black panel of REQ-22 by another route.
  const f = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  return f >= 60 ? 0 : 1000 / f;
}

/** An analyser paired with its reusable time-domain + frequency buffers. */
interface Channel {
  analyser: AnalyserNode;
  /** Float, not byte: 8-bit quantises to 1/128, which the auto-gain would magnify
   *  into a visible staircase on quiet material. (REQ-18) */
  wave: Float32Array<ArrayBuffer>;
  freq: Uint8Array<ArrayBuffer>;
  /** Held max level in displayed dB for the Spectrum peak-hold; -Infinity = cleared. */
  peakDb: number;
  /** Seconds left on the hold plateau before the held peak starts to fall. */
  peakHoldS: number;
}

export class Scope {
  readonly el: HTMLCanvasElement;
  private mode: ScopeMode = 'wave';
  private channels: ScopeChannels = 'mono';
  private rafId = 0;
  private running = false;
  /** Min ms between drawn frames; 0 = every frame. Set by fps (live via setFps). */
  private frameInterval: number;
  /** rAF timestamp of the last drawn frame; throttles the loop to frameInterval. */
  private lastDrawTs = 0;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly mono: Channel;
  private readonly left: Channel | null;
  private readonly right: Channel | null;
  private bitmapW = 0;
  private bitmapH = 0;
  /** Cached CSS layout box + devicePixelRatio, refreshed only by the ResizeObserver. */
  private cssW = 0;
  private cssH = 0;
  /** Spectrum gradients per region box — allocated once, not per frame. */
  private readonly gradCache = new Map<string, CanvasGradient>();
  /** Column→bin boundaries per (cols, fftSize, sampleRate) — see REQ-27. */
  private readonly edgeCache = new Map<string, Float32Array>();
  /** Pruned ruler per (regionW, fMax) — `visibleTicks` allocates, the loop must not. */
  private readonly tickCache = new Map<string, SpectrumTick[]>();
  /** Problem-band overlay (REQ-29). Spectrum-only, memory-only, default off. */
  private zones = false;
  /** Pointer position in canvas CSS px while hovering the Spectrum; null = none. */
  private hoverX: number | null = null;
  private hoverY: number | null = null;
  /** Whether the hover listeners are currently attached (they are mode-scoped). */
  private hoverBound = false;
  /** Cached cursor label + the rounded Hz it was built from (no per-frame string). */
  private cursorHz = -1;
  private cursorLabel = '';
  /** Whether a region actually drew the cursor this frame — see the end of `draw`. */
  private cursorShown = false;
  private dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  private ro: ResizeObserver | null = null;
  /** Last value mirrored to each dataset key — lets us skip redundant per-frame writes. */
  private readonly mirrored: {
    peak: string; peakL: string; peakR: string; waveGain: string; zones: string; cursorHz: string;
  } = { peak: '', peakL: '', peakR: '', waveGain: '', zones: '', cursorHz: '' };
  /** Timestamp of the previous drawn frame; 0 = none yet (peak decay is dt-based). */
  private lastTs = 0;
  /**
   * Wave auto-gain, shared by *every* region rather than held per channel (REQ-17):
   * per-channel gains would blow a hard-panned quiet side up to match the loud one
   * and erase the stereo image the Stereo view exists to show.
   */
  private waveGain = 1;
  /**
   * Max |sample| seen across all regions in the frame being drawn. It feeds the
   * *next* frame's gain — accumulating it during the draw pass costs nothing,
   * whereas a pre-pass to get it first would double the per-sample work. (REQ-18)
   */
  private wavePeak = 0;

  constructor(analysers: ScopeAnalysers, opts: ScopeOptions = {}) {
    this.frameInterval = fpsToInterval(opts.fps ?? DEFAULT_FPS);
    this.el = document.createElement('canvas');
    this.el.className = styles.root!;
    this.el.dataset.testid = 'scope-canvas';
    this.ctx = this.el.getContext('2d');
    this.mono = makeChannel(analysers.mono);
    this.left = analysers.left ? makeChannel(analysers.left) : null;
    this.right = analysers.right ? makeChannel(analysers.right) : null;
    // Pause the redraw loop while the tab is hidden — a backgrounded scope is
    // pure wasted main-thread work that can starve the audio thread on mobile.
    document.addEventListener('visibilitychange', this.onVisibility);
    // Clicking the graph resets the Spectrum peak-hold. The listener is on the
    // canvas itself; the Wave/Spectrum + Mono/Stereo buttons are siblings (not
    // children) of it, so clicking a button never resets — "anywhere but the
    // buttons" with no stopPropagation needed. (REQ-13)
    this.el.addEventListener('click', this.onClick);
    // A backgrounded tab can have its canvas backing store reclaimed. The
    // browser only ever restores a lost 2D context if the page asks it to, so
    // these two are the difference between "blank for a moment" and "blank for
    // the life of the page" (REQ-24).
    this.el.addEventListener('contextlost', this.onContextLost);
    this.el.addEventListener('contextrestored', this.onContextRestored);
    // A bfcache restore can reach a visible page without a visibilitychange
    // (REQ-25) — and it is exactly the path that drops a queued frame.
    window.addEventListener('pageshow', this.onVisibility);
    // Track the canvas's layout box so the rAF loop never reads clientWidth/Height
    // (a per-frame forced reflow). jsdom (unit tests) has no ResizeObserver — the
    // draw path measures itself in that case (see syncSize).
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.measure());
      this.ro.observe(this.el);
    }
    this.start();
  }

  setMode(m: ScopeMode): void {
    this.mode = m;
    // Leaving Spectrum must drop the held-peak readout; re-entering re-acquires it.
    this.clearDatasetMirror();
    // The cursor belongs to the Spectrum's frequency axis, so it goes with it —
    // and its listeners are attached only while that axis is on screen (REQ-31).
    this.clearHover();
    if (m === 'spectrum') { this.bindHover(); this.mirrorZones(); } else this.unbindHover();
  }

  /** Show/hide the problem-band overlay. Spectrum-only, memory-only. (REQ-29) */
  setZones(on: boolean): void {
    this.zones = on;
    this.mirrorZones();
  }

  /** Whether the problem-band overlay is on. */
  get zonesOn(): boolean { return this.zones; }

  /** Clear the Spectrum peak-hold (also bound to a canvas click). (REQ-13) */
  resetPeak(): void {
    for (const c of [this.mono, this.left, this.right]) {
      if (!c) continue;
      c.peakDb = -Infinity;
      c.peakHoldS = 0;
    }
    this.clearDatasetMirror();
  }

  /** Switch mono/stereo. Stereo needs both channel analysers; falls back to mono. */
  setChannels(c: ScopeChannels): void {
    this.channels = c === 'stereo' && this.left && this.right ? 'stereo' : 'mono';
    // The set of active peak keys (peak vs peakL/peakR) changes with the layout.
    this.clearDatasetMirror();
  }

  /** The effective channel layout (mono unless stereo was set with both analysers). */
  get channelMode(): ScopeChannels { return this.channels; }

  private readonly onVisibility = (): void => {
    if (document.hidden) { this.stop(); return; }
    // ResizeObserver will not fire for a box that comes back the size it left,
    // so a hidden spell that zeroed the layout would otherwise leave `cssW/cssH`
    // stale and every draw early-returning. `measure()` refuses a 0×0 read, so
    // this can only help (REQ-25).
    this.measure();
    this.start();
  };

  /**
   * Without `preventDefault()` here the browser never restores the context and
   * the panel stays blank forever — the whole of REQ-24 is this one line.
   */
  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.stop();
  };

  private readonly onContextRestored = (): void => {
    // The restored context comes back with a blank bitmap of unknown size and
    // no cached gradients; force `measure()` past its unchanged-size check.
    this.dropCaches();
    this.bitmapW = 0;
    this.bitmapH = 0;
    this.measure();
    this.start();
  };

  private readonly onClick = (): void => { this.resetPeak(); };

  /**
   * Hover cursor (REQ-31). `offsetX/offsetY` are already relative to the canvas's
   * padding box, so this forces no layout — a `getBoundingClientRect()` here would
   * be a reflow on every pointer move. Mouse only: hover has no touch equivalent,
   * and a finger drag that left a cursor line behind reads as a bug.
   */
  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    this.hoverX = e.offsetX;
    this.hoverY = e.offsetY;
  };

  private readonly onPointerLeave = (): void => { this.clearHover(); };

  private bindHover(): void {
    if (this.hoverBound) return;
    this.el.addEventListener('pointermove', this.onPointerMove);
    this.el.addEventListener('pointerleave', this.onPointerLeave);
    this.hoverBound = true;
  }

  private unbindHover(): void {
    if (!this.hoverBound) return;
    this.el.removeEventListener('pointermove', this.onPointerMove);
    this.el.removeEventListener('pointerleave', this.onPointerLeave);
    this.hoverBound = false;
  }

  private clearHover(): void {
    this.hoverX = null;
    this.hoverY = null;
    this.cursorHz = -1;
    this.cursorLabel = '';
    this.mirrorCursor('');
  }

  /** The channel feeding a region tag (left/right fall back to mono if absent). */
  private channelFor(tag: ScopeRegion['tag']): Channel {
    if (tag === 'left') return this.left ?? this.mono;
    if (tag === 'right') return this.right ?? this.mono;
    return this.mono;
  }

  /**
   * Measure the canvas layout box and resize its bitmap to match. This reads
   * layout (clientWidth/Height) so it runs only from the ResizeObserver (on an
   * actual resize), never from the rAF loop. The cached CSS size + dpr feed `draw`.
   */
  private measure(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (w === 0 || h === 0) return;
    this.dropCaches(); // region boxes moved — gradients, ruler and bin edges are stale
    this.cssW = w;
    this.cssH = h;
    this.dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * this.dpr);
    const bh = Math.round(h * this.dpr);
    if (bw !== this.bitmapW || bh !== this.bitmapH) {
      this.el.width = bw;
      this.el.height = bh;
      this.bitmapW = bw;
      this.bitmapH = bh;
    }
  }

  /** Ready-to-draw guard from the cached size — no layout read in the rAF loop. */
  private syncSize(): boolean {
    // No ResizeObserver (jsdom): keep the old behaviour and measure on each draw.
    if (!this.ro) this.measure();
    return this.cssW > 0 && this.cssH > 0;
  }

  /** Change the target redraw rate live (e.g. a perf-mode tier switch). */
  setFps(fps: number): void {
    // `fpsToInterval` rejects a non-finite or non-positive rate for us.
    this.frameInterval = fpsToInterval(fps);
  }

  /**
   * Change the analyser FFT size live (a perf-mode tier switch). `AnalyserNode.fftSize`
   * is settable at runtime — no graph rebuild — but the reusable read buffers are sized
   * to it, so reallocate each channel's `wave`/`freq` to match the new size.
   */
  setFftSize(fftSize: number): void {
    for (const c of [this.mono, this.left, this.right]) {
      if (!c) continue;
      c.analyser.fftSize = fftSize;
      c.wave = new Float32Array(c.analyser.fftSize);
      c.freq = new Uint8Array(new ArrayBuffer(c.analyser.frequencyBinCount));
    }
    // The column→bin mapping is keyed on fftSize, so it is now stale (REQ-27).
    this.dropCaches();
  }

  /**
   * Drop everything derived from the canvas box, the fftSize or the sample rate.
   * The three callers are the three moments any of those can change: a resize, a
   * perf-tier fftSize switch, and a restored (blank, unsized) canvas context.
   */
  private dropCaches(): void {
    this.gradCache.clear();
    this.edgeCache.clear();
    this.tickCache.clear();
  }

  /** Cached column→bin boundaries — allocating this per frame is the thing REQ-16 forbids. */
  private binEdges(cols: number, fftSize: number, sampleRate: number): Float32Array {
    const key = `${cols}:${fftSize}:${sampleRate}`;
    let edges = this.edgeCache.get(key);
    if (!edges) {
      edges = columnBinEdges(cols, fftSize, sampleRate);
      this.edgeCache.set(key, edges);
    }
    return edges;
  }

  /** Cached ruler for a plot width — `visibleTicks` sorts and allocates. */
  private ticksFor(regionW: number, fMax: number): SpectrumTick[] {
    const key = `${Math.round(regionW)}:${fMax}`;
    let ticks = this.tickCache.get(key);
    if (!ticks) {
      ticks = visibleTicks(regionW, fMax);
      this.tickCache.set(key, ticks);
    }
    return ticks;
  }

  /**
   * Start (or restart) the redraw loop. Deliberately **not** guarded on
   * `running` (REQ-22): that guard was the only thing between a broken frame
   * chain and recovery. A frame the browser dropped while freezing the renderer,
   * or one that threw before re-arming, left `running` latched true with nothing
   * queued — and then every restart path in this component was a no-op, forever.
   * Cancelling first means a restart on a healthy loop is still exactly one
   * callback in flight.
   */
  private start(): void {
    cancelAnimationFrame(this.rafId);
    this.running = true;
    // Throttle to frameInterval using the rAF timestamp, not a frame counter — a
    // counter would lock to the display's refresh rate (wrong on 120Hz panels).
    const loop = (now: number) => {
      if (!this.running) return;
      // Re-arm BEFORE drawing (REQ-23). A throw in draw() then still reaches the
      // console — an invisible error is how this shipped — but the next frame is
      // already queued, so one bad frame cannot end the loop.
      this.rafId = requestAnimationFrame(loop);
      if (now - this.lastDrawTs >= this.frameInterval) {
        this.lastDrawTs = now;
        this.draw();
      }
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    // Forget the last frame time so the first frame after resuming has dt 0 — the
    // peak-hold must not decay across the (possibly long) paused-while-hidden gap.
    this.lastTs = 0;
  }

  private draw(): void {
    if (!this.syncSize()) return;
    const ctx = this.ctx;
    if (!ctx) return;
    // Seconds since the previous frame, clamped — drives the dt-based peak decay
    // identically at ~30/60fps. The clamp caps any residual gap after a pause.
    const now = performance.now();
    const dt = this.lastTs ? Math.min((now - this.lastTs) / 1000, 0.1) : 0;
    this.lastTs = now;
    const dpr = this.dpr;
    // Set transform fresh each frame — no compounding.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Cached CSS box (kept in sync by the ResizeObserver) — no per-frame layout read.
    const w = this.cssW;
    const h = this.cssH;
    ctx.clearRect(0, 0, w, h);

    if (this.mode === 'wave') {
      // Gain for THIS frame comes from the LAST frame's peak (one frame ≈ 16ms of
      // lag — imperceptible, and it buys a single-pass draw). Only while in Wave, so
      // the gain freezes in Spectrum exactly as the peak-hold freezes in Wave.
      this.waveGain = updateWaveGain(this.waveGain, this.wavePeak, dt);
      this.wavePeak = 0;
      this.mirrorWaveGain();
    }

    this.cursorShown = false;

    // One renderer drives every region (DRY): mono = 1 region, stereo = 2.
    for (const region of scopeRegions(this.channels, w, h)) {
      const channel = this.channelFor(region.tag);
      if (this.mode === 'wave') this.drawWave(ctx, channel, region);
      else this.drawSpectrum(ctx, channel, region, dt);
      if (region.label) this.drawLabel(ctx, region);
    }

    // The pointer can be inside the canvas but outside every region — the stereo
    // centre gutter — where there is no frequency to report. No region drew a
    // cursor, so the readout must not keep showing the last one.
    if (!this.cursorShown && this.mirrored.cursorHz) {
      this.cursorHz = -1;
      this.mirrorCursor('');
    }
  }

  /** Faint horizontal mid-line for a region (vintage CRT look). */
  private spectrumGradient(ctx: CanvasRenderingContext2D, r: ScopeRegion): CanvasGradient {
    const key = `${r.y}:${r.h}`;
    let grad = this.gradCache.get(key);
    if (!grad) {
      grad = ctx.createLinearGradient(0, r.y + r.h, 0, r.y);
      grad.addColorStop(0, '#e8742e');
      grad.addColorStop(0.6, '#f4cd5e');
      grad.addColorStop(1, '#ff3a20');
      this.gradCache.set(key, grad);
    }
    return grad;
  }

  private drawMidline(ctx: CanvasRenderingContext2D, r: ScopeRegion): void {
    const midY = r.y + r.h / 2;
    ctx.strokeStyle = 'rgba(244, 205, 94, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(r.x, midY);
    ctx.lineTo(r.x + r.w, midY);
    ctx.stroke();
  }

  /**
   * Every string this component draws goes through here (REQ-30): a dark outline
   * under the fill, so a label sitting on top of a full-height bar stays readable.
   * It is an outline rather than a `shadowBlur` — omnidirectional, crisper at
   * 10px, and it does not reintroduce canvas shadows to a component that dropped
   * them for cost (REQ-8). Eight short strings a frame is a different order of
   * expense from shadowing every bar.
   */
  private haloText(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string,
  ): void {
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  private drawLabel(ctx: CanvasRenderingContext2D, r: ScopeRegion): void {
    ctx.font = LABEL_FONT;
    // Bottom-left: the corner overlay buttons (Mono/Stereo top-left, Wave/Spectrum
    // top-right) sit flush with the canvas corners, so a top-anchored label hides
    // behind them. Same dodge the peak-dB readout makes by centring. (REQ-6)
    ctx.textBaseline = 'bottom';
    this.haloText(ctx, r.label, r.x + 4, r.y + r.h - 4, 'rgba(244, 205, 94, 0.6)');
  }

  private drawWave(ctx: CanvasRenderingContext2D, channel: Channel, r: ScopeRegion): void {
    this.drawMidline(ctx, r);
    channel.analyser.getFloatTimeDomainData(channel.wave);
    const data = channel.wave;
    const midY = r.y + r.h / 2;
    const amp = r.h / 2 - 4;
    const gain = this.waveGain;
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = '#e8742e';
    ctx.beginPath();
    const len = data.length;
    // One pass: draw the scaled sample *and* accumulate the raw peak that will set
    // the next frame's gain. The two extra ops per sample sit inside a loop already
    // issuing a lineTo, so the auto-gain costs nothing measurable. (REQ-18)
    let peak = this.wavePeak;
    for (let i = 0; i < len; i++) {
      const x = r.x + (i / (len - 1)) * r.w;
      const v = data[i] ?? 0;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      // Clamp *after* the gain: there is no ctx.clip(), so an un-clamped overshoot
      // during the fast fall would paint into the neighbouring stereo region.
      const s = v * gain;
      const y = midY + (s < -1 ? -1 : s > 1 ? 1 : s) * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    this.wavePeak = peak;
    ctx.stroke();
  }

  private drawSpectrum(
    ctx: CanvasRenderingContext2D,
    channel: Channel,
    r: ScopeRegion,
    dtSec: number,
  ): void {
    this.drawMidline(ctx, r);
    const analyser = channel.analyser;
    analyser.getByteFrequencyData(channel.freq);
    const data = channel.freq;
    const sampleRate = sampleRateOf(analyser);
    const fMax = Math.min(SPECTRUM_F_MAX, sampleRate / 2);
    // The plot is the whole region: no gutter is reserved for the Zones button.
    // On a panel narrow enough for the two to meet, the top tick label goes behind
    // the button — a deliberate trade, because reserving the width cost every
    // region a dead strip (and put an 80px hole down the middle of side-by-side
    // stereo) to protect one label at one end. (REQ-29)
    const cols = Math.max(1, Math.floor(r.w / SPECTRUM_COL_W));
    const edges = this.binEdges(cols, analyser.fftSize, sampleRate);

    // Bands go behind the bars; their names go in front, further down.
    if (this.zones) this.drawZoneBands(ctx, r, fMax);

    const maxByte = this.drawBars(ctx, r, data, edges, cols);

    // Peak-hold: pushed up by the loudest visible bar, held briefly, then falls slowly.
    const next = updatePeak(
      { db: channel.peakDb, holdS: channel.peakHoldS },
      byteToDisplayDb(maxByte),
      dtSec,
    );
    channel.peakDb = next.db;
    channel.peakHoldS = next.holdS;
    this.drawPeak(ctx, r, channel.peakDb);
    this.mirrorPeak(r.tag, channel.peakDb);
    this.drawTicks(ctx, r, fMax);
    if (this.zones) this.drawZoneNames(ctx, r, fMax);
    this.drawCursor(ctx, r, fMax);
  }

  /**
   * The bars themselves, and the raw peak byte they were drawn from (REQ-27).
   * Column-based, not bin-based: a log axis maps the two ends of the spectrum in
   * opposite directions, so a column covering whole bins takes the **max** over
   * them (a narrow peak must never be averaged away) while a column narrower than
   * a bin **interpolates** between its neighbours (otherwise the bottom third is
   * three flat plateaus, which is what makes a naive log analyser look broken).
   */
  private drawBars(
    ctx: CanvasRenderingContext2D,
    r: ScopeRegion,
    data: Uint8Array,
    edges: Float32Array,
    cols: number,
  ): number {
    ctx.fillStyle = this.spectrumGradient(ctx, r);
    const nBins = data.length;
    const colW = r.w / cols;
    const barW = Math.max(1, colW - 1);
    const maxH = r.h - 2;
    let maxByte = 0;
    for (let c = 0; c < cols; c++) {
      const b0 = edges[c] ?? 0;
      const b1 = edges[c + 1] ?? 0;
      let level: number;
      if (b1 - b0 >= 1) {
        const lo = Math.max(0, Math.floor(b0));
        const hi = Math.min(nBins - 1, Math.ceil(b1) - 1);
        let m = 0;
        for (let i = lo; i <= hi; i++) { const b = data[i] ?? 0; if (b > m) m = b; }
        level = m;
        if (m > maxByte) maxByte = m;
      } else {
        const mid = (b0 + b1) / 2;
        const i0 = Math.min(nBins - 1, Math.max(0, Math.floor(mid)));
        const i1 = Math.min(nBins - 1, i0 + 1);
        const a = data[i0] ?? 0;
        const b = data[i1] ?? 0;
        level = a + (b - a) * (mid - i0);
        // The held peak reads RAW bins, never the interpolation (REQ-27).
        if (a > maxByte) maxByte = a;
        if (b > maxByte) maxByte = b;
      }
      const bh = (level / 255) * maxH;
      if (bh < 0.5) continue;
      ctx.fillRect(r.x + c * colW, r.y + r.h - bh, barW, bh);
    }
    return maxByte;
  }

  /**
   * Canvas x of a frequency inside a region — the one place a Hz becomes a pixel,
   * so the bands, their names and anything added later cannot drift apart.
   */
  private xForFreq(r: ScopeRegion, hz: number, fMax: number): number {
    return r.x + freqToFrac(hz, fMax) * r.w;
  }

  /** The shaded problem bands, behind the bars. (REQ-29) */
  private drawZoneBands(ctx: CanvasRenderingContext2D, r: ScopeRegion, fMax: number): void {
    ctx.fillStyle = 'rgba(244, 205, 94, 0.08)';
    for (const z of SPECTRUM_ZONES) {
      const x0 = this.xForFreq(r, z.from, fMax);
      ctx.fillRect(x0, r.y, this.xForFreq(r, z.to, fMax) - x0, r.h);
    }
  }

  /**
   * The band names, in front of the bars. Inset from the region top so they clear
   * the two corner overlay buttons, and dropped entirely on a region too narrow to
   * hold them — the shading still says where the band is. (REQ-29)
   */
  private drawZoneNames(ctx: CanvasRenderingContext2D, r: ScopeRegion, fMax: number): void {
    if (r.w < ZONE_NAME_MIN_W || r.h < ZONE_NAME_TOP + 12) return;
    ctx.save();
    ctx.font = ZONE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const z of SPECTRUM_ZONES) {
      const mid = (this.xForFreq(r, z.from, fMax) + this.xForFreq(r, z.to, fMax)) / 2;
      this.haloText(ctx, z.name, mid, r.y + ZONE_NAME_TOP, 'rgba(244, 205, 94, 0.75)');
    }
    ctx.restore();
  }

  /** The bottom ruler: a short tick per labelled frequency, the label above it. (REQ-28) */
  private drawTicks(ctx: CanvasRenderingContext2D, r: ScopeRegion, fMax: number): void {
    const ticks = this.ticksFor(r.w, fMax);
    const bottom = r.y + r.h;
    ctx.save();
    ctx.strokeStyle = 'rgba(244, 205, 94, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const t of ticks) {
      const x = Math.round(r.x + t.x) + 0.5;
      ctx.moveTo(x, bottom);
      ctx.lineTo(x, bottom - 4);
    }
    ctx.stroke();
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const t of ticks) {
      this.haloText(ctx, t.label, r.x + t.labelX, bottom - 5, 'rgba(244, 205, 94, 0.75)');
    }
    ctx.restore();
  }

  /**
   * The hover cursor: a line at the pointer and the frequency under it (REQ-31).
   * Drawn only for the region the pointer is actually in, so in Stereo you read
   * the channel you are pointing at. The label rides the pointer's own Y and flips
   * side at the halfway mark, which keeps it clear of the corner chrome without a
   * fixed anchor that could collide.
   */
  private drawCursor(ctx: CanvasRenderingContext2D, r: ScopeRegion, fMax: number): void {
    const hx = this.hoverX;
    const hy = this.hoverY;
    if (hx === null || hy === null) return;
    if (hx < r.x || hx > r.x + r.w || hy < r.y || hy > r.y + r.h) return;
    const frac = (hx - r.x) / r.w;
    const hz = fracToFreq(frac, fMax);
    const rounded = hz < 1000 ? Math.round(hz) : Math.round(hz / 100) * 100;
    this.cursorShown = true;
    if (rounded !== this.cursorHz) {
      this.cursorHz = rounded;
      this.cursorLabel = formatHzFull(hz);
      this.mirrorCursor(`${rounded}`);
    }
    ctx.save();
    ctx.strokeStyle = 'rgba(244, 205, 94, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x = Math.round(hx) + 0.5;
    ctx.moveTo(x, r.y);
    ctx.lineTo(x, r.y + r.h);
    ctx.stroke();
    ctx.font = LABEL_FONT;
    const left = frac > 0.5;
    ctx.textAlign = left ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    this.haloText(ctx, this.cursorLabel, hx + (left ? -5 : 5), hy, '#f4cd5e');
    ctx.restore();
  }

  /** The dotted max-dB peak-hold line + its dB label for one region. (REQ-10/11) */
  private drawPeak(ctx: CanvasRenderingContext2D, r: ScopeRegion, peakDb: number): void {
    if (!Number.isFinite(peakDb)) return;
    const y = r.y + r.h - dbToFrac(peakDb) * (r.h - 2);
    // Turn the red accent on as the peak approaches 0 dB (clip).
    const color = peakDb >= -0.05 ? '#ff3a20' : 'rgba(244, 205, 94, 0.9)';
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(r.x, y);
    ctx.lineTo(r.x + r.w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = LABEL_FONT;
    // Centre the value within the region so it can't hide behind the corner buttons.
    ctx.textAlign = 'center';
    // Flip the label below the line when it's hugging the top edge.
    const near = y < r.y + 12;
    ctx.textBaseline = near ? 'top' : 'bottom';
    this.haloText(ctx, `${peakDb.toFixed(1)} dB`, r.x + r.w / 2, near ? y + 2 : y - 2, color);
    ctx.restore();
  }

  /**
   * Mirror a region's held peak onto the canvas dataset for E2E (REQ-15) — but only
   * when the formatted value changes, so a steady scope writes no attribute per frame
   * (a per-frame `data-*` write would dirty layout). The mirror still always reflects
   * the latest displayed value.
   */
  private mirrorPeak(tag: ScopeRegion['tag'], peakDb: number): void {
    const key = tag === 'left' ? 'peakL' : tag === 'right' ? 'peakR' : 'peak';
    const v = Number.isFinite(peakDb) ? peakDb.toFixed(1) : '';
    if (this.mirrored[key] === v) return;
    this.mirrored[key] = v;
    if (v) this.el.dataset[key] = v;
    else delete this.el.dataset[key];
  }

  /**
   * Mirror the applied Wave gain for E2E, under the same change-only-write rule as
   * `mirrorPeak` — a steady scope writes no attribute per frame (REQ-15/16/18).
   */
  private mirrorWaveGain(): void {
    const v = this.waveGain.toFixed(1);
    if (this.mirrored.waveGain === v) return;
    this.mirrored.waveGain = v;
    this.el.dataset.waveGain = v;
  }

  /**
   * Drop every mirrored value. Only called on rare transitions (Wave/Mono-Stereo
   * switch, reset) — never per frame — so it clears unconditionally for correctness.
   */
  private clearDatasetMirror(): void {
    for (const key of ['peak', 'peakL', 'peakR', 'waveGain', 'zones', 'cursorHz'] as const) {
      this.mirrored[key] = '';
      delete this.el.dataset[key];
    }
  }

  /** Mirror the overlay state for E2E — Spectrum-only, so cleared in Wave. (REQ-29) */
  private mirrorZones(): void {
    const v = this.mode === 'spectrum' ? (this.zones ? 'on' : 'off') : '';
    if (this.mirrored.zones === v) return;
    this.mirrored.zones = v;
    if (v) this.el.dataset.zones = v;
    else delete this.el.dataset.zones;
  }

  /**
   * Mirror the frequency under the cursor. Written only when the rounded value
   * changes, and only while a mouse is over the graph — so a scope nobody is
   * pointing at still performs no attribute write at all. (REQ-15/31)
   */
  private mirrorCursor(v: string): void {
    if (this.mirrored.cursorHz === v) return;
    this.mirrored.cursorHz = v;
    if (v) this.el.dataset.cursorHz = v;
    else delete this.el.dataset.cursorHz;
  }

  destroy(): void {
    this.stop();
    this.unbindHover();
    this.ro?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pageshow', this.onVisibility);
    this.el.removeEventListener('click', this.onClick);
    this.el.removeEventListener('contextlost', this.onContextLost);
    this.el.removeEventListener('contextrestored', this.onContextRestored);
  }
}

function makeChannel(analyser: AnalyserNode): Channel {
  return {
    analyser,
    wave: new Float32Array(analyser.fftSize),
    freq: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
    peakDb: -Infinity,
    peakHoldS: 0,
  };
}
