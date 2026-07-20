import { assertIndex } from '../utils/array';

/**
 * Non-scalar state — step grids for the sequencer and drum machine.
 * Lives outside ParamBus because the shapes are arrays of objects.
 *
 * The sequencer and the drum machine each have BANK_COUNT independent
 * "banks" (A/B/C/D). The UI edits one bank per machine (the *edit* bank);
 * the transport plays whichever bank the Arrangement selects (which may
 * differ when a chain lane is running). Subscribers are notified on any
 * mutation and whenever the edit bank changes (every step re-emitted).
 */
/** Per-step settings shared by all three machines (seq / drum / sampler). */
export interface StepSettings {
  velocity: number; // 0..1
  gate: number;     // 0..1 of one step duration (drum/sampler: 1 = let ring, <1 chokes)
  prob: number;     // 0..1 chance to fire (1 = always)
  ratchet: number;  // 1..4 sub-hits within the step
  tie: boolean;     // hold into the next step (seq: legato/slide; drum/sampler: skip the choke)
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
  on: false, velocity: 0.85, gate: 1, prob: 1, ratchet: 1, tie: false,
};

/** Seq fields that v1 song files may lack (on/note/velocity/gate were always present). */
export const SEQ_EXTRA_DEFAULTS = { prob: 1, ratchet: 1, tie: false };

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

export const SEQ_LENGTH = 16;

export const DRUM_TRACKS = ['Kick', 'Snare', 'C.Hat', 'O.Hat', 'L.Tom', 'M.Tom', 'H.Tom', 'Clap'] as const;
export const DRUM_TRACK_COUNT = DRUM_TRACKS.length;

export const SAMPLER_SLOT_COUNT = 8;
export const SAMPLER_SLOT_LABELS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

export const BANK_COUNT = 4;
export const BANK_LABELS = ['A', 'B', 'C', 'D'];

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
  | { kind: 'seq'; bank: number; index: number; before: SeqStep }
  | { kind: 'drum'; bank: number; track: number; step: number; before: DrumCell }
  | { kind: 'sampler'; bank: number; slot: number; step: number; before: SamplerStep }
  | { kind: 'motion'; bank: number; index: number; before: MotionStep }
  | { kind: 'motion-assign'; bank: number; before: MotionAssign | null }
  | { kind: 'seq-copy'; bank: number; before: SeqStep[] }
  | { kind: 'drum-copy'; bank: number; before: DrumCell[][] }
  | { kind: 'sampler-copy'; bank: number; before: SamplerStep[][] }
  | { kind: 'motion-copy'; bank: number; before: MotionStep[]; beforeAssign: MotionAssign | null };

export interface PatternSnapshot {
  seqBanks: SeqStep[][];
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
}

function clampBank(i: number): number {
  return Math.max(0, Math.min(BANK_COUNT - 1, Math.round(i)));
}

/**
 * Clamp an arrangement-chain step: the `REST` sentinel passes through untouched,
 * any other value is clamped to a real bank index. Used when ingesting chains
 * (arrangement setters, song import) so a rest survives while bad indices don't.
 */
export function clampChainStep(i: number): number {
  return i === REST ? REST : clampBank(i);
}

