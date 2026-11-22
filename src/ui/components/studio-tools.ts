/**
 * Four of the sample studio's five tool pages (sample-recorder.md REQ-the-tools-are-tabs;
 * the fifth, the Vocoder, is studio-vocoder.ts):
 * Effects, Chop (sample-chop.md), Fit & Shift (time-stretch.md) and Scratch
 * (scratch.md). Each is a builder over a narrow `ToolContext` the editor hands
 * it — the material, the selection, the marks, and the one edit path `runOp`
 * — and returns its page plus a `sync` the editor calls when the material, the
 * selection or the busy latch changes. None of them holds the material itself,
 * so every page edits the same selection through the same undo.
 */
import recStyles from '../styles/record-sound.module.css';
import type { StudioApi } from '../studio-api';
import type { CapturedAudio } from '../../audio/recorder/node';
import { createButton } from './button';
import { Dropdown } from './dropdown';
import { confirmDialog } from './dialog';
import { showToast } from './toast';
import { ScratchGraph } from './scratch-graph';
import { UI_ICONS } from './ui-icons';
import { el } from './studio-kit';
import {
  crop, reverse, normalize, gain, fadeIn, fadeOut, computePeaks,
  sliceEqual, sliceRanges, detectOnsets,
} from '../../audio/recorder/buffer-dsp';
import { renderEffect, renderPitchShift } from '../../audio/recorder/offline-render';
import { fitToFrames, type StretchMode } from '../../audio/recorder/time-stretch';
import { renderScratch } from '../../audio/recorder/scratch';
import {
  scratchPreset, randomScratch, autoCue, SCRATCH_PRESETS,
  type ScratchCurve, type ScratchPresetName,
} from '../../audio/recorder/scratch-curve';
import { capturedToAudioBuffer } from '../../audio/recorder/audio-buffer';
import { SAMPLER_SLOT_COUNT, slotTag } from '../../state/patterns';
import {
  MIN_STRETCH_RATIO, MAX_STRETCH_RATIO, MAX_STRETCH_OUTPUT_FRAMES,
  MAX_PITCH_SHIFT_SEMITONES } from '../../state/limits';
import { FIT_TARGETS, fitLabel as fitLabelFor, nearestTarget as nearestTargetFor } from '../../state/fit-targets';
import { samplerSlotFilled, snapshotSamplerSlot, writeSamplerSlot } from '../panels/step-panel-scaffold';

const FADE_MS = 150;
const BOOST_FACTOR = 2; // ≈ +6 dB
/** Columns of source peaks the scratch graph warps. Enough to resolve a hit at
 *  any usable width, cheap enough to recompute on a crop drag. */
const PEAK_COLS = 512;
const MIN_F = 20;
const MAX_F = 18000;

type Op = (src: CapturedAudio) => CapturedAudio | Promise<CapturedAudio>;

/**
 * Musical length arithmetic, shared by the Fit and Scratch pages. Targets are
 * sixteenth counts, because that is the unit the clock actually runs on (ADR-019:
 * a tick IS a sixteenth) and because "a bar" is only a count of them — one that
 * changes with the meter. One derivation for both pages: time-stretch.md
 * REQ-the-editor-gains-a-fit-row forbids re-deriving what a bar is. The pure half
 * is state/fit-targets.ts; this binds it to the studio's material and tempo.
 */
export interface MusicLengths {
  srOf(): number;
  selFrames(): number;
  /** Frames one target occupies at the current tempo — render-to-sampler.md's arithmetic. */
  framesFor(steps: number): number;
  fitLabel(steps: number): string;
  stepsFor(label: string): number;
  /** The target closest to how long the selection already is — what both pages preselect. */
  nearestTarget(): number;
}

export interface ToolContext {
  engine: StudioApi;
  working(): CapturedAudio | null;
  cropStart(): number;
  cropEnd(): number;
  marks(): number[];
  /** Lay new chop boundaries: they are drawn, and the Chop page re-syncs. */
  setMarks(next: number[]): void;
  /** Repaint the waveform and the status line. */
  redraw(): void;
  /** Say what just happened, in the status line. */
  note(action: string): void;
  /** The one destructive edit path: busy latch, undo, marks reset, auto-play. */
  runOp(btn: HTMLButtonElement, label: string, op: Op): void;
  isBusy(): boolean;
  /** A button the busy latch disables wholesale. */
  track(...btns: HTMLButtonElement[]): void;
  /** Register something with listeners outside the page (REQ-the-editor-owns-its-teardown). */
  own<T extends { destroy(): void }>(d: T): T;
  /** Audition a clip through the studio's one preview player. */
  playClip(c: CapturedAudio): void;
  /** Stop that player (with its fade). */
  stopPreview(): void;
  /** Override where the waveform draws the playhead — frames into the selection,
   *  or null for none — while a clip longer than the selection plays (the
   *  vocoder's cue pass, vocoder.md REQ-the-voice-take-follows-the-carrier). Null
   *  puts the preview's own playhead back. */
  setPlayhead(fn: (() => number | null) | null): void;
  music: MusicLengths;
}

