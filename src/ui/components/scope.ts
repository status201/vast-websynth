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

/** Min ms between drawn frames for a target fps; 0 = draw every frame. */
function fpsToInterval(fps: number): number {
  return fps >= 60 ? 0 : 1000 / fps;
}

/** An analyser paired with its reusable time-domain + frequency buffers. */
interface Channel {
  analyser: AnalyserNode;
  wave: Uint8Array<ArrayBuffer>;
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
  private dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  private ro: ResizeObserver | null = null;
  /** Last value mirrored to each dataset key — lets us skip redundant per-frame writes. */
  private readonly mirrored: { peak: string; peakL: string; peakR: string } =
    { peak: '', peakL: '', peakR: '' };
  /** Timestamp of the previous drawn frame; 0 = none yet (peak decay is dt-based). */
  private lastTs = 0;

  constructor(analysers: ScopeAnalysers, opts: ScopeOptions = {}) {
    this.frameInterval = fpsToInterval(opts.fps ?? 60);
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
    this.clearPeakDataset();
  }

  /** Clear the Spectrum peak-hold (also bound to a canvas click). (REQ-13) */
  resetPeak(): void {
    for (const c of [this.mono, this.left, this.right]) {
      if (!c) continue;
      c.peakDb = -Infinity;
      c.peakHoldS = 0;
    }
    this.clearPeakDataset();
  }

  /** Switch mono/stereo. Stereo needs both channel analysers; falls back to mono. */
  setChannels(c: ScopeChannels): void {
    this.channels = c === 'stereo' && this.left && this.right ? 'stereo' : 'mono';
    // The set of active peak keys (peak vs peakL/peakR) changes with the layout.
    this.clearPeakDataset();
  }

  /** The effective channel layout (mono unless stereo was set with both analysers). */
  get channelMode(): ScopeChannels { return this.channels; }

  private readonly onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private readonly onClick = (): void => { this.resetPeak(); };

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
    this.gradCache.clear(); // region boxes moved — cached gradients are stale
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
    this.frameInterval = fpsToInterval(fps);
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    // Throttle to frameInterval using the rAF timestamp, not a frame counter — a
    // counter would lock to the display's refresh rate (wrong on 120Hz panels).
    const loop = (now: number) => {
      if (!this.running) return;
      if (now - this.lastDrawTs >= this.frameInterval) {
        this.lastDrawTs = now;
        this.draw();
      }
      this.rafId = requestAnimationFrame(loop);
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

    // One renderer drives every region (DRY): mono = 1 region, stereo = 2.
    for (const region of scopeRegions(this.channels, w, h)) {
      const channel = this.channelFor(region.tag);
      if (this.mode === 'wave') this.drawWave(ctx, channel, region);
      else this.drawSpectrum(ctx, channel, region, dt);
      if (region.label) this.drawLabel(ctx, region);
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

  private drawLabel(ctx: CanvasRenderingContext2D, r: ScopeRegion): void {
    ctx.fillStyle = 'rgba(244, 205, 94, 0.4)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(r.label, r.x + 4, r.y + 4);
  }

  private drawWave(ctx: CanvasRenderingContext2D, channel: Channel, r: ScopeRegion): void {
    this.drawMidline(ctx, r);
    channel.analyser.getByteTimeDomainData(channel.wave);
    const data = channel.wave;
    const midY = r.y + r.h / 2;
    const amp = r.h / 2 - 4;
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = '#e8742e';
    ctx.beginPath();
    const len = data.length;
    for (let i = 0; i < len; i++) {
      const x = r.x + (i / (len - 1)) * r.w;
      const v = ((data[i] ?? 128) - 128) / 128;
      const y = midY + v * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  private drawSpectrum(
    ctx: CanvasRenderingContext2D,
    channel: Channel,
    r: ScopeRegion,
    dtSec: number,
  ): void {
    this.drawMidline(ctx, r);
    channel.analyser.getByteFrequencyData(channel.freq);
    const data = channel.freq;
    const used = Math.floor(data.length * 0.6);
    const barW = r.w / used;
    ctx.fillStyle = this.spectrumGradient(ctx, r);
    let maxByte = 0;
    for (let i = 0; i < used; i++) {
      const b = data[i] ?? 0;
      if (b > maxByte) maxByte = b;
      const bh = (b / 255) * (r.h - 2);
      if (bh < 0.5) continue;
      ctx.fillRect(r.x + i * barW, r.y + r.h - bh, Math.max(1, barW - 1), bh);
    }

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
    ctx.fillStyle = color;
    ctx.font = '10px ui-monospace, monospace';
    // Centre the value within the region so it can't hide behind the corner buttons.
    ctx.textAlign = 'center';
    // Flip the label below the line when it's hugging the top edge.
    const near = y < r.y + 12;
    ctx.textBaseline = near ? 'top' : 'bottom';
    ctx.fillText(`${peakDb.toFixed(1)} dB`, r.x + r.w / 2, near ? y + 2 : y - 2);
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
   * Drop every mirrored peak. Only called on rare transitions (Wave/Mono-Stereo
   * switch, reset) — never per frame — so it clears unconditionally for correctness.
   */
  private clearPeakDataset(): void {
    for (const key of ['peak', 'peakL', 'peakR'] as const) {
      this.mirrored[key] = '';
      delete this.el.dataset[key];
    }
  }

  destroy(): void {
    this.stop();
    this.ro?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.el.removeEventListener('click', this.onClick);
  }
}

function makeChannel(analyser: AnalyserNode): Channel {
  return {
    analyser,
    wave: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
    freq: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
    peakDb: -Infinity,
    peakHoldS: 0,
  };
}
