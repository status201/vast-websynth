import { assertIndex } from '../utils/array';
import { MAX_CHAIN_TRANSPOSE } from './limits';
import { GRID_CELLS } from './meter';

/**
 * Non-scalar state — step grids for the sequencer and drum machine.
 * Lives outside ParamBus because the shapes are arrays of objects.
 *
 * Each machine holds its own independent "banks" (A..H) — 4 by default and up
 * to MAX_BANK_COUNT, counted per machine, where the count IS the length of that
 * machine's array (banks.md REQ-a-machine-owns-its-bank-count, ADR-022). The UI
 * edits one bank per machine (the *edit* bank); the transport plays whichever
 * bank the Arrangement selects (which may differ when a chain lane is running).
 * Subscribers are notified on any mutation, whenever the edit bank changes
 * (every step re-emitted) and whenever a count changes.
 */
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

export interface SeqStep extends StepSettings {
  on: boolean;
  note: number;     // MIDI note
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
 *  `micro` joined them in v3 and is absent from every file written before it. */
export const SEQ_EXTRA_DEFAULTS = { prob: 1, ratchet: 1, tie: false, micro: 0 };

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
 * One step of an extra single-param motion track (motion-sequencer.md REQ-two-extra-tracks-per-bank).
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

/** Extra single-param tracks per motion bank (beyond the XY lane). */
export const MOTION_TRACK_COUNT = 2;
export const MOTION_TRACK_LABELS = ['A', 'B'];

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
 * Cells in one pattern grid.
 *
 * This used to mean three things at once — cells per pattern, ticks per bar, and
 * columns of UI — and every bar line in the app was written `step % SEQ_LENGTH`.
 * `meter.ts` now owns the other two (`barTicks`, `LANE_RATES`); this name is
 * kept, aliasing `GRID_CELLS`, purely because 17 modules import it. New code
 * should say which one it means (meter.md REQ-meter-ts-names-the-three-jobs, ADR-019).
 */
export const SEQ_LENGTH = GRID_CELLS;

/** Sequencer tracks per bank (sequencer.md REQ-four-tracks-per-bank). Track 0 is the pre-v3
 *  sequencer; 1..3 are the additions and only sound in poly voicing (REQ-song-file-v4-adds-motion-banks). */
export const SEQ_TRACK_COUNT = 4;
export const SEQ_TRACK_LABELS = ['1', '2', '3', '4'];

export const DRUM_TRACKS = ['Kick', 'Snare', 'C.Hat', 'O.Hat', 'L.Tom', 'M.Tom', 'H.Tom', 'Clap'] as const;
export const DRUM_TRACK_COUNT = DRUM_TRACKS.length;

export const SAMPLER_SLOT_COUNT = 8;
export const SAMPLER_SLOT_LABELS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

/**
 * Bank counts (banks.md REQ-a-machine-owns-its-bank-count, ADR-022).
 *
 * A machine always has at least MIN_BANK_COUNT banks and never more than
 * MAX_BANK_COUNT; the count *is* the length of that machine's bank array, so
 * there is no separate field to keep honest. Raising the ceiling is this one
 * line — everything below derives from it, and the literals that cannot
 * (the two published JSON schemas, llms.txt) are pinned to it by
 * `tests/state/authoring-docs.test.ts`.
 */
export const MIN_BANK_COUNT = 4;
export const MAX_BANK_COUNT = 8;

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
 * that `clampChainStep` preserves while `clampBank` still squashes it to a real
 * bank. See specs/features/arrangement-rest.md.
 */
export const REST = -1;

/**
 * Pre-state of one mutation-entry-point call, emitted via `onMutate` for the
 * undo layer (`specs/features/pattern-undo.md`). `before` is always a CLONE
 * taken before the write — the store mutates cells in place. `bank` is the
 * machine's edit bank at mutation time (mutations only touch the edit bank).
 * `restore()` bypasses the setters and never emits these.
 */
export type PatternMutation =
  | { kind: 'seq'; bank: number; track: number; index: number; before: SeqStep }
  | { kind: 'drum'; bank: number; track: number; step: number; before: DrumCell }
  | { kind: 'sampler'; bank: number; slot: number; step: number; before: SamplerStep }
  | { kind: 'motion'; bank: number; index: number; before: MotionStep }
  | { kind: 'motion-assign'; bank: number; before: MotionAssign | null }
  | { kind: 'motion-track'; bank: number; track: number; index: number; before: MotionTrackStep }
  | { kind: 'motion-track-param'; bank: number; track: number; before: string | undefined }
  | { kind: 'seq-copy'; bank: number; before: SeqStep[][] }
  | { kind: 'drum-copy'; bank: number; before: DrumCell[][] }
  | { kind: 'sampler-copy'; bank: number; before: SamplerStep[][] }
  | { kind: 'motion-copy'; bank: number; before: MotionStep[]; beforeAssign: MotionAssign | null;
      beforeTracks: MotionTrack[] };

export interface PatternSnapshot {
  /** [bank][track][step] since v3 (sequencer.md REQ-four-tracks-per-bank). */
  seqBanks: SeqStep[][][];
  drumBanks: DrumCell[][][];
  seqEditBank: number;
  drumEditBank: number;
  /** Optional so v1 song files (no sampler fields) still restore cleanly. */
  samplerBanks?: SamplerStep[][][];
  samplerEditBank?: number;
  sampleNames?: (string | null)[];
  /** Optional so v1-v3 song files (no motion fields) still restore cleanly. */
  motionBanks?: MotionStep[][];
  motionAssigns?: (MotionAssign | null)[];
  motionEditBank?: number;
  /** Optional so v1-v4 song files (no extra motion tracks) still restore cleanly. */
  motionTracks?: (MotionTrack | null)[][];
}

/** Clamp into `0..count-1`. `count` is the owning machine's, never a constant. */
function clampBankIn(i: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(i)));
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

/**
 * How long a machine's arrays should be after a restore.
 *
 * A section the snapshot omits leaves the machine's current length alone — that
 * is what keeps the sampler's documented inherit-across-a-load behaviour
 * (song-mode.md REQ-apply-resets-to-defaults-first) and what lets a v1 file's
 * `samplerChain` stay legal with no `samplerBanks` at all. `want` may still
 * RAISE an inherited length (a chain that names a bank past it) but never lower
 * it: the inherit is of the whole machine, count included, so a v1 file cannot
 * quietly destroy banks E..H of the kit it is deliberately keeping. A section that
 * IS present is authoritative — the longer of what arrived and what the caller
 * asked for, floored and capped.
 */
