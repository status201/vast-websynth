/**
 * The pattern model — the step and track shapes, the machine constants, and the
 * pure factories and clamps that build and bound them (banks.md, step-settings.md,
 * motion-sequencer.md). No state: `PatternStore` (patterns.ts) holds the live
 * banks and re-exports everything here, so importers keep one path.
 */
import { clampInt } from '../utils/math';
import { MAX_CHAIN_TRANSPOSE } from './limits';
import { GRID_CELLS } from './meter';

/** Per-step settings shared by all three machines (seq / drum / sampler). */
export interface StepSettings {
  velocity: number; // 0..1
  gate: number;     // 0..1 of one step duration (drum/sampler: 1 = let ring, <1 chokes)
  prob: number;     // 0..1 chance to fire (1 = always)
  ratchet: number;  // 1..4 sub-hits within the step
  tie: boolean;     // hold into the next step (seq: legato/slide; drum/sampler: skip the choke)
  /**
   * Micro-timing: a signed integer in `-MICRO_MAX..+MICRO_MAX` notches of
   * `1/MICRO_UNITS` of **this lane's cell** — negative early, positive late
   * (step-settings.md REQ-a-step-carries-a-micro-offset). 0 is the no-op default, so a step that predates the
   * field sounds exactly as it did (ADR-006). Applied as a pure `when` offset by
   * `microOffset` in step-hits.ts; nothing in the clock or the meter knows about it.
   */
  micro: number;
}

/** How a seq step's bend moves (step-settings.md REQ-bend-shapes-are-scoop-and-fall):
 *  a scoop arrives at the note from `bend` away, a fall leaves it toward `bend`. */
export type BendShape = 'scoop' | 'fall';
export const BEND_SHAPES: readonly BendShape[] = ['scoop', 'fall'];

export interface SeqStep extends StepSettings {
  on: boolean;
  note: number;     // MIDI note
  /**
   * Signed integer semitones in `-BEND_MAX..+BEND_MAX` — 0 is the no-op default
   * (step-settings.md REQ-a-seq-step-carries-a-bend). Seq only: the drum and
   * sampler voices have no synth detune to bend.
   */
  bend: number;
  bendShape: BendShape;
}

/** One-shot trigger cell — the drum machine and sampler step shape. */
export interface TriggerCell extends StepSettings {
  on: boolean;
}

export type DrumCell = TriggerCell;
/** Sampler step — same shape as DrumCell; one-shot trigger of a loaded file. */
export type SamplerStep = TriggerCell;

/** Defaults for drum/sampler cells. gate 1 = natural decay (no choke), so
 *  legacy patterns/songs that predate per-step settings sound identical. */
export const TRIGGER_CELL_DEFAULTS: TriggerCell = {
  on: false, velocity: 0.85, gate: 1, prob: 1, ratchet: 1, tie: false, micro: 0,
};

/** Seq fields that v1 song files may lack (on/note/velocity/gate were always present).
 *  `micro` joined them in v3 and is absent from every file written before it;
 *  `bend`/`bendShape` likewise (step-settings.md v5). */
export const SEQ_EXTRA_DEFAULTS: {
  prob: number; ratchet: number; tie: boolean; micro: number; bend: number; bendShape: BendShape;
} = { prob: 1, ratchet: 1, tie: false, micro: 0, bend: 0, bendShape: 'scoop' };

/**
 * Motion sequencer step — an optional XY anchor. x/y are 0..1 in *taper space*
 * (the XY Pad surface's normalized coordinates), mapped to real param values at
 * play time via fromNorm(def, n). A dead cell keeps its last coordinate so
 * toggling a step off and on doesn't lose the dot position.
 */
export interface MotionStep {
  on: boolean;
  x: number; // 0..1
  y: number; // 0..1
}

/** Per-bank axis override; an unset axis falls back to the XY Pad assignment. */
export interface MotionAssign {
  x?: string; // ParamBus id
  y?: string;
}

export const MOTION_STEP_DEFAULTS: MotionStep = { on: false, x: 0.5, y: 0.5 };

/**
 * One step of an extra single-param motion track (motion-sequencer.md REQ-extra-single-param-tracks-per-bank).
 * `v` is 0..1 in the same normalized taper space as MotionStep's x/y. A dead
 * cell keeps its level so toggling a step off and on doesn't lose the value.
 */
export interface MotionTrackStep {
  on: boolean;
  v: number; // 0..1
}

/**
 * An extra motion track, per bank. `param` absent = the track writes nothing —
 * the no-op default (ADR-006). Unlike the XY axes there is no global assignment
 * to inherit from, because there is no pad behind these tracks.
 */
