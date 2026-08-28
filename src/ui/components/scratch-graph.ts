import styles from '../styles/scratch-graph.module.css';
import { showValueBubble, hideValueBubble } from './value-bubble';
import {
  normalizeCurve, scratchPlan, segmentAt, rateIn, positionIn, cutIn, warpPeaks,
  type ScratchCurve, type ScratchPoint,
} from '../../audio/recorder/scratch-curve';
import { MAX_SCRATCH_POINTS, MAX_SCRATCH_RATE } from '../../state/limits';

/**
 * The scratch editor's canvas (scratch.md REQ-16/REQ-17/REQ-18).
 *
 * Four lanes, three of them sharing one x-axis of **output time** gridded in
 * sixteenths, so what the user draws is read against the bar it will be played
 * against:
 *
 *   cut      the crossfader, one band per segment — tap to close or open it
 *   preview  the warped result. Read-only, and the reason the model is legible:
 *            the user draws a rate, but a rate's *integral* is where the needle
 *            is, and that is invisible until you draw what comes out.
 *   rate     the editable curve. y is playback rate, so up is faster AND higher —
 *            one gesture, one outcome (ADR-014 law 2).
 *   source   the record itself, in SOURCE time, with the cue and the span the
 *            needle will cover. The only lane on a different axis, which is why
 *            it is separated by a rule rather than sharing the grid.
 *
 * It holds no engine reference and no audio — peaks and a curve go in, a curve
 * comes out — so it tests in jsdom with a stubbed rect, and so the modal stays
 * the only place that knows about tempo, selection and undo.
 *
 * Redraw is synchronous, like the waveform canvas this sits beneath: the whole
 * frame is a few hundred line segments over a cached peak array, and a dirty
 * flag would only add a way for the drawing to lag the pointer.
 */

/** Lane geometry, in CSS pixels from the top. One table, read by both the
 *  drawing and the hit tests, so a lane cannot be drawn where it is not clicked. */
const CUT_Y = 0;
const CUT_H = 12;
const PREVIEW_Y = 15;
const PREVIEW_H = 46;
const RATE_Y = 64;
const RATE_H = 116;
const SOURCE_Y = 184;
const SOURCE_H = 26;
const CANVAS_H = 210;

/** Hit radius for a curve point: a 44 px target, per ADR-014 law 6. */
const GRAB_PX = 22;
/** Drawn radius. Deliberately far smaller than the target — a 44 px dot would
 *  hide the curve it sits on. */
const DOT_PX = 4;
/** Two taps closer together than this are a double-tap. Matches `knob.ts`;
 *  `dblclick` is unreliable on touch, so it is hand-rolled off timestamps. */
const DOUBLE_MS = 300;
/** Sub-divisions of a sixteenth the horizontal drag snaps to (a 32nd). */
const SNAP_DIV = 2;
/**
 * Rate step the vertical drag snaps to, unless Shift is held.
 *
 * The lane spans the model's full ±4, which puts unity about 15 px from the
 * centre — landing on exactly 1.00x (or exactly 0) by eye would be luck. Snapping
 * to quarters makes every musically-named rate reachable: 0, ±0.5, ±1, ±1.5, ±2.
 * A finer step would be smaller than a pixel here and so no snap at all.
 */
const RATE_SNAP = 0.25;
/** Sixteenths in a quarter note — the lighter of the two grid accents. */
const QUARTER = 4;

const COL_GRID = 'rgba(244, 205, 94, 0.10)';
const COL_BEAT = 'rgba(244, 205, 94, 0.20)';
const COL_BAR = 'rgba(244, 205, 94, 0.45)';
const COL_ZERO = 'rgba(244, 205, 94, 0.30)';
const COL_UNITY = 'rgba(244, 205, 94, 0.14)';
const COL_WAVE = '#e8742e';
const COL_WAVE_DIM = 'rgba(232, 116, 46, 0.22)';
const COL_CURVE = '#f4cd5e';
const COL_DOT = '#ffe9a8';
const COL_CUT = 'rgba(255, 58, 32, 0.55)';
const COL_OFF = 'rgba(255, 58, 32, 0.13)';
const COL_CUE = '#7fd6ff';

export interface ScratchGraphOptions {
  curve: ScratchCurve;
  /** Fired on every edit, including each step of a drag. */
  onChange: (c: ScratchCurve) => void;
  /** Fired once when a gesture finishes — the modal's audition hook. */
  onCommit?: () => void;
  /** Fired when the preview lane is tapped. */
  onAudition?: () => void;
}

