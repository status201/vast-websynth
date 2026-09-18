import type { ParamBus } from '../../state/params';
import {
  EQ_BANDS, EQ_BAND_COUNT, EQ_GAIN_MAX,
  eqCurveParamIds, eqResponseDb, readEqSettings, type EqSettings,
} from '../../state/eq';
import {
  SPECTRUM_ZONES, freqToFrac, fracToFreq, formatHzFull, visibleTicks,
} from './scope';
import { haloText } from './canvas-text';
import { clamp } from '../../utils/math';
import styles from '../styles/eq.module.css';

/**
 * The drawable EQ curve — `specs/features/equalizer.md` REQ-the-curve-is-drawn-by-dragging/REQ-the-graph-computes-from-bus-values/REQ-the-drawn-curve-is-exact.
 *
 * Two properties are worth stating up front because they are what the component
 * is *for*, and both are easy to lose in a later edit:
 *
 * 1. **It runs no animation loop.** The curve is a pure function of twelve bus
 *    params, so it repaints when one changes and at no other time. A dozen writes
 *    in one turn (a preset) coalesce into a single frame. At rest this costs
 *    nothing at all — which is the only reason an EQ per lane is affordable.
 * 2. **It reaches for no audio node.** The response comes from `state/eq.ts`,
 *    the same table the filters are built from, so the drawing needs neither an
 *    `AnalyserNode` nor a `StudioApi` member and the UI/audio separation
 *    (architecture REQ-ui-and-audio-never-call-each-other, ADR-009) is untouched.
 *
 * The frequency axis is imported from `Scope` rather than re-derived, so a curve
 * drawn here and a spectrum drawn there put the same Hz at the same x.
 */

/** Vertical half-range of the plot, in dB. Slightly past the param's ±18 so a
 *  band pinned at full cut still has its curve inside the box. */
const DB_VIEW = 21;

/** Bottom strip reserved for the frequency ruler. */
const RULER_H = 13;

const LABEL_FONT = '10px ui-monospace, monospace';
const BAND_FONT = '8px ui-monospace, monospace';

const INK = '#f4cd5e';
const GRID = 'rgba(244, 205, 94, 0.10)';
const ZERO_LINE = 'rgba(244, 205, 94, 0.22)';
const CURVE = '#e8742e';
const ZONE_FILL = 'rgba(244, 205, 94, 0.05)';

/**
 * How near a band's dot a double-tap must land to reset it, in CSS px. Used only
 * by the reset: a drag walks every band it crosses and needs no grab radius, but
 * a reset has to name exactly one band, and "the nearest band" alone would let a
 * double-tap far out in a gap silently zero something the user was not pointing
 * at. Roughly half the narrowest band column at the desktop width.
 */
const RESET_GRAB_PX = 26;

/** Hand-rolled, because `dblclick` is unreliable on touch (the scratch graph's
 *  finding, and the same constant). */
const DOUBLE_MS = 300;

export interface EqGraphOpts {
  bus: ParamBus;
  /** `fx.eq`, `fx.drum.eq` or `fx.sampler.eq`. */
  prefix: string;
  /** Lane suffix for the testid, e.g. `seq`. */
  lane: string;
  /** The real context rate — the response of a digital filter depends on it. */
  sampleRate: number;
}

export class EqGraph {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D | null;
  private readonly bus: ParamBus;
  private readonly prefix: string;
  private readonly sampleRate: number;

  private readonly unsubs: Array<() => void> = [];
  private ro: ResizeObserver | null = null;

  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private bitmapW = 0;
  private bitmapH = 0;

  private visible = true;
  private dirty = true;
  private rafId = 0;

  /** Drag state. Held only for the duration of a gesture (runtime-performance REQ-global-listeners-live-only-for-a-gesture). */
  private dragging = false;
  private lastBand = -1;
  private lastY = 0;
  private lastTapAt = 0;
  private lastTapBand = -1;
  private rect: DOMRect | null = null;
  private onMove: ((e: PointerEvent) => void) | null = null;
  private onUp: ((e: PointerEvent) => void) | null = null;

  /** Hover readout, desktop only — never the sole route to anything. */
  private hoverX = -1;

  /** Last value written to `data-eq-curve`, so a repaint that changes nothing
   *  writes no attribute (runtime-performance REQ-dom-writes-are-guarded-on-what-is-rendered). */
  private mirroredCurve = '';

