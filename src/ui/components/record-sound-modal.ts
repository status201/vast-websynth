/**
 * The sample studio — "Record a sound" / "Edit sample" (sample-recorder.md).
 *
 * One near-full-screen frame (REQ-the-studio-fills-the-screen) with two screens:
 * **Record** (live input meter, count-in, a big record button, a timer) and
 * **Edit** (waveform, edit bar, four tool tabs, one primary action). The
 * transport and a metronome sit in the frame's toolbar, so a song playing under
 * a take can be stopped without leaving (REQ-the-transport-is-in-reach), and
 * nothing the user recorded is dropped without asking
 * (REQ-nothing-closes-the-studio-by-accident).
 *
 * Glue only: it composes the reusable `Modal`, the `MicSession` capture, the
 * pure `buffer-dsp` ops, the `offline-render` effects, the `encode` pipeline,
 * `createPanelTabs` and the metronome.
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
  createPeakCache, capturedFrames,
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
import { createPanelTabs, type PanelTabs } from './panel-tabs';
import { capturedToAudioBuffer } from '../../audio/recorder/audio-buffer';
import { encodeWav, encodeMp3 } from '../../audio/recorder/encode';
import { triggerDownload } from '../../utils/download';
import { SAMPLER_SLOT_COUNT, slotOptionLabels, slotTag } from '../../state/patterns';
import {
  MIN_STRETCH_RATIO, MAX_STRETCH_RATIO, MAX_STRETCH_OUTPUT_FRAMES,
  MAX_PITCH_SHIFT_SEMITONES } from '../../state/limits';
import { UI_ICONS } from './ui-icons';
import { onPaletteChange, paletteDerived, rgba } from '../theme-colors';
import { backingScale, toLocal } from '../ui-scale';
import { FIT_TARGETS, fitLabel as fitLabelFor, nearestTarget as nearestTargetFor } from '../../state/fit-targets';
import { createMetronome } from '../../audio/metronome';
import { isEditableTarget, isTopModal } from '../modal-stack';
import { EditHistory } from '../../state/edit-history';
import { createStudioTransport } from './studio-transport';
import { samplerSlotFilled, snapshotSamplerSlot, writeSamplerSlot } from '../panels/step-panel-scaffold';

/** The waveform's inks, from the screen tokens (ui-themes.md REQ-canvas-reads-the-screen-tokens). */
const waveColours = paletteDerived((p) => ({
  midline: rgba(p.ink, 0.07),
  clipped: rgba(p.hot),
  inside: rgba(p.trace),
  outside: rgba(p.trace, 0.18),
  mark: rgba(p.ink),
}));

const FADE_MS = 150;
const BOOST_FACTOR = 2; // ≈ +6 dB
/** Columns of source peaks the scratch graph warps. Enough to resolve a hit at
 *  any usable width, cheap enough to recompute on a crop drag. */
const PEAK_COLS = 512;
const MIN_F = 20;
const MAX_F = 18000;

/** A take stops itself here (REQ-a-take-is-bounded). Sizes memory, not trust. */
export const MAX_TAKE_SECONDS = 120;
/** Undo entries kept (REQ-undo-is-a-stack). */
export const UNDO_DEPTH = 10;
/** Frames the undo + redo stacks may hold together — ~200 MB of stereo float. */
export const UNDO_FRAME_BUDGET = 25_000_000;
/** The input meter's clip light (REQ-the-mic-opens-with-the-studio): −0.5 dBFS. */
const CLIP_LEVEL = Math.pow(10, -0.5 / 20);
/** How often the Record screen re-reads time (the timer, the count, the bound). */
const WATCH_MS = 50;

export interface RecordSoundOptions {
  /** Slot the picker defaults to (and that "Load into" targets). */
  slot?: number;
  /** If set, skip recording and open this audio straight in the editor. */
  source?: CapturedAudio;
  /** The header's own Play button (transport-window.md REQ-play-pause-is-not-a-second-truth).
   *  Required: the studio never starts the clock any other way. */
  toggleTransport: () => void;
}

type ToolTab = 'effects' | 'chop' | 'stretch' | 'scratch';
type RecState = 'opening' | 'ready' | 'counting' | 'recording' | 'stopping' | 'error';

/**
 * Studio memory that outlives one open, for the rest of the session — module
 * scope of a lazy chunk, never persisted.
 */
const memory: {
  /** The newest audio thrown away through the guard (REQ-a-discarded-take-can-be-restored). */
  discarded: { audio: CapturedAudio; slot: number } | null;
  /** The selected tool (REQ-the-tools-are-tabs). */
  tab: ToolTab;
  countIn: boolean;
  click: boolean;
} = { discarded: null, tab: 'effects', countIn: false, click: false };