export interface MotionTrack {
  param?: string;
  steps: MotionTrackStep[];
}

export const MOTION_TRACK_STEP_DEFAULTS: MotionTrackStep = { on: false, v: 0.5 };

/**
 * Extra single-param tracks per motion bank, beyond the XY lane
 * (motion-sequencer.md REQ-extra-single-param-tracks-per-bank). Four since v17: two was
 * enough to prove the idea and not enough to use it, since the third moving
 * parameter had to spend the XY lane — the one surface the lanes exist to keep
 * free. The count lives HERE and only here; the params, the engine's
 * subscriptions, the machine's loops and the panel's rows all derive from it.
 */
export const MOTION_TRACK_COUNT = 4;

/**
 * Derived, not hand-kept beside the count — the same rule (and the same past
 * bug) as {@link BANK_LABELS}: a written-out list next to a written-out number
 * is two things that can disagree.
 */
export const MOTION_TRACK_LABELS: readonly string[] =
  Array.from({ length: MOTION_TRACK_COUNT }, (_, i) => String.fromCharCode(65 + i));

/**
 * The serialized floor for a bank's track array
 * (motion-sequencer.md REQ-the-motion-track-array-length-is-the-count). Every v5-v7 song carries
 * exactly two tracks per bank, so trimming to this floor rather than to zero is
 * what keeps those files — and every committed demo — byte-for-byte identical
 * through an export.
 */
export const MIN_MOTION_TRACK_COUNT = 2;

export function makeMotionTrack(): MotionTrack {
  return { steps: Array.from({ length: SEQ_LENGTH }, () => ({ ...MOTION_TRACK_STEP_DEFAULTS })) };
}

export function cloneMotionTracks(tracks: readonly MotionTrack[]): MotionTrack[] {
  return tracks.map((t) => ({
    ...(t.param !== undefined ? { param: t.param } : {}),
    steps: t.steps.map((s) => ({ ...s })),
  }));
}

export function makeMotionTracks(): MotionTrack[] {
  return Array.from({ length: MOTION_TRACK_COUNT }, makeMotionTrack);
}

/**
 * A track carries information only when it names a param or holds an anchor;
 * anything else is indistinguishable from an untouched one, so it serializes as
 * `null` (ADR-011 default-sparse). Shared so the export's "is this worth
 * writing" test and {@link motionTrackDepth}'s "how deep is this bank" test
 * cannot drift apart — they are the same question asked twice.
 */
export function motionTrackIsEmpty(t: MotionTrack | null | undefined): boolean {
  return !t || (!t.param && !t.steps.some((s) => s.on));
}

/**
 * How many of a bank's tracks are worth serializing: the highest one carrying
 * information, plus one, floored at {@link MIN_MOTION_TRACK_COUNT} and capped at
 * {@link MOTION_TRACK_COUNT} (motion-sequencer.md REQ-the-motion-track-array-length-is-the-count).
 *
 * Two callers, and that is the whole reason this is a function: the exporter
 * trims with it and the authoring dialect's version ladder decides `v8` with it.
 * Written out twice, the depth a file is stamped for and the depth it actually
 * carries could disagree — which is exactly the class of bug the v8 chain-
 * reference rung was added to close.
 */
export function motionTrackDepth(bank: readonly (MotionTrack | null)[] | null | undefined): number {
  const n = Math.min(bank?.length ?? 0, MOTION_TRACK_COUNT);
  for (let t = n - 1; t >= MIN_MOTION_TRACK_COUNT; t--) {
    if (!motionTrackIsEmpty(bank![t])) return t + 1;
  }
  return MIN_MOTION_TRACK_COUNT;
}

/**
 * Cells in one pattern grid.
 *
 * This used to mean three things at once — cells per pattern, ticks per bar, and
 * columns of UI — and every bar line in the app was written `step % SEQ_LENGTH`.
 * `meter.ts` now owns the other two (`barTicks`, `LANE_RATES`); this name is
 * kept, aliasing `GRID_CELLS`, because the validator, the dialect and many tests
 * still import it. New code should say which one it means (meter.md REQ-meter-ts-names-the-three-jobs, ADR-019).
 */
export const SEQ_LENGTH = GRID_CELLS;

/** Sequencer tracks per bank (sequencer.md REQ-four-tracks-per-bank). Track 0 is the pre-v3
 *  sequencer; 1..3 are the additions and only sound in poly voicing (sequencer.md REQ-poly-voicing-gates-the-extra-tracks). */
