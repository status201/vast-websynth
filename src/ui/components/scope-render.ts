/**
 * The scope's painters (scope.md) — every stroke the panel draws, as plain
 * functions over a canvas context and one region (REQ-scope-renderers-are-rect-scoped).
 *
 * `Scope` (scope.ts) owns the loop, the liveness, the peak state and the dataset
 * mirrors; it decides WHAT to draw each frame and calls these to draw it. They
 * hold no state of their own except `SpectrumCaches`, which keeps the per-frame
 * allocations (gradients, bin edges, rulers) out of the loop
 * (REQ-no-per-frame-layout-read). The pure maths is scope-math.ts.
 */
import { haloText } from './canvas-text';
import { paletteDerived, rgba, type ScreenPalette } from '../theme-colors';
import {
  type ScopeRegion,
  dbToFrac,
  LABEL_FONT,
  ZONE_FONT,
  ZONE_NAME_MIN_W,
  ZONE_NAME_TOP,
  SPECTRUM_ZONES,
  freqToFrac,
  type SpectrumTick,
  visibleTicks,
  findRisingZeroCrossing,
  columnBinEdges,
} from './scope-math';

/** The scope's inks, from the screen tokens (ui-themes.md REQ-canvas-reads-the-screen-tokens). */
export const scopeInks = paletteDerived((p) => ({
  palette: p,
  midline: rgba(p.ink, 0.07),
  label: rgba(p.ink, 0.6),
  zoneFill: rgba(p.ink, 0.08),
  zoneName: rgba(p.ink, 0.75),
  tick: rgba(p.ink, 0.45),
  tickLabel: rgba(p.ink, 0.75),
  cursor: rgba(p.ink, 0.55),
  cursorLabel: rgba(p.ink),
  peak: rgba(p.ink, 0.9),
  peakHot: rgba(p.hot),
  wave: rgba(p.trace),
}));

/**
 * The allocations a Spectrum frame would otherwise make — the bar gradient per
 * region box, the column→bin boundaries (REQ-bars-are-drawn-per-pixel-column) and
 * the pruned ruler per plot width. Cleared on a resize, an fftSize switch, a
 * restored canvas, and (for the gradients) a theme change.
 */
export class SpectrumCaches {
  private readonly gradients = new Map<string, CanvasGradient>();
  /** The palette the cached gradients were built from. */
  private gradPalette: ScreenPalette | null = null;
  private readonly edges = new Map<string, Float32Array>();
  private readonly ticks = new Map<string, SpectrumTick[]>();

  clear(): void {
    this.gradients.clear();
    this.edges.clear();
    this.ticks.clear();
  }

  /** The bars' vertical gradient for one region box. */
  gradient(ctx: CanvasRenderingContext2D, r: ScopeRegion): CanvasGradient {
    // A cached gradient holds the colours it was built with; a new palette (a
    // theme change) starts the cache over.
    const p = scopeInks().palette;
    if (p !== this.gradPalette) {
      this.gradients.clear();
      this.gradPalette = p;
    }
    const key = `${r.y}:${r.h}`;
    let grad = this.gradients.get(key);
    if (!grad) {
      grad = ctx.createLinearGradient(0, r.y + r.h, 0, r.y);
      grad.addColorStop(0, rgba(p.trace));
      grad.addColorStop(0.6, rgba(p.ink));
      grad.addColorStop(1, rgba(p.hot));
      this.gradients.set(key, grad);
    }
    return grad;
  }

  /** Column→bin boundaries — allocating these per frame is what REQ-no-per-frame-layout-read forbids. */
  binEdges(cols: number, fftSize: number, sampleRate: number): Float32Array {
    const key = `${cols}:${fftSize}:${sampleRate}`;
    let e = this.edges.get(key);
    if (!e) {
      e = columnBinEdges(cols, fftSize, sampleRate);
      this.edges.set(key, e);
    }
    return e;
  }

  /** The ruler for a plot width — `visibleTicks` sorts and allocates. */
  rulerFor(regionW: number, fMax: number): SpectrumTick[] {
    const key = `${Math.round(regionW)}:${fMax}`;
    let t = this.ticks.get(key);
    if (!t) {
      t = visibleTicks(regionW, fMax);
      this.ticks.set(key, t);
    }
    return t;
  }
}

/** Faint horizontal mid-line for a region (vintage CRT look). */
export function drawMidline(ctx: CanvasRenderingContext2D, r: ScopeRegion): void {
  const midY = r.y + r.h / 2;
  ctx.strokeStyle = scopeInks().midline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(r.x, midY);
  ctx.lineTo(r.x + r.w, midY);
  ctx.stroke();
}

export function drawLabel(ctx: CanvasRenderingContext2D, r: ScopeRegion): void {
  ctx.font = LABEL_FONT;
  // Bottom-left: the corner overlay buttons (Mono/Stereo top-left, Wave/Spectrum
  // top-right) sit flush with the canvas corners, so a top-anchored label hides
  // behind them. Same dodge the peak-dB readout makes by centring. (REQ-scope-renderers-are-rect-scoped)
  ctx.textBaseline = 'bottom';
  haloText(ctx, r.label, r.x + 4, r.y + r.h - 4, scopeInks().label);
}

/**
 * The triggered wave trace (REQ-the-wave-trace-is-triggered) at `gain`. Returns
 * the larger of `peakIn` and the raw peak it drew, which sets the NEXT frame's
 * gain — accumulated in the same pass, so the auto-gain costs no second read
 * (REQ-the-wave-read-is-float).
 */