/** Test seam: forget the session memory. */
export function resetStudioMemory(): void {
  memory.discarded = null;
  memory.tab = 'effects';
  memory.countIn = false;
  memory.click = false;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function fmtClip(c: CapturedAudio): string {
  const dur = capturedFrames(c) / c.sampleRate;
  const db = peakDb(c);
  const dbStr = db === -Infinity ? '−∞' : db.toFixed(1);
  return `${dur.toFixed(2)} s · ${c.sampleRate.toLocaleString()} Hz · peak ${dbStr} dB`;
}

/** `m:ss.s` */
function fmtTime(s: number): string {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const rest = t - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

/** "2:00" — the take bound as the timer shows it. */
const TAKE_LIMIT_LABEL = fmtTime(MAX_TAKE_SECONDS).replace(/\.0$/, '');

/**
 * Size a canvas's bitmap to its box at the backing scale (ui-scale.md
 * REQ-canvases-stay-sharp-at-any-scale) and hand back a cleared context in CSS
 * pixels — or null while it has no box. Shared by the live take and the waveform.
 */
function fitCanvas(canvas: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
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
function drawMidline(g: CanvasRenderingContext2D, w: number, h: number, ink: string): void {
  g.strokeStyle = ink;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function openRecordSoundModal(engine: StudioApi, opts: RecordSoundOptions): void {
  const editing = opts.source != null;
  /** The material is the slot's own sound, edited — until a new take (or a
   *  restored one) replaces it, after which it is a fresh recording. */
  let ofSlot = editing;
  const slotFilled = (s: number): boolean => samplerSlotFilled(engine, s);
  /** REQ-one-primary-action-per-screen: an edit aims at its own slot, a fresh
   *  recording at the first empty one. */
  const firstEmpty = (): number | null => {
    for (let s = 0; s < SAMPLER_SLOT_COUNT; s++) if (!slotFilled(s)) return s;
    return null;
  };
  const clampSlot = (s: number): number => Math.max(0, Math.min(s, SAMPLER_SLOT_COUNT - 1));
  let targetSlot = clampSlot(editing ? (opts.slot ?? 0) : (firstEmpty() ?? opts.slot ?? 0));
  /** The slot the editor was opened from — the chop's stem and an edit's name. */
  const sourceSlot = opts.slot ?? targetSlot;

  let session: MicSession | null = null;
  let original: CapturedAudio | null = null;
  let working: CapturedAudio | null = null;
  /** REQ-undo-is-a-stack. */
  const edits = new EditHistory<CapturedAudio>({
    depth: UNDO_DEPTH, budget: UNDO_FRAME_BUDGET, size: capturedFrames,
  });
  let cropStart = 0;
  let cropEnd = 0;
  /** Audio the user would lose by closing (REQ-nothing-closes-the-studio-by-accident). */
  let dirty = false;
  let recState: RecState = 'opening';
  /** The audition player — the audio layer's, with the slot's edges (sample-recorder.md
   *  REQ-the-preview-fades-like-the-slot). */
  const preview = engine.clipPreview;
  let playRaf = 0;
  let resizeObs: ResizeObserver | null = null;
  let cleaned = false;
  let lastAction = 'Ready';
  let onPlayingChange: ((playing: boolean) => void) | null = null;
  let redrawHook: (() => void) | null = null;
  // The waveform paints on demand, so a theme change asks for one repaint
  // (ui-themes.md REQ-a-theme-change-repaints-the-canvases); cleanup unsubscribes.
  const offPalette = onPaletteChange(() => redrawHook?.());
  /** Interior chop boundaries, absolute sample indices (sample-chop.md REQ-two-ways-to-place-the-cuts). */
  let marks: number[] = [];
  /** Re-reads `marks` into the chop row's labels and disabled states. */
  let syncChop: (() => void) | null = null;
  /** Re-reads the selection into the Fit row's target list, hint and disabled
   *  states (time-stretch.md REQ-the-editor-gains-a-fit-row/REQ-the-fit-row-preselects-the-nearest-target). */
  let syncFit: ((repick?: boolean) => void) | null = null;
  /** Re-reads the selection into the Scratch row's hint, grid and disabled state
   *  (scratch.md REQ-the-scratch-editor-is-a-modal-section). */
  let syncScratch: ((repick?: boolean) => void) | null = null;
  /** Re-reads the undo/redo stacks into their buttons. */
  let syncHistory: (() => void) | null = null;
  /** Last-rendered Fit target labels, so a meter change rebuilds the list and a
   *  crop drag does not. */
  let fitLabels = '';
  /** The drawn scratch. Lives exactly as long as the studio does — nothing about
   *  it is persisted (scratch.md REQ-scratch-registers-no-params). */
  let scratch: ScratchCurve = scratchPreset('Baby', 16);
  let scratchGraph: ScratchGraph | null = null;
  let activeTab: ToolTab = memory.tab;

  /** Record screen loops: the meter's animation frame and the time watch. */
  let meterRaf = 0;
  let watchTimer = 0;
  /** Count-in: the context time the take really starts at. */
  let captureAt: number | null = null;
  /** Bumped on every screen change, so a mic prompt answered after the user
   *  moved on attaches to nothing. */
  let screenGen = 0;

  /**
   * Everything the current screen builds that owns listeners outside its own
   * subtree. A `Dropdown` registers four — `click` and `keydown` on `document`,
   * `scroll` and `resize` on `window` — in its constructor, and only `destroy()`
   * takes them off again. Removing the card from the DOM does not, so without
   * this a studio opened and closed repeatedly leaves a handler on every click
   * and keystroke in the app (REQ-the-editor-owns-its-teardown). Emptied on every
   * screen change, and by `cleanup()`.
   */
  const owned: Array<{ destroy(): void }> = [];
  const own = <T extends { destroy(): void }>(d: T): T => {
    owned.push(d);
    return d;
  };
  /** Studio-lifetime unsubscribes: the transport strip, keys. */
  const offs: Array<() => void> = [];
  /** Screen-lifetime unsubscribes: the count-in's beat listener. */
  const screenOffs: Array<() => void> = [];

  /** `ended`: the clip ran out by itself, so there is nothing left to fade. */
  const stopPreview = (ended = false): void => {
    cancelAnimationFrame(playRaf);
    playRaf = 0;
    preview.stop(ended);
    onPlayingChange?.(false);
    redrawHook?.();
  };

  /** Tear down whatever the current screen built (REQ-the-editor-owns-its-teardown). */
  const teardownScreen = (): void => {
    screenGen++;
    session?.dispose();
    session = null;
    cancelAnimationFrame(meterRaf);
    meterRaf = 0;
    window.clearInterval(watchTimer);
    watchTimer = 0;
    if (captureAt !== null) metronome.cancelCountIn();
    captureAt = null;
    stopPreview();
    onPlayingChange = null;
    redrawHook = null;
    syncChop = null;
    syncFit = null;
    syncScratch = null;
    syncHistory = null;
    // The graph owns a ResizeObserver and, mid-drag, listeners on its own canvas
    // plus the shared value bubble — none of which the studio's teardown can see.
    scratchGraph?.destroy();
    scratchGraph = null;
    resizeObs?.disconnect();
    resizeObs = null;
    for (const d of owned) d.destroy();
    owned.length = 0;
    for (const off of screenOffs) off();
    screenOffs.length = 0;
  };

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    teardownScreen();
    offPalette();
    for (const off of offs) off();
    offs.length = 0;
    releaseMetronome();
  };

  // ---- the close guard (REQ-nothing-closes-the-studio-by-accident) ----------

  /** Ask before audio is thrown away; stash it if it is (REQ-a-discarded-take-can-be-restored). */
  const confirmDiscard = (leaving: boolean): boolean | Promise<boolean> => {
    if (recState === 'recording' || recState === 'counting' || recState === 'stopping') {
      return confirmDialog({
        title: 'Stop and discard this recording?',
        message: 'The take in progress is thrown away.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep recording',
        danger: true,
      });
    }
    if (!dirty || !working) return true;
    const lost = working;
    const buttons = { confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true };
    return confirmDialog(ofSlot && leaving
      ? { ...buttons, title: 'Discard your changes?', message: `${slotTag(sourceSlot)} keeps its current sound.` }
      : {
        ...buttons,
        title: 'Discard this recording?',
        message: "It isn't in a slot or downloaded yet.",
        detail: 'You can restore it the next time you open Record a sound.',
      }).then((ok) => {
      if (ok) memory.discarded = { audio: lost, slot: targetSlot };
      return ok;
    });
  };

  const modal = new Modal({
    title: editing ? 'Edit sample' : 'Record a sound',
    cardClass: recStyles.modal!,
    onClose: cleanup,
    dismissOnBackdrop: false,
    closeButton: true,
    closeTestId: 'mic-close',
    beforeClose: () => confirmDiscard(true),
  });
  const body = modal.body;
  body.classList.add(recStyles.studio!);

  // ---- the frame: toolbar · screen · footer (REQ-the-studio-fills-the-screen) ----

  const toolbar = el('div', recStyles.toolbar);
  const crumbs = el('div', recStyles.crumbs);
  const crumbRec = el('span', recStyles.crumb, 'Record');
  const crumbSep = el('span', recStyles.crumbSep, '›');
  const crumbEdit = el('span', recStyles.crumb, 'Edit');
  crumbs.append(crumbRec, crumbSep, crumbEdit);
  const setCrumb = (which: 'record' | 'edit'): void => {
    crumbRec.classList.toggle('active', which === 'record');
    crumbEdit.classList.toggle('active', which === 'edit');
  };

  // The metronome is held for as long as the studio is open (metronome.md
  // REQ-a-metronome-runs-only-while-held); the strip paints its beats.
  const metronome = createMetronome(engine);
  const releaseMetronome = metronome.acquire();
  metronome.setClick(memory.click);
  // The transport strip (REQ-the-transport-is-in-reach).
  const transport = createStudioTransport({
    engine,
    metronome,
    toggleTransport: opts.toggleTransport,
    onClickChange: (on) => { memory.click = on; },
  });
  offs.push(() => transport.destroy());
  toolbar.append(crumbs, transport.el);

  const screen = el('div', recStyles.screen);
  const footer = el('div', recStyles.footer);
  body.append(toolbar, screen, footer);

  // `R` records / stops while the Record screen shows (ADR-014: a press, not a hold).
  let recordKey: (() => void) | null = null;
  const onKey = (e: KeyboardEvent): void => {
    if (!recordKey || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    // A confirmation raised over the studio owns the keyboard.
    if (!isTopModal(modal) || isEditableTarget(e)) return;
    if (e.key !== 'r' && e.key !== 'R') return;
    e.preventDefault();
    recordKey();
  };
  window.addEventListener('keydown', onKey);
  offs.push(() => window.removeEventListener('keydown', onKey));

  // ---- Screen 1: Record ----------------------------------------------------

  function showRecord(message?: string): void {
    teardownScreen();
    setCrumb('record');
    screen.replaceChildren();
    screen.dataset.testid = 'rec-screen-record';
    screen.classList.remove(recStyles.recording!);
    footer.replaceChildren();
    recState = 'opening';

    const restore = memory.discarded;
    if (restore) {
      const banner = el('div', recStyles.banner);
      const secs = capturedFrames(restore.audio) / restore.audio.sampleRate;
      banner.append(el('span', undefined, `Your last recording (${secs.toFixed(1)} s) was discarded.`));
      banner.append(createButton({
        label: 'Restore',
        testId: 'rec-restore',
        onClick: () => {
          memory.discarded = null;
          targetSlot = restore.slot;
          startEditing(restore.audio, 'Restored', true);
        },
      }));
      screen.appendChild(banner);
    }

    // The take's envelope, growing live while it records.
    const live = el('canvas', recStyles.liveWave);
    screen.appendChild(live);

    const meterRow = el('div', recStyles.meterRow);
    meterRow.dataset.testid = 'mic-meter';
    const meterLabel = el('span', recStyles.meterLabel, 'Input');
    // The scale is the meter's own gradient; a cover slides off it from the
    // right, so the colour under the level is the colour of that level.
    const meter = el('div', recStyles.meter);
    const meterCover = el('div', recStyles.meterCover);
    meter.appendChild(meterCover);
    const meterDb = el('span', recStyles.meterDb, '−∞ dB');
    const clip = el('span', recStyles.clip, 'Clip');
    clip.title = 'Lights when the input reaches full scale — move away or turn the input down.';
    meterRow.append(meterLabel, meter, meterDb, clip);
    screen.appendChild(meterRow);

    const recArea = el('div', recStyles.recArea);
    const recBtn = el('button', recStyles.recBtn);
    recBtn.type = 'button';
    recBtn.dataset.testid = 'mic-record-toggle';
    const recFace = el('span', recStyles.recFace);
    const recLabel = el('span', recStyles.recLabel, 'Record');
    recBtn.append(recFace, recLabel);
    const timer = el('div', recStyles.timer);
    timer.dataset.testid = 'mic-timer';
    const stateLine = el('div', recStyles.stateLine);
    stateLine.dataset.testid = 'mic-state';
    recArea.append(recBtn, timer, stateLine);
    screen.appendChild(recArea);

    const countRow = el('label', recStyles.countRow);
    const countBox = el('input');
    countBox.type = 'checkbox';
    countBox.dataset.testid = 'mic-countin';
    countBox.checked = memory.countIn;
    countBox.addEventListener('change', () => { memory.countIn = countBox.checked; });
    countRow.append(countBox, el('span', undefined, 'Count-in: one bar on the click, then record from the downbeat'));
    screen.appendChild(countRow);

    const tip = el('div', recStyles.tip,
      'Tip: wear headphones if you record while the song plays — otherwise the mic hears the speakers too.');
    screen.appendChild(tip);

    let retry: HTMLButtonElement | null = null;
    footer.append(el('span', recStyles.footSpacer), createButton({
      label: 'Cancel',
      testId: 'mic-cancel',
      onClick: () => { void modal.requestClose(); },
    }));

    /** Repaint the button, the timer and the state line from `recState`. */
    const paint = (count?: number): void => {
      recBtn.dataset.state = recState;
      recBtn.disabled = recState === 'opening' || recState === 'stopping' || recState === 'error';
      screen.classList.toggle(recStyles.recording!, recState === 'recording');
      recFace.replaceChildren();
      switch (recState) {
        case 'opening':
          recFace.innerHTML = UI_ICONS.record;
          recLabel.textContent = 'Record';
          stateLine.textContent = 'Opening the microphone — allow access in your browser’s prompt.';
          break;
        case 'ready':
          recFace.innerHTML = UI_ICONS.record;
          recLabel.textContent = 'Record';
          stateLine.textContent = message ?? 'Ready. Check the input meter, then press Record (or R).';
          break;
        case 'counting':
          recFace.textContent = count != null && count > 0 ? String(count) : '';
          recLabel.textContent = 'Cancel count';
          stateLine.textContent = 'Counting in — recording starts on the downbeat.';
          break;
        case 'recording':
          recFace.innerHTML = UI_ICONS.stop;
          recLabel.textContent = 'Stop';
          stateLine.textContent = 'Recording. Press Stop (or R) when you are done.';
          break;
        case 'stopping':
          recFace.innerHTML = UI_ICONS.stop;
          recLabel.textContent = 'Stop';
          stateLine.textContent = 'Finishing the take…';
          break;
        case 'error':
          recFace.innerHTML = UI_ICONS.record;
          recLabel.textContent = 'Record';
          break;
      }
      recBtn.setAttribute('aria-label', recLabel.textContent ?? 'Record');
    };

    const showTimer = (): void => {
      if (recState === 'recording' && session) {
        const t0 = captureAt ?? session.startedAt;
        const el2 = engine.ctx.currentTime - t0;
        const left = MAX_TAKE_SECONDS - el2;
        timer.textContent = left <= 10
          ? `● REC ${fmtTime(el2)} — ${Math.ceil(Math.max(0, left))} s left`
          : `● REC ${fmtTime(el2)} / ${TAKE_LIMIT_LABEL}`;
      } else if (recState === 'counting') {
        timer.textContent = 'Count-in';
      } else {
        timer.textContent = `0:00.0 / ${TAKE_LIMIT_LABEL}`;
      }
    };

    // ---- the meter and the live envelope (REQ-the-mic-opens-with-the-studio) ----
    const trail: number[] = [];
    let clipUntil = 0;
    const drawLive = (): void => {
      const fit = fitCanvas(live);
      if (!fit) return;
      const { g, w, h } = fit;
      const ink = waveColours();
      drawMidline(g, w, h, ink.midline);
      const n = trail.length;
      if (n === 0) return;
      const cols = Math.max(1, Math.floor(w));
      // Fill the width as the take grows; once it is longer than the canvas,
      // squeeze it — max per column — so the whole take stays in view.
      const per = Math.max(1, n / cols);
      const shown = Math.min(cols, n);
      for (let c = 0; c < shown; c++) {
        const from = Math.floor(c * per);
        const to = Math.max(from + 1, Math.floor((c + 1) * per));
        let pk = 0;
        for (let i = from; i < to && i < n; i++) pk = Math.max(pk, trail[i]!);
        const y = Math.min(1, pk) * (h / 2 - 2);
        g.strokeStyle = pk >= CLIP_LEVEL ? ink.clipped : ink.inside;
        g.beginPath();
        g.moveTo(c + 0.5, h / 2 - y);
        g.lineTo(c + 0.5, h / 2 + Math.max(0.5, y));
        g.stroke();
      }
    };

    const meterLoop = (): void => {
      meterRaf = 0;
      if (cleaned || !session) return;
      const { peak } = session.level();
      const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
      const pct = db === -Infinity ? 0 : Math.max(0, Math.min(1, (db + 60) / 60));
      meterCover.style.width = `${((1 - pct) * 100).toFixed(1)}%`;
      meter.dataset.level = pct.toFixed(3);
      meterDb.textContent = db === -Infinity ? '−∞ dB' : `${db.toFixed(0)} dB`;
      const now = performance.now();
      if (peak >= CLIP_LEVEL) clipUntil = now + 1000;
      clip.classList.toggle(recStyles.clipOn!, now < clipUntil);
      if (recState === 'recording') {
        trail.push(peak);
        drawLive();
      }
      meterRaf = requestAnimationFrame(meterLoop);
    };

    /** Time-driven transitions: the count ends, the bound is hit, the timer moves. */
    const watch = (): void => {
      if (cleaned || !session) return;
      const now = engine.ctx.currentTime;
      if (recState === 'counting' && captureAt !== null && now >= captureAt) {
        recState = 'recording';
        paint();
      }
      if (recState === 'recording') {
        const t0 = captureAt ?? session.startedAt;
        if (now - t0 >= MAX_TAKE_SECONDS) {
          void finishRecording(`Stopped at the ${TAKE_LIMIT_LABEL} limit`);
          return;
        }
      }
      showTimer();
    };

    /** Beats from `when` to the counted downbeat. */
    const beatsLeft = (when: number): number =>
      captureAt === null ? 0 : Math.round((captureAt - when) / Math.max(1e-6, metronome.beatDuration()));
    // The count shows the beats left, painted when each is heard.
    screenOffs.push(transport.onHeardBeat((b) => {
      if (recState !== 'counting') return;
      const left = beatsLeft(b.when);
      if (left > 0) paint(left);
    }));

    const openMic = async (): Promise<void> => {
      const gen = screenGen;
      recState = 'opening';
      paint();
      retry?.remove();
      retry = null;
      let s: MicSession;
      try {
        s = await openMicSession(engine.ctx);
      } catch (err) {
        if (cleaned || gen !== screenGen) return;
        recState = 'error';
        paint();
        stateLine.textContent = errorText(err instanceof MicCaptureError ? err.code : 'unknown');
        retry = createButton({ label: 'Try again', testId: 'mic-retry', onClick: () => { void openMic(); } });
        recArea.appendChild(retry);
        return;
      }
      // Closed, or left for the Edit screen, while the permission prompt was up.
      if (cleaned || gen !== screenGen || session) {
        s.dispose();
        return;
      }
      session = s;
      recState = 'ready';
      paint();
      showTimer();
      meterRaf = requestAnimationFrame(meterLoop);
      window.clearInterval(watchTimer);
      watchTimer = window.setInterval(watch, WATCH_MS);
    };

    const press = (): void => {
      switch (recState) {
        case 'ready': {
          if (!session) return;
          trail.length = 0;
          session.start();
          if (countBox.checked) {
            // Capture starts now; the pre-roll is cropped to the downbeat on stop
            // (REQ-count-in-lands-the-take-on-a-downbeat).
            captureAt = metronome.countIn();
            recState = 'counting';
            paint(Math.max(1, beatsLeft(engine.ctx.currentTime)));
          } else {
            captureAt = null;
            recState = 'recording';
            paint();
          }
          showTimer();
          return;
        }
        case 'counting': {
          // Cancel the count: no take is kept, and the mic comes back fresh.
          metronome.cancelCountIn();
          captureAt = null;
          const old = session;
          session = null;
          if (old) void old.stop().catch(() => undefined).finally(() => old.dispose());
          void openMic();
          return;
        }
        case 'recording':
          void finishRecording();
          return;
        default:
      }
    };
    recBtn.addEventListener('click', press);
    recordKey = press;

    async function finishRecording(reason?: string): Promise<void> {
      if (!session) return;
      const live2 = session;
      session = null; // claim it first — a second tap must not stop it twice
      recState = 'stopping';
      paint();
      const at = captureAt;
      metronome.cancelCountIn();
      // Await the take BEFORE disposing: `dispose()` releases the recorder, and
      // the worklet's final batch is still in flight until `stop()` resolves
      // (audio-export.md REQ-chunks-are-batched-then-flushed). Disposing first would truncate every take.
      let captured = await live2.stop();
      live2.dispose();
      // Closed while the final batch was in flight: cleanup has already run, and
      // it is the only teardown there will be — so build nothing it cannot release
      // (REQ-the-editor-owns-its-teardown).
      if (cleaned) return;
      if (at !== null) {
        const pre = Math.max(0, Math.round((at - live2.startedAt) * captured.sampleRate));
        captured = pre < capturedFrames(captured)
          ? crop(captured, pre, capturedFrames(captured))
          : { left: new Float32Array(0), right: new Float32Array(0), sampleRate: captured.sampleRate };
      }
      captureAt = null;
      if (capturedFrames(captured) === 0) {
        showRecord('Nothing was recorded — try again.');
        return;
      }
      startEditing(captured, reason ?? 'Recorded', true);
    }

    paint();
    showTimer();
    void openMic();
  }

  /** Make `audio` the material and go to the Edit screen. */
  function startEditing(audio: CapturedAudio, action: string, unsaved: boolean): void {
    recState = 'ready';
    // A take or a restore is new material; only the opening source is the slot's own.
    if (unsaved) ofSlot = false;
    recordKey = null;
    original = audio;
    working = cloneCaptured(audio);
    edits.clear();
    marks = [];
    cropStart = 0;
    cropEnd = capturedFrames(audio);
    dirty = unsaved;
    lastAction = action;
    showEditor();
  }

  // ---- Screen 2: Edit --------------------------------------------------------
  function showEditor(): void {
    if (!working) return;
    teardownScreen();
    setCrumb('edit');
    screen.replaceChildren();
    screen.dataset.testid = 'rec-screen-edit';
    screen.classList.remove(recStyles.recording!);
    footer.replaceChildren();

    // Waveform + crop handles
    const wrap = el('div', recStyles.waveWrap);
    const canvas = el('canvas', recStyles.wave);
    const hL = el('div', `${recStyles.handle!} left`);
    const hR = el('div', `${recStyles.handle!} right`);
    wrap.append(canvas, hL, hR);
    screen.appendChild(wrap);

    const sampleLen = (): number => (working ? capturedFrames(working) : 0);
    const wpx = (): number => canvas.clientWidth || wrap.clientWidth || 1;
    const xOf = (s: number): number => (sampleLen() ? (s / sampleLen()) * wpx() : 0);
    const sampleAt = (x: number): number =>
      Math.round((Math.max(0, x) / wpx()) * sampleLen());
    const clamp1 = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

    // The edit bar: audition + history, and what the selection is.
    const editBar = el('div', recStyles.editBar);
    const status = el('div', recStyles.status);
    status.dataset.testid = 'mic-status';

    const refreshStatus = (buf: CapturedAudio): void => {
      const sel = crop(buf, cropStart, cropEnd);
      status.textContent = `${lastAction} — selection ${fmtClip(sel)}`;
    };

    /**
     * Waveform peaks, memoised (buffer-dsp.ts `createPeakCache`). `redraw()`
     * runs once per animation frame while a preview plays, and `computePeaks`
     * walks the whole clip (REQ-the-waveform-redraw-is-cheap).
     */
    const peaksFor = createPeakCache();

    const redraw = (): void => {
      const buf = working;
      if (!buf) return;
      refreshStatus(buf);
      const fit = fitCanvas(canvas);
      if (!fit) return;
      const { g, w, h } = fit;
      const ink = waveColours();
      drawMidline(g, w, h, ink.midline);

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

      if (preview.playing && preview.samples > 0) {
        const elapsed = engine.ctx.currentTime - preview.startTime;
        const pos = cropStart + elapsed * buf.sampleRate;
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
      for (const m of marks) {
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
    redrawHook = redraw;

    /**
     * Audition one clip. Split out of `playSelection` so the scratch row can
     * preview a render it has NOT committed (scratch.md REQ-preview-plays-without-committing) through the same
     * node lifecycle, playhead loop and Play/Stop button as everything else.
     */
    const playClip = (c: CapturedAudio): void => {
      stopPreview();
      // The slot's edges, so a selection cut mid-waveform previews the way it
      // will play (sample-recorder.md REQ-the-preview-fades-like-the-slot).
      preview.play(c, () => stopPreview(true));
      onPlayingChange?.(true);
      cancelAnimationFrame(playRaf);
      const loop = (): void => {
        redraw();
        if (preview.playing) playRaf = requestAnimationFrame(loop);
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
          const s = sampleAt(toLocal(ev.clientX - rect.left));
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

    // Dragging a chop boundary (REQ-two-ways-to-place-the-cuts). Hit-tested on the canvas rather than given
    // handles of its own: there can be seven of them, and the two crop handles are
    // separate elements that keep priority wherever they overlap.
    const GRAB_PX = 8;
    canvas.addEventListener('pointerdown', (e) => {
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
      const gap = Math.max(1, Math.floor(sampleLen() * 0.005));
      const onMove = (ev: PointerEvent): void => {
        const lo = (marks[idx - 1] ?? cropStart) + gap;
        const hi = (marks[idx + 1] ?? cropEnd) - gap;
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

    // ---- the Effects page --------------------------------------------------
    const effectsPage = el('div', recStyles.page);

    const hint = el('div', recStyles.hint, 'Drag the side handles on the waveform to crop. Effects apply to the selection.');
    effectsPage.appendChild(hint);

    // Cutoff slider (log-mapped) for the filters
    const cutoffRow = el('div', recStyles.cutoff);
    const cutoffLabel = el('span');
    const slider = el('input');
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

    const fxRow = el('div', recStyles.fxRow);
    effectsPage.append(fxRow, cutoffRow);

    // Auto-play toggle (default on)
    const autoRow = el('label', recStyles.autoplay);
    const autoPlay = el('input');
    autoPlay.type = 'checkbox';
    autoPlay.checked = true;
    autoRow.append(autoPlay, el('span', undefined, 'Auto-play after each effect'));
    effectsPage.appendChild(autoRow);

    /* ---- musical length arithmetic, shared by the Fit and Scratch pages ----
     * Targets are sixteenth counts, because that is the unit the clock actually
     * runs on (ADR-019: a tick IS a sixteenth) and because "a bar" is only a
     * count of them — one that changes with the meter. Annotating the ones that
     * land on a bar keeps both readings in one control instead of two.
     *
     * This sits above both pages rather than inside Fit's, because
     * time-stretch.md REQ-the-editor-gains-a-fit-row forbids re-deriving what a bar is and a second
     * derivation for the scratch length would be exactly that. The pure half is
     * state/fit-targets.ts; what is left here binds it to this session. */

    const srOf = (): number => working?.sampleRate ?? engine.ctx.sampleRate;
    const selFrames = (): number => Math.max(0, cropEnd - cropStart);
    /** Frames one target occupies at the current tempo — render-to-sampler.md's
     *  arithmetic, never a second derivation of what a bar is. */
    const framesFor = (steps: number): number =>
      Math.round(steps * engine.clock.sixteenthDuration() * srOf());

    const fitLabel = (steps: number): string => fitLabelFor(steps, engine.barTicks);
    const stepsFor = (label: string): number =>
      FIT_TARGETS.find((s) => fitLabel(s) === label) ?? 0;

    /** The target closest to how long the selection already is — what both pages
     *  preselect, so the first thing offered is the one that barely moves. */
    const nearestTarget = (): number => nearestTargetFor(selFrames(), framesFor);

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
      syncHistory?.();
    };

    const afterMutate = (next: CapturedAudio, action: string, btn?: HTMLButtonElement): void => {
      working = next;
      cropStart = 0;
      cropEnd = capturedFrames(next);
      // Every edit re-bases the sample indices, so the old boundaries now point at
      // the wrong audio. Dropping them is the only honest answer: a stale marker
      // that still LOOKS placed is how a chop cuts in the wrong place silently.
      marks = [];
      syncChop?.();
      syncFit?.(true);
      syncScratch?.(true);
      syncHistory?.();
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
     * label the button with it, push the undo stack, then hand the result to
     * `afterMutate`. Shared by the effect buttons and by the Fit / Shift / Scratch
     * pages (time-stretch.md REQ-the-editor-gains-a-fit-row) so all of them
     * inherit the same undo, the same busy latch and the same marks reset.
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
          if (cleaned) return;
          edits.record(cur);
          dirty = true;
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

    // ---- the edit bar: Play · Undo · Redo · Reset · status ----
    const playBtn = createButton({ label: 'Play', led: true, testId: 'mic-play' });
    playBtn.title = 'Play the selection';
    playBtn.addEventListener('click', () => {
      if (preview.playing) stopPreview();
      else playSelection();
    });
    onPlayingChange = (playing: boolean): void => {
      playBtn.classList.toggle('on', playing);
      setButtonLabel(playBtn, playing ? 'Stop' : 'Play');
    };
    const undoBtn = createButton({
      label: 'Undo',
      testId: 'mic-undo',
      onClick: () => {
        const prev = working && edits.undo(working);
        if (!prev) return;
        dirty = true;
        afterMutate(prev, 'Undone');
      },
    });
    const redoBtn = createButton({
      label: 'Redo',
      testId: 'mic-redo',
      onClick: () => {
        const next = working && edits.redo(working);
        if (!next) return;
        dirty = true;
        afterMutate(next, 'Redone');
      },
    });
    const resetBtn = createButton({
      label: 'Reset',
      testId: 'mic-reset',
      title: 'Back to the original — Undo takes it back',
      onClick: () => {
        if (!original || !working) return;
        edits.record(working);
        dirty = true;
        afterMutate(cloneCaptured(original), 'Reset to original');
      },
    });
    syncHistory = (): void => {
      undoBtn.disabled = busy || !edits.canUndo;
      redoBtn.disabled = busy || !edits.canRedo;
    };
    editBar.append(playBtn, undoBtn, redoBtn, resetBtn, status);
    screen.appendChild(editBar);

    // Built before the chop page, which needs to know where a spread would start
    // to decide how many slices fit (sample-chop.md REQ-no-slice-spreads-into-a-missing-slot).
    const slotOptions = slotOptionLabels(engine.patterns.sampleNames);
    const picker = own(new Dropdown(slotOptions, slotOptions[clampSlot(targetSlot)]));
    picker.el.dataset.testid = 'mic-slot-select';

    // ---- the Chop page (sample-chop.md) ----
    const chopPage = el('div', recStyles.page);
    const chopRow = el('div', recStyles.fxRow);
    chopRow.dataset.testid = 'chop-row';
    const chopLabel = el('span', recStyles.hint);
    chopRow.appendChild(chopLabel);

    const startSlot = (): number => Math.max(0, slotOptions.indexOf(picker.value));
    /** REQ-the-result-is-exactly-out-frames — offer only counts that fit from the picker's slot, so a spread can
     *  never quietly drop the slices it has no room for. */
    const fittingCounts = (): string[] => {
      const room = SAMPLER_SLOT_COUNT - startSlot();
      return [2, 4, 6, 8].filter((n) => n <= room).map((n) => `${n} slices`);
    };
    // `—` rather than an empty list: a dropdown with no options reads as broken,
    // and this state is legitimate (the last slot has no room to spread into).
    const countDd = own(new Dropdown(fittingCounts().length ? fittingCounts() : ['—'], '4 slices'));
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
    chopPage.appendChild(chopRow);

    syncChop = (): void => {
      const fits = fittingCounts();
      const noRoom = fits.length === 0;
      countDd.setOptions(noRoom ? ['—'] : fits);
      const room = SAMPLER_SLOT_COUNT - startSlot();
      const n = marks.length + 1;
      // REQ-the-result-is-exactly-out-frames has to survive the picker MOVING, not just the moment of chopping.
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
    syncChop();

    /** The slices' shared stem: the source slot's filename without its extension. */
    const baseName = (): string =>
      (engine.patterns.sampleNames[sourceSlot] ?? 'chop').replace(/\.[^.]+$/, '');

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
      const occupied = targets.filter(slotFilled);
      // REQ-spreading-is-confirmed-then-reversible — it overwrites up to eight slots at once, so it names them first.
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
      // own reversal exactly as `samplerSlotClearRow` does (REQ-pitch-rides-speed).
      const base = baseName();
      const restores = targets.map((slot) => snapshotSamplerSlot(engine, slot));
      targets.forEach((slot, k) => {
        const [from, to] = ranges[k]!;
        writeSamplerSlot(engine, slot,
          capturedToAudioBuffer(engine.ctx, crop(cur, from, to)), `${base} ${k + 1}/${n}`);
      });
      // The slices are in slots now — nothing left to lose.
      dirty = false;
      modal.close();
      showToast({
        message: `Chopped into ${n} slices`,
        actionLabel: 'Undo',
        testId: 'chop-toast',
        onAction: () => { for (const restore of restores) restore(); },
      });
    };

    // ---- the Fit & Shift page (time-stretch.md REQ-the-editor-gains-a-fit-row/REQ-the-fit-row-preselects-the-nearest-target) ----

    /** Whether a target is reachable from this selection within the stretch limits. */
    const fitOk = (steps: number): boolean => {
      const from = selFrames();
      const to = framesFor(steps);
      if (from <= 0 || to <= 0 || to > MAX_STRETCH_OUTPUT_FRAMES) return false;
      const r = to / from;
      return r >= MIN_STRETCH_RATIO && r <= MAX_STRETCH_RATIO;
    };

    const stretchPage = el('div', recStyles.page);
    const fitRow = el('div', recStyles.fxRow);
    fitRow.dataset.testid = 'fit-row';
    const fitHint = el('span', recStyles.hint);
    fitHint.dataset.testid = 'fit-hint';
    fitRow.appendChild(fitHint);

    const targetDd = own(new Dropdown(FIT_TARGETS.map(fitLabel), fitLabel(16)));
    targetDd.el.dataset.testid = 'fit-target';
    fitRow.appendChild(targetDd.el);

    const MODE_LABELS = ['Rhythmic', 'Tonal'] as const;
    const modeDd = own(new Dropdown([...MODE_LABELS], MODE_LABELS[0]));
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

    const shiftRow = el('div', recStyles.fxRow);
    shiftRow.dataset.testid = 'shift-row';
    shiftRow.appendChild(el('span', recStyles.hint, 'Shift: pitch only, length kept.'));

    const shiftLabel = (st: number): string => (st > 0 ? `+${st} st` : `${st} st`);
    const SHIFT_STEPS = Array.from(
      { length: MAX_PITCH_SHIFT_SEMITONES * 2 + 1 },
      (_, i) => i - MAX_PITCH_SHIFT_SEMITONES,
    );
    const shiftDd = own(new Dropdown(SHIFT_STEPS.map(shiftLabel), shiftLabel(0)));
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
    // One page for both rows: they are the same question asked twice — retime and
    // keep the pitch, or repitch and keep the time (time-stretch.md REQ-fit-and-shift-share-a-tab).
    stretchPage.append(fitRow, shiftRow);

    /* ---- the Scratch page (scratch.md REQ-the-scratch-editor-is-a-modal-section
     through scratch.md REQ-preview-plays-without-committing) ----
     * A page rather than a second modal: it edits the same selection, and it
     * applies through the same `runOp`, so undo, the busy latch and the crop
     * reset are inherited rather than reimplemented. The costliest page — a 210 px
     * canvas plus a 512-column peak scan — and the only one whose visibility also
     * gates work (runtime-performance.md): the scan is skipped while another tab
     * shows, and re-run when this one is picked.
     */
    const scratchPage = el('div', recStyles.page);

    const scratchRow = el('div', recStyles.fxRow);
    scratchRow.dataset.testid = 'scratch-row';
    const scratchHint = el('span', recStyles.hint);
    scratchHint.dataset.testid = 'scratch-hint';
    scratchRow.appendChild(scratchHint);

    const lenDd = own(new Dropdown(FIT_TARGETS.map(fitLabel), fitLabel(16)));
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
    const presetDd = own(new Dropdown([...PRESET_LABELS], PRESET_LABELS[0]));
    presetDd.el.dataset.testid = 'scratch-preset';
    presetDd.el.title = 'Classic patterns. Baby is a push, a pull and a long push — '
      + 'the one that reads as a scratch straight away.';
    scratchRow.appendChild(presetDd.el);

    const scratchSteps = (): number => stepsFor(lenDd.value) || 16;
    const scratchFrames = (): number => framesFor(scratchSteps());
    const presetFor = (label: string): ScratchPresetName =>
      SCRATCH_PRESETS[Math.max(0, PRESET_LABELS.indexOf(label))] ?? 'Baby';

    /** Drop the needle so the gesture reads from inside the sample (REQ-the-cue-auto-places-from-the-excursion).
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

    /** Render and play without committing (REQ-preview-plays-without-committing) — no `working`, no undo
     *  entry, no button flash. The render is a single pass over a bar of
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
    scratchPage.append(graph.el, scratchRow);

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

      // Peaks are recomputed only when the Scratch tab shows and the selection
      // has audio: a crop drag on another tab would otherwise pay for a
      // 512-column min/max scan nobody can see (runtime-performance.md).
      if (activeTab === 'scratch' && working && frames > 0) {
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

      // time-stretch.md REQ-the-fit-row-preselects-the-nearest-target — preselect the target nearest what the selection already is, so
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

    // ---- the tabs (REQ-the-tools-are-tabs) ----
    const tabs: PanelTabs = own(createPanelTabs({
      prefix: 'sample',
      pages: [
        { id: 'effects', label: 'Effects', content: effectsPage },
        { id: 'chop', label: 'Chop', content: chopPage },
        { id: 'stretch', label: 'Fit & Shift', content: stretchPage },
        { id: 'scratch', label: 'Scratch', content: scratchPage },
      ],
      initialId: activeTab,
    }));
    tabs.bar.classList.add(recStyles.tabBar!);
    // The page stack is content-sized here, so the waveform above takes the
    // slack. Inline, because `.panelPages { flex: 1 }` sits in a later cascade
    // layer than this studio's sheet (css-cascade-layers.md).
    tabs.body.style.flex = '0 0 auto';
    tabs.onChange((id) => {
      activeTab = id as ToolTab;
      memory.tab = activeTab;
      // A page is never shown with a stale hint.
      if (id === 'chop') syncChop?.();
      if (id === 'stretch') syncFit?.();
      if (id === 'scratch') syncScratch?.();
    });
    screen.append(tabs.bar, tabs.body);

    syncFit(true);
    // Built last so it sees the Fit row settled, then given the length the
    // material suggests and a cue placed for it (REQ-the-cue-auto-places-from-the-excursion).
    syncScratch(true);
    setScratch(scratch);
    syncHistory();

    // ---- the footer: one primary action (REQ-one-primary-action-per-screen) ----
    const finalClip = (): CapturedAudio => crop(working!, cropStart, cropEnd);

    const rerecordBtn = createButton({
      label: editing ? 'Record new' : 'Re-record',
      iconBefore: UI_ICONS.record,
      testId: 'mic-rerecord',
      title: 'Back to the Record screen',
      onClick: () => {
        void Promise.resolve(confirmDiscard(false)).then((ok) => {
          if (!ok || cleaned) return;
          dirty = false;
          showRecord();
        });
      },
    });
    const saved = (fn: string): void => {
      dirty = false;
      lastAction = `Saved ${fn}`;
      redraw();
    };
    const wavBtn = createButton({
      label: 'WAV',
      iconBefore: UI_ICONS.download,
      testId: 'mic-save-wav',
      title: 'Download the selection as a WAV file',
      onClick: () => {
        const c = finalClip();
        const fn = `recording-${timestamp()}.wav`;
        triggerDownload(encodeWav(c.left, c.right, c.sampleRate), fn);
        saved(fn);
      },
    });
    const mp3Btn = createButton({
      label: 'MP3',
      iconBefore: UI_ICONS.download,
      testId: 'mic-save-mp3',
      title: 'Download the selection as an MP3 file',
      onClick: async () => {
        const c = finalClip();
        const fn = `recording-${timestamp()}.mp3`;
        triggerDownload(await encodeMp3(c.left, c.right, c.sampleRate), fn);
        saved(fn);
      },
    });
    const loadBtn = createButton({
      label: 'Load',
      testId: 'mic-load',
      onClick: () => {
        const slot = slotOptions.indexOf(picker.value);
        if (slot < 0 || !working) return;
        const restore = snapshotSamplerSlot(engine, slot);
        // A fresh recording is a new sound; an edit is the same one, so it keeps
        // its source's name (time-stretch.md REQ-a-fitted-clip-is-not-renamed).
        const name = ofSlot
          ? (engine.patterns.sampleNames[sourceSlot] ?? `recording-${slotTag(slot)}`)
          : `recording-${slotTag(slot)}`;
        writeSamplerSlot(engine, slot, capturedToAudioBuffer(engine.ctx, finalClip()), name);
        dirty = false;
        modal.close();
        showToast({
          message: `Loaded into ${slotTag(slot)}`,
          actionLabel: 'Undo',
          testId: 'mic-load-toast',
          onAction: restore,
        });
      },
    });
    // On top of the shared switch look, never instead of it.
    loadBtn.classList.add(recStyles.primary!);
    const syncLoad = (): void => {
      const slot = Math.max(0, slotOptions.indexOf(picker.value));
      targetSlot = slot;
      setButtonLabel(loadBtn, slotFilled(slot) ? `Replace ${slotTag(slot)}` : `Load into ${slotTag(slot)}`);
      loadBtn.title = slotFilled(slot)
        ? `Put this sound in ${slotTag(slot)}, replacing what is there — the toast can undo it`
        : `Put this sound in ${slotTag(slot)}`;
    };
    picker.onChange(() => { syncChop?.(); syncLoad(); });
    syncLoad();

    const pickWrap = el('label', recStyles.slot);
    pickWrap.append(el('span', undefined, 'Slot'), picker.el);

    footer.append(rerecordBtn, wavBtn, mp3Btn, el('span', recStyles.footSpacer), pickWrap, loadBtn);

    resizeObs = new ResizeObserver(() => redraw());
    resizeObs.observe(wrap);
    // The words now, the waveform once the card has laid out.
    refreshStatus(working);
    requestAnimationFrame(redraw);
  }

  modal.open();
  if (opts.source) {
    startEditing(opts.source, 'Loaded', false);
  } else {
    showRecord();
  }
}
