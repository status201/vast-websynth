/**
 * "Record a sound" — capture from the mic (or re-open a loaded sample),
 * trim/clean it, then save (WAV/MP3) or drop it into a Sampler slot. Glue
 * only: it composes the reusable `Modal`, the `MicSession` capture, the pure
 * `buffer-dsp` ops, the `offline-render` effects, and the `encode` pipeline.
 */
import recStyles from '../styles/record-sound.module.css';
import type { StudioApi } from '../studio-api';
import { Modal } from './modal';
import { createButton, setButtonLabel } from './button';
import { Dropdown } from './dropdown';
import { openMicSession, MicCaptureError, type MicSession } from '../../audio/recorder/mic-capture';
import type { CapturedAudio } from '../../audio/recorder/node';
import {
  cloneCaptured, crop, reverse, normalize, gain, fadeIn, fadeOut, computePeaks, peakDb,
  sliceEqual, sliceRanges, detectOnsets,
} from '../../audio/recorder/buffer-dsp';
import { confirmDialog } from './dialog';
import { showToast } from './toast';
import { renderEffect, renderPitchShift } from '../../audio/recorder/offline-render';
import { fitToFrames, type StretchMode } from '../../audio/recorder/time-stretch';
import { renderScratch } from '../../audio/recorder/scratch';
import {
  scratchPreset, randomScratch, autoCue, SCRATCH_PRESETS,
  type ScratchCurve, type ScratchPresetName,
} from '../../audio/recorder/scratch-curve';
import { ScratchGraph } from './scratch-graph';
import { createCollapseToggle, type CollapseToggle } from './collapse-toggle';
import { capturedToAudioBuffer } from '../../audio/recorder/audio-buffer';
import { encodeWav, encodeMp3, triggerDownload } from '../../audio/recorder/encode';
import { SAMPLER_SLOT_COUNT, SAMPLER_SLOT_LABELS } from '../../state/patterns';
import {
  MIN_STRETCH_RATIO, MAX_STRETCH_RATIO, MAX_STRETCH_OUTPUT_FRAMES,
  MAX_PITCH_SHIFT_SEMITONES, MAX_SCRATCH_STEPS,
} from '../../state/limits';
import { UI_ICONS } from './ui-icons';

const FADE_MS = 150;
const BOOST_FACTOR = 2; // ≈ +6 dB
/** Columns of source peaks the scratch graph warps. Enough to resolve a hit at
 *  any usable width, cheap enough to recompute on a crop drag. */
const PEAK_COLS = 512;
const MIN_F = 20;
const MAX_F = 18000;

export interface RecordSoundOptions {
  /** Slot the picker defaults to (and that "Load into Sampler" targets). */
  slot?: number;
  /** If set, skip recording and open this audio straight in the editor. */
  source?: CapturedAudio;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function fmtClip(c: CapturedAudio): string {
  const n = Math.min(c.left.length, c.right.length);
  const dur = n / c.sampleRate;
  const db = peakDb(c);
  const dbStr = db === -Infinity ? '−∞' : db.toFixed(1);
  return `${dur.toFixed(2)} s · ${c.sampleRate.toLocaleString()} Hz · peak ${dbStr} dB`;
}

function errorText(code: string): string {
  switch (code) {
    case 'insecure-context':
      return 'Microphone needs HTTPS or localhost. The network/LAN address is plain HTTP and is blocked — open the app on the host machine via http://localhost, or serve it over HTTPS.';
    case 'denied':
      return "Microphone permission was blocked. Allow mic access in your browser's site settings, then try again.";
    case 'no-device':
      return 'No microphone was found. Connect one and try again.';
    case 'unsupported':
      return "This browser can't record audio.";
    default:
      return 'Could not start the microphone. Try again.';
  }
}

export function openRecordSoundModal(engine: StudioApi, opts: RecordSoundOptions = {}): void {
  const defaultSlot = opts.slot ?? 0;

  let session: MicSession | null = null;
  let original: CapturedAudio | null = null;
  let working: CapturedAudio | null = null;
  let undoSnapshot: CapturedAudio | null = null;
  let cropStart = 0;
  let cropEnd = 0;
  let previewSrc: AudioBufferSourceNode | null = null;
  let previewStartTime = 0;
  let previewClipSamples = 0;
  let playRaf = 0;
  let resizeObs: ResizeObserver | null = null;
  let cleaned = false;
  let lastAction = 'Ready';
  let onPlayingChange: ((playing: boolean) => void) | null = null;
  let redrawHook: (() => void) | null = null;
  /** Interior chop boundaries, absolute sample indices (sample-chop.md REQ-3). */
  let marks: number[] = [];
  /** Re-reads `marks` into the chop row's labels and disabled states. */
  let syncChop: (() => void) | null = null;
  /** Re-reads the selection into the Fit row's target list, hint and disabled
   *  states (time-stretch.md REQ-9/REQ-10). */
  let syncFit: ((repick?: boolean) => void) | null = null;
  /** Re-reads the selection into the Scratch row's hint, grid and disabled state
   *  (scratch.md REQ-15). */
  let syncScratch: ((repick?: boolean) => void) | null = null;
  /** Last-rendered Fit target labels, so a meter change rebuilds the list and a
   *  crop drag does not. */
  let fitLabels = '';
  /** The drawn scratch. Lives exactly as long as the modal does — nothing about
   *  it is persisted (scratch.md REQ-24). */
  let scratch: ScratchCurve = scratchPreset('Baby', 16);
  let scratchGraph: ScratchGraph | null = null;

  const stopPreview = (): void => {
    cancelAnimationFrame(playRaf);
    playRaf = 0;
    if (previewSrc) {
      try { previewSrc.stop(); } catch { /* already stopped */ }
      try { previewSrc.disconnect(); } catch { /* already disconnected */ }
      previewSrc = null;
    }
    onPlayingChange?.(false);
    redrawHook?.();
  };

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    session?.dispose();
    session = null;
    cancelAnimationFrame(playRaf);
    stopPreview();
    onPlayingChange = null;
    redrawHook = null;
    syncChop = null;
    syncFit = null;
    syncScratch = null;
    // The graph owns a ResizeObserver and, mid-drag, listeners on its own canvas
    // plus the shared value bubble — none of which the modal's teardown can see.
    scratchGraph?.destroy();
    scratchGraph = null;
    resizeObs?.disconnect();
    resizeObs = null;
  };