  constructor(opts: EqGraphOpts) {
    this.bus = opts.bus;
    this.prefix = opts.prefix;
    this.sampleRate = opts.sampleRate;

    this.el = document.createElement('div');
    this.el.className = styles.graphWrap!;
    this.el.dataset.testid = `eq-graph-${opts.lane}`;

    this.canvas = document.createElement('canvas');
    this.canvas.className = styles.graph!;
    this.canvas.dataset.testid = `eq-canvas-${opts.lane}`;
    // preventDefault() alone does not stop touch panning (the grid gestures'
    // finding); this does.
    this.canvas.style.touchAction = 'none';
    this.canvas.title =
      'Drag to draw the curve. Shift-drag for fine control, double-tap a band to reset it.';
    this.el.appendChild(this.canvas);

    this.ctx2d = this.canvas.getContext('2d');

    for (const id of eqCurveParamIds(this.prefix)) {
      this.unsubs.push(this.bus.subscribe(id, () => this.invalidate()));
    }

    this.canvas.addEventListener('pointerdown', this.handleDown);
    this.canvas.addEventListener('pointermove', this.handleHover);
    this.canvas.addEventListener('pointerleave', this.handleLeave);

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => { this.measure(); this.invalidate(); });
      this.ro.observe(this.el);
    }
  }

  /**
   * Off-screen means off-duty (runtime-performance REQ-no-work-for-offscreen-dom) — and a folded section
   * counts as off screen. Becoming visible repaints once from current values, so
   * a page revealed after a song load is already correct.
   */
  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    if (v) { this.measure(); this.invalidate(); }
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.ro?.disconnect();
    this.ro = null;
    this.canvas.removeEventListener('pointerdown', this.handleDown);
    this.canvas.removeEventListener('pointermove', this.handleHover);
    this.canvas.removeEventListener('pointerleave', this.handleLeave);
    this.detachDrag();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /**
   * Mark the curve stale and schedule **one** frame. Applying a preset writes a
   * dozen params, which would otherwise be a dozen repaints of the same picture.
   */
  private invalidate(): void {
    this.dirty = true;
    if (!this.visible || this.rafId) return;
    if (typeof requestAnimationFrame !== 'function') { this.draw(); return; }
    this.rafId = requestAnimationFrame(() => { this.rafId = 0; this.draw(); });
  }

  /** The only place layout is read (the `Scope.measure` shape). */
  private measure(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (w === 0 || h === 0) return;
    this.cssW = w;
    this.cssH = h;
    this.dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * this.dpr);
    const bh = Math.round(h * this.dpr);
    if (bw !== this.bitmapW || bh !== this.bitmapH) {
      this.canvas.width = bw;
      this.canvas.height = bh;
      this.bitmapW = bw;
      this.bitmapH = bh;
    }
  }

  private settings(): EqSettings {
    return readEqSettings(this.bus, this.prefix);
  }

  /* ---------- geometry ---------- */

  private plotH(): number {
    return Math.max(1, this.cssH - RULER_H);
  }

  private xForHz(hz: number): number {
    return freqToFrac(hz) * this.cssW;
  }

  private yForDb(db: number): number {
    const h = this.plotH();
    return h / 2 - (clamp(db, -DB_VIEW, DB_VIEW) / DB_VIEW) * (h / 2);
  }

  private dbForY(y: number): number {
    const h = this.plotH();
    return clamp(((h / 2 - y) / (h / 2)) * DB_VIEW, -EQ_GAIN_MAX, EQ_GAIN_MAX);
  }

  /** Nearest band to a canvas x, by log distance — the axis the eye reads. */
  private bandAtX(x: number): number {
    const hz = fracToFreq(clamp(x / Math.max(1, this.cssW), 0, 1));
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      const d = Math.abs(Math.log(hz) - Math.log(EQ_BANDS[i]!.hz));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /* ---------- gestures ---------- */

  private handleDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return; // right-click: nothing
    e.preventDefault();
    // A gesture must never hit-test against unknown geometry. The
    // ResizeObserver has normally run long before any pointer arrives, but a
    // press in the same frame as a reveal — or an environment with no
    // ResizeObserver at all — would otherwise map every x onto the last band.
    if (this.cssW === 0) this.measure();
    // Measured once per gesture, not once per move (add-a-ui-component.md).
    this.rect = this.canvas.getBoundingClientRect();
    const { x, y } = this.posOf(e);
    const band = this.bandAtX(x);

    const now = Date.now();
    const isDouble = now - this.lastTapAt < DOUBLE_MS
      && this.lastTapBand === band
      && Math.abs(x - this.xForHz(EQ_BANDS[band]!.hz)) < RESET_GRAB_PX;
    this.lastTapAt = now;
    this.lastTapBand = band;
    if (isDouble) {
      this.bus.set(`${this.prefix}.b${band}`, 0);
      return;
    }

    this.canvas.setPointerCapture?.(e.pointerId);
    this.dragging = true;
    this.lastBand = band;
    this.lastY = y;
    this.writeBand(band, y, e.shiftKey);

    this.onMove = (ev) => this.handleDrag(ev);
    this.onUp = () => this.detachDrag();
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  };

  private handleDrag(e: PointerEvent): void {
    if (!this.dragging) return;
    const { x, y } = this.posOf(e);
    const band = this.bandAtX(x);
    // Walk every band between the last position and this one, so a fast sweep
    // paints them all instead of leaving holes where the pointer jumped — and
    // interpolate the height across them, so what lands is the line the hand
    // drew rather than a staircase of the latest value.
    const span = Math.abs(band - this.lastBand);
    const step = band >= this.lastBand ? 1 : -1;
    for (let n = 0; n <= span; n++) {
      const b = this.lastBand + n * step;
      const t = span === 0 ? 1 : n / span;
      this.writeBand(b, this.lastY + (y - this.lastY) * t, e.shiftKey);
    }
    this.lastBand = band;
    this.lastY = y;
  }

  /**
   * Shift quarters the travel — one decision for the whole gesture, as the
   * scratch graph does, rather than a separate fine mode per axis.
   */
  private writeBand(i: number, y: number, fine: boolean): void {
    const id = `${this.prefix}.b${i}`;
    const target = this.dbForY(y);
    const v = fine ? this.bus.get(id) + (target - this.bus.get(id)) * 0.25 : target;
    this.bus.set(id, v);
  }

  private detachDrag(): void {
    this.dragging = false;
    this.rect = null;
    if (this.onMove) window.removeEventListener('pointermove', this.onMove);
    if (this.onUp) {
      window.removeEventListener('pointerup', this.onUp);
      window.removeEventListener('pointercancel', this.onUp);
    }
    this.onMove = null;
    this.onUp = null;
  }

  private handleHover = (e: PointerEvent): void => {
    if (this.dragging) return;
    // `offsetX` rather than a rect read: a getBoundingClientRect() here would be
    // a reflow on every pointer move (the Scope's finding).
    this.hoverX = e.offsetX;
    this.invalidate();
  };

  private handleLeave = (): void => {
    if (this.hoverX < 0) return;
    this.hoverX = -1;
    this.invalidate();
  };

  private posOf(e: PointerEvent): { x: number; y: number } {
    const r = this.rect ?? this.canvas.getBoundingClientRect();
    // jsdom reports a zero rect; fall back to the offsets so tests can drive it.
    if (r.width === 0 || r.height === 0) return { x: e.offsetX, y: e.offsetY };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /* ---------- drawing ---------- */

  private draw(): void {
    // A frame scheduled while visible can still arrive after the page was
    // folded away — `invalidate` guards the scheduling, not the callback. Bail
    // here too, leaving `dirty` set, so REQ-the-graph-computes-from-bus-values's "no work off screen" holds for
    // the in-flight frame as well and `setVisible(true)` repaints from current
    // values rather than from whatever was true when the frame was queued.
    if (!this.visible) return;
    if (!this.dirty) return;
    if (!this.ro) this.measure(); // jsdom has no ResizeObserver
    const ctx = this.ctx2d;
    if (!ctx || this.cssW === 0 || this.cssH === 0) return;
    this.dirty = false;

    const s = this.settings();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // fresh each frame, no compounding
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const h = this.plotH();
    this.drawZones(ctx, h);
    this.drawGrid(ctx);
    this.drawCurve(ctx, s);
    this.drawBands(ctx, s, h);
    this.drawRuler(ctx);
    this.drawHover(ctx, s, h);
    this.mirror(s);
  }

  /** The Spectrum's named problem bands, faintly — the same four, in the same
   *  places, so the two views teach one vocabulary. */
  private drawZones(ctx: CanvasRenderingContext2D, h: number): void {
    ctx.fillStyle = ZONE_FILL;
    for (const z of SPECTRUM_ZONES) {
      const x0 = this.xForHz(z.from);
      const x1 = this.xForHz(z.to);
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    ctx.lineWidth = 1;
    for (const db of [-12, -6, 6, 12]) {
      const y = Math.round(this.yForDb(db)) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.cssW, y);
      ctx.stroke();
    }
    const zero = Math.round(this.yForDb(0)) + 0.5;
    ctx.strokeStyle = ZERO_LINE;
    ctx.beginPath();
    ctx.moveTo(0, zero);
    ctx.lineTo(this.cssW, zero);
    ctx.stroke();
  }

  /**
   * The response, sampled per pixel column. Filled back to the 0 dB line so a
   * boost and a cut read as different shapes at a glance, not just different
   * curve positions.
   */
  private drawCurve(ctx: CanvasRenderingContext2D, s: EqSettings): void {
    const zero = this.yForDb(0);
    const pts: number[] = [];
    for (let x = 0; x <= this.cssW; x += 2) {
      const hz = fracToFreq(x / Math.max(1, this.cssW));
      pts.push(this.yForDb(eqResponseDb(s, hz, this.sampleRate)));
    }

    ctx.beginPath();
    ctx.moveTo(0, pts[0]!);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(i * 2, pts[i]!);
    ctx.lineTo(this.cssW, pts[pts.length - 1]!);
    ctx.lineTo(this.cssW, zero);
    ctx.lineTo(0, zero);
    ctx.closePath();
    ctx.fillStyle = 'rgba(232, 116, 46, 0.18)';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, pts[0]!);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(i * 2, pts[i]!);
    ctx.strokeStyle = CURVE;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /** A dot per band at its own gain, plus its short name — the handles the
   *  drag gesture is aiming at, made visible (ADR-014 law 1). */
  private drawBands(ctx: CanvasRenderingContext2D, s: EqSettings, h: number): void {
    ctx.font = BAND_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      const band = EQ_BANDS[i]!;
      const x = this.xForHz(band.hz);
      const g = s.gains[i] ?? 0;
      const y = this.yForDb(g);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = Math.abs(g) < 0.05 ? 'rgba(244, 205, 94, 0.45)' : INK;
      ctx.fill();
      haloText(ctx, band.label, x, h - 4, 'rgba(244, 205, 94, 0.5)');
    }
  }

  private drawRuler(ctx: CanvasRenderingContext2D): void {
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const t of visibleTicks(this.cssW)) {
      ctx.strokeStyle = 'rgba(244, 205, 94, 0.30)';
      ctx.lineWidth = 1;
      const x = Math.round(t.x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, this.plotH());
      ctx.lineTo(x, this.plotH() + 3);
      ctx.stroke();
      haloText(ctx, t.label, t.labelX, this.cssH - 1, 'rgba(244, 205, 94, 0.7)');
    }
  }

  /** Frequency and gain under the cursor, like the Spectrum's (scope.md REQ-hovering-reads-out-a-frequency). */
  private drawHover(ctx: CanvasRenderingContext2D, s: EqSettings, h: number): void {
    if (this.hoverX < 0 || this.hoverX > this.cssW) return;
    const hz = fracToFreq(this.hoverX / Math.max(1, this.cssW));
    const db = eqResponseDb(s, hz, this.sampleRate);
    ctx.strokeStyle = 'rgba(244, 205, 94, 0.35)';
    ctx.lineWidth = 1;
    const x = Math.round(this.hoverX) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();

    ctx.font = LABEL_FONT;
    const left = this.hoverX > this.cssW / 2;
    ctx.textAlign = left ? 'right' : 'left';
    ctx.textBaseline = 'top';
    const label = `${formatHzFull(hz)}  ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
    haloText(ctx, label, this.hoverX + (left ? -5 : 5), 3, INK);
  }

  /**
   * The curve at the eight band centres, mirrored onto the element so E2E can
   * compare it with a real `BiquadFilterNode` (equalizer.md REQ-the-drawn-curve-is-exact). Written
   * only when it changes — a `data-*` write dirties layout.
   */
  private mirror(s: EqSettings): void {
    const at = EQ_BANDS.map((b) => eqResponseDb(s, b.hz, this.sampleRate).toFixed(2));
    const v = at.join(',');
    if (v === this.mirroredCurve) return;
    this.mirroredCurve = v;
    this.el.dataset.eqCurve = v;
  }
}
