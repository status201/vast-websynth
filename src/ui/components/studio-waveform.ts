/**
 * The Edit screen's waveform (sample-recorder.md): the clip drawn against its
 * selection, the two crop handles, the chop boundaries and the preview's
 * playhead — and the three drags that move them (crop handles; a boundary, hit-
 * tested on the canvas — sample-chop.md REQ-two-ways-to-place-the-cuts).
 *
 * The view holds no material. It reads the studio's through the deps on every
 * paint and writes a dragged crop back through `setCrop`, so the selection has
 * one owner. Peaks are memoised (REQ-the-waveform-redraw-is-cheap), and the view
 * repaints itself when its box changes.
 */
import recStyles from '../styles/record-sound.module.css';
import type { CapturedAudio } from '../../audio/recorder/node';
import { capturedFrames, createPeakCache } from '../../audio/recorder/buffer-dsp';
import { toLocal } from '../ui-scale';
import { el } from '../dom';
import { fitCanvas, drawMidline, waveColours } from './studio-kit';

export interface WaveformDeps {
  working(): CapturedAudio | null;
  cropStart(): number;
  cropEnd(): number;
  /** A crop handle moved: the studio stores it and re-syncs its pages. */
  setCrop(start: number, end: number): void;
  /** The chop boundaries — a boundary drag moves one in place. */
  marks(): number[];
  /** Where the preview's playhead is, in frames of the selection, or null. */
  playhead(): number | null;
  /** Called after every paint — the status line follows the selection. */
  onPaint?(): void;
}

export interface WaveformView {
  readonly el: HTMLElement;
  redraw(): void;
  destroy(): void;
}

/** How near a boundary a press must land to grab it. */
const GRAB_PX = 8;

export function createWaveform(deps: WaveformDeps): WaveformView {
  const wrap = el('div', recStyles.waveWrap);
  const canvas = el('canvas', recStyles.wave);
  const hL = el('div', `${recStyles.handle!} left`);
  const hR = el('div', `${recStyles.handle!} right`);
  wrap.append(canvas, hL, hR);

  const sampleLen = (): number => {
    const w = deps.working();
    return w ? capturedFrames(w) : 0;
  };
  const wpx = (): number => canvas.clientWidth || wrap.clientWidth || 1;
  const xOf = (s: number): number => (sampleLen() ? (s / sampleLen()) * wpx() : 0);
  const sampleAt = (x: number): number => Math.round((Math.max(0, x) / wpx()) * sampleLen());
  const clamp1 = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);
  /** The smallest selection or slice a drag may leave: half a percent of the clip. */
  const minGap = (): number => Math.max(1, Math.floor(sampleLen() * 0.005));

  /**
   * Waveform peaks, memoised (buffer-dsp.ts `createPeakCache`). `redraw()` runs
   * once per animation frame while a preview plays, and `computePeaks` walks the
   * whole clip (REQ-the-waveform-redraw-is-cheap).
   */
  const peaksFor = createPeakCache();

  const redraw = (): void => {
    const buf = deps.working();
    if (!buf) return;
    deps.onPaint?.();
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const { g, w, h } = fit;
    const ink = waveColours();
    drawMidline(g, w, h, ink.midline);
    const cropStart = deps.cropStart();
    const cropEnd = deps.cropEnd();

    const cols = Math.max(1, Math.floor(w));
    const peaks = peaksFor(buf, cols);
    const len = sampleLen();
    for (let c = 0; c < cols; c++) {
      const min = peaks[c * 2] ?? 0;
      const max = peaks[c * 2 + 1] ?? 0;
      const sample = (c / cols) * len;
      const inside = sample >= cropStart && sample < cropEnd;
      const clipped = max > 1 || min < -1;
      g.strokeStyle = clipped ? ink.clipped : inside ? ink.inside : ink.outside;
      g.lineWidth = 1;
      const y1 = h / 2 - clamp1(max) * (h / 2 - 2);
      const y2 = h / 2 - clamp1(min) * (h / 2 - 2);
      g.beginPath();
      g.moveTo(c + 0.5, y1);
      g.lineTo(c + 0.5, Math.max(y2, y1 + 0.5));
      g.stroke();
    }

    const played = deps.playhead();
    if (played !== null) {
      const pos = cropStart + played;
      if (pos >= cropStart && pos <= cropEnd) {
        const x = xOf(pos);
        g.strokeStyle = ink.mark;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
      }
    }

    // Chop boundaries (sample-chop.md REQ-two-ways-to-place-the-cuts). Drawn after the waveform so they
    // read as cuts THROUGH it, and clipped to the selection because that is the
    // region they divide (REQ-chop-divides-the-selection).
    for (const m of deps.marks()) {
      if (m <= cropStart || m >= cropEnd) continue;
      const x = xOf(m);
      g.strokeStyle = ink.mark;
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
      g.setLineDash([]);
    }

    hL.style.left = `${xOf(cropStart)}px`;
    hR.style.left = `${xOf(cropEnd)}px`;
  };

  const dragHandle = (handle: HTMLElement, which: 'start' | 'end'): void => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent): void => {
        const rect = wrap.getBoundingClientRect();
        const s = sampleAt(toLocal(ev.clientX - rect.left));
        const gap = minGap();
        const start = deps.cropStart();
        const end = deps.cropEnd();
        if (which === 'start') deps.setCrop(Math.max(0, Math.min(s, end - gap)), end);
        else deps.setCrop(start, Math.min(sampleLen(), Math.max(s, start + gap)));
        redraw();
      };
      const onUp = (ev: PointerEvent): void => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  };
  dragHandle(hL, 'start');
  dragHandle(hR, 'end');

  // A boundary is hit-tested on the canvas rather than given a handle of its
  // own: there can be seven of them, and the two crop handles are separate
  // elements that keep priority wherever they overlap.
  canvas.addEventListener('pointerdown', (e) => {
    const marks = deps.marks();
    if (marks.length === 0) return;
    const rect = wrap.getBoundingClientRect();
    let idx = -1;
    let best = GRAB_PX;
    marks.forEach((m, i) => {
      const d = Math.abs(xOf(m) - toLocal(e.clientX - rect.left));
      if (d < best) { best = d; idx = i; }
    });
    if (idx < 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const gap = minGap();
    const onMove = (ev: PointerEvent): void => {
      const lo = (marks[idx - 1] ?? deps.cropStart()) + gap;
      const hi = (marks[idx + 1] ?? deps.cropEnd()) - gap;
      if (hi <= lo) return;
      marks[idx] = Math.max(lo, Math.min(sampleAt(toLocal(ev.clientX - rect.left)), hi));
      redraw();
    };
    const onUp = (ev: PointerEvent): void => {
      canvas.releasePointerCapture(ev.pointerId);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
  });

  const resizeObs = new ResizeObserver(() => redraw());
  resizeObs.observe(wrap);

  return {
    el: wrap,
    redraw,
    destroy: () => resizeObs.disconnect(),
  };
}