  const editing = opts.source != null;
  const modal = new Modal({
    title: editing ? 'Edit sample' : 'Record a sound',
    cardClass: recStyles.modal!,
    onClose: cleanup,
  });
  const body = modal.body;

  // ---- Phase A: idle / recording ------------------------------------------
  function showIdle(message?: string): void {
    body.innerHTML = '';
    const text = document.createElement('div');
    text.className = recStyles.text!;
    text.textContent =
      message ?? 'Tap/click Record to record directly using your device’s microphone.';
    body.appendChild(text);

    const actions = document.createElement('div');
    actions.className = recStyles.actions!;
    const recBtn = createButton({ label: 'Record', led: true, testId: 'mic-record-toggle' });
    let recording = false;
    recBtn.addEventListener('click', async () => {
      if (recording) {
        await finishRecording();
        return;
      }
      recBtn.disabled = true;
      try {
        session = await openMicSession(engine.ctx);
      } catch (err) {
        recBtn.disabled = false;
        showIdle(errorText(err instanceof MicCaptureError ? err.code : 'unknown'));
        return;
      }
      if (cleaned) {
        // Modal was closed while the mic prompt was pending.
        session.dispose();
        session = null;
        return;
      }
      session.start();
      recording = true;
      recBtn.disabled = false;
      recBtn.classList.add('on'); // global state class
      setButtonLabel(recBtn, 'Stop');
    });
    const closeBtn = createButton({ label: 'Close', testId: 'mic-close', onClick: () => modal.close() });
    actions.appendChild(recBtn);
    actions.appendChild(closeBtn);
    body.appendChild(actions);
  }

  async function finishRecording(): Promise<void> {
    if (!session) return;
    const live = session;
    session = null;   // claim it first — a second tap must not stop it twice
    // Await the take BEFORE disposing: `dispose()` releases the recorder, and
    // the worklet's final batch is still in flight until `stop()` resolves
    // (audio-export.md REQ-6b). Disposing first would truncate every take.
    const captured = await live.stop();
    live.dispose();
    if (captured.left.length === 0) {
      showIdle('Nothing was recorded — try again.');
      return;
    }
    original = captured;
    working = cloneCaptured(captured);
    cropStart = 0;
    cropEnd = Math.min(captured.left.length, captured.right.length);
    lastAction = 'Recorded';
    showEditor();
  }