export const SEQ_TRACK_COUNT = 4;
/** Derived, for the reason {@link MOTION_TRACK_LABELS} gives. */
export const SEQ_TRACK_LABELS: string[] =
  Array.from({ length: SEQ_TRACK_COUNT }, (_, i) => String(i + 1));

export const DRUM_TRACKS = ['Kick', 'Snare', 'C.Hat', 'O.Hat', 'L.Tom', 'M.Tom', 'H.Tom', 'Clap'] as const;
export const DRUM_TRACK_COUNT = DRUM_TRACKS.length;

export const SAMPLER_SLOT_COUNT = 8;
/** Derived, for the reason {@link MOTION_TRACK_LABELS} gives. */
export const SAMPLER_SLOT_LABELS: string[] =
  Array.from({ length: SAMPLER_SLOT_COUNT }, (_, i) => `S${i + 1}`);

/** A slot's short tag (`S1`…), the one spelling every surface uses. */
export function slotTag(slot: number): string {
  return SAMPLER_SLOT_LABELS[slot] ?? `S${slot + 1}`;
}

/** One picker row per slot — `S1 — kick.wav`, `S2 — empty` — for every slot picker. */
export function slotOptionLabels(names: readonly (string | null | undefined)[]): string[] {
  return Array.from({ length: SAMPLER_SLOT_COUNT }, (_, i) => `${slotTag(i)} — ${names[i] ?? 'empty'}`);
}

/**
 * Bank counts (banks.md REQ-a-machine-owns-its-bank-count, ADR-022).
 *
 * A machine always has at least MIN_BANK_COUNT banks and never more than
 * MAX_BANK_COUNT; the count *is* the length of that machine's bank array, so
 * there is no separate field to keep honest. Raising the ceiling is this one
 * line — everything below derives from it, and the literals that cannot
 * (the two published JSON schemas, llms.txt) are pinned to it by
 * `tests/state/authoring-docs.test.ts`. A raise also owes a SONG_VERSION bump
 * and a dialect ladder rung: 8 (A..H) was SongFile v8's ceiling, 16 (A..P) is
 * v9's (song-file.md REQ-song-file-v9-raises-the-bank-ceiling).
 */
export const MIN_BANK_COUNT = 4;
export const MAX_BANK_COUNT = 16;

/**
 * One label per POSSIBLE bank, derived rather than written out: a hand-kept list
 * beside a hand-kept count is two things that can disagree, and they did — this
 * pair was `4` and `['A','B','C','D']` with nothing asserting they matched.
 * Surfaces slice it by the machine's own count.
 */
export const BANK_LABELS: readonly string[] =
  Array.from({ length: MAX_BANK_COUNT }, (_, i) => String.fromCharCode(65 + i));

/** The four pattern machines. `Arrangement`'s `LaneName` aliases this. */
export type Machine = 'seq' | 'drum' | 'sampler' | 'motion';

/**
 * Sentinel for an arrangement-chain "rest" slot: an always-empty bar. It lives
 * only in `ChainLane.steps` (never as an edit/play bank), so it is a value < 0
 * that `clampChainStep` preserves while `clampBankIn` still squashes it to a real
 * bank. See specs/features/arrangement-rest.md.
 */
export const REST = -1;

/** Clamp into `0..count-1`; a non-finite index is bank A (REQ-a-bank-index-is-always-a-bank).
 *  `count` is the owning machine's, never a constant. */
export function clampBankIn(i: number, count: number): number {
  return clampInt(i, 0, count - 1);
}

/**
 * Clamp an arrangement-chain step: the `REST` sentinel passes through untouched,
 * any other value is clamped to a real bank index. Used when ingesting chains
 * (arrangement setters, song import) so a rest survives while bad indices don't.
 *
 * `bankCount` is **required on purpose** (ADR-022). Defaulting it to
 * `MIN_BANK_COUNT` would let a lane-blind caller keep compiling and silently
 * squash a grown machine back to four — and `steps.map(clampChainStep)` would
 * quietly pass the array index as the count, which is wrong in a way that looks
 * plausible. Make every caller name the machine it means.
 */
export function clampChainStep(i: number, bankCount: number): number {
  return i === REST ? REST : clampBankIn(i, bankCount);
}

/** Clamp a bank count itself into the legal range; absent/garbage ⇒ the floor. */
export function clampBankCount(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return MIN_BANK_COUNT;
  return Math.max(MIN_BANK_COUNT, Math.min(MAX_BANK_COUNT, Math.floor(n)));
}

/** Per-machine bank counts, as `Song.apply` computes them and `restore` takes them. */
export type BankCounts = Partial<Record<Machine, number>>;