export function musicLengths(
  engine: StudioApi,
  working: () => CapturedAudio | null,
  cropStart: () => number,
  cropEnd: () => number,
): MusicLengths {
  const srOf = (): number => working()?.sampleRate ?? engine.ctx.sampleRate;
  const selFrames = (): number => Math.max(0, cropEnd() - cropStart());
  const framesFor = (steps: number): number =>
    Math.round(steps * engine.clock.sixteenthDuration() * srOf());
  const fitLabel = (steps: number): string => fitLabelFor(steps, engine.barTicks);
  return {
    srOf,
    selFrames,
    framesFor,
    fitLabel,
    stepsFor: (label) => FIT_TARGETS.find((s) => fitLabel(s) === label) ?? 0,
    nearestTarget: () => nearestTargetFor(selFrames(), framesFor),
  };
}

/** The selection as audio. */
const selection = (ctx: ToolContext, cur: CapturedAudio): CapturedAudio =>
  crop(cur, ctx.cropStart(), ctx.cropEnd());

// ---- Effects --------------------------------------------------------------

export interface EffectsPage {
  readonly el: HTMLElement;
  /** Whether a finished edit (and a committed scratch) auditions itself. */
  autoPlay(): boolean;
}

export function buildEffectsPage(ctx: ToolContext): EffectsPage {
  const page = el('div', recStyles.page);
  page.appendChild(el('div', recStyles.hint,
    'Drag the side handles on the waveform to crop. Effects apply to the selection.'));

  // Cutoff slider (log-mapped) for the filters
  const cutoffRow = el('div', recStyles.cutoff);
  const cutoffLabel = el('span');
  const slider = el('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1000';
  const freqFromSlider = (v: number): number => MIN_F * Math.pow(MAX_F / MIN_F, v / 1000);
  const sliderFromFreq = (f: number): number => (1000 * Math.log(f / MIN_F)) / Math.log(MAX_F / MIN_F);
  slider.value = String(Math.round(sliderFromFreq(1200)));
  const cutoffFreq = (): number => freqFromSlider(Number(slider.value));
  const paintCutoff = (): void => {
    cutoffLabel.textContent = `Cutoff: ${Math.round(cutoffFreq())} Hz`;
  };
  slider.addEventListener('input', paintCutoff);
  paintCutoff();
  cutoffRow.append(cutoffLabel, slider);

  const fxRow = el('div', recStyles.fxRow);
  page.append(fxRow, cutoffRow);

  // Auto-play toggle (default on)
  const autoRow = el('label', recStyles.autoplay);
  const autoPlay = el('input');
  autoPlay.type = 'checkbox';
  autoPlay.checked = true;
  autoRow.append(autoPlay, el('span', undefined, 'Auto-play after each effect'));
  page.appendChild(autoRow);

  const apply = (label: string, op: Op): void => {
    const btn = createButton({
      label,
      testId: `mic-fx-${label.toLowerCase().replace(/\s+/g, '-')}`,
      onClick: () => ctx.runOp(btn, label, op),
    });
    ctx.track(btn);
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

  return { el: page, autoPlay: () => autoPlay.checked };
}

// ---- Chop (sample-chop.md) ------------------------------------------------

export interface ChopPageOptions {
  /** The slot a spread starts at — the footer picker's. */
  startSlot(): number;
  /** The slices' shared stem: the source slot's filename without its extension. */
  baseName(): string;
  /** The slices are in slots now: nothing left to lose, so the studio closes. */
  onSpread(): void;
}

export interface ToolPage {
  readonly el: HTMLElement;
  sync(repick?: boolean): void;
}

export function buildChopPage(ctx: ToolContext, opts: ChopPageOptions): ToolPage {
  const { engine } = ctx;
  const page = el('div', recStyles.page);
  const chopRow = el('div', recStyles.fxRow);
  chopRow.dataset.testid = 'chop-row';
  const chopLabel = el('span', recStyles.hint);
  chopRow.appendChild(chopLabel);

  /** REQ-the-result-is-exactly-out-frames — offer only counts that fit from the picker's slot, so a spread can
   *  never quietly drop the slices it has no room for. */
  const fittingCounts = (): string[] => {
    const room = SAMPLER_SLOT_COUNT - opts.startSlot();
    return [2, 4, 6, 8].filter((n) => n <= room).map((n) => `${n} slices`);
  };
  // `—` rather than an empty list: a dropdown with no options reads as broken,
  // and this state is legitimate (the last slot has no room to spread into).
  const countDd = ctx.own(new Dropdown(fittingCounts().length ? fittingCounts() : ['—'], '4 slices'));
  countDd.el.dataset.testid = 'chop-count';
  chopRow.appendChild(countDd.el);
  const wantCount = (): number => parseInt(countDd.value, 10) || 2;

  const chopBtn = createButton({
    label: 'Chop',
    testId: 'chop-equal',
    onClick: () => {
      const cur = ctx.working();
      if (cur) ctx.setMarks(sliceEqual(cur, wantCount(), ctx.cropStart(), ctx.cropEnd()));
    },
  });
  const detectBtn = createButton({
    label: 'Detect',
    testId: 'chop-detect',
    onClick: () => {
      const cur = ctx.working();
      if (!cur) return;
      const found = detectOnsets(cur, { from: ctx.cropStart(), to: ctx.cropEnd(), maxSlices: wantCount() });
      // Falling back to an equal cut would misrepresent the result as detection.
      // Say nothing was found and leave the boundaries alone.
      if (found.length === 0) { ctx.note('No transients found'); return; }
      ctx.setMarks(found);
    },
  });

  const spread = async (): Promise<void> => {
    const cur = ctx.working();
    const marks = ctx.marks();
    if (!cur || marks.length === 0) return;
    const start = opts.startSlot();
    const ranges = sliceRanges(ctx.cropStart(), ctx.cropEnd(), marks);
    const n = ranges.length;
    // Guarded by `sync`, which disables the button rather than let this be
    // reached. Kept as a hard refuse and NOT as a `Math.min` clamp: clamping
    // here is what silently dropped the slices that did not fit, and it did it
    // behind a label that had already promised them.
    if (n > SAMPLER_SLOT_COUNT - start) return;
    const targets = Array.from({ length: n }, (_, k) => start + k);
    const occupied = targets.filter((s) => samplerSlotFilled(engine, s));
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
    // own reversal exactly as `samplerSlotClearRow` does.
    const base = opts.baseName();
    const restores = targets.map((slot) => snapshotSamplerSlot(engine, slot));
    targets.forEach((slot, k) => {
      const [from, to] = ranges[k]!;
      writeSamplerSlot(engine, slot,
        capturedToAudioBuffer(engine.ctx, crop(cur, from, to)), `${base} ${k + 1}/${n}`);
    });
    opts.onSpread();
    showToast({
      message: `Chopped into ${n} slices`,
      actionLabel: 'Undo',
      testId: 'chop-toast',
      onAction: () => { for (const restore of restores) restore(); },
    });
  };
  const spreadBtn = createButton({
    label: 'Spread to slots',
    testId: 'chop-spread',
    onClick: () => { void spread(); },
  });
  chopRow.append(chopBtn, detectBtn, spreadBtn);
  page.appendChild(chopRow);

  const sync = (): void => {
    const fits = fittingCounts();
    const noRoom = fits.length === 0;
    countDd.setOptions(noRoom ? ['—'] : fits);
    const start = opts.startSlot();
    const room = SAMPLER_SLOT_COUNT - start;
    const marks = ctx.marks();
    const n = marks.length + 1;
    // REQ-the-result-is-exactly-out-frames has to survive the picker MOVING, not just the moment of chopping.
    // Filtering the count list is what stops an over-long chop being made; this
    // is what stops one being made and then aimed at a slot with less room
    // behind it. Refuse rather than quietly re-cut: the user chose this many
    // slices, and silently dropping the tail — or silently merging it into the
    // last slice — is the same class of defect in a nicer coat.
    const tooMany = marks.length > 0 && n > room;
    chopLabel.textContent = noRoom
      ? `Chop: no room below ${slotTag(start)} — pick an earlier slot.`
      : tooMany
        ? `Chop: ${n} slices need ${n} slots — ${slotTag(start)} has room for ${room}.`
        : marks.length === 0
          ? 'Chop: cut the selection, then drag any boundary.'
          : `Chop: ${n} slices → ${slotTag(start)}–${slotTag(start + n - 1)}`;
    const busy = ctx.isBusy();
    chopBtn.disabled = busy || noRoom;
    detectBtn.disabled = busy || noRoom;
    spreadBtn.disabled = busy || noRoom || tooMany || marks.length === 0;
  };
  sync();

  return { el: page, sync };
}

// ---- Fit & Shift (time-stretch.md REQ-the-editor-gains-a-fit-row/REQ-the-fit-row-preselects-the-nearest-target) ----

export function buildStretchPage(ctx: ToolContext): ToolPage {
  const { engine } = ctx;
  const { srOf, selFrames, framesFor, fitLabel, stepsFor, nearestTarget } = ctx.music;
  /** Last-rendered target labels, so a meter change rebuilds the list and a crop drag does not. */
  let fitLabels = '';

  /** Whether a target is reachable from this selection within the stretch limits. */
  const fitOk = (steps: number): boolean => {
    const from = selFrames();
    const to = framesFor(steps);
    if (from <= 0 || to <= 0 || to > MAX_STRETCH_OUTPUT_FRAMES) return false;
    const r = to / from;
    return r >= MIN_STRETCH_RATIO && r <= MAX_STRETCH_RATIO;
  };

  const page = el('div', recStyles.page);
  const fitRow = el('div', recStyles.fxRow);
  fitRow.dataset.testid = 'fit-row';
  const fitHint = el('span', recStyles.hint);
  fitHint.dataset.testid = 'fit-hint';
  fitRow.appendChild(fitHint);

  const targetDd = ctx.own(new Dropdown(FIT_TARGETS.map(fitLabel), fitLabel(16)));
  targetDd.el.dataset.testid = 'fit-target';
  fitRow.appendChild(targetDd.el);

  const MODE_LABELS = ['Rhythmic', 'Tonal'] as const;
  const modeDd = ctx.own(new Dropdown([...MODE_LABELS], MODE_LABELS[0]));
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
      ctx.runOp(fitBtn, 'Fit', (src) => fitToFrames(src, frames, mode));
    },
  });
  ctx.track(fitBtn);
  fitRow.appendChild(fitBtn);

  const shiftRow = el('div', recStyles.fxRow);
  shiftRow.dataset.testid = 'shift-row';
  shiftRow.appendChild(el('span', recStyles.hint, 'Shift: pitch only, length kept.'));

  const shiftLabel = (st: number): string => (st > 0 ? `+${st} st` : `${st} st`);
  const SHIFT_STEPS = Array.from(
    { length: MAX_PITCH_SHIFT_SEMITONES * 2 + 1 },
    (_, i) => i - MAX_PITCH_SHIFT_SEMITONES,
  );
  const shiftDd = ctx.own(new Dropdown(SHIFT_STEPS.map(shiftLabel), shiftLabel(0)));
  shiftDd.el.dataset.testid = 'shift-amount';
  shiftRow.appendChild(shiftDd.el);

  const shiftAmount = (): number => SHIFT_STEPS.find((s) => shiftLabel(s) === shiftDd.value) ?? 0;

  const shiftBtn = createButton({
    label: 'Shift',
    testId: 'shift-apply',
    onClick: () => {
      const st = shiftAmount();
      if (st === 0) return;
      const mode = fitMode();
      ctx.runOp(shiftBtn, 'Shift', (src) => renderPitchShift(src, st, mode));
    },
  });
  ctx.track(shiftBtn);
  shiftRow.appendChild(shiftBtn);
  // One page for both rows: they are the same question asked twice — retime and
  // keep the pitch, or repitch and keep the time (time-stretch.md REQ-fit-and-shift-share-a-tab).
  page.append(fitRow, shiftRow);

  const sync = (repick = false): void => {
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

    // REQ-the-fit-row-preselects-the-nearest-target — preselect the target nearest what the selection already is, so
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

    const busy = ctx.isBusy();
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
  targetDd.onChange(() => sync());
  shiftDd.onChange(() => sync());

  return { el: page, sync };
}