  // ---- Phase B/C: edit + actions ------------------------------------------
  function showEditor(): void {
    if (!working) return;
    body.innerHTML = '';
    resizeObs?.disconnect();

    // Waveform + crop handles
    const wrap = document.createElement('div');
    wrap.className = recStyles.waveWrap!;
    const canvas = document.createElement('canvas');
    canvas.className = recStyles.wave!;
    const hL = document.createElement('div');
    hL.className = `${recStyles.handle!} left`;
    const hR = document.createElement('div');
    hR.className = `${recStyles.handle!} right`;
    wrap.append(canvas, hL, hR);
    body.appendChild(wrap);

    const hint = document.createElement('div');
    hint.className = recStyles.hint!;
    hint.textContent = 'Drag the side handles to crop. Effects apply to the selection.';
    body.appendChild(hint);

    const status = document.createElement('div');
    status.className = recStyles.status!;
    body.appendChild(status);

    const sampleLen = (): number =>
      working ? Math.min(working.left.length, working.right.length) : 0;
    const wpx = (): number => canvas.clientWidth || wrap.clientWidth || 1;
    const xOf = (s: number): number => (sampleLen() ? (s / sampleLen()) * wpx() : 0);
    const sampleAt = (x: number): number =>
      Math.round((Math.max(0, x) / wpx()) * sampleLen());
    const clamp1 = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

    const refreshStatus = (buf: CapturedAudio): void => {
      const sel = crop(buf, cropStart, cropEnd);
      status.textContent = `${lastAction} — selection ${fmtClip(sel)}`;
    };

    let bw = 0;
    let bh = 0;
    const redraw = (): void => {
      const buf = working;
      if (!buf) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const nbw = Math.round(w * dpr);
      const nbh = Math.round(h * dpr);
      if (nbw !== bw || nbh !== bh) { canvas.width = nbw; canvas.height = nbh; bw = nbw; bh = nbh; }
      const g = canvas.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      g.strokeStyle = 'rgba(244, 205, 94, 0.07)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, h / 2);
      g.lineTo(w, h / 2);
      g.stroke();

      const cols = Math.max(1, Math.floor(w));
      const peaks = computePeaks(buf, cols);
      const len = sampleLen();
      for (let c = 0; c < cols; c++) {
        const min = peaks[c * 2] ?? 0;
        const max = peaks[c * 2 + 1] ?? 0;
        const sample = (c / cols) * len;
        const inside = sample >= cropStart && sample < cropEnd;
        const clipped = max > 1 || min < -1;
        g.strokeStyle = clipped
          ? '#ff3a20'
          : inside
            ? '#e8742e'
            : 'rgba(232, 116, 46, 0.18)';
        g.lineWidth = 1;
        const y1 = h / 2 - clamp1(max) * (h / 2 - 2);
        const y2 = h / 2 - clamp1(min) * (h / 2 - 2);
        g.beginPath();
        g.moveTo(c + 0.5, y1);
        g.lineTo(c + 0.5, Math.max(y2, y1 + 0.5));
        g.stroke();
      }

      if (previewSrc && previewClipSamples > 0) {
        const elapsed = engine.ctx.currentTime - previewStartTime;
        const pos = cropStart + elapsed * buf.sampleRate;
        if (pos >= cropStart && pos <= cropEnd) {
          const x = xOf(pos);
          g.strokeStyle = '#f4cd5e';
          g.lineWidth = 1.5;
          g.beginPath();
          g.moveTo(x, 0);
          g.lineTo(x, h);
          g.stroke();
        }
      }

      // Chop boundaries (sample-chop.md REQ-3). Drawn after the waveform so they
      // read as cuts THROUGH it, and clipped to the selection because that is the
      // region they divide (REQ-2).
      for (const m of marks) {
        if (m <= cropStart || m >= cropEnd) continue;
        const x = xOf(m);
        g.strokeStyle = '#f4cd5e';
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
      refreshStatus(buf);
    };
    redrawHook = redraw;

    /**
     * Audition one clip. Split out of `playSelection` so the scratch row can
     * preview a render it has NOT committed (scratch.md REQ-23) through the same
     * node lifecycle, playhead loop and Play/Stop button as everything else.
     */
    const playClip = (c: CapturedAudio): void => {
      stopPreview();
      const node = engine.ctx.createBufferSource();
      node.buffer = capturedToAudioBuffer(engine.ctx, c);
      node.connect(engine.ctx.destination);
      previewStartTime = engine.ctx.currentTime;
      previewClipSamples = Math.min(c.left.length, c.right.length);
      node.onended = (): void => { if (previewSrc === node) stopPreview(); };
      previewSrc = node;
      node.start();
      onPlayingChange?.(true);
      cancelAnimationFrame(playRaf);
      const loop = (): void => {
        redraw();
        if (previewSrc) playRaf = requestAnimationFrame(loop);
      };
      playRaf = requestAnimationFrame(loop);
    };

    const playSelection = (): void => {
      const cur = working;
      if (!cur) return;
      playClip(crop(cur, cropStart, cropEnd));
    };

    const dragHandle = (handle: HTMLElement, which: 'start' | 'end'): void => {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const onMove = (ev: PointerEvent): void => {
          const rect = wrap.getBoundingClientRect();
          const s = sampleAt(ev.clientX - rect.left);
          const gap = Math.max(1, Math.floor(sampleLen() * 0.005));
          if (which === 'start') cropStart = Math.max(0, Math.min(s, cropEnd - gap));
          else cropEnd = Math.min(sampleLen(), Math.max(s, cropStart + gap));
          redraw();
          syncFit?.();
          syncScratch?.();
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

    // Dragging a chop boundary (REQ-3). Hit-tested on the canvas rather than given
    // handles of its own: there can be seven of them, and the two crop handles are
    // separate elements that keep priority wherever they overlap.
    const GRAB_PX = 8;
    canvas.addEventListener('pointerdown', (e) => {
      if (marks.length === 0) return;
      const rect = wrap.getBoundingClientRect();
      let idx = -1;
      let best = GRAB_PX;
      marks.forEach((m, i) => {
        const d = Math.abs(xOf(m) - (e.clientX - rect.left));
        if (d < best) { best = d; idx = i; }
      });
      if (idx < 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const gap = Math.max(1, Math.floor(sampleLen() * 0.005));
      const onMove = (ev: PointerEvent): void => {
        const lo = (marks[idx - 1] ?? cropStart) + gap;
        const hi = (marks[idx + 1] ?? cropEnd) - gap;
        if (hi <= lo) return;
        marks[idx] = Math.max(lo, Math.min(sampleAt(ev.clientX - rect.left), hi));
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

    // Cutoff slider (log-mapped) for the filters
    const cutoffRow = document.createElement('div');
    cutoffRow.className = recStyles.cutoff!;
    const cutoffLabel = document.createElement('span');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1000';
    const freqFromSlider = (v: number): number =>
      MIN_F * Math.pow(MAX_F / MIN_F, v / 1000);
    const sliderFromFreq = (f: number): number =>
      (1000 * Math.log(f / MIN_F)) / Math.log(MAX_F / MIN_F);
    slider.value = String(Math.round(sliderFromFreq(1200)));
    const cutoffFreq = (): number => freqFromSlider(Number(slider.value));
    const paintCutoff = (): void => {
      cutoffLabel.textContent = `Cutoff: ${Math.round(cutoffFreq())} Hz`;
    };
    slider.addEventListener('input', paintCutoff);
    paintCutoff();
    cutoffRow.append(cutoffLabel, slider);
    body.appendChild(cutoffRow);

    // Auto-play toggle (default on)
    const autoRow = document.createElement('label');
    autoRow.className = recStyles.autoplay!;
    const autoPlay = document.createElement('input');
    autoPlay.type = 'checkbox';
    autoPlay.checked = true;
    const autoText = document.createElement('span');
    autoText.textContent = 'Auto-play after each effect';
    autoRow.append(autoPlay, autoText);
    body.appendChild(autoRow);

    // Effects
    const fxRow = document.createElement('div');
    fxRow.className = recStyles.fxRow!;
    body.appendChild(fxRow);

    /* ---- musical length arithmetic, shared by the Fit and Scratch rows ----
     * Targets are sixteenth counts, because that is the unit the clock actually
     * runs on (ADR-019: a tick IS a sixteenth) and because "a bar" is only a
     * count of them — one that changes with the meter. Annotating the ones that
     * land on a bar keeps both readings in one control instead of two.
     *
     * This sits above both rows rather than inside Fit's, because
     * time-stretch.md REQ-9 forbids re-deriving what a bar is and a second
     * derivation for the scratch length would be exactly that. */
    const FIT_TARGETS: readonly number[] = [
      ...Array.from({ length: 32 }, (_, i) => i + 1), 48, MAX_SCRATCH_STEPS,
    ];

    const srOf = (): number => working?.sampleRate ?? engine.ctx.sampleRate;
    const selFrames = (): number => Math.max(0, cropEnd - cropStart);
    /** Frames one target occupies at the current tempo — render-to-sampler.md's
     *  arithmetic, never a second derivation of what a bar is. */
    const framesFor = (steps: number): number =>
      Math.round(steps * engine.clock.sixteenthDuration() * srOf());

    const fitLabel = (steps: number): string => {
      const bars = steps / Math.max(1, engine.barTicks);
      if (Number.isInteger(bars)) return `${steps} · ${bars} bar${bars === 1 ? '' : 's'}`;
      if (bars === 0.5) return `${steps} · ½ bar`;
      if (bars === 0.25) return `${steps} · ¼ bar`;
      return `${steps}`;
    };
    const stepsFor = (label: string): number =>
      FIT_TARGETS.find((s) => fitLabel(s) === label) ?? 0;

    /** The target closest to how long the selection already is — what both rows
     *  preselect, so the first thing offered is the one that barely moves. */
    const nearestTarget = (): number => {
      const frames = selFrames();
      let best = FIT_TARGETS[0]!;
      let bestErr = Infinity;
      for (const s of FIT_TARGETS) {
        const err = Math.abs(framesFor(s) - frames);
        if (err < bestErr) { bestErr = err; best = s; }
      }
      return best;
    };

    const allButtons: HTMLButtonElement[] = [];
    let busy = false;
    const setBusy = (b: boolean): void => {
      busy = b;
      for (const btn of allButtons) btn.disabled = b;
      // The chop row's buttons depend on more than busy (room to spread into, and
      // whether any boundary exists), so it re-derives its own rather than being
      // swept along — a blanket re-enable would light up Spread with nothing to
      // spread, and an offline effect would be racing the audio it spreads.
      syncChop?.();
      // Same reasoning for Fit: the target may be out of the stretch limits for
      // this selection, and a blanket re-enable would offer a fit that is refused.
      syncFit?.();
      // And for Scratch, whose chosen length must still fit the frame bound.
      syncScratch?.();
    };

    const afterMutate = (next: CapturedAudio, action: string, btn?: HTMLButtonElement): void => {
      working = next;
      cropStart = 0;
      cropEnd = Math.min(next.left.length, next.right.length);
      // Every edit re-bases the sample indices, so the old boundaries now point at
      // the wrong audio. Dropping them is the only honest answer: a stale marker
      // that still LOOKS placed is how a chop cuts in the wrong place silently.
      marks = [];
      syncChop?.();
      syncFit?.(true);
      syncScratch?.(true);
      lastAction = action;
      redraw();
      if (btn) {
        btn.classList.add(recStyles.applied!);
        window.setTimeout(() => btn.classList.remove(recStyles.applied!), 600);
      }
      if (autoPlay.checked) playSelection();
    };

    /**
     * Run one destructive edit on the current selection: latch the busy state,
     * label the button with it, snapshot for undo, then hand the result to
     * `afterMutate`. Shared by the effect buttons and by the Fit / Shift rows
     * (time-stretch.md REQ-9) so all of them inherit the same undo, the same busy
     * latch and the same marks reset instead of reimplementing them.
     */
    const runOp = (
      btn: HTMLButtonElement,
      label: string,
      op: (src: CapturedAudio) => CapturedAudio | Promise<CapturedAudio>,
    ): void => {
      const cur = working;
      if (!cur) return;
      setBusy(true);
      setButtonLabel(btn, `${label}…`);
      const base = crop(cur, cropStart, cropEnd);
      Promise.resolve(op(base))
        .then((next) => {
          undoSnapshot = cur;
          afterMutate(next, `${label} applied`, btn);
        })
        .catch(() => { /* keep prior working */ })
        .finally(() => { setBusy(false); setButtonLabel(btn, label); });
    };

    const apply = (
      label: string,
      op: (src: CapturedAudio) => CapturedAudio | Promise<CapturedAudio>,
    ): void => {
      const btn = createButton({
        label,
        testId: `mic-fx-${label.toLowerCase().replace(/\s+/g, '-')}`,
        onClick: () => runOp(btn, label, op),
      });
      allButtons.push(btn);
      fxRow.appendChild(btn);
    };

    // Filter buttons read the live slider value at click time.
    apply('Low Pass', (src) => renderEffect(src, { kind: 'lowpass', freq: cutoffFreq() }));
    apply('Hi Pass', (src) => renderEffect(src, { kind: 'highpass', freq: cutoffFreq() }));
    apply('Octave Up', (src) => renderEffect(src, { kind: 'octaveUp' }));
    apply('Octave Down', (src) => renderEffect(src, { kind: 'octaveDown' }));
    apply('Reverse', (src) => reverse(src));
    apply('Normalize', (src) => normalize(src));
    apply('Fade In', (src) => fadeIn(src, FADE_MS));
    apply('Fade Out', (src) => fadeOut(src, FADE_MS));
    apply('Boost', (src) => gain(src, BOOST_FACTOR));

    const editRow = document.createElement('div');
    editRow.className = recStyles.fxRow!;
    const undoBtn = createButton({
      label: 'Undo',
      testId: 'mic-undo',
      onClick: () => {
        const snap = undoSnapshot;
        if (!snap) return;
        undoSnapshot = null;
        afterMutate(snap, 'Undone');
      },
    });
    const resetBtn = createButton({
      label: 'Reset',
      testId: 'mic-reset',
      onClick: () => {
        if (!original) return;
        undoSnapshot = null;
        afterMutate(cloneCaptured(original), 'Reset to original');
      },
    });
    const playBtn = createButton({ label: 'Play', led: true, testId: 'mic-play' });
    playBtn.addEventListener('click', () => {
      if (previewSrc) stopPreview();
      else playSelection();
    });
    onPlayingChange = (playing: boolean): void => {
      playBtn.classList.toggle('on', playing);
      setButtonLabel(playBtn, playing ? 'Stop' : 'Play');
    };
    editRow.append(undoBtn, resetBtn, playBtn);
    body.appendChild(editRow);

    // Built before the chop row, which needs to know where a spread would start
    // to decide how many slices fit (sample-chop.md REQ-5).
    const slotOptions = Array.from({ length: SAMPLER_SLOT_COUNT }, (_, i) => {
      const name = engine.patterns.sampleNames[i] ?? null;
      const tag = SAMPLER_SLOT_LABELS[i] ?? `S${i + 1}`;
      return `${tag} — ${name ?? 'empty'}`;
    });
    const picker = new Dropdown(
      slotOptions,
      slotOptions[Math.max(0, Math.min(defaultSlot, SAMPLER_SLOT_COUNT - 1))],
    );
    picker.el.dataset.testid = 'mic-slot-select';

    // ---- Chop (sample-chop.md) ----
    const chopRow = document.createElement('div');
    chopRow.className = recStyles.fxRow!;
    chopRow.dataset.testid = 'chop-row';
    const chopLabel = document.createElement('span');
    chopLabel.className = recStyles.hint!;
    chopRow.appendChild(chopLabel);

    const startSlot = (): number => Math.max(0, slotOptions.indexOf(picker.value));
    const slotTag = (i: number): string => SAMPLER_SLOT_LABELS[i] ?? `S${i + 1}`;
    /** REQ-5 — offer only counts that fit from the picker's slot, so a spread can
     *  never quietly drop the slices it has no room for. */
    const fittingCounts = (): string[] => {
      const room = SAMPLER_SLOT_COUNT - startSlot();
      return [2, 4, 6, 8].filter((n) => n <= room).map((n) => `${n} slices`);
    };
    // `—` rather than an empty list: a dropdown with no options reads as broken,
    // and this state is legitimate (the last slot has no room to spread into).
    const countDd = new Dropdown(fittingCounts().length ? fittingCounts() : ['—'], '4 slices');
    countDd.el.dataset.testid = 'chop-count';
    chopRow.appendChild(countDd.el);
    const wantCount = (): number => parseInt(countDd.value, 10) || 2;

    const layMarks = (next: number[]): void => {
      marks = next;
      syncChop?.();
      redraw();
    };

    const chopBtn = createButton({
      label: 'Chop',
      testId: 'chop-equal',
      onClick: () => {
        const cur = working;
        if (cur) layMarks(sliceEqual(cur, wantCount(), cropStart, cropEnd));
      },
    });
    const detectBtn = createButton({
      label: 'Detect',
      testId: 'chop-detect',
      onClick: () => {
        const cur = working;
        if (!cur) return;
        const found = detectOnsets(cur, {
          from: cropStart, to: cropEnd, maxSlices: wantCount(),
        });
        // Falling back to an equal cut would misrepresent the result as detection.
        // Say nothing was found and leave the boundaries alone.
        if (found.length === 0) { lastAction = 'No transients found'; redraw(); return; }
        layMarks(found);
      },
    });
    const spreadBtn = createButton({
      label: 'Spread to slots',
      testId: 'chop-spread',
      onClick: () => { void spread(); },
    });
    chopRow.append(chopBtn, detectBtn, spreadBtn);

    syncChop = (): void => {
      const fits = fittingCounts();
      const noRoom = fits.length === 0;
      countDd.setOptions(noRoom ? ['—'] : fits);
      const room = SAMPLER_SLOT_COUNT - startSlot();
      const n = marks.length + 1;
      // REQ-5 has to survive the picker MOVING, not just the moment of chopping.
      // Filtering the count list is what stops an over-long chop being made; this
      // is what stops one being made and then aimed at a slot with less room
      // behind it. Refuse rather than quietly re-cut: the user chose this many
      // slices, and silently dropping the tail — or silently merging it into the
      // last slice — is the same class of defect in a nicer coat.
      const tooMany = marks.length > 0 && n > room;
      chopLabel.textContent = noRoom
        ? `Chop: no room below ${slotTag(startSlot())} — pick an earlier slot.`
        : tooMany
          ? `Chop: ${n} slices need ${n} slots — ${slotTag(startSlot())} has room for ${room}.`
          : marks.length === 0
            ? 'Chop: cut the selection, then drag any boundary.'
            : `Chop: ${n} slices → ${slotTag(startSlot())}–${slotTag(startSlot() + n - 1)}`;
      chopBtn.disabled = busy || noRoom;
      detectBtn.disabled = busy || noRoom;
      spreadBtn.disabled = busy || noRoom || tooMany || marks.length === 0;
    };
    picker.onChange(() => syncChop?.());
    syncChop();

    /** The slices' shared stem: the source slot's filename without its extension. */
    const baseName = (): string =>
      (engine.patterns.sampleNames[defaultSlot] ?? 'chop').replace(/\.[^.]+$/, '');

    const spread = async (): Promise<void> => {
      const cur = working;
      if (!cur || marks.length === 0) return;
      const start = startSlot();
      const ranges = sliceRanges(cropStart, cropEnd, marks);
      const n = ranges.length;
      // Guarded by `syncChop`, which disables the button rather than let this be
      // reached. Kept as a hard refuse and NOT as a `Math.min` clamp: clamping
      // here is what silently dropped the slices that did not fit, and it did it
      // behind a label that had already promised them.
      if (n > SAMPLER_SLOT_COUNT - start) return;
      const targets = Array.from({ length: n }, (_, k) => start + k);
      const occupied = targets.filter((slot) =>
        engine.patterns.sampleNames[slot] != null || engine.sampler.buffers[slot] != null);
      // REQ-6 — it overwrites up to eight slots at once, so it names them first.
      const ok = await confirmDialog({
        title: `Spread ${n} slices`,
        message: `Slices go to ${slotTag(start)}–${slotTag(start + n - 1)}.`,
        detail: occupied.length
          ? `This replaces ${occupied.map(slotTag).join(', ')}. You can undo it.`
          : undefined,
        confirmLabel: 'Spread',
        danger: occupied.length > 0,
      });
      if (!ok) return;

      // Captured BEFORE the writes, and held only by the toast's closure — the
      // pattern-undo stack carries steps, never audio, so this mutation owns its
      // own reversal exactly as `samplerSlotClearRow` does (REQ-6).
      const base = baseName();
      const prev = targets.map((slot) => ({
        slot,
        buffer: engine.sampler.buffers[slot] ?? null,
        name: engine.patterns.sampleNames[slot] ?? null,
      }));
      targets.forEach((slot, k) => {
        const [from, to] = ranges[k]!;
        engine.sampler.setBuffer(slot, capturedToAudioBuffer(engine.ctx, crop(cur, from, to)));
        engine.patterns.setSampleName(slot, `${base} ${k + 1}/${n}`);
      });
      modal.close();
      showToast({
        message: `Chopped into ${n} slices`,
        actionLabel: 'Undo',
        testId: 'chop-toast',
        onAction: () => {
          for (const q of prev) {
            // Buffer first, then the name: the meta event is what repaints the
            // row, and it reads `buffers[slot]` for the .needs-reload hint.
            engine.sampler.setBuffer(q.slot, q.buffer);
            engine.patterns.setSampleName(q.slot, q.name);
          }
        },
      });
    };

    body.appendChild(chopRow);

    // ---- Fit + Shift (time-stretch.md REQ-9/REQ-10) ----
    // The sixteenth arithmetic these read lives above the chop row, shared with
    // the Scratch section.

    /** Whether a target is reachable from this selection within the stretch limits. */
    const fitOk = (steps: number): boolean => {
      const from = selFrames();
      const to = framesFor(steps);
      if (from <= 0 || to <= 0 || to > MAX_STRETCH_OUTPUT_FRAMES) return false;
      const r = to / from;
      return r >= MIN_STRETCH_RATIO && r <= MAX_STRETCH_RATIO;
    };

    const fitRow = document.createElement('div');
    fitRow.className = recStyles.fxRow!;
    fitRow.dataset.testid = 'fit-row';
    const fitHint = document.createElement('span');
    fitHint.className = recStyles.hint!;
    fitHint.dataset.testid = 'fit-hint';
    fitRow.appendChild(fitHint);

    const targetDd = new Dropdown(FIT_TARGETS.map(fitLabel), fitLabel(16));
    targetDd.el.dataset.testid = 'fit-target';
    fitRow.appendChild(targetDd.el);

    const MODE_LABELS = ['Rhythmic', 'Tonal'] as const;
    const modeDd = new Dropdown([...MODE_LABELS], MODE_LABELS[0]);
    modeDd.el.dataset.testid = 'fit-mode';
    modeDd.el.title = 'Rhythmic keeps transients (drums, loops). Tonal is smoother '
      + 'on sustained sounds and washes drums out.';
    fitRow.appendChild(modeDd.el);

    const fitMode = (): StretchMode => (modeDd.value === 'Tonal' ? 'tonal' : 'rhythmic');

    const fitBtn = createButton({
      label: 'Fit',
      testId: 'fit-apply',
      onClick: () => {
        const steps = stepsFor(targetDd.value);
        if (!steps || !fitOk(steps)) return;
        const frames = framesFor(steps);
        const mode = fitMode();
        runOp(fitBtn, 'Fit', (src) => fitToFrames(src, frames, mode));
      },
    });
    allButtons.push(fitBtn);
    fitRow.appendChild(fitBtn);
    body.appendChild(fitRow);

    const shiftRow = document.createElement('div');
    shiftRow.className = recStyles.fxRow!;
    shiftRow.dataset.testid = 'shift-row';
    const shiftHint = document.createElement('span');
    shiftHint.className = recStyles.hint!;
    shiftHint.textContent = 'Shift: pitch only, length kept.';
    shiftRow.appendChild(shiftHint);

    const shiftLabel = (st: number): string => (st > 0 ? `+${st} st` : `${st} st`);
    const SHIFT_STEPS = Array.from(
      { length: MAX_PITCH_SHIFT_SEMITONES * 2 + 1 },
      (_, i) => i - MAX_PITCH_SHIFT_SEMITONES,
    );
    const shiftDd = new Dropdown(SHIFT_STEPS.map(shiftLabel), shiftLabel(0));
    shiftDd.el.dataset.testid = 'shift-amount';
    shiftRow.appendChild(shiftDd.el);

    const shiftAmount = (): number =>
      SHIFT_STEPS.find((s) => shiftLabel(s) === shiftDd.value) ?? 0;

    const shiftBtn = createButton({
      label: 'Shift',
      testId: 'shift-apply',
      onClick: () => {
        const st = shiftAmount();
        if (st === 0) return;
        const mode = fitMode();
        runOp(shiftBtn, 'Shift', (src) => renderPitchShift(src, st, mode));
      },
    });
    allButtons.push(shiftBtn);
    shiftRow.appendChild(shiftBtn);
    body.appendChild(shiftRow);

    /* ---- Scratch (scratch.md REQ-15 … REQ-23) ----
     * A section rather than a second modal: it edits the same selection, and it
     * applies through the same `runOp`, so undo, the busy latch and the crop
     * reset are inherited rather than reimplemented. It is collapsed until asked
     * for, because a 210 px canvas is a lot of modal to spend on a feature most
     * sessions never open (runtime-performance.md).
     */
    const scratchWrap = document.createElement('div');
    scratchWrap.className = recStyles.scratchSection!;
    scratchWrap.dataset.testid = 'scratch-section';
    const scratchHead = document.createElement('div');
    scratchHead.className = recStyles.scratchHead!;
    const scratchTitle = document.createElement('span');
    scratchTitle.textContent = 'Scratch';
    const scratchBody = document.createElement('div');
    scratchBody.className = recStyles.scratchBody!;
    scratchBody.dataset.testid = 'scratch-body';

    const scratchRow = document.createElement('div');
    scratchRow.className = recStyles.fxRow!;
    scratchRow.dataset.testid = 'scratch-row';
    const scratchHint = document.createElement('span');
    scratchHint.className = recStyles.hint!;
    scratchHint.dataset.testid = 'scratch-hint';
    scratchRow.appendChild(scratchHint);

    const lenDd = new Dropdown(FIT_TARGETS.map(fitLabel), fitLabel(16));
    lenDd.el.dataset.testid = 'scratch-length';
    lenDd.el.title = 'How long the scratch lasts, in sixteenths at the current tempo.';
    scratchRow.appendChild(lenDd.el);

    // "Custom" is not a preset you can pick — it is what the dropdown says once
    // the curve stops being any of them, so the control never names a shape that
    // is no longer on screen (ADR-014 law 5).
    const CUSTOM = 'Custom';
    const PRESET_LABELS = [
      ...SCRATCH_PRESETS.map((n) => (n === 'Baby' ? 'Baby (short-short-long)' : n)),
      CUSTOM,
    ];
    const presetDd = new Dropdown([...PRESET_LABELS], PRESET_LABELS[0]);
    presetDd.el.dataset.testid = 'scratch-preset';
    presetDd.el.title = 'Classic patterns. Baby is a push, a pull and a long push — '
      + 'the one that reads as a scratch straight away.';
    scratchRow.appendChild(presetDd.el);

    const scratchSteps = (): number => stepsFor(lenDd.value) || 16;
    const scratchFrames = (): number => framesFor(scratchSteps());
    const presetFor = (label: string): ScratchPresetName =>
      SCRATCH_PRESETS[Math.max(0, PRESET_LABELS.indexOf(label))] ?? 'Baby';

    /** Drop the needle so the gesture reads from inside the sample (REQ-20).
     *  Recomputed whenever the shape or the length changes, never stored. */
    const recue = (c: ScratchCurve): ScratchCurve =>
      ({ ...c, cue: autoCue(c, selFrames(), scratchFrames()) });

    const setScratch = (c: ScratchCurve, recueIt = true): void => {
      scratch = recueIt ? recue(c) : c;
      scratchGraph?.setCurve(scratch);
      syncScratch?.();
    };

    const graph = new ScratchGraph({
      curve: scratch,
      // A hand-edited curve is no longer any named preset, and saying so is
      // cheaper than a dropdown that lies about what is on screen.
      onChange: (c) => {
        scratch = c;
        if (presetDd.value !== CUSTOM) presetDd.setValue(CUSTOM);
        syncScratch?.();
      },
      // Reuse the checkbox the user already set rather than inventing a second
      // preference for the same question.
      onCommit: () => { if (autoPlay.checked) previewScratch(); },
      onAudition: () => previewScratch(),
    });
    scratchGraph = graph;

    const scratchOf = (src: CapturedAudio): CapturedAudio =>
      renderScratch(src, scratch, scratchFrames());

    /** Render and play without committing (REQ-23) — no `working`, no undo
     *  snapshot, no button flash. The render is a single pass over a bar of
     *  audio, so it is cheap enough to sit behind a tap. */
    function previewScratch(): void {
      const cur = working;
      if (!cur || busy || selFrames() <= 0) return;
      playClip(scratchOf(crop(cur, cropStart, cropEnd)));
    }

    const diceBtn = createButton({
      label: 'Roll',
      iconBefore: UI_ICONS.dice,
      testId: 'scratch-random',
      title: 'Roll a new scratch on the grid.',
      onClick: () => {
        setScratch(randomScratch(scratchSteps()));
        presetDd.setValue(CUSTOM);
      },
    });
    const previewBtn = createButton({
      label: 'Preview',
      testId: 'scratch-preview',
      title: 'Hear it without applying it.',
      onClick: () => previewScratch(),
    });
    const scratchBtn = createButton({
      label: 'Scratch',
      testId: 'scratch-apply',
      onClick: () => {
        if (selFrames() <= 0) return;
        runOp(scratchBtn, 'Scratch', (src) => scratchOf(src));
      },
    });
    allButtons.push(diceBtn, previewBtn, scratchBtn);
    scratchRow.append(diceBtn, previewBtn, scratchBtn);

    scratchBody.append(graph.el, scratchRow);
    // Closed until asked for: a 210 px canvas is a lot of modal to spend on a
    // section most sessions never open. The chevron persists that choice like
    // every other panel in the app — the curve itself is not persisted (REQ-24).
    const scratchFold: CollapseToggle = createCollapseToggle(
      scratchBody,
      'websynth.scratch.open',
      { defaultCollapsed: () => true, trigger: scratchHead, onChange: () => syncScratch?.() },
    );
    scratchFold.el.dataset.testid = 'scratch-toggle';
    scratchHead.append(scratchFold.el, scratchTitle);
    scratchWrap.append(scratchHead, scratchBody);
    body.appendChild(scratchWrap);

    lenDd.onChange(() => setScratch(scratch));
    presetDd.onChange((v) => {
      if (v === CUSTOM) return;
      setScratch(scratchPreset(presetFor(v), scratchSteps()));
    });

    syncScratch = (repick = false): void => {
      const frames = selFrames();
      const sr = srOf();
      const labels = FIT_TARGETS.map(fitLabel);
      if (lenDd.value !== '' && labels.indexOf(lenDd.value) < 0) lenDd.setOptions(labels);
      // Same rule the Fit row follows: preselect what the material suggests, and
      // only on a real change of material, or a crop drag would fight the choice.
      if (repick && frames > 0) lenDd.setValue(fitLabel(nearestTarget()));

      const steps = scratchSteps();
      const out = framesFor(steps);
      const ok = frames > 0 && out > 0 && out <= MAX_STRETCH_OUTPUT_FRAMES;

      // Peaks are recomputed only when the section is open and the selection has
      // audio: a crop drag with the panel folded away would otherwise pay for a
      // 512-column min/max scan nobody can see (runtime-performance.md).
      if (!scratchBody.classList.contains('collapsed') && working && frames > 0) {
        graph.setSource(computePeaks(crop(working, cropStart, cropEnd), PEAK_COLS), frames);
      }
      graph.setGrid(steps, Math.max(1, engine.barTicks), out);

      if (frames <= 0) {
        scratchHint.textContent = 'Scratch: nothing selected.';
      } else if (!ok) {
        scratchHint.textContent = 'Scratch: that length is past the limit.';
      } else {
        const inSteps = frames / Math.max(1, framesFor(1));
        scratchHint.textContent = `Scratch: selection is ~${inSteps.toFixed(1)} sixteenths `
          + `→ ${(out / sr).toFixed(2)} s`;
      }
      for (const b of [diceBtn, previewBtn, scratchBtn]) b.disabled = busy || !ok;
      scratchBtn.title = ok
        ? 'Print the drawn scratch into the selection. Undo takes it back.'
        : 'Select some audio and pick a length that fits.';
    };

    syncFit = (repick = false): void => {
      const frames = selFrames();
      const sr = srOf();

      // The bar annotations move with the meter, so the labels are rebuilt when
      // they actually change — not every pointermove of a crop handle, which is
      // where this is called from.
      const labels = FIT_TARGETS.map(fitLabel);
      if (labels.join('|') !== fitLabels) {
        fitLabels = labels.join('|');
        targetDd.setOptions(labels);
        repick = true;
      }

      // REQ-10 — preselect the target nearest what the selection already is, so
      // the offered action is the one that barely moves the audio. Only on a real
      // change of material: re-picking under a dragging crop handle would fight
      // whatever the user had chosen.
      if (repick && frames > 0) targetDd.setValue(fitLabel(nearestTarget()));

      targetDd.setDisabledOptions(FIT_TARGETS.filter((s) => !fitOk(s)).map(fitLabel));

      const steps = stepsFor(targetDd.value);
      const to = steps ? framesFor(steps) : 0;
      const ok = steps > 0 && fitOk(steps);
      if (frames <= 0) {
        fitHint.textContent = 'Fit: nothing selected.';
      } else if (!ok) {
        fitHint.textContent = `Fit: ${(frames / sr).toFixed(2)} s — that target is `
          + `outside ${MIN_STRETCH_RATIO}x–${MAX_STRETCH_RATIO}x.`;
      } else {
        fitHint.textContent = `Fit: ${(frames / sr).toFixed(2)} s → ${(to / sr).toFixed(2)} s `
          + `· ${(to / frames).toFixed(2)}x`;
      }

      fitBtn.disabled = busy || !ok;
      fitBtn.title = ok
        ? `Retime the selection to ${targetDd.value} at ${Math.round(engine.clock.bpm)} BPM`
        : frames <= 0
          ? 'Select some audio first.'
          : `A ${targetDd.value} target is more than ${MAX_STRETCH_RATIO}x away from this `
            + `selection (or less than ${MIN_STRETCH_RATIO}x) — pick a closer length.`;

      shiftBtn.disabled = busy || shiftAmount() === 0 || frames <= 0;
      shiftBtn.title = shiftAmount() === 0
        ? 'Pick a number of semitones first.'
        : `Shift the selection by ${shiftDd.value}, keeping its length`;
    };
    targetDd.onChange(() => syncFit?.());
    shiftDd.onChange(() => syncFit?.());
    syncFit(true);
    // Built last so it sees the Fit row settled, then given the length the
    // material suggests and a cue placed for it (REQ-20).
    syncScratch(true);
    setScratch(scratch);

    // Done actions: save/load/close
    const actions = document.createElement('div');
    actions.className = recStyles.actions!;

    const finalClip = (): CapturedAudio => crop(working!, cropStart, cropEnd);

    const wavBtn = createButton({
      label: 'Save WAV',
      testId: 'mic-save-wav',
      onClick: () => {
        const c = finalClip();
        const fn = `recording-${timestamp()}.wav`;
        triggerDownload(encodeWav(c.left, c.right, c.sampleRate), fn);
        lastAction = `Saved ${fn}`;
        redraw();
      },
    });
    const mp3Btn = createButton({
      label: 'Save MP3',
      testId: 'mic-save-mp3',
      onClick: async () => {
        const c = finalClip();
        const fn = `recording-${timestamp()}.mp3`;
        triggerDownload(await encodeMp3(c.left, c.right, c.sampleRate), fn);
        lastAction = `Saved ${fn}`;
        redraw();
      },
    });
    const loadBtn = createButton({
      label: 'Load into Sampler',
      testId: 'mic-load',
      onClick: () => {
        const slot = slotOptions.indexOf(picker.value);
        if (slot < 0) return;
        const c = finalClip();
        engine.sampler.setBuffer(slot, capturedToAudioBuffer(engine.ctx, c));
        const existing = engine.patterns.sampleNames[slot] ?? null;
        engine.patterns.setSampleName(
          slot,
          existing ?? `recording-${SAMPLER_SLOT_LABELS[slot] ?? slot + 1}`,
        );
        modal.close();
      },
    });
    const closeBtn = createButton({ label: 'Close', testId: 'mic-close', onClick: () => modal.close() });

    const pickWrap = document.createElement('div');
    pickWrap.className = recStyles.slot!;
    const pickLabel = document.createElement('span');
    pickLabel.textContent = 'Slot:';
    pickWrap.append(pickLabel, picker.el);

    actions.append(pickWrap, loadBtn, wavBtn, mp3Btn, closeBtn);
    body.appendChild(actions);

    resizeObs = new ResizeObserver(() => redraw());
    resizeObs.observe(wrap);
    requestAnimationFrame(redraw);
  }

  modal.open();
  if (opts.source) {
    original = opts.source;
    working = cloneCaptured(opts.source);
    cropStart = 0;
    cropEnd = Math.min(opts.source.left.length, opts.source.right.length);
    lastAction = 'Loaded';
    showEditor();
  } else {
    showIdle();
  }
}