/** The highest bank index a chain names, or -1 for an empty/rest-only chain. */
export function highestChainBank(steps: readonly number[] | undefined): number {
  let hi = -1;
  for (const s of steps ?? []) {
    if (typeof s === 'number' && Number.isFinite(s) && s > hi) hi = Math.floor(s);
  }
  return hi;
}

/**
 * Clamp an arrangement-chain slot's transpose to a whole number of semitones
 * within `±MAX_CHAIN_TRANSPOSE` (arrangement.md REQ-a-seq-slot-carries-a-transpose).
 *
 * `Math.round` before the clamp, and a non-finite input floored to 0: the
 * app-wide `Math.max(min, Math.min(max, v))` idiom returns `NaN` for `NaN`
 * (untrusted-input.md REQ-no-subscriber-can-wedge-the-clock), and a `NaN` here would reach the oscillator as a
 * note offset.
 */
export function clampTranspose(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_CHAIN_TRANSPOSE, Math.min(MAX_CHAIN_TRANSPOSE, Math.round(n)));
}

/** One track's 16 steps. The default note ladder is the pre-v3 seeding. */
export function makeSeqTrack(): SeqStep[] {
  return Array.from({ length: SEQ_LENGTH }, (_, i) => ({
    on: false,
    note: 60 + (i % 8),
    velocity: 0.8,
    gate: 0.5,
    prob: 1,
    ratchet: 1,
    tie: false,
    micro: 0,
    bend: 0,
    bendShape: 'scoop',
  }));
}

/** One bank: SEQ_TRACK_COUNT tracks (sequencer.md REQ-four-tracks-per-bank). */
export function makeSeqBank(): SeqStep[][] {
  return Array.from({ length: SEQ_TRACK_COUNT }, makeSeqTrack);
}

export function makeDrumBank(): DrumCell[][] {
  return Array.from({ length: DRUM_TRACK_COUNT }, () =>
    Array.from({ length: SEQ_LENGTH }, () => ({ ...TRIGGER_CELL_DEFAULTS }))
  );
}

export function makeSamplerBank(): SamplerStep[][] {
  return Array.from({ length: SAMPLER_SLOT_COUNT }, () =>
    Array.from({ length: SEQ_LENGTH }, () => ({ ...TRIGGER_CELL_DEFAULTS }))
  );
}

export function makeMotionBank(): MotionStep[] {
  return Array.from({ length: SEQ_LENGTH }, () => ({ ...MOTION_STEP_DEFAULTS }));
}

/**
 * A full set of blank banks for every machine — what "New Song" restores and
 * what `PatternStore` boots with. Shares the per-machine builders above so a
 * blank bank can never drift between the two.
 */
export function emptyPatternBanks(count: number = MIN_BANK_COUNT): {
  seqBanks: SeqStep[][][];
  drumBanks: DrumCell[][][];
  samplerBanks: SamplerStep[][][];
  motionBanks: MotionStep[][];
  motionTracks: MotionTrack[][];
} {
  const n = clampBankCount(count);
  return {
    seqBanks: Array.from({ length: n }, makeSeqBank),
    drumBanks: Array.from({ length: n }, makeDrumBank),
    samplerBanks: Array.from({ length: n }, makeSamplerBank),
    motionBanks: Array.from({ length: n }, makeMotionBank),
    // Blank AND unassigned: a New Song that inherited the previous song's track
    // parameters would silently keep automating them.
    motionTracks: Array.from({ length: n }, makeMotionTracks),
  };
}

/**
 * A **complete** blank PatternStore snapshot — every optional section defined —
 * so `restore()` applies it authoritatively (an absent section can't slip through
 * `restore`'s skip-on-undefined and be inherited). This is the single source of
 * blank shared by New Song and the load path (`Song.apply`): both start here so an
 * authoritative clear can't drift between them (song-mode.md REQ-apply-resets-to-defaults-first). Extends
 * `emptyPatternBanks()` with the two per-slot/per-bank sections it omits.
 */
export function emptyPatternSnapshot(count: number = MIN_BANK_COUNT): {
  seqBanks: SeqStep[][][];
  drumBanks: DrumCell[][][];
  samplerBanks: SamplerStep[][][];
  sampleNames: (string | null)[];
  motionBanks: MotionStep[][];
  motionAssigns: (MotionAssign | null)[];
  motionTracks: MotionTrack[][];
} {
  const n = clampBankCount(count);
  return {
    ...emptyPatternBanks(n),
    sampleNames: Array(SAMPLER_SLOT_COUNT).fill(null),
    motionAssigns: Array(n).fill(null),
  };
}