// ---- Scratch (scratch.md REQ-the-scratch-editor-is-a-modal-section … REQ-preview-plays-without-committing) ----

export interface ScratchPageOptions {
  /** The drawn scratch. It lives as long as the studio does, not the page —
   *  nothing about it is persisted (scratch.md REQ-scratch-registers-no-params). */
  curve: { get(): ScratchCurve; set(c: ScratchCurve): void };
  /** The Effects page's auto-play box — reused, not a second preference. */
  autoPlay(): boolean;
  /** Whether the Scratch tab shows: the 512-column peak scan runs only then. */
  visible(): boolean;
}

export interface ScratchPage extends ToolPage {
  /** Give the curve its cue for the material (REQ-the-cue-auto-places-from-the-excursion). */
  settle(): void;
  /** The graph owns a ResizeObserver and, mid-drag, listeners the studio cannot see. */
  destroy(): void;
}

/**
 * A page rather than a second modal: it edits the same selection, and it
 * applies through the same `runOp`, so undo, the busy latch and the crop reset
 * are inherited. The costliest page — a 210 px canvas plus a 512-column peak scan
 * — and, with the Vocoder, one whose visibility also gates work (runtime-performance.md).
 */
export function buildScratchPage(ctx: ToolContext, opts: ScratchPageOptions): ScratchPage {
  const { engine } = ctx;
  const { srOf, selFrames, framesFor, fitLabel, stepsFor, nearestTarget } = ctx.music;
  const page = el('div', recStyles.page);

  const scratchRow = el('div', recStyles.fxRow);
  scratchRow.dataset.testid = 'scratch-row';
  const scratchHint = el('span', recStyles.hint);
  scratchHint.dataset.testid = 'scratch-hint';
  scratchRow.appendChild(scratchHint);

  const lenDd = ctx.own(new Dropdown(FIT_TARGETS.map(fitLabel), fitLabel(16)));
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
  const presetDd = ctx.own(new Dropdown([...PRESET_LABELS], PRESET_LABELS[0]));
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

  let graph: ScratchGraph | null = null;
  const setScratch = (c: ScratchCurve, recueIt = true): void => {
    opts.curve.set(recueIt ? recue(c) : c);
    graph?.setCurve(opts.curve.get());
    sync();
  };

  const scratchOf = (src: CapturedAudio): CapturedAudio =>
    renderScratch(src, opts.curve.get(), scratchFrames());

  /** Render and play without committing (REQ-preview-plays-without-committing) — no material, no undo
   *  entry, no button flash. The render is a single pass over a bar of audio,
   *  so it is cheap enough to sit behind a tap. */
  const previewScratch = (): void => {
    const cur = ctx.working();
    if (!cur || ctx.isBusy() || selFrames() <= 0) return;
    ctx.playClip(scratchOf(selection(ctx, cur)));
  };

  graph = new ScratchGraph({
    curve: opts.curve.get(),
    // A hand-edited curve is no longer any named preset, and saying so is
    // cheaper than a dropdown that lies about what is on screen.
    onChange: (c) => {
      opts.curve.set(c);
      if (presetDd.value !== CUSTOM) presetDd.setValue(CUSTOM);
      sync();
    },
    onCommit: () => { if (opts.autoPlay()) previewScratch(); },
    onAudition: () => previewScratch(),
  });
  const g = graph;

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
      ctx.runOp(scratchBtn, 'Scratch', (src) => scratchOf(src));
    },
  });
  ctx.track(diceBtn, previewBtn, scratchBtn);
  scratchRow.append(diceBtn, previewBtn, scratchBtn);
  page.append(g.el, scratchRow);

  lenDd.onChange(() => setScratch(opts.curve.get()));
  presetDd.onChange((v) => {
    if (v === CUSTOM) return;
    setScratch(scratchPreset(presetFor(v), scratchSteps()));
  });

  function sync(repick = false): void {
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
    const cur = ctx.working();
    if (opts.visible() && cur && frames > 0) {
      g.setSource(computePeaks(selection(ctx, cur), PEAK_COLS), frames);
    }
    g.setGrid(steps, Math.max(1, engine.barTicks), out);

    if (frames <= 0) {
      scratchHint.textContent = 'Scratch: nothing selected.';
    } else if (!ok) {
      scratchHint.textContent = 'Scratch: that length is past the limit.';
    } else {
      const inSteps = frames / Math.max(1, framesFor(1));
      scratchHint.textContent = `Scratch: selection is ~${inSteps.toFixed(1)} sixteenths `
        + `→ ${(out / sr).toFixed(2)} s`;
    }
    const busy = ctx.isBusy();
    for (const b of [diceBtn, previewBtn, scratchBtn]) b.disabled = busy || !ok;
    scratchBtn.title = ok
      ? 'Print the drawn scratch into the selection. Undo takes it back.'
      : 'Select some audio and pick a length that fits.';
  }

  return {
    el: page,
    sync,
    settle: () => setScratch(opts.curve.get()),
    destroy: () => { g.destroy(); graph = null; },
  };
}
