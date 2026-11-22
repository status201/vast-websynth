/**
 * Small pieces the sample studio's screens share (sample-recorder.md): the
 * waveform inks, canvas sizing, the centre line, element building and the time
 * and clip readouts. Used by record-sound-modal.ts, record-screen.ts and
 * studio-tools.ts — one copy, so the Record screen's live take and the Edit
 * screen's waveform cannot drift apart in how they size or ink a canvas.
 */
import type { CapturedAudio } from '../../audio/recorder/node';
import { capturedFrames, peakDb } from '../../audio/recorder/buffer-dsp';
import { paletteDerived, rgba } from '../theme-colors';
import { backingScale } from '../ui-scale';

/** The waveform's inks, from the screen tokens (ui-themes.md REQ-canvas-reads-the-screen-tokens). */
export const waveColours = paletteDerived((p) => ({
  midline: rgba(p.ink, 0.07),
  clipped: rgba(p.hot),
  inside: rgba(p.trace),
  outside: rgba(p.trace, 0.18),
  mark: rgba(p.ink),
}));

/** `m:ss.s` */
export function fmtTime(s: number): string {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const rest = t - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

/** "1.46 s · 48,000 Hz · peak 1.1 dB" — a clip in one line. */
export function fmtClip(c: CapturedAudio): string {
  const dur = capturedFrames(c) / c.sampleRate;
  const db = peakDb(c);
  const dbStr = db === -Infinity ? '−∞' : db.toFixed(1);
  return `${dur.toFixed(2)} s · ${c.sampleRate.toLocaleString()} Hz · peak ${dbStr} dB`;
}

/**
 * Size a canvas's bitmap to its box at the backing scale (ui-scale.md
 * REQ-canvases-stay-sharp-at-any-scale) and hand back a cleared context in CSS
 * pixels — or null while it has no box.
 */
export function fitCanvas(canvas: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return null;
  const dpr = backingScale();
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  // Assigning a size reallocates the bitmap, so only when it changed.
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

/** The centre line both waveforms are drawn about. */
export function drawMidline(g: CanvasRenderingContext2D, w: number, h: number, ink: string): void {
  g.strokeStyle = ink;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
}