export function drawWave(
  ctx: CanvasRenderingContext2D, data: Float32Array, r: ScopeRegion, gain: number, peakIn: number,
): number {
  drawMidline(ctx, r);
  const midY = r.y + r.h / 2;
  const amp = r.h / 2 - 4;
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = scopeInks().wave;
  ctx.beginPath();
  // Start at the first rising zero crossing in the first quarter, draw a fixed
  // three quarters — so the span is the same whether or not a trigger was found,
  // and silence free-runs from 0.
  const search = data.length >> 2;
  const len = data.length - search;
  const start = Math.max(0, findRisingZeroCrossing(data, search));
  let peak = peakIn;
  for (let i = 0; i < len; i++) {
    const x = r.x + (i / (len - 1)) * r.w;
    const v = data[start + i] ?? 0;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    // Clamp *after* the gain: there is no ctx.clip(), so an un-clamped overshoot
    // during the fast fall would paint into the neighbouring stereo region.
    const s = v * gain;
    const y = midY + (s < -1 ? -1 : s > 1 ? 1 : s) * amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  return peak;
}

/**
 * The bars themselves, and the raw peak byte they were drawn from (REQ-bars-are-drawn-per-pixel-column).
 * Column-based, not bin-based: a log axis maps the two ends of the spectrum in
 * opposite directions, so a column covering whole bins takes the **max** over
 * them (a narrow peak must never be averaged away) while a column narrower than
 * a bin **interpolates** between its neighbours (otherwise the bottom third is
 * three flat plateaus, which is what makes a naive log analyser look broken).
 */
export function drawBars(
  ctx: CanvasRenderingContext2D,
  r: ScopeRegion,
  data: Uint8Array,
  edges: Float32Array,
  cols: number,
  fill: CanvasGradient,
): number {
  ctx.fillStyle = fill;
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
      // The held peak reads RAW bins, never the interpolation (REQ-bars-are-drawn-per-pixel-column).
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
export function xForFreq(r: ScopeRegion, hz: number, fMax: number): number {
  return r.x + freqToFrac(hz, fMax) * r.w;
}

/** The shaded problem bands, behind the bars. (REQ-a-zones-toggle) */
export function drawZoneBands(ctx: CanvasRenderingContext2D, r: ScopeRegion, fMax: number): void {
  ctx.fillStyle = scopeInks().zoneFill;
  for (const z of SPECTRUM_ZONES) {
    const x0 = xForFreq(r, z.from, fMax);
    ctx.fillRect(x0, r.y, xForFreq(r, z.to, fMax) - x0, r.h);
  }
}

/**
 * The band names, in front of the bars. Inset from the region top so they clear
 * the two corner overlay buttons, and dropped entirely on a region too narrow to
 * hold them — the shading still says where the band is. (REQ-a-zones-toggle)
 */
export function drawZoneNames(ctx: CanvasRenderingContext2D, r: ScopeRegion, fMax: number): void {
  if (r.w < ZONE_NAME_MIN_W || r.h < ZONE_NAME_TOP + 12) return;
  ctx.save();
  ctx.font = ZONE_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const z of SPECTRUM_ZONES) {
    const mid = (xForFreq(r, z.from, fMax) + xForFreq(r, z.to, fMax)) / 2;
    haloText(ctx, z.name, mid, r.y + ZONE_NAME_TOP, scopeInks().zoneName);
  }
  ctx.restore();
}

/** The bottom ruler: a short tick per labelled frequency, the label above it. (REQ-the-scale-is-a-permanent-ruler) */
export function drawTicks(ctx: CanvasRenderingContext2D, r: ScopeRegion, ticks: readonly SpectrumTick[]): void {
  const bottom = r.y + r.h;
  ctx.save();
  ctx.strokeStyle = scopeInks().tick;
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
    haloText(ctx, t.label, r.x + t.labelX, bottom - 5, scopeInks().tickLabel);
  }
  ctx.restore();
}

/**
 * The hover cursor's line and its frequency label (REQ-hovering-reads-out-a-frequency).
 * The label rides the pointer's own Y and flips side at the halfway mark (`frac`
 * across the region), which keeps it clear of the corner chrome without a fixed
 * anchor that could collide.
 */
export function drawCursorLine(
  ctx: CanvasRenderingContext2D, r: ScopeRegion, hx: number, hy: number, frac: number, label: string,
): void {
  ctx.save();
  ctx.strokeStyle = scopeInks().cursor;
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
  haloText(ctx, label, hx + (left ? -5 : 5), hy, scopeInks().cursorLabel);
  ctx.restore();
}

/** The dotted max-dB peak-hold line + its dB label for one region. (REQ-spectrum-draws-a-peak-hold) */
export function drawPeak(ctx: CanvasRenderingContext2D, r: ScopeRegion, peakDb: number): void {
  if (!Number.isFinite(peakDb)) return;
  const y = r.y + r.h - dbToFrac(peakDb) * (r.h - 2);
  // Turn the red accent on as the peak approaches 0 dB (clip).
  const color = peakDb >= -0.05 ? scopeInks().peakHot : scopeInks().peak;
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
  haloText(ctx, `${peakDb.toFixed(1)} dB`, r.x + r.w / 2, near ? y + 2 : y - 2, color);
  ctx.restore();
}