function sectionCount(
  section: { length: number } | undefined,
  want: number | undefined,
  current: number,
): number {
  return clampBankCount(Math.max(section?.length ?? current, want ?? MIN_BANK_COUNT));
}

/** The longest of several optional parallel sections, or undefined if all absent. */
function longest(...sections: ({ length: number } | undefined)[]): { length: number } | undefined {
  let best: { length: number } | undefined;
  for (const s of sections) if (s && (!best || s.length > best.length)) best = s;
  return best;
}

function sameCounts(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

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

export class PatternStore {
  /** seqBanks[bank][track][step] */
  readonly seqBanks: SeqStep[][][];
  /** drumBanks[bank][track][step] */
  readonly drumBanks: DrumCell[][][];
  /** samplerBanks[bank][slot][step] */
  readonly samplerBanks: SamplerStep[][][];
  /** motionBanks[bank][step] */
  readonly motionBanks: MotionStep[][];
  /** Per-bank axis override (null = inherit the XY Pad assignment). */
  readonly motionAssigns: (MotionAssign | null)[];
  /** motionTrackBanks[bank][track] — the extra single-param tracks (REQ-two-extra-tracks-per-bank). */
  readonly motionTrackBanks: MotionTrack[][];

  /** Filename per sampler slot (null = empty). Decoded audio lives in the
   *  audio layer (SamplerMachine), not here — only the name persists. */
  readonly sampleNames: (string | null)[] = Array(SAMPLER_SLOT_COUNT).fill(null);

  private _seqEdit = 0;
  private _drumEdit = 0;
  private _samplerEdit = 0;
  private _motionEdit = 0;

  private readonly seqListeners = new Set<(track: number, index: number, step: SeqStep) => void>();
  private readonly drumListeners = new Set<(track: number, step: number, cell: DrumCell) => void>();
  private readonly samplerListeners = new Set<(slot: number, step: number, cell: SamplerStep) => void>();
  private readonly seqBankListeners = new Set<(bank: readonly (readonly SeqStep[])[]) => void>();
  private readonly drumBankListeners = new Set<(bank: readonly (readonly DrumCell[])[]) => void>();
  private readonly samplerBankListeners = new Set<(bank: readonly (readonly SamplerStep[])[]) => void>();
  private readonly motionListeners = new Set<(index: number, step: MotionStep) => void>();
  private readonly motionBankListeners = new Set<(bank: readonly MotionStep[]) => void>();
  private readonly motionTrackListeners = new Set<(track: number, index: number) => void>();
  private readonly sampleMetaListeners = new Set<(slot: number, name: string | null) => void>();
  private readonly editBankListeners = new Set<() => void>();
  private readonly bankCountListeners = new Set<() => void>();
  private readonly bankDropListeners = new Set<(m: Machine, bank: number) => void>();
  private readonly mutateListeners = new Set<(m: PatternMutation) => void>();
  private readonly bulkRestoreListeners = new Set<() => void>();

  constructor() {
    this.seqBanks = Array.from({ length: MIN_BANK_COUNT }, makeSeqBank);
    this.drumBanks = Array.from({ length: MIN_BANK_COUNT }, makeDrumBank);
    this.samplerBanks = Array.from({ length: MIN_BANK_COUNT }, makeSamplerBank);
    this.motionBanks = Array.from({ length: MIN_BANK_COUNT }, makeMotionBank);
    this.motionAssigns = Array(MIN_BANK_COUNT).fill(null);
    this.motionTrackBanks = Array.from({ length: MIN_BANK_COUNT }, makeMotionTracks);

    // Seed a friendly default groove into drum bank A only
    // (basic 4-on-the-floor + offbeat hats + snare on 5/13).
    const d = this.drumBanks[0]!;
    d[0]![0]!.on = true; d[0]![4]!.on = true; d[0]![8]!.on = true; d[0]![12]!.on = true;
    d[1]![4]!.on = true; d[1]![12]!.on = true;
    for (let i = 2; i < SEQ_LENGTH; i += 4) d[2]![i]!.on = true;
  }

  // ---- Edit-bank selection (UI) ----

  get seqEditBank(): number { return this._seqEdit; }
  get drumEditBank(): number { return this._drumEdit; }
  get samplerEditBank(): number { return this._samplerEdit; }
  get motionEditBank(): number { return this._motionEdit; }

  /** Back-compat accessors: the bank currently being edited in the UI. */
  get seq(): SeqStep[][] { return this.seqBanks[this._seqEdit]!; }
  /** One track of the edit bank. */
  seqTrack(track: number): SeqStep[] | undefined { return this.seqBanks[this._seqEdit]?.[track]; }
  get drum(): DrumCell[][] { return this.drumBanks[this._drumEdit]!; }
  get sampler(): SamplerStep[][] { return this.samplerBanks[this._samplerEdit]!; }
  get motion(): MotionStep[] { return this.motionBanks[this._motionEdit]!; }

  // ---- Bank count, per machine (REQ-a-machine-owns-its-bank-count) ----

  get seqBankCount(): number { return this.seqBanks.length; }
  get drumBankCount(): number { return this.drumBanks.length; }
  get samplerBankCount(): number { return this.samplerBanks.length; }
  get motionBankCount(): number { return this.motionBanks.length; }

  /**
   * How many banks a machine has right now. The lane-keyed primitive the rest of
   * the count API is written against — `addBank` has to touch every parallel
   * array a machine owns, and four hand-written copies of that is how six
   * parallel arrays drift apart.
   */
  bankCount(m: Machine): number {
    switch (m) {
      case 'seq': return this.seqBanks.length;
      case 'drum': return this.drumBanks.length;
      case 'sampler': return this.samplerBanks.length;
      case 'motion': return this.motionBanks.length;
    }
  }

  canAddBank(m: Machine): boolean { return this.bankCount(m) < MAX_BANK_COUNT; }

  /** The four counts, for cheap before/after comparison across a restore. */
  private countsSnapshot(): [number, number, number, number] {
    return [this.seqBanks.length, this.drumBanks.length,
      this.samplerBanks.length, this.motionBanks.length];
  }

  private emitBankCount(): void {
    for (const l of this.bankCountListeners) l();
  }

  /** Re-clamp every edit cursor into its machine's current count. */
  private clampEditBanks(): void {
    this._seqEdit = clampBankIn(this._seqEdit, this.seqBanks.length);
    this._drumEdit = clampBankIn(this._drumEdit, this.drumBanks.length);
    this._samplerEdit = clampBankIn(this._samplerEdit, this.samplerBanks.length);
    this._motionEdit = clampBankIn(this._motionEdit, this.motionBanks.length);
  }

  /**
   * Grow or shrink a machine to exactly `n` banks, minting new banks from the
   * same builders a blank store boots with — never by retaining an old object,
   * which is what would let one song's banks survive into the next.
   */
  private resizeMachine(m: Machine, n: number): void {
    const grow = <T>(arr: T[], make: () => T): void => {
      while (arr.length < n) arr.push(make());
      if (arr.length > n) arr.length = n;
    };
    switch (m) {
      case 'seq': grow(this.seqBanks, makeSeqBank); break;
      case 'drum': grow(this.drumBanks, makeDrumBank); break;
      case 'sampler': grow(this.samplerBanks, makeSamplerBank); break;
      case 'motion':
        grow(this.motionBanks, makeMotionBank);
        grow(this.motionAssigns, () => null);
        grow(this.motionTrackBanks, makeMotionTracks);
        break;
    }
  }

  /**
   * Append one blank bank. Motion grows **three** arrays as one step — its
   * anchors, its per-bank axis override and its extra tracks — because a
   * half-resized motion machine is a crash one `motionTrackBanks[b]!` away.
   *
   * Deliberately emits no `PatternMutation`: minting a blank bank destroys
   * nothing, so there is nothing for undo to restore (REQ-a-bank-is-added-on-demand).
   */
  addBank(m: Machine): boolean {
    if (!this.canAddBank(m)) return false;
    switch (m) {
      case 'seq': this.seqBanks.push(makeSeqBank()); break;
      case 'drum': this.drumBanks.push(makeDrumBank()); break;
      case 'sampler': this.samplerBanks.push(makeSamplerBank()); break;
      case 'motion':
        this.motionBanks.push(makeMotionBank());
        this.motionAssigns.push(null);
        this.motionTrackBanks.push(makeMotionTracks());
        break;
    }
    this.emitBankCount();
    return true;
  }

  /**
   * Whether the machine's **highest** bank could be dropped: it must not be the
   * last of the mandatory floor, and it must be empty. The caller adds the third
   * condition — that no chain lane names it — because the chains live in
   * `Arrangement`, which owns this store rather than the other way round
   * (REQ-a-bank-is-removed-only-when-unused).
   */
  canRemoveBank(m: Machine): boolean {
    const n = this.bankCount(m);
    return n > MIN_BANK_COUNT && !this.bankHasContent(m, n - 1);
  }

  /** Does bank `i` of `m` hold anything? False for an index past the count. */
  bankHasContent(m: Machine, i: number): boolean {
    switch (m) {
      case 'seq':
        return (this.seqBanks[i] ?? []).some((track) => track.some((s) => s.on));
      case 'drum':
        return (this.drumBanks[i] ?? []).some((row) => row.some((c) => c.on));
      case 'sampler':
        return (this.samplerBanks[i] ?? []).some((row) => row.some((c) => c.on));
      case 'motion':
        return (this.motionBanks[i] ?? []).some((s) => s.on)
          || (this.motionTrackBanks[i] ?? []).some((t) => t.steps.some((s) => s.on));
    }
  }

  /**
   * Drop the machine's **highest** bank. Never any other one: every bank index
   * in the app — chain slots, undo entries, the edit cursors — is a bare
   * integer, so removing from the middle would renumber the banks above it and
   * silently rewrite every reference (ADR-022).
   *
   * An emptied bank can still be named by undo history (a clear is itself
   * undoable), so the stale entries are pruned here rather than left to restore
   * into a bank that no longer exists.
   */
  removeBank(m: Machine): boolean {
    if (!this.canRemoveBank(m)) return false;
    const gone = this.bankCount(m) - 1;
    // Was the user looking at the bank about to go? Then the cursor is about to
    // move, and a moved cursor owes the panel a re-emit — exactly what
    // setSeqEditBank does. `editBankListeners` alone repaints the BankBar's dots,
    // not the grid, so without this the step grid keeps painting the bank that no
    // longer exists (banks.md REQ-a-bank-is-removed-only-when-unused).
    const wasEditing = this.editBank(m) === gone;
    switch (m) {
      case 'seq': this.seqBanks.length = gone; break;
      case 'drum': this.drumBanks.length = gone; break;
      case 'sampler': this.samplerBanks.length = gone; break;
      case 'motion':
        this.motionBanks.length = gone;
        this.motionAssigns.length = gone;
        this.motionTrackBanks.length = gone;
        break;
    }
    this.clampEditBanks();
    if (wasEditing) this.emitBank(m);
    for (const l of this.bankDropListeners) l(m, gone);
    this.emitBankCount();
    for (const l of this.editBankListeners) l();
    return true;
  }

  /** That machine's edit cursor, lane-keyed like `bankCount`. */
  private editBank(m: Machine): number {
    switch (m) {
      case 'seq': return this._seqEdit;
      case 'drum': return this._drumEdit;
      case 'sampler': return this._samplerEdit;
      case 'motion': return this._motionEdit;
    }
  }

  /**
   * Re-emit one machine's edit bank, every step of it. Motion emits its extra
   * tracks too — the same pair `setMotionEditBank` sends, because a motion panel
   * paints three lanes and one signal only repaints one of them.
   */
  private emitBank(m: Machine): void {
    switch (m) {
      case 'seq': this.emitBankSeq(); break;
      case 'drum': this.emitBankDrum(); break;
      case 'sampler': this.emitBankSampler(); break;
      case 'motion': this.emitBankMotion(); this.emitAllMotionTracks(); break;
    }
  }

  /** Direct bank access (used by the transport for the *playing* bank). */
  seqBank(i: number): SeqStep[][] { return this.seqBanks[clampBankIn(i, this.seqBanks.length)]!; }
  drumBank(i: number): DrumCell[][] { return this.drumBanks[clampBankIn(i, this.drumBanks.length)]!; }
  samplerBank(i: number): SamplerStep[][] { return this.samplerBanks[clampBankIn(i, this.samplerBanks.length)]!; }
  motionBank(i: number): MotionStep[] { return this.motionBanks[clampBankIn(i, this.motionBanks.length)]!; }
  motionAssign(i: number): MotionAssign | null { return this.motionAssigns[clampBankIn(i, this.motionBanks.length)] ?? null; }
  /** A bank's extra tracks (the transport reads the *play* bank's). */
  motionTracks(i: number): MotionTrack[] { return this.motionTrackBanks[clampBankIn(i, this.motionBanks.length)]!; }
  /** One extra track of the *edit* bank (what the panel edits). */
  motionTrack(track: number): MotionTrack | undefined {
    return this.motionTrackBanks[this._motionEdit]?.[track];
  }

  setSeqEditBank(i: number): void {
    const n = clampBankIn(i, this.seqBanks.length);
    if (n === this._seqEdit) return;
    this._seqEdit = n;
    this.emitBankSeq();
    for (const l of this.editBankListeners) l();
  }

  setDrumEditBank(i: number): void {
    const n = clampBankIn(i, this.drumBanks.length);
    if (n === this._drumEdit) return;
    this._drumEdit = n;
    this.emitBankDrum();
    for (const l of this.editBankListeners) l();
  }

  setSamplerEditBank(i: number): void {
    const n = clampBankIn(i, this.samplerBanks.length);
    if (n === this._samplerEdit) return;
    this._samplerEdit = n;
    this.emitBankSampler();
    for (const l of this.editBankListeners) l();
  }

  setMotionEditBank(i: number): void {
    const n = clampBankIn(i, this.motionBanks.length);
    if (n === this._motionEdit) return;
    this._motionEdit = n;
    this.emitBankMotion();
    this.emitAllMotionTracks();
    for (const l of this.editBankListeners) l();
  }

  // ---- Mutations (operate on the edit bank) ----

  setSeqStep(track: number, index: number, patch: Partial<SeqStep>): void {
    const s = this.seqBanks[this._seqEdit]?.[track]?.[index];
    if (!s) return;
    this.emitMutate(() => ({ kind: 'seq', bank: this._seqEdit, track, index, before: { ...s } }));
    Object.assign(s, patch);
    for (const l of this.seqListeners) l(track, index, s);
  }

  /**
   * Write `notes` down the tracks at one step index — the chord writer's one mutation
   * (chord-tools.md REQ-the-chord-writer-patches-not-replaces/REQ-one-chord-gesture-one-undo).
   *
   * Takes **plain notes**, never a scale or a degree: the theory lives in
   * `utils/music.ts` and the caller applies it, so the store stays a data store
   * (ADR-004) and this is testable without a key (REQ-motion-drives-the-xy-assignment).
   *
   * Only `on` and `note` are written, so a chord dropped onto shaped steps keeps their
   * velocity/gate/prob/ratchet/tie/micro. Tracks past `notes.length` are switched **off**
   * rather than left alone — otherwise a triad written over a 7th would leave the old
   * seventh ringing underneath it.
   */
  writeSeqChord(index: number, notes: readonly number[]): boolean {
    const bank = this.seqBanks[this._seqEdit];
    if (!bank || notes.length === 0) return false;
    if (index < 0 || index >= SEQ_LENGTH) return false;
    // One entry for the whole gesture, so a chord costs one Ctrl+Z, not four.
    this.emitMutate(() => ({
      kind: 'seq-copy', bank: this._seqEdit,
      before: bank.map((row) => row.map((s) => ({ ...s }))),
    }));
    for (let t = 0; t < bank.length; t++) {
      const s = bank[t]?.[index];
      if (!s) continue;
      const note = notes[t];
      if (note === undefined) {
        if (!s.on) continue;
        s.on = false;
      } else {
        s.on = true;
        s.note = note;
      }
      for (const l of this.seqListeners) l(t, index, s);
    }
    return true;
  }

  /**
   * Rewrite every stored note in the edit bank through `map` — the destructive
   * counterpart of the live key filter (scale-quantization.md REQ-snap-to-scale-is-the-destructive-opt-in).
   *
   * `map` is a plain function for the same reason as above: no music theory in here.
   * Returns false when nothing moved, so the caller can report "already in key"
   * instead of pushing an undo entry that would restore identical data.
   */
  snapSeqBank(map: (note: number) => number): boolean {
    const bank = this.seqBanks[this._seqEdit];
    if (!bank) return false;
    const changed = bank.some((row) => row.some((s) => map(s.note) !== s.note));
    if (!changed) return false;
    this.emitMutate(() => ({
      kind: 'seq-copy', bank: this._seqEdit,
      before: bank.map((row) => row.map((s) => ({ ...s }))),
    }));
    for (let t = 0; t < bank.length; t++) {
      const row = bank[t]!;
      for (let i = 0; i < row.length; i++) {
        const s = row[i]!;
        const next = map(s.note);
        if (next === s.note) continue;
        s.note = next;
        for (const l of this.seqListeners) l(t, i, s);
      }
    }
    return true;
  }

  setDrumCell(track: number, step: number, patch: Partial<DrumCell>): void {
    const cell = this.drumBanks[this._drumEdit]?.[track]?.[step];
    if (!cell) return;
    this.emitMutate(() => ({ kind: 'drum', bank: this._drumEdit, track, step, before: { ...cell } }));
    Object.assign(cell, patch);
    for (const l of this.drumListeners) l(track, step, cell);
  }

  setSamplerCell(slot: number, step: number, patch: Partial<SamplerStep>): void {
    const cell = this.samplerBanks[this._samplerEdit]?.[slot]?.[step];
    if (!cell) return;
    this.emitMutate(() => ({ kind: 'sampler', bank: this._samplerEdit, slot, step, before: { ...cell } }));
    Object.assign(cell, patch);
    for (const l of this.samplerListeners) l(slot, step, cell);
  }

  setMotionStep(index: number, patch: Partial<MotionStep>): void {
    const s = this.motionBanks[this._motionEdit]?.[index];
    if (!s) return;
    this.emitMutate(() => ({ kind: 'motion', bank: this._motionEdit, index, before: { ...s } }));
    Object.assign(s, patch);
    for (const l of this.motionListeners) l(index, s);
  }

  setMotionTrackStep(track: number, index: number, patch: Partial<MotionTrackStep>): void {
    const s = this.motionTrackBanks[this._motionEdit]?.[track]?.steps?.[index];
    if (!s) return;
    this.emitMutate(() => ({
      kind: 'motion-track', bank: this._motionEdit, track, index, before: { ...s },
    }));
    Object.assign(s, patch);
    for (const l of this.motionTrackListeners) l(track, index);
  }

  /** Choose (or clear) the parameter an extra track drives, for the edit bank. */
  setMotionTrackParam(track: number, param: string | null): void {
    const t = this.motionTrackBanks[this._motionEdit]?.[track];
    if (!t) return;
    this.emitMutate(() => ({
      kind: 'motion-track-param', bank: this._motionEdit, track, before: t.param,
    }));
    if (param) t.param = param;
    else delete t.param;
    for (const l of this.motionTrackListeners) l(track, -1);
  }

  /** Clear one extra track's anchors (its param choice is configuration, kept —
   *  same rule as the axis override). */
  clearMotionTrack(track: number): boolean {
    return this.clearMotionCells(false, [track]);
  }

  /** Clear the XY lane's anchors only, leaving the extra tracks alone. */
  clearMotionXy(): boolean {
    return this.clearMotionCells(true, []);
  }

  /** Set/clear the edit bank's axis override; repaints via the bank listeners. */
  setMotionAssign(assign: MotionAssign | null): void {
    this.emitMutate(() => {
      const prev = this.motionAssigns[this._motionEdit] ?? null;
      return { kind: 'motion-assign', bank: this._motionEdit, before: prev ? { ...prev } : null };
    });
    this.motionAssigns[this._motionEdit] = assign && (assign.x || assign.y) ? { ...assign } : null;
    this.emitBankMotion();
  }

  setSampleName(slot: number, name: string | null): void {
    if (slot < 0 || slot >= SAMPLER_SLOT_COUNT) return;
    this.sampleNames[slot] = name;
    for (const l of this.sampleMetaListeners) l(slot, name);
  }

  // ---- Bulk clears (step-grid-editing.md REQ-clear-menu-clears-in-bulk/REQ-one-bulk-action-one-undo-entry) ----
  //
  // Each emits exactly ONE `*-copy` mutation carrying a clone of the whole
  // pre-clear bank, so a single Undo press restores everything — emitting N
  // per-cell mutations would cost N undo presses to reverse one click. Only
  // `on` is reset (REQ-set-steps-are-anchors): a cleared step keeps its note/velocity/gate, so
  // re-toggling it restores the step exactly. Each returns whether anything
  // changed, so a caller can skip the toast on an already-empty bank.

  clearSeqBank(): boolean {
    return this.clearSeqCells(null);
  }

  clearSeqTrack(track: number): boolean {
    return this.clearSeqCells(track);
  }

  /** `track === null` clears every track of the edit bank; the mutation is
   *  whole-bank either way, so one undo kind covers both scopes (REQ-both-motion-modes-share-one-frame-loop). */
  private clearSeqCells(track: number | null): boolean {
    const bank = this.seqBanks[this._seqEdit]!;
    const rows = track === null ? [...bank.keys()] : [track];
    const touched = rows.filter((t) => bank[t]?.some((s) => s.on));
    if (touched.length === 0) return false;
    this.emitMutate(() => ({
      kind: 'seq-copy', bank: this._seqEdit,
      before: bank.map((row) => row.map((s) => ({ ...s }))),
    }));
    for (const t of touched) {
      const row = assertIndex(bank, t, 'seqTracks');
      for (let i = 0; i < row.length; i++) {
        const s = assertIndex(row, i, 'seqSteps');
        if (!s.on) continue;
        s.on = false;
        for (const l of this.seqListeners) l(t, i, s);
      }
    }
    return true;
  }

  clearDrumBank(): boolean {
    return this.clearDrumCells(null);
  }

  clearDrumTrack(track: number): boolean {
    return this.clearDrumCells(track);
  }

  clearSamplerBank(): boolean {
    return this.clearSamplerCells(null);
  }

  clearSamplerSlot(slot: number): boolean {
    return this.clearSamplerCells(slot);
  }

  /**
   * Clear the edit bank's anchors. The bank's axis **override** is deliberately
   * kept — it is configuration, not step data — and passing it as `beforeAssign`
   * means undo restores it unchanged rather than resurrecting a stale one.
   */
  clearMotionBank(): boolean {
    // The whole bank means every lane — the XY anchors AND both extra tracks —
    // matching what "Clear bank" does on the drum and sampler grids.
    return this.clearMotionCells(
      true, Array.from({ length: MOTION_TRACK_COUNT }, (_, t) => t));
  }

  /**
   * The one motion clear (step-grid-editing.md REQ-one-bulk-action-one-undo-entry): whichever lanes are
   * named, cleared under a SINGLE `motion-copy` mutation carrying the whole
   * pre-clear bank — anchors, axis override and both tracks — so one Undo
   * press restores everything however narrow the clear was. Only `on` is reset
   * (REQ-set-steps-are-anchors) and the axis override / track params survive: they are
   * configuration, not step data.
   */
  private clearMotionCells(xy: boolean, tracks: readonly number[]): boolean {
    const b = this._motionEdit;
    const bank = this.motionBanks[b]!;
    const trackBanks = this.motionTrackBanks[b]!;
    const hitXy = xy && bank.some((s) => s.on);
    const hitTracks = tracks.filter((t) => trackBanks[t]?.steps.some((s) => s.on));
    if (!hitXy && hitTracks.length === 0) return false;

    const assign = this.motionAssigns[b] ?? null;
    this.emitMutate(() => ({
      kind: 'motion-copy',
      bank: b,
      before: bank.map((s) => ({ ...s })),
      beforeAssign: assign ? { ...assign } : null,
      beforeTracks: cloneMotionTracks(trackBanks),
    }));

    if (hitXy) {
      for (let i = 0; i < bank.length; i++) {
        const s = assertIndex(bank, i, 'motionSteps');
        if (!s.on) continue;
        s.on = false;
        for (const l of this.motionListeners) l(i, s);
      }
    }
    for (const t of hitTracks) {
      const steps = assertIndex(trackBanks, t, 'motionTracks').steps;
      for (let i = 0; i < steps.length; i++) {
        const s = assertIndex(steps, i, 'motionTrackSteps');
        if (!s.on) continue;
        s.on = false;
        for (const l of this.motionTrackListeners) l(t, i);
      }
    }
    return true;
  }

  /** `track === null` clears the whole bank; the mutation is whole-bank either
   *  way, so one undo kind per machine covers both scopes (REQ-both-motion-modes-share-one-frame-loop). */
  private clearDrumCells(track: number | null): boolean {
    const bank = this.drumBanks[this._drumEdit]!;
    const rows = track === null ? bank.keys() : [track];
    const touched = [...rows].filter((t) => bank[t]?.some((c) => c.on));
    if (touched.length === 0) return false;
    this.emitMutate(() => ({
      kind: 'drum-copy',
      bank: this._drumEdit,
      before: bank.map((row) => row.map((c) => ({ ...c }))),
    }));
    for (const t of touched) {
      const row = assertIndex(bank, t, 'drumTracks');
      for (let s = 0; s < row.length; s++) {
        const cell = assertIndex(row, s, 'drumCells');
        if (!cell.on) continue;
        cell.on = false;
        for (const l of this.drumListeners) l(t, s, cell);
      }
    }
    return true;
  }

  private clearSamplerCells(slot: number | null): boolean {
    const bank = this.samplerBanks[this._samplerEdit]!;
    const rows = slot === null ? bank.keys() : [slot];
    const touched = [...rows].filter((sl) => bank[sl]?.some((c) => c.on));
    if (touched.length === 0) return false;
    this.emitMutate(() => ({
      kind: 'sampler-copy',
      bank: this._samplerEdit,
      before: bank.map((row) => row.map((c) => ({ ...c }))),
    }));
    for (const sl of touched) {
      const row = assertIndex(bank, sl, 'samplerTracks');
      for (let s = 0; s < row.length; s++) {
        const cell = assertIndex(row, s, 'samplerCells');
        if (!cell.on) continue;
        cell.on = false;
        for (const l of this.samplerListeners) l(sl, s, cell);
      }
    }
    return true;
  }

  copySeqBank(from: number, to: number): void {
    const n = this.seqBanks.length;
    const a = clampBankIn(from, n), b = clampBankIn(to, n);
    if (a === b) return;
    const src = assertIndex(this.seqBanks, a, 'seqBanks');
    const dst = assertIndex(this.seqBanks, b, 'seqBanks');
    this.emitMutate(() => ({ kind: 'seq-copy', bank: b, before: dst.map((row) => row.map((s) => ({ ...s }))) }));
    for (let t = 0; t < dst.length; t++) {
      const srcRow = assertIndex(src, t, 'seqTracks');
      const dstRow = assertIndex(dst, t, 'seqTracks');
      for (let i = 0; i < dstRow.length; i++) Object.assign(assertIndex(dstRow, i, 'seqSteps'), assertIndex(srcRow, i, 'seqSteps'));
    }
    if (b === this._seqEdit) this.emitBankSeq();
  }

  copyDrumBank(from: number, to: number): void {
    const n = this.drumBanks.length;
    const a = clampBankIn(from, n), b = clampBankIn(to, n);
    if (a === b) return;
    const src = assertIndex(this.drumBanks, a, 'drumBanks');
    const dst = assertIndex(this.drumBanks, b, 'drumBanks');
    this.emitMutate(() => ({ kind: 'drum-copy', bank: b, before: dst.map((row) => row.map((c) => ({ ...c }))) }));
    for (let t = 0; t < dst.length; t++) {
      const srcRow = assertIndex(src, t, 'drumTracks');
      const dstRow = assertIndex(dst, t, 'drumTracks');
      for (let s = 0; s < dstRow.length; s++) Object.assign(assertIndex(dstRow, s, 'drumCells'), assertIndex(srcRow, s, 'drumCells'));
    }
    if (b === this._drumEdit) this.emitBankDrum();
  }

  copySamplerBank(from: number, to: number): void {
    const n = this.samplerBanks.length;
    const a = clampBankIn(from, n), b = clampBankIn(to, n);
    if (a === b) return;
    const src = assertIndex(this.samplerBanks, a, 'samplerBanks');
    const dst = assertIndex(this.samplerBanks, b, 'samplerBanks');
    this.emitMutate(() => ({ kind: 'sampler-copy', bank: b, before: dst.map((row) => row.map((c) => ({ ...c }))) }));
    for (let t = 0; t < dst.length; t++) {
      const srcRow = assertIndex(src, t, 'samplerTracks');
      const dstRow = assertIndex(dst, t, 'samplerTracks');
      for (let s = 0; s < dstRow.length; s++) Object.assign(assertIndex(dstRow, s, 'samplerCells'), assertIndex(srcRow, s, 'samplerCells'));
    }
    if (b === this._samplerEdit) this.emitBankSampler();
  }

  copyMotionBank(from: number, to: number): void {
    const n = this.motionBanks.length;
    const a = clampBankIn(from, n), b = clampBankIn(to, n);
    if (a === b) return;
    const src = assertIndex(this.motionBanks, a, 'motionBanks');
    const dst = assertIndex(this.motionBanks, b, 'motionBanks');
    this.emitMutate(() => {
      const prevAssign = this.motionAssigns[b] ?? null;
      return {
        kind: 'motion-copy', bank: b,
        before: dst.map((s) => ({ ...s })),
        beforeAssign: prevAssign ? { ...prevAssign } : null,
        beforeTracks: cloneMotionTracks(this.motionTrackBanks[b]!),
      };
    });
    for (let i = 0; i < dst.length; i++) Object.assign(assertIndex(dst, i, 'motionSteps'), assertIndex(src, i, 'motionSteps'));
    const srcAssign = this.motionAssigns[a] ?? null;
    this.motionAssigns[b] = srcAssign ? { ...srcAssign } : null;
    // The extra tracks travel with the bank, params included (REQ-two-extra-tracks-per-bank): copying a
    // bank you just built must not mean re-picking every parameter.
    this.motionTrackBanks[b] = cloneMotionTracks(this.motionTrackBanks[a]!);
    if (b === this._motionEdit) { this.emitBankMotion(); this.emitAllMotionTracks(); }
  }

  // ---- Subscriptions ----

  onSeqChange(fn: (track: number, index: number, step: SeqStep) => void): () => void {
    this.seqListeners.add(fn);
    return () => { this.seqListeners.delete(fn); };
  }

  onDrumChange(fn: (track: number, step: number, cell: DrumCell) => void): () => void {
    this.drumListeners.add(fn);
    return () => { this.drumListeners.delete(fn); };
  }

  onSamplerChange(fn: (slot: number, step: number, cell: SamplerStep) => void): () => void {
    this.samplerListeners.add(fn);
    return () => { this.samplerListeners.delete(fn); };
  }

  onSampleMetaChange(fn: (slot: number, name: string | null) => void): () => void {
    this.sampleMetaListeners.add(fn);
    return () => { this.sampleMetaListeners.delete(fn); };
  }

  /**
   * Fires when any machine's bank count changes — an add, a remove, or a song
   * load that resized one. Deliberately **separate** from `onEditBankChange`:
   * the `BankBar` rebuilds its letter row on this, and the edit-bank signal
   * fires on every bank click, which would tear the row down mid-gesture and
   * take the copy-armed state with it (banks.md REQ-a-machine-owns-its-bank-count).
   */
  onBankCountChange(fn: () => void): () => void {
    this.bankCountListeners.add(fn);
    return () => { this.bankCountListeners.delete(fn); };
  }

  /**
   * Fires with the machine and index of a bank that has just been removed, so
   * the undo layer can drop entries naming it (REQ-a-bank-is-removed-only-when-unused).
   * A removed bank is always the highest one, so no surviving index shifts.
   */
  onBankDrop(fn: (m: Machine, bank: number) => void): () => void {
    this.bankDropListeners.add(fn);
    return () => { this.bankDropListeners.delete(fn); };
  }

  onEditBankChange(fn: () => void): () => void {
    this.editBankListeners.add(fn);
    return () => { this.editBankListeners.delete(fn); };
  }

  /**
   * Pre-state of every mutation-entry-point call (the undo capture hook —
   * pattern-undo.md REQ-capture-happens-at-the-mutation-entry). `restore()` and `setSampleName` never emit.
   */
  onMutate(fn: (m: PatternMutation) => void): () => void {
    this.mutateListeners.add(fn);
    return () => { this.mutateListeners.delete(fn); };
  }

  /** Fires at the start of `restore()` — a whole-store overwrite (song load). */
  onBulkRestore(fn: () => void): () => void {
    this.bulkRestoreListeners.add(fn);
    return () => { this.bulkRestoreListeners.delete(fn); };
  }

  /** Emit a mutation record; `make` runs (and clones) only when someone listens. */
  private emitMutate(make: () => PatternMutation): void {
    if (this.mutateListeners.size === 0) return;
    const m = make();
    for (const l of this.mutateListeners) l(m);
  }

  /** Fires once when the active edit bank changes (not per-cell). */
  onSeqBankChange(fn: (bank: readonly (readonly SeqStep[])[]) => void): () => void {
    this.seqBankListeners.add(fn);
    return () => { this.seqBankListeners.delete(fn); };
  }

  onDrumBankChange(fn: (bank: readonly (readonly DrumCell[])[]) => void): () => void {
    this.drumBankListeners.add(fn);
    return () => { this.drumBankListeners.delete(fn); };
  }

  onSamplerBankChange(fn: (bank: readonly (readonly SamplerStep[])[]) => void): () => void {
    this.samplerBankListeners.add(fn);
    return () => { this.samplerBankListeners.delete(fn); };
  }

  onMotionChange(fn: (index: number, step: MotionStep) => void): () => void {
    this.motionListeners.add(fn);
    return () => { this.motionListeners.delete(fn); };
  }

  onMotionBankChange(fn: (bank: readonly MotionStep[]) => void): () => void {
    this.motionBankListeners.add(fn);
    return () => { this.motionBankListeners.delete(fn); };
  }

  /** An extra track changed. `index` is the step, or -1 for a param change. */
  onMotionTrackChange(fn: (track: number, index: number) => void): () => void {
    this.motionTrackListeners.add(fn);
    return () => { this.motionTrackListeners.delete(fn); };
  }

  /** Repaint every extra-track cell (bank switch / restore / copy). */
  private emitAllMotionTracks(): void {
    for (let t = 0; t < MOTION_TRACK_COUNT; t++) {
      for (const l of this.motionTrackListeners) l(t, -1);
    }
  }

  private emitBankSeq(): void {
    const bank = assertIndex(this.seqBanks, this._seqEdit, 'seqBanks');
    for (const l of this.seqBankListeners) l(bank);
  }

  private emitBankDrum(): void {
    const bank = assertIndex(this.drumBanks, this._drumEdit, 'drumBanks');
    for (const l of this.drumBankListeners) l(bank);
  }

  private emitBankSampler(): void {
    const bank = assertIndex(this.samplerBanks, this._samplerEdit, 'samplerBanks');
    for (const l of this.samplerBankListeners) l(bank);
  }

  private emitBankMotion(): void {
    const bank = assertIndex(this.motionBanks, this._motionEdit, 'motionBanks');
    for (const l of this.motionBankListeners) l(bank);
  }

  // ---- Serialisation (used by Song save/load) ----

  snapshot(): PatternSnapshot {
    return {
      seqBanks: this.seqBanks.map((bk) => bk.map((row) => row.map((s) => ({ ...s })))),
      drumBanks: this.drumBanks.map((bk) => bk.map((row) => row.map((c) => ({ ...c })))),
      seqEditBank: this._seqEdit,
      drumEditBank: this._drumEdit,
      samplerBanks: this.samplerBanks.map((bk) => bk.map((row) => row.map((c) => ({ ...c })))),
      samplerEditBank: this._samplerEdit,
      sampleNames: [...this.sampleNames],
      motionBanks: this.motionBanks.map((b) => b.map((s) => ({ ...s }))),
      motionAssigns: this.motionAssigns.map((a) => (a ? { ...a } : null)),
      motionEditBank: this._motionEdit,
      motionTracks: this.motionTrackBanks.map(cloneMotionTracks),
    };
  }

  /**
   * Overwrite the whole store from a snapshot.
   *
   * `counts` lets the caller size a machine **above** what its incoming array
   * carries — `Song.apply` uses it so a chain naming a bank the file omits grows
   * the machine instead of clamping (REQ-a-chain-reference-grows-the-machine).
   * It can only raise the floor, never truncate below the incoming data.
   *
   * Every section is applied **authoritatively**: a bank, row or cell the
   * snapshot omits comes back blank rather than lingering from the previous song
   * (REQ-an-omitted-bank-restores-blank). With a fixed bank count that was merely
   * latent; once lengths vary, loading a four-bank song after an eight-bank one
   * would otherwise leave E..H holding the last song's patterns.
   */
  restore(snap: Partial<PatternSnapshot>, counts?: BankCounts): void {
    // A whole-store overwrite: undo stacks must drop their (now stale) history
    // before the new state lands (pattern-undo.md REQ-restore-fires-a-bulk-hook).
    for (const l of this.bulkRestoreListeners) l();

    // Size every machine BEFORE filling it, so the fill loops can run over the
    // destination and stay authoritative.
    const before = this.countsSnapshot();
    this.resizeMachine('seq', sectionCount(snap.seqBanks, counts?.seq, this.seqBanks.length));
    this.resizeMachine('drum', sectionCount(snap.drumBanks, counts?.drum, this.drumBanks.length));
    this.resizeMachine('sampler',
      sectionCount(snap.samplerBanks, counts?.sampler, this.samplerBanks.length));
    // Motion's three parallel arrays are sized as ONE step from the longest of
    // them: `restore` is public and takes a Partial, so motionTracks can arrive
    // without motionBanks, and independent resizes would desync them.
    this.resizeMachine('motion', sectionCount(
      longest(snap.motionBanks, snap.motionTracks, snap.motionAssigns),
      counts?.motion, this.motionBanks.length));

    // Legacy files may lack the newer per-step fields — spread defaults first
    // so a load resets anything the incoming cell doesn't carry.
    if (snap.seqBanks) {
      for (let b = 0; b < this.seqBanks.length; b++) {
        const incoming = snap.seqBanks[b];
        const bank = assertIndex(this.seqBanks, b, 'seqBanks');
        for (let t = 0; t < bank.length; t++) {
          const row = incoming?.[t];
          const rowDst = assertIndex(bank, t, 'seqTracks');
          for (let i = 0; i < rowDst.length; i++) {
            const step = row?.[i];
            // Authoritative like the other machines: a track absent from the
            // snapshot (every v1-v5 file has only track 0) resets to blank
            // rather than lingering from the previous song.
            Object.assign(assertIndex(rowDst, i, 'seqSteps'),
              makeSeqTrack()[i]!, SEQ_EXTRA_DEFAULTS, step ?? {});
          }
        }
      }
    }
    if (snap.drumBanks) {
      for (let b = 0; b < this.drumBanks.length; b++) {
        const incoming = snap.drumBanks[b];
        const bank = assertIndex(this.drumBanks, b, 'drumBanks');
        for (let t = 0; t < bank.length; t++) {
          const row = incoming?.[t];
          const rowDst = assertIndex(bank, t, 'drumTracks');
          for (let s = 0; s < rowDst.length; s++) {
            // `?? {}` rather than `if (cell)`: an omitted row or cell must reset
            // to the defaults, not keep the previous song's hit.
            Object.assign(assertIndex(rowDst, s, 'drumCells'), TRIGGER_CELL_DEFAULTS, row?.[s] ?? {});
          }
        }
      }
    }
    if (snap.samplerBanks) {
      for (let b = 0; b < this.samplerBanks.length; b++) {
        const incoming = snap.samplerBanks[b];
        const bank = assertIndex(this.samplerBanks, b, 'samplerBanks');
        for (let t = 0; t < bank.length; t++) {
          const row = incoming?.[t];
          const rowDst = assertIndex(bank, t, 'samplerTracks');
          for (let s = 0; s < rowDst.length; s++) {
            Object.assign(assertIndex(rowDst, s, 'samplerCells'), TRIGGER_CELL_DEFAULTS, row?.[s] ?? {});
          }
        }
      }
    }
    if (snap.motionBanks) {
      for (let b = 0; b < this.motionBanks.length; b++) {
        const incoming = snap.motionBanks[b];
        const bank = assertIndex(this.motionBanks, b, 'motionBanks');
        for (let i = 0; i < bank.length; i++) {
          Object.assign(assertIndex(bank, i, 'motionSteps'), MOTION_STEP_DEFAULTS, incoming?.[i] ?? {});
        }
      }
    }
    if (snap.motionTracks) {
      for (let b = 0; b < this.motionTrackBanks.length; b++) {
        const incoming = snap.motionTracks[b];
        const dst = assertIndex(this.motionTrackBanks, b, 'motionTrackBanks');
        for (let t = 0; t < MOTION_TRACK_COUNT; t++) {
          const src = incoming?.[t] ?? null;
          const track = assertIndex(dst, t, 'motionTracks');
          // Authoritative like the rest of restore: a track absent from the file
          // comes back blank and unassigned rather than lingering from the
          // previous song (REQ-song-file-v5-adds-motion-tracks — v1-v4 files have none at all).
          if (src?.param) track.param = src.param;
          else delete track.param;
          for (let i = 0; i < track.steps.length; i++) {
            const cell = src?.steps?.[i];
            Object.assign(assertIndex(track.steps, i, 'motionTrackSteps'),
              MOTION_TRACK_STEP_DEFAULTS, cell ?? {});
          }
        }
      }
    }
    if (snap.motionAssigns) {
      for (let b = 0; b < this.motionAssigns.length; b++) {
        const a = snap.motionAssigns[b];
        this.motionAssigns[b] = a && (a.x || a.y) ? { ...a } : null;
      }
    }
    if (snap.sampleNames) {
      for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) {
        this.sampleNames[i] = snap.sampleNames[i] ?? null;
      }
    }
    // Unconditional, and AFTER the resize. The conditional form this replaces
    // never ran on the load path at all — a SongFile carries no edit banks, so
    // `Song.apply` never passes one — which meant a cursor parked on a high bank
    // survived a load into a shorter song and then indexed past the array on the
    // next read (REQ-an-omitted-bank-restores-blank).
    this._seqEdit = clampBankIn(snap.seqEditBank ?? this._seqEdit, this.seqBanks.length);
    this._drumEdit = clampBankIn(snap.drumEditBank ?? this._drumEdit, this.drumBanks.length);
    this._samplerEdit = clampBankIn(snap.samplerEditBank ?? this._samplerEdit, this.samplerBanks.length);
    this._motionEdit = clampBankIn(snap.motionEditBank ?? this._motionEdit, this.motionBanks.length);
    if (!sameCounts(before, this.countsSnapshot())) this.emitBankCount();
    // Repaint whatever bank is now selected for editing.
    this.emitBankSeq();
    this.emitBankDrum();
    this.emitBankSampler();
    this.emitBankMotion();
    this.emitAllMotionTracks();
    for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) {
      for (const l of this.sampleMetaListeners) l(i, this.sampleNames[i] ?? null);
    }
    for (const l of this.editBankListeners) l();
  }
}
