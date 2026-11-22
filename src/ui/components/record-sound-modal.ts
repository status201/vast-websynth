/**
 * The sample studio — "Record a sound" / "Edit sample" (sample-recorder.md).
 *
 * One near-full-screen frame (REQ-the-studio-fills-the-screen) with two screens:
 * **Record** (record-screen.ts) and **Edit** (the waveform, the edit bar, the five
 * tool tabs from studio-tools.ts and studio-vocoder.ts, and one primary action). The transport and a
 * metronome sit in the frame's toolbar (studio-transport.ts), so a song playing
 * under a take can be stopped without leaving (REQ-the-transport-is-in-reach),
 * and nothing the user recorded is dropped without asking
 * (REQ-nothing-closes-the-studio-by-accident).
 *
 * This module owns the frame, the close guard, the session memory and the
 * material being edited — the selection, the marks, the undo stack, the busy
 * latch — and hands the screens and pages only the narrow view they need.
 */
import recStyles from '../styles/record-sound.module.css';
import type { StudioApi } from '../studio-api';
import { Modal } from './modal';
import { createButton, setButtonLabel } from './button';
import { Dropdown } from './dropdown';
import type { CapturedAudio } from '../../audio/recorder/node';
import { cloneCaptured, crop, capturedFrames } from '../../audio/recorder/buffer-dsp';
import { confirmDialog } from './dialog';
import { showToast } from './toast';
import { scratchPreset, type ScratchCurve } from '../../audio/recorder/scratch-curve';
import { createPanelTabs, type PanelTabs } from './panel-tabs';
import { capturedToAudioBuffer } from '../../audio/recorder/audio-buffer';
import { encodeWav, encodeMp3 } from '../../audio/recorder/encode';
import { triggerDownload } from '../../utils/download';
import { SAMPLER_SLOT_COUNT, slotOptionLabels, slotTag } from '../../state/patterns';
import { UI_ICONS } from './ui-icons';
import { onPaletteChange } from '../theme-colors';
import { createMetronome } from '../../audio/metronome';
import { isEditableTarget, isTopModal } from '../modal-stack';
import { EditHistory } from '../../state/edit-history';
import { createStudioTransport } from './studio-transport';
import { samplerSlotFilled, snapshotSamplerSlot, writeSamplerSlot } from '../panels/step-panel-scaffold';
import { el, fmtClip } from './studio-kit';
import { createWaveform } from './studio-waveform';
import { buildRecordScreen, type RecordScreen } from './record-screen';
import {
  musicLengths, buildEffectsPage, buildChopPage, buildStretchPage, buildScratchPage,
  type ToolContext, type ToolPage, type ScratchPage,
} from './studio-tools';
import { buildVocoderPage, type VocoderPage, type VoiceState } from './studio-vocoder';
import { DEFAULT_VOCODER, type VocoderSettings } from '../../audio/recorder/vocoder';

export { MAX_TAKE_SECONDS } from './record-screen';

/** Undo entries kept (REQ-undo-is-a-stack). */
export const UNDO_DEPTH = 10;
/** Frames the undo + redo stacks may hold together — ~200 MB of stereo float. */
export const UNDO_FRAME_BUDGET = 25_000_000;

export interface RecordSoundOptions {
  /** Slot the picker defaults to (and that "Load into" targets). */
  slot?: number;
  /** If set, skip recording and open this audio straight in the editor. */
  source?: CapturedAudio;
  /** The header's own Play button (transport-window.md REQ-play-pause-is-not-a-second-truth).
   *  Required: the studio never starts the clock any other way. */
  toggleTransport: () => void;
}