export function makeSeqBank(): SeqStep[] {
  return Array.from({ length: SEQ_LENGTH }, (_, i) => ({
    on: false,
    note: 60 + (i % 8),
    velocity: 0.8,
    gate: 0.5,
    prob: 1,
    ratchet: 1,
    tie: false,
  }));
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
export function emptyPatternBanks(): {
  seqBanks: SeqStep[][];
  drumBanks: DrumCell[][][];
  samplerBanks: SamplerStep[][][];
  motionBanks: MotionStep[][];
} {
  return {
    seqBanks: Array.from({ length: BANK_COUNT }, makeSeqBank),
    drumBanks: Array.from({ length: BANK_COUNT }, makeDrumBank),
    samplerBanks: Array.from({ length: BANK_COUNT }, makeSamplerBank),
    motionBanks: Array.from({ length: BANK_COUNT }, makeMotionBank),
  };
}

export class PatternStore {
  /** seqBanks[bank][step] */
  readonly seqBanks: SeqStep[][];
  /** drumBanks[bank][track][step] */
  readonly drumBanks: DrumCell[][][];
  /** samplerBanks[bank][slot][step] */
  readonly samplerBanks: SamplerStep[][][];
  /** motionBanks[bank][step] */
  readonly motionBanks: MotionStep[][];
  /** Per-bank axis override (null = inherit the XY Pad assignment). */
  readonly motionAssigns: (MotionAssign | null)[];

  /** Filename per sampler slot (null = empty). Decoded audio lives in the
   *  audio layer (SamplerMachine), not here — only the name persists. */
  readonly sampleNames: (string | null)[] = Array(SAMPLER_SLOT_COUNT).fill(null);

  private _seqEdit = 0;
  private _drumEdit = 0;
  private _samplerEdit = 0;
  private _motionEdit = 0;

  private readonly seqListeners = new Set<(index: number, step: SeqStep) => void>();
  private readonly drumListeners = new Set<(track: number, step: number, cell: DrumCell) => void>();
  private readonly samplerListeners = new Set<(slot: number, step: number, cell: SamplerStep) => void>();
  private readonly seqBankListeners = new Set<(bank: readonly SeqStep[]) => void>();
  private readonly drumBankListeners = new Set<(bank: readonly (readonly DrumCell[])[]) => void>();
  private readonly samplerBankListeners = new Set<(bank: readonly (readonly SamplerStep[])[]) => void>();
  private readonly motionListeners = new Set<(index: number, step: MotionStep) => void>();
  private readonly motionBankListeners = new Set<(bank: readonly MotionStep[]) => void>();
  private readonly sampleMetaListeners = new Set<(slot: number, name: string | null) => void>();
  private readonly editBankListeners = new Set<() => void>();
  private readonly mutateListeners = new Set<(m: PatternMutation) => void>();
  private readonly bulkRestoreListeners = new Set<() => void>();

  constructor() {
    this.seqBanks = Array.from({ length: BANK_COUNT }, makeSeqBank);
    this.drumBanks = Array.from({ length: BANK_COUNT }, makeDrumBank);
    this.samplerBanks = Array.from({ length: BANK_COUNT }, makeSamplerBank);
    this.motionBanks = Array.from({ length: BANK_COUNT }, makeMotionBank);
    this.motionAssigns = Array(BANK_COUNT).fill(null);

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
  get seq(): SeqStep[] { return this.seqBanks[this._seqEdit]!; }
  get drum(): DrumCell[][] { return this.drumBanks[this._drumEdit]!; }
  get sampler(): SamplerStep[][] { return this.samplerBanks[this._samplerEdit]!; }
  get motion(): MotionStep[] { return this.motionBanks[this._motionEdit]!; }

  /** Direct bank access (used by the transport for the *playing* bank). */
  seqBank(i: number): SeqStep[] { return this.seqBanks[clampBank(i)]!; }
  drumBank(i: number): DrumCell[][] { return this.drumBanks[clampBank(i)]!; }
  samplerBank(i: number): SamplerStep[][] { return this.samplerBanks[clampBank(i)]!; }
  motionBank(i: number): MotionStep[] { return this.motionBanks[clampBank(i)]!; }
  motionAssign(i: number): MotionAssign | null { return this.motionAssigns[clampBank(i)] ?? null; }

  setSeqEditBank(i: number): void {
    const n = clampBank(i);
    if (n === this._seqEdit) return;
    this._seqEdit = n;
    this.emitBankSeq();
    for (const l of this.editBankListeners) l();
  }

  setDrumEditBank(i: number): void {
    const n = clampBank(i);
    if (n === this._drumEdit) return;
    this._drumEdit = n;
    this.emitBankDrum();
    for (const l of this.editBankListeners) l();
  }

  setSamplerEditBank(i: number): void {
    const n = clampBank(i);
    if (n === this._samplerEdit) return;
    this._samplerEdit = n;
    this.emitBankSampler();
    for (const l of this.editBankListeners) l();
  }

  setMotionEditBank(i: number): void {
    const n = clampBank(i);
    if (n === this._motionEdit) return;
    this._motionEdit = n;
    this.emitBankMotion();
    for (const l of this.editBankListeners) l();
  }

  // ---- Mutations (operate on the edit bank) ----

  setSeqStep(index: number, patch: Partial<SeqStep>): void {
    const s = this.seqBanks[this._seqEdit]?.[index];
    if (!s) return;
    this.emitMutate(() => ({ kind: 'seq', bank: this._seqEdit, index, before: { ...s } }));
    Object.assign(s, patch);
    for (const l of this.seqListeners) l(index, s);
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

  copySeqBank(from: number, to: number): void {
    const a = clampBank(from), b = clampBank(to);
    if (a === b) return;
    const src = assertIndex(this.seqBanks, a, 'seqBanks');
    const dst = assertIndex(this.seqBanks, b, 'seqBanks');
    this.emitMutate(() => ({ kind: 'seq-copy', bank: b, before: dst.map((s) => ({ ...s })) }));
    for (let i = 0; i < dst.length; i++) Object.assign(assertIndex(dst, i, 'seqSteps'), assertIndex(src, i, 'seqSteps'));
    if (b === this._seqEdit) this.emitBankSeq();
  }

  copyDrumBank(from: number, to: number): void {
    const a = clampBank(from), b = clampBank(to);
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
    const a = clampBank(from), b = clampBank(to);
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
    const a = clampBank(from), b = clampBank(to);
    if (a === b) return;
    const src = assertIndex(this.motionBanks, a, 'motionBanks');
    const dst = assertIndex(this.motionBanks, b, 'motionBanks');
    this.emitMutate(() => {
      const prevAssign = this.motionAssigns[b] ?? null;
      return {
        kind: 'motion-copy', bank: b,
        before: dst.map((s) => ({ ...s })),
        beforeAssign: prevAssign ? { ...prevAssign } : null,
      };
    });
    for (let i = 0; i < dst.length; i++) Object.assign(assertIndex(dst, i, 'motionSteps'), assertIndex(src, i, 'motionSteps'));
    const srcAssign = this.motionAssigns[a] ?? null;
    this.motionAssigns[b] = srcAssign ? { ...srcAssign } : null;
    if (b === this._motionEdit) this.emitBankMotion();
  }

  // ---- Subscriptions ----

  onSeqChange(fn: (index: number, step: SeqStep) => void): () => void {
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

  onEditBankChange(fn: () => void): () => void {
    this.editBankListeners.add(fn);
    return () => { this.editBankListeners.delete(fn); };
  }

  /**
   * Pre-state of every mutation-entry-point call (the undo capture hook —
   * pattern-undo.md REQ-2). `restore()` and `setSampleName` never emit.
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
  onSeqBankChange(fn: (bank: readonly SeqStep[]) => void): () => void {
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

  private emitAllSeq(): void {
    const bank = assertIndex(this.seqBanks, this._seqEdit, 'seqBanks');
    for (let i = 0; i < bank.length; i++) {
      for (const l of this.seqListeners) l(i, assertIndex(bank, i, 'seqSteps'));
    }
  }

  private emitAllDrum(): void {
    const bank = assertIndex(this.drumBanks, this._drumEdit, 'drumBanks');
    for (let t = 0; t < bank.length; t++) {
      const row = assertIndex(bank, t, 'drumTracks');
      for (let s = 0; s < row.length; s++) {
        for (const l of this.drumListeners) l(t, s, assertIndex(row, s, 'drumCells'));
      }
    }
  }

  private emitAllSampler(): void {
    const bank = assertIndex(this.samplerBanks, this._samplerEdit, 'samplerBanks');
    for (let t = 0; t < bank.length; t++) {
      const row = assertIndex(bank, t, 'samplerTracks');
      for (let s = 0; s < row.length; s++) {
        for (const l of this.samplerListeners) l(t, s, assertIndex(row, s, 'samplerCells'));
      }
    }
  }

  // ---- Serialisation (used by Song save/load) ----

  snapshot(): PatternSnapshot {
    return {
      seqBanks: this.seqBanks.map((b) => b.map((s) => ({ ...s }))),
      drumBanks: this.drumBanks.map((bk) => bk.map((row) => row.map((c) => ({ ...c })))),
      seqEditBank: this._seqEdit,
      drumEditBank: this._drumEdit,
      samplerBanks: this.samplerBanks.map((bk) => bk.map((row) => row.map((c) => ({ ...c })))),
      samplerEditBank: this._samplerEdit,
      sampleNames: [...this.sampleNames],
      motionBanks: this.motionBanks.map((b) => b.map((s) => ({ ...s }))),
      motionAssigns: this.motionAssigns.map((a) => (a ? { ...a } : null)),
      motionEditBank: this._motionEdit,
    };
  }

  restore(snap: Partial<PatternSnapshot>): void {
    // A whole-store overwrite: undo stacks must drop their (now stale) history
    // before the new state lands (pattern-undo.md REQ-7).
    for (const l of this.bulkRestoreListeners) l();
    // Legacy files may lack the newer per-step fields — spread defaults first
    // so a load resets anything the incoming cell doesn't carry.
    if (snap.seqBanks) {
      for (let b = 0; b < BANK_COUNT; b++) {
        const incoming = snap.seqBanks[b];
        if (!incoming) continue;
        const bank = assertIndex(this.seqBanks, b, 'seqBanks');
        for (let i = 0; i < bank.length; i++) {
          const step = incoming[i];
          if (step) Object.assign(assertIndex(bank, i, 'seqSteps'), SEQ_EXTRA_DEFAULTS, step);
        }
      }
    }
    if (snap.drumBanks) {
      for (let b = 0; b < BANK_COUNT; b++) {
        const incoming = snap.drumBanks[b];
        if (!incoming) continue;
        const bank = assertIndex(this.drumBanks, b, 'drumBanks');
        for (let t = 0; t < bank.length; t++) {
          const row = incoming[t];
          if (!row) continue;
          const rowDst = assertIndex(bank, t, 'drumTracks');
          for (let s = 0; s < rowDst.length; s++) {
            const cell = row[s];
            if (cell) Object.assign(assertIndex(rowDst, s, 'drumCells'), TRIGGER_CELL_DEFAULTS, cell);
          }
        }
      }
    }
    if (snap.samplerBanks) {
      for (let b = 0; b < BANK_COUNT; b++) {
        const incoming = snap.samplerBanks[b];
        if (!incoming) continue;
        const bank = assertIndex(this.samplerBanks, b, 'samplerBanks');
        for (let t = 0; t < bank.length; t++) {
          const row = incoming[t];
          if (!row) continue;
          const rowDst = assertIndex(bank, t, 'samplerTracks');
          for (let s = 0; s < rowDst.length; s++) {
            const cell = row[s];
            if (cell) Object.assign(assertIndex(rowDst, s, 'samplerCells'), TRIGGER_CELL_DEFAULTS, cell);
          }
        }
      }
    }
    if (snap.motionBanks) {
      for (let b = 0; b < BANK_COUNT; b++) {
        const incoming = snap.motionBanks[b];
        if (!incoming) continue;
        const bank = assertIndex(this.motionBanks, b, 'motionBanks');
        for (let i = 0; i < bank.length; i++) {
          const step = incoming[i];
          if (step) Object.assign(assertIndex(bank, i, 'motionSteps'), MOTION_STEP_DEFAULTS, step);
        }
      }
    }
    if (snap.motionAssigns) {
      for (let b = 0; b < BANK_COUNT; b++) {
        const a = snap.motionAssigns[b];
        this.motionAssigns[b] = a && (a.x || a.y) ? { ...a } : null;
      }
    }
    if (snap.sampleNames) {
      for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) {
        this.sampleNames[i] = snap.sampleNames[i] ?? null;
      }
    }
    if (typeof snap.seqEditBank === 'number') this._seqEdit = clampBank(snap.seqEditBank);
    if (typeof snap.drumEditBank === 'number') this._drumEdit = clampBank(snap.drumEditBank);
    if (typeof snap.samplerEditBank === 'number') this._samplerEdit = clampBank(snap.samplerEditBank);
    if (typeof snap.motionEditBank === 'number') this._motionEdit = clampBank(snap.motionEditBank);
    // Repaint whatever bank is now selected for editing.
    this.emitBankSeq();
    this.emitBankDrum();
    this.emitBankSampler();
    this.emitBankMotion();
    for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) {
      for (const l of this.sampleMetaListeners) l(i, this.sampleNames[i] ?? null);
    }
    for (const l of this.editBankListeners) l();
  }
}