type Drag =
  | { kind: 'point'; idx: number }
  | { kind: 'cue' }
  | null;

export class ScratchGraph {
  readonly el: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private readonly opts: ScratchGraphOptions;

  private curve: ScratchCurve;
  private peaks: Float32Array = new Float32Array(0);
  private srcFrames = 0;
  private outFrames = 0;
  private steps = 16;
  private barTicks = 16;

  private drag: Drag = null;
  private lastTapAt = 0;
  private lastTapIdx = -1;
  private bw = 0;
  private bh = 0;
  private ro: ResizeObserver | null = null;

  private readonly onDown: (e: PointerEvent) => void;
  private readonly onMove: (e: PointerEvent) => void;
  private readonly onUp: () => void;

  constructor(opts: ScratchGraphOptions) {
    this.opts = opts;
    this.curve = normalizeCurve(opts.curve);

    this.el = document.createElement('div');
    this.el.className = styles.root!;
    this.el.dataset.testid = 'scratch-graph';
    this.el.style.touchAction = 'none';

    this.canvas = document.createElement('canvas');
    this.canvas.className = styles.canvas!;
    this.canvas.dataset.testid = 'scratch-canvas';
    this.canvas.style.touchAction = 'none';
    this.canvas.title = 'Drag a point to shape the speed. Tap the lane to add one, '
      + 'double-tap a point to remove it, tap the top band to cut the fader.';
    this.el.appendChild(this.canvas);

    this.legend = document.createElement('div');
    this.legend.className = styles.legend!;
    this.legend.dataset.testid = 'scratch-legend';
    this.el.appendChild(this.legend);

    this.onDown = (e): void => this.handleDown(e);
    this.onMove = (e): void => this.handleMove(e);
    this.onUp = (): void => this.handleUp();
    this.canvas.addEventListener('pointerdown', this.onDown);

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.redraw());
      this.ro.observe(this.el);
    }
    this.redraw();
  }

  setCurve(c: ScratchCurve): void {
    this.curve = normalizeCurve(c);
    this.redraw();
  }

  /** The source's peak envelope (from `computePeaks`) and its length in frames. */
  setSource(peaks: Float32Array, srcFrames: number): void {
    this.peaks = peaks;
    this.srcFrames = Math.max(0, Math.floor(srcFrames));
    this.redraw();
  }

  /**
   * The grid the gesture is drawn against, and the output length it will fill.
   *
   * `barTicks` is the bar in sixteenths (meter.md REQ-6) — the line that matters,
   * because locking to it is the point of the feature. The lighter line every
   * {@link QUARTER} sixteenths is a *quarter note*, not "the beat": a sixteenth
   * count alone cannot tell 3/4 from 6/8, and drawing a beat grid that is wrong
   * in compound time would be worse than drawing none.
   */
  setGrid(steps: number, barTicks: number, outFrames: number): void {
    this.steps = Math.max(1, Math.floor(steps));
    this.barTicks = Math.max(1, Math.floor(barTicks));
    this.outFrames = Math.max(0, Math.floor(outFrames));
    this.redraw();
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.detachDrag();
    this.ro?.disconnect();
    this.ro = null;
    hideValueBubble();
  }

  /* ------------------------------------------------------------- geometry */

  private width(): number {
    return this.canvas.clientWidth || this.el.clientWidth || 0;
  }

  private xOf(t: number): number { return t * this.width(); }

  private tOf(x: number): number {
    const w = this.width();
    return w > 0 ? Math.max(0, Math.min(1, x / w)) : 0;
  }

  /** Rate lane: the drawable range is exactly the model's, so nothing the user
   *  can reach is drawn off the lane and nothing drawn is unreachable. */
  private yOfRate(v: number): number {
    const mid = RATE_Y + RATE_H / 2;
    return mid - (v / MAX_SCRATCH_RATE) * (RATE_H / 2);
  }

  private rateOfY(y: number): number {
    const mid = RATE_Y + RATE_H / 2;
    const v = ((mid - y) / (RATE_H / 2)) * MAX_SCRATCH_RATE;
    return Math.max(-MAX_SCRATCH_RATE, Math.min(MAX_SCRATCH_RATE, v));
  }

  private posOf(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    // jsdom has no layout, and a hidden panel measures zero — treat a degenerate
    // rect as the origin rather than dividing by it.
    return { x: e.clientX - (r.left || 0), y: e.clientY - (r.top || 0) };
  }

  /* -------------------------------------------------------------- gestures */

  private handleDown(e: PointerEvent): void {
    const { x, y } = this.posOf(e);

    if (y >= SOURCE_Y) {
      e.preventDefault();
      this.beginDrag(e, { kind: 'cue' });
      this.applyCue(x);
      return;
    }
    if (y < CUT_Y + CUT_H) {
      e.preventDefault();
      this.toggleCut(this.tOf(x));
      return;
    }
    if (y < RATE_Y) {
      e.preventDefault();
      this.opts.onAudition?.();
      return;
    }

    const idx = this.hitPoint(x, y);
    if (idx >= 0) {
      const now = Date.now();
      if (idx === this.lastTapIdx && now - this.lastTapAt < DOUBLE_MS) {
        e.preventDefault();
        this.lastTapAt = 0;
        this.lastTapIdx = -1;
        this.deletePoint(idx);
        return;
      }
      this.lastTapAt = now;
      this.lastTapIdx = idx;
      e.preventDefault();
      this.beginDrag(e, { kind: 'point', idx });
      return;
    }

    e.preventDefault();
    const added = this.addPoint(
      this.tOf(x), Math.round(this.rateOfY(y) / RATE_SNAP) * RATE_SNAP,
    );
    if (added < 0) return;
    this.lastTapAt = Date.now();
    this.lastTapIdx = added;
    this.beginDrag(e, { kind: 'point', idx: added });
  }

  private beginDrag(e: PointerEvent, d: Drag): void {
    this.drag = d;
    this.canvas.setPointerCapture?.(e.pointerId);
    // Drag listeners are attached for the stroke and removed when it ends, so a
    // finished gesture leaves nothing on the element (add-a-ui-component.md).
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onUp);
  }

  private detachDrag(): void {
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.drag = null;
  }

  private handleMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const { x, y } = this.posOf(e);
    if (d.kind === 'cue') { this.applyCue(x); return; }

    const pts = this.curve.points.slice();
    const p = pts[d.idx];
    if (!p) return;

    // The opening point is pinned to 0: something has to say what the rate is at
    // the start of the scratch, and a curve that begins in the middle does not.
    const rawT = d.idx === 0 ? 0 : this.tOf(x);
    const t = d.idx === 0 ? 0 : (e.shiftKey ? rawT : this.snap(rawT));
    const rawV = this.rateOfY(y);
    // Shift is one decision for both axes: off the grid horizontally and off the
    // rate steps vertically, so "fine" means the same thing whichever way you drag.
    const v = e.shiftKey ? rawV : Math.round(rawV / RATE_SNAP) * RATE_SNAP;
    pts[d.idx] = { ...p, t, v };
    // Re-sorting mid-drag would renumber the point under the finger. Ordering is
    // settled once, on release, by normalizeCurve.
    this.commit({ ...this.curve, points: pts }, false);
    showValueBubble(this.canvas, rateLabel(v));
  }

  private handleUp(): void {
    const wasPoint = this.drag?.kind === 'point';
    this.detachDrag();
    hideValueBubble();
    if (wasPoint) this.commit({ ...this.curve, points: this.curve.points.slice() }, true);
    else this.opts.onCommit?.();
  }

  /** Snap to a 32nd of the scratch — fine enough for a flare, coarse enough that
   *  a drag lands somewhere a listener can hear as musical. Shift bypasses it. */
  private snap(t: number): number {
    const div = this.steps * SNAP_DIV;
    return Math.max(0, Math.min(1, Math.round(t * div) / div));
  }

  private hitPoint(x: number, y: number): number {
    let best = GRAB_PX;
    let idx = -1;
    this.curve.points.forEach((p, i) => {
      const dx = this.xOf(p.t) - x;
      const dy = this.yOfRate(p.v) - y;
      const d = Math.hypot(dx, dy);
      if (d < best) { best = d; idx = i; }
    });
    return idx;
  }

  private addPoint(t: number, v: number): number {
    if (this.curve.points.length >= MAX_SCRATCH_POINTS) return -1;
    const snapped = this.snap(t);
    const pts = this.curve.points.slice();
    // Inherit the segment's own shape and fader state, so adding a point in the
    // middle of a held, cut run does not silently un-cut or un-hold it.
    const plan = scratchPlan(this.curve);
    const seg = segmentAt(plan, snapped);
    const host = this.curve.points[Math.max(0, seg)];
    const at = pts.findIndex((p) => p.t > snapped);
    const point: ScratchPoint = {
      t: snapped,
      v,
      cut: host?.cut ?? false,
      hold: host?.hold ?? false,
    };
    const idx = at < 0 ? pts.length : at;
    pts.splice(idx, 0, point);
    this.commit({ ...this.curve, points: pts }, true);
    return idx;
  }

  private deletePoint(idx: number): void {
    // A curve with no points is a curve the reader refuses, so the last one stays.
    if (this.curve.points.length <= 1) return;
    const pts = this.curve.points.slice();
    pts.splice(idx, 1);
    if (pts[0]) pts[0] = { ...pts[0], t: 0 };
    this.commit({ ...this.curve, points: pts }, true);
  }

  private toggleCut(t: number): void {
    const plan = scratchPlan(this.curve);
    const seg = segmentAt(plan, t);
    if (seg < 0) return;
    const pts = this.curve.points.slice();
    const p = pts[seg];
    if (!p) return;
    pts[seg] = { ...p, cut: !p.cut };
    this.commit({ ...this.curve, points: pts }, true);
  }

  private applyCue(x: number): void {
    this.commit({ ...this.curve, cue: this.tOf(x) }, false);
  }

  private commit(next: ScratchCurve, done: boolean): void {
    this.curve = normalizeCurve(next);
    this.redraw();
    this.opts.onChange(this.curve);
    if (done) this.opts.onCommit?.();
  }

  /* -------------------------------------------------------------- drawing */

  redraw(): void {
    const plan = scratchPlan(this.curve);
    // The legend is text, so it is written before the canvas guard below: a lost
    // or unavailable 2D context should not also stop the readout updating.
    this.drawLegend(plan);

    const w = this.width();
    const g = this.canvas.getContext('2d');
    if (!g || w <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const nbw = Math.round(w * dpr);
    const nbh = Math.round(CANVAS_H * dpr);
    if (nbw !== this.bw || nbh !== this.bh) {
      this.canvas.width = nbw;
      this.canvas.height = nbh;
      this.bw = nbw;
      this.bh = nbh;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, CANVAS_H);

    this.drawGrid(g, w);
    this.drawPreview(g, w, plan);
    this.drawCuts(g, w, plan);
    this.drawCurve(g, plan);
    this.drawSource(g, w, plan);
  }

  private drawGrid(g: CanvasRenderingContext2D, w: number): void {
    g.lineWidth = 1;
    for (let s = 0; s <= this.steps; s++) {
      const x = Math.round((s / this.steps) * w) + 0.5;
      g.strokeStyle = s % this.barTicks === 0 ? COL_BAR
        : s % QUARTER === 0 ? COL_BEAT : COL_GRID;
      g.beginPath();
      g.moveTo(x, PREVIEW_Y);
      g.lineTo(x, RATE_Y + RATE_H);
      g.stroke();
    }
    // Unity and zero, the two rates a player reads the curve against.
    for (const [v, col] of [[0, COL_ZERO], [1, COL_UNITY], [-1, COL_UNITY]] as const) {
      const y = Math.round(this.yOfRate(v)) + 0.5;
      g.strokeStyle = col;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
  }

  private drawPreview(
    g: CanvasRenderingContext2D, w: number, plan: ReturnType<typeof scratchPlan>,
  ): void {
    const cols = Math.max(1, Math.floor(w));
    const mid = PREVIEW_Y + PREVIEW_H / 2;
    const half = PREVIEW_H / 2 - 1;

    // Off-record first, underneath: the shading is the answer to "why is this
    // stretch of my scratch silent?" (REQ-20), and it has to read as a region.
    if (this.srcFrames > 0 && this.outFrames > 0) {
      g.fillStyle = COL_OFF;
      let seg = 0;
      let runFrom = -1;
      for (let x = 0; x <= cols; x++) {
        const t = x / cols;
        seg = segmentAt(plan, t, seg);
        const pos = plan.cue * this.srcFrames + positionIn(plan, seg, t) * this.outFrames;
        const off = x < cols && (pos < 0 || pos >= this.srcFrames);
        if (off && runFrom < 0) runFrom = x;
        if (!off && runFrom >= 0) {
          g.fillRect(runFrom, PREVIEW_Y, x - runFrom, PREVIEW_H);
          runFrom = -1;
        }
      }
    }

    const warped = warpPeaks(
      this.peaks, this.curve, this.srcFrames, this.outFrames, cols,
    );
    g.fillStyle = COL_WAVE;
    for (let x = 0; x < cols; x++) {
      const lo = warped[x * 2]!;
      const hi = warped[x * 2 + 1]!;
      if (lo === 0 && hi === 0) continue;
      const y0 = mid - Math.max(-1, Math.min(1, hi)) * half;
      const y1 = mid - Math.max(-1, Math.min(1, lo)) * half;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  private drawCuts(
    g: CanvasRenderingContext2D, w: number, plan: ReturnType<typeof scratchPlan>,
  ): void {
    g.fillStyle = 'rgba(244, 205, 94, 0.05)';
    g.fillRect(0, CUT_Y, w, CUT_H);
    g.fillStyle = COL_CUT;
    for (let i = 0; i < plan.n; i++) {
      if (!cutIn(plan, i)) continue;
      const x0 = this.xOf(plan.t[i]!);
      const x1 = this.xOf(plan.t[i + 1]!);
      g.fillRect(x0, CUT_Y + 1, Math.max(1, x1 - x0), CUT_H - 2);
    }
  }

  private drawCurve(g: CanvasRenderingContext2D, plan: ReturnType<typeof scratchPlan>): void {
    if (plan.n === 0) return;
    g.strokeStyle = COL_CURVE;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(this.xOf(plan.t[0]!), this.yOfRate(plan.v0[0]!));
    for (let i = 0; i < plan.n; i++) {
      // A segment is a straight line in rate, so two points draw it exactly —
      // a hold ends where it started and the next segment steps to its own value,
      // which is the vertical jump a transformer is made of.
      g.lineTo(this.xOf(plan.t[i]!), this.yOfRate(plan.v0[i]!));
      g.lineTo(this.xOf(plan.t[i + 1]!), this.yOfRate(plan.v1[i]!));
    }
    g.stroke();

    for (const p of this.curve.points) {
      g.fillStyle = COL_DOT;
      g.beginPath();
      g.arc(this.xOf(p.t), this.yOfRate(p.v), DOT_PX, 0, Math.PI * 2);
      g.fill();
    }
  }

  private drawSource(
    g: CanvasRenderingContext2D, w: number, plan: ReturnType<typeof scratchPlan>,
  ): void {
    const pw = Math.floor(this.peaks.length / 2);
    const mid = SOURCE_Y + SOURCE_H / 2;
    const half = SOURCE_H / 2 - 1;

    g.fillStyle = COL_WAVE_DIM;
    for (let x = 0; x < w && pw > 0; x++) {
      const c = Math.min(pw - 1, Math.floor((x / w) * pw));
      const lo = this.peaks[c * 2]!;
      const hi = this.peaks[c * 2 + 1]!;
      const y0 = mid - Math.max(-1, Math.min(1, hi)) * half;
      const y1 = mid - Math.max(-1, Math.min(1, lo)) * half;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }

    // The span the needle will actually cover, drawn on the record it covers it
    // on. Running past either end is what the off-record shading above explains.
    if (this.srcFrames > 0 && this.outFrames > 0 && plan.n > 0) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i <= plan.n; i++) {
        const f = plan.cue * this.srcFrames + plan.p[i]! * this.outFrames;
        if (f < lo) lo = f;
        if (f > hi) hi = f;
      }
      const x0 = (lo / this.srcFrames) * w;
      const x1 = (hi / this.srcFrames) * w;
      g.fillStyle = 'rgba(232, 116, 46, 0.16)';
      g.fillRect(x0, SOURCE_Y, Math.max(1, x1 - x0), SOURCE_H);
    }

    const cx = Math.round(this.xOf(plan.cue)) + 0.5;
    g.strokeStyle = COL_CUE;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx, SOURCE_Y);
    g.lineTo(cx, SOURCE_Y + SOURCE_H);
    g.stroke();
    g.fillStyle = COL_CUE;
    g.beginPath();
    g.moveTo(cx - 4, SOURCE_Y);
    g.lineTo(cx + 4, SOURCE_Y);
    g.lineTo(cx, SOURCE_Y + 5);
    g.fill();
  }

  private drawLegend(plan: ReturnType<typeof scratchPlan>): void {
    const cuts = plan.cut.reduce((n, c) => n + c, 0);
    const text = `<b>${this.curve.points.length}</b> points · `
      + `<b>${cuts}</b> cut · needle <b>${rateLabel(rateIn(plan, 0, 0))}</b> at the drop`;
    if (this.legend.innerHTML !== text) this.legend.innerHTML = text;
  }
}

/**
 * A rate and what it does to pitch. The semitone half is the readout a musician
 * reads: "1.5x" is a number, "+7.0 st" is a fifth.
 */
export function rateLabel(v: number): string {
  const mag = Math.abs(v);
  if (mag < 0.005) return 'stopped';
  const st = 12 * Math.log2(mag);
  const dir = v < 0 ? '← ' : '';
  return `${dir}${mag.toFixed(2)}x · ${st >= 0 ? '+' : ''}${st.toFixed(1)} st`;
}