type ToolTab = 'effects' | 'chop' | 'stretch' | 'scratch' | 'vocoder';

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

  let original: CapturedAudio | null = null;
  let working: CapturedAudio | null = null;
  /** REQ-undo-is-a-stack. */
  const edits = new EditHistory<CapturedAudio>({
    depth: UNDO_DEPTH, budget: UNDO_FRAME_BUDGET, size: capturedFrames,
  });
  let cropStart = 0;
  let cropEnd = 0;
  /** Interior chop boundaries, absolute sample indices (sample-chop.md REQ-two-ways-to-place-the-cuts). */
  let marks: number[] = [];
  /** Audio the user would lose by closing (REQ-nothing-closes-the-studio-by-accident). */
  let dirty = false;
  let lastAction = 'Ready';
  /** The drawn scratch: studio-lifetime, so a re-record keeps it (scratch.md REQ-scratch-registers-no-params). */
  let scratch: ScratchCurve = scratchPreset('Baby', 16);
  let activeTab: ToolTab = memory.tab;
  /** The vocoder's settings and voice: studio-lifetime, so a re-record or an
   *  undo keeps them (vocoder.md REQ-vocoder-registers-no-params). */
  let vocoderSettings: VocoderSettings = { ...DEFAULT_VOCODER };
  let voiceState: VoiceState = { source: 'mic', take: null, offsetMs: 0, stretch: false };
  /** Where the waveform draws the playhead while the vocoder's cue pass plays (ToolContext.setPlayhead). */
  let playheadOverride: (() => number | null) | null = null;

  /** The audition player — the audio layer's, with the slot's edges (sample-recorder.md
   *  REQ-the-preview-fades-like-the-slot). */
  const preview = engine.clipPreview;
  let playRaf = 0;
  let cleaned = false;
  let onPlayingChange: ((playing: boolean) => void) | null = null;
  let redrawHook: (() => void) | null = null;
  // The waveform paints on demand, so a theme change asks for one repaint
  // (ui-themes.md REQ-a-theme-change-repaints-the-canvases); cleanup unsubscribes.
  const offPalette = onPaletteChange(() => redrawHook?.());

  /** The Record screen while it shows — the guard and the `R` key ask it. */
  let recScreen: RecordScreen | null = null;
  /** The Edit screen's tool pages, re-synced when the material or the busy latch moves. */
  let pages: { chop: ToolPage; stretch: ToolPage; scratch: ScratchPage; vocoder: VocoderPage } | null = null;
  let syncHistory: (() => void) | null = null;

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
    recScreen?.destroy();
    recScreen = null;
    stopPreview();
    onPlayingChange = null;
    redrawHook = null;
    // The scratch graph owns a ResizeObserver and, mid-drag, listeners on its
    // own canvas plus the shared value bubble — none of which `owned` can see.
    pages?.scratch.destroy();
    // A voice take in flight holds the mic, a watch interval and the click
    // (vocoder.md REQ-the-voice-take-owns-its-teardown).
    pages?.vocoder.destroy();
    pages = null;
    playheadOverride = null;
    syncHistory = null;
    for (const d of owned) d.destroy();
    owned.length = 0;
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
    const state = recScreen?.state;
    if (state === 'recording' || state === 'counting' || state === 'stopping') {
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
  const onKey = (e: KeyboardEvent): void => {
    if (!recScreen || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    // A confirmation raised over the studio owns the keyboard.
    if (!isTopModal(modal) || isEditableTarget(e)) return;
    if (e.key !== 'r' && e.key !== 'R') return;
    e.preventDefault();
    recScreen.press();
  };
  window.addEventListener('keydown', onKey);
  offs.push(() => window.removeEventListener('keydown', onKey));

  /** Empty the screen and the footer for the next screen. */
  const clearScreen = (which: 'record' | 'edit'): void => {
    teardownScreen();
    setCrumb(which);
    screen.replaceChildren();
    footer.replaceChildren();
  };

  // ---- Screen 1: Record (record-screen.ts) ---------------------------------

  function showRecord(message?: string): void {
    clearScreen('record');
    const restore = memory.discarded;
    recScreen = buildRecordScreen({
      engine,
      metronome,
      transport,
      screen,
      footer,
      message,
      countIn: { get: () => memory.countIn, set: (on) => { memory.countIn = on; } },
      restore: restore && {
        seconds: capturedFrames(restore.audio) / restore.audio.sampleRate,
        onRestore: () => {
          memory.discarded = null;
          targetSlot = restore.slot;
          startEditing(restore.audio, 'Restored', true);
        },
      },
      onCancel: () => { void modal.requestClose(); },
      onTake: (audio, reason) => startEditing(audio, reason, true),
      onNothing: () => showRecord('Nothing was recorded — try again.'),
    });
  }

  /** Make `audio` the material and go to the Edit screen. */
  function startEditing(audio: CapturedAudio, action: string, unsaved: boolean): void {
    // A take or a restore is new material; only the opening source is the slot's own.
    if (unsaved) ofSlot = false;
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
    clearScreen('edit');
    screen.dataset.testid = 'rec-screen-edit';
    screen.classList.remove(recStyles.recording!);

    // The edit bar's status line follows the selection on every paint.
    const editBar = el('div', recStyles.editBar);
    const status = el('div', recStyles.status);
    status.dataset.testid = 'mic-status';
    const refreshStatus = (buf: CapturedAudio): void => {
      status.textContent = `${lastAction} — selection ${fmtClip(crop(buf, cropStart, cropEnd))}`;
    };

    // The waveform, its crop handles and the chop boundaries (studio-waveform.ts).
    const wave = createWaveform({
      working: () => working,
      cropStart: () => cropStart,
      cropEnd: () => cropEnd,
      setCrop: (start, end) => {
        cropStart = start;
        cropEnd = end;
        pages?.stretch.sync();
        pages?.scratch.sync();
        pages?.vocoder.sync();
      },
      marks: () => marks,
      playhead: () => {
        if (playheadOverride) return preview.playing ? playheadOverride() : null;
        return working && preview.playing && preview.samples > 0
          ? (engine.ctx.currentTime - preview.startTime) * working.sampleRate
          : null;
      },
      onPaint: () => { if (working) refreshStatus(working); },
    });
    owned.push(wave);
    screen.appendChild(wave.el);
    const redraw = wave.redraw;
    redrawHook = redraw;

    /**
     * Audition one clip. Split out of `playSelection` so the scratch page can
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

    // ---- the one edit path: busy latch, undo, marks reset, auto-play ----
    const tracked: HTMLButtonElement[] = [];
    let busy = false;
    /** Read by the auto-play after an edit; set once the Effects page exists. */
    let autoPlay = (): boolean => true;
    const setBusy = (b: boolean): void => {
      busy = b;
      for (const btn of tracked) btn.disabled = b;
      // Each page re-derives its own buttons rather than being swept along: they
      // depend on more than busy (room to spread into, a target in the stretch
      // limits, a scratch length that fits), and a blanket re-enable would offer
      // an edit that is then refused.
      pages?.chop.sync();
      pages?.stretch.sync();
      pages?.scratch.sync();
      pages?.vocoder.sync();
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
      pages?.chop.sync();
      pages?.stretch.sync(true);
      pages?.scratch.sync(true);
      pages?.vocoder.sync();
      syncHistory?.();
      lastAction = action;
      redraw();
      if (btn) {
        btn.classList.add(recStyles.applied!);
        window.setTimeout(() => btn.classList.remove(recStyles.applied!), 600);
      }
      if (autoPlay()) playSelection();
    };

    /**
     * Run one destructive edit on the current selection: latch the busy state,
     * label the button with it, push the undo stack, then hand the result to
     * `afterMutate`. Every page's edit comes through here (time-stretch.md
     * REQ-the-editor-gains-a-fit-row), so all of them inherit the same undo, the
     * same busy latch and the same marks reset.
     */
    const runOp: ToolContext['runOp'] = (btn, label, op) => {
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

    const ctx: ToolContext = {
      engine,
      working: () => working,
      cropStart: () => cropStart,
      cropEnd: () => cropEnd,
      marks: () => marks,
      setMarks: (next) => {
        marks = next;
        pages?.chop.sync();
        redraw();
      },
      redraw,
      note: (action) => { lastAction = action; redraw(); },
      runOp,
      isBusy: () => busy,
      track: (...btns) => { tracked.push(...btns); },
      own,
      playClip,
      stopPreview: () => stopPreview(),
      setPlayhead: (fn) => { playheadOverride = fn; redraw(); },
      music: musicLengths(engine, () => working, () => cropStart, () => cropEnd),
    };

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
    const pickedSlot = (): number => Math.max(0, slotOptions.indexOf(picker.value));

    // ---- the five tool pages (studio-tools.ts; the Vocoder in studio-vocoder.ts) ----
    const effects = buildEffectsPage(ctx);
    autoPlay = effects.autoPlay;
    const chop = buildChopPage(ctx, {
      startSlot: pickedSlot,
      baseName: () => (engine.patterns.sampleNames[sourceSlot] ?? 'chop').replace(/\.[^.]+$/, ''),
      // The slices are in slots now — nothing left to lose.
      onSpread: () => { dirty = false; modal.close(); },
    });
    const stretch = buildStretchPage(ctx);
    const scratchPage = buildScratchPage(ctx, {
      curve: { get: () => scratch, set: (c) => { scratch = c; } },
      autoPlay: () => effects.autoPlay(),
      visible: () => activeTab === 'scratch',
    });
    const vocoder = buildVocoderPage(ctx, {
      toggleTransport: opts.toggleTransport,
      metronome,
      settings: { get: () => vocoderSettings, set: (s) => { vocoderSettings = s; } },
      voice: { get: () => voiceState, set: (v) => { voiceState = v; } },
      autoPlay: () => effects.autoPlay(),
      visible: () => activeTab === 'vocoder',
    });
    pages = { chop, stretch, scratch: scratchPage, vocoder };

    // ---- the tabs (REQ-the-tools-are-tabs) ----
    const tabs: PanelTabs = own(createPanelTabs({
      prefix: 'sample',
      pages: [
        { id: 'effects', label: 'Effects', content: effects.el },
        { id: 'chop', label: 'Chop', content: chop.el },
        { id: 'stretch', label: 'Fit & Shift', content: stretch.el },
        { id: 'scratch', label: 'Scratch', content: scratchPage.el },
        { id: 'vocoder', label: 'Vocoder', content: vocoder.el },
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
      if (id === 'chop') chop.sync();
      if (id === 'stretch') stretch.sync();
      if (id === 'scratch') scratchPage.sync();
      // The lane is a canvas with no box until its page shows.
      if (id === 'vocoder') vocoder.sync();
    });
    screen.append(tabs.bar, tabs.body);

    stretch.sync(true);
    // Built last so it sees the Fit row settled, then given the length the
    // material suggests and a cue placed for it (REQ-the-cue-auto-places-from-the-excursion).
    scratchPage.sync(true);
    scratchPage.settle();
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
      const slot = pickedSlot();
      targetSlot = slot;
      setButtonLabel(loadBtn, slotFilled(slot) ? `Replace ${slotTag(slot)}` : `Load into ${slotTag(slot)}`);
      loadBtn.title = slotFilled(slot)
        ? `Put this sound in ${slotTag(slot)}, replacing what is there — the toast can undo it`
        : `Put this sound in ${slotTag(slot)}`;
    };
    picker.onChange(() => { chop.sync(); syncLoad(); });
    syncLoad();

    const pickWrap = el('label', recStyles.slot);
    pickWrap.append(el('span', undefined, 'Slot'), picker.el);

    footer.append(rerecordBtn, wavBtn, mp3Btn, el('span', recStyles.footSpacer), pickWrap, loadBtn);

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
