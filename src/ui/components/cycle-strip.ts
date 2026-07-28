import styles from '../styles/zoetrope.module.css';
import type { CycleMeter } from '../../audio/zoetrope/node';

export interface StripBar {
  /** Left edge in CSS pixels. */
  readonly x: number;
  /** Width in CSS pixels. */
  readonly w: number;
}

const GAP = 2;
const MIN_BAR_H = 0.04; // fraction of height — a silent cycle still reads as a bar

/**
 * Bar geometry for `count` cycles across `width` CSS pixels.
 *
 * The bars always span the full strip, so the count you see is exactly the
 * window Depth reaches into — raise Depth and the bars get finer, lower it and
 * they get chunkier. There is no maximum bar width: capping it left most of a
 * wide strip empty at the default depth of 12, and a fixed-width bar would stop
 * the display meaning anything in particular.
 *
 * Exported canvas-free so the layout is unit-testable under jsdom, which has no
 * 2D context — the same split as `scopeRegions` and `motionGraphPoints`.
 */
export function cycleStripBars(count: number, width: number): StripBar[] {
  if (count <= 0 || width <= 0) return [];
  const slot = width / count;
  const w = Math.max(1, slot - GAP);
  const bars: StripBar[] = [];
  // Shifted by one gap so the newest cycle's bar sits flush under "now".
  for (let i = 0; i < count; i++) bars.push({ x: i * slot + GAP, w });
  return bars;
}

/** Bottom of the bar scale, in dB — below this a cycle reads as silent. */
const FLOOR_DB = 48;

/**
 * Bar height for a cycle's peak amplitude, 0..1, on a dB scale like any level
 * meter.
 *
 * Linear was unreadable: post-voice-bus peaks sit near 0.05, which is a 3px
 * stub. Normalising against the loudest cycle in the frame was worse — the
 * window is only `depth` cycles wide (~55 ms), and consecutive cycles of a
 * steady note have identical peaks, so every bar came out full height and the
 * display said nothing. A fixed dB floor keeps the reading absolute *and*
 * legible: 0.05 lands near half height, and a decaying tail visibly ramps down.
 */
export function barHeightFrac(peak: number): number {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(Math.min(1, peak));
  const frac = 1 + db / FLOOR_DB;
  return frac < 0 ? 0 : frac > 1 ? 1 : frac;
}

/**
 * The cycle library display: one bar per stored cycle at its peak amplitude,
 * an accent bar on the cycle being read right now, and the newest cycle (the
 * write head) picked out at the right.
 *
 * This is the part of Zoetrope that makes it learnable — with chaos low the
 * accent bar visibly bounces between a few fixed positions; pushed up it lands
 * everywhere. See specs/features/zoetrope.md.
 *
 * Repaints on each telemetry frame (~31 Hz), never on a rAF loop, so it costs
 * exactly nothing whenever the worklet is not posting — which is whenever the
 * module is bypassed, collapsed or off-screen.
 */
export class CycleStrip {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private cssW = 0;
  private cssH = 0;

  constructor(testId = 'zoetrope-strip') {
    this.el = document.createElement('canvas');
    this.el.className = styles.strip!;
    this.el.dataset.testid = testId;
    this.ctx = this.el.getContext('2d');
  }

  /** Draw a telemetry frame. */
  update(m: CycleMeter): void {
    const g = this.ctx;
    if (!g) return;
    const { w, h } = this.measure();
    if (w <= 0 || h <= 0) return;

    g.clearRect(0, 0, w, h);
    const bars = cycleStripBars(m.count, w);
    // `peaks` is oldest → newest, and `lag` counts back from the newest.
    const readIdx = m.count - m.lag;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]!;
      const bh = Math.max(MIN_BAR_H, barHeightFrac(m.peaks[i] ?? 0)) * h;
      g.fillStyle = i === m.count - 1
        ? '#f2f2f2' // the write head
        : i === readIdx
          ? '#4a9eff' // the cycle being read right now
          : '#5a5a5a';
      g.fillRect(bar.x, h - bh, bar.w, bh);
    }
  }

  /** Clear to the empty baseline (bypass, or telemetry stopping). */
  clear(): void {
    const g = this.ctx;
    if (!g) return;
    const { w, h } = this.measure();
    if (w > 0 && h > 0) g.clearRect(0, 0, w, h);
  }

  /**
   * Size the backing store to the CSS box × DPR, but only when the box has
   * actually changed — `getBoundingClientRect` forces layout, and this runs on
   * every telemetry frame.
   */
  private measure(): { w: number; h: number } {
    const rect = this.el.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w !== this.cssW || h !== this.cssH) {
      this.cssW = w;
      this.cssH = h;
      const dpr = window.devicePixelRatio || 1;
      this.el.width = Math.max(1, Math.round(w * dpr));
      this.el.height = Math.max(1, Math.round(h * dpr));
      this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { w, h };
  }
}
