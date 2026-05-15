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
export interface SeqStep {
  on: boolean;
  note: number;     // MIDI note
  velocity: number; // 0..1
  gate: number;     // 0..1 of one step duration
}

export interface DrumCell {
  on: boolean;
  velocity: number; // 0..1
}

export const SEQ_LENGTH = 16;

export const DRUM_TRACKS = ['Kick', 'Snare', 'C.Hat', 'O.Hat', 'L.Tom', 'M.Tom', 'H.Tom', 'Clap'] as const;
export type DrumTrack = typeof DRUM_TRACKS[number];
export const DRUM_TRACK_COUNT = DRUM_TRACKS.length;

export const BANK_COUNT = 4;
export const BANK_LABELS = ['A', 'B', 'C', 'D'];

export interface PatternSnapshot {
  seqBanks: SeqStep[][];
  drumBanks: DrumCell[][][];
  seqEditBank: number;
  drumEditBank: number;
}

function clampBank(i: number): number {
  return Math.max(0, Math.min(BANK_COUNT - 1, Math.round(i)));
}

function makeSeqBank(): SeqStep[] {
  return Array.from({ length: SEQ_LENGTH }, (_, i) => ({
    on: false,
    note: 60 + (i % 8),
    velocity: 0.8,
    gate: 0.5,
  }));
}

function makeDrumBank(): DrumCell[][] {
  return Array.from({ length: DRUM_TRACK_COUNT }, () =>
    Array.from({ length: SEQ_LENGTH }, () => ({ on: false, velocity: 0.85 } as DrumCell))
  );
}

export class PatternStore {
  /** seqBanks[bank][step] */
  readonly seqBanks: SeqStep[][];
  /** drumBanks[bank][track][step] */
  readonly drumBanks: DrumCell[][][];

  private _seqEdit = 0;
  private _drumEdit = 0;

  private readonly seqListeners = new Set<(index: number, step: SeqStep) => void>();
  private readonly drumListeners = new Set<(track: number, step: number, cell: DrumCell) => void>();
  private readonly editBankListeners = new Set<() => void>();

  constructor() {
    this.seqBanks = Array.from({ length: BANK_COUNT }, makeSeqBank);
    this.drumBanks = Array.from({ length: BANK_COUNT }, makeDrumBank);

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

  /** Back-compat accessors: the bank currently being edited in the UI. */
  get seq(): SeqStep[] { return this.seqBanks[this._seqEdit]!; }
  get drum(): DrumCell[][] { return this.drumBanks[this._drumEdit]!; }

  /** Direct bank access (used by the transport for the *playing* bank). */
  seqBank(i: number): SeqStep[] { return this.seqBanks[clampBank(i)]!; }
  drumBank(i: number): DrumCell[][] { return this.drumBanks[clampBank(i)]!; }

  setSeqEditBank(i: number): void {
    const n = clampBank(i);
    if (n === this._seqEdit) return;
    this._seqEdit = n;
    this.emitAllSeq();
    for (const l of this.editBankListeners) l();
  }

  setDrumEditBank(i: number): void {
    const n = clampBank(i);
    if (n === this._drumEdit) return;
    this._drumEdit = n;
    this.emitAllDrum();
    for (const l of this.editBankListeners) l();
  }

  // ---- Mutations (operate on the edit bank) ----

  setSeqStep(index: number, patch: Partial<SeqStep>): void {
    const s = this.seqBanks[this._seqEdit]?.[index];
    if (!s) return;
    Object.assign(s, patch);
    for (const l of this.seqListeners) l(index, s);
  }

  setDrumCell(track: number, step: number, patch: Partial<DrumCell>): void {
    const cell = this.drumBanks[this._drumEdit]?.[track]?.[step];
    if (!cell) return;
    Object.assign(cell, patch);
    for (const l of this.drumListeners) l(track, step, cell);
  }

  copySeqBank(from: number, to: number): void {
    const a = clampBank(from), b = clampBank(to);
    if (a === b) return;
    const src = this.seqBanks[a]!, dst = this.seqBanks[b]!;
    for (let i = 0; i < dst.length; i++) Object.assign(dst[i]!, src[i]!);
    if (b === this._seqEdit) this.emitAllSeq();
  }

  copyDrumBank(from: number, to: number): void {
    const a = clampBank(from), b = clampBank(to);
    if (a === b) return;
    const src = this.drumBanks[a]!, dst = this.drumBanks[b]!;
    for (let t = 0; t < dst.length; t++) {
      for (let s = 0; s < dst[t]!.length; s++) Object.assign(dst[t]![s]!, src[t]![s]!);
    }
    if (b === this._drumEdit) this.emitAllDrum();
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

  onEditBankChange(fn: () => void): () => void {
    this.editBankListeners.add(fn);
    return () => { this.editBankListeners.delete(fn); };
  }

  private emitAllSeq(): void {
    const bank = this.seqBanks[this._seqEdit]!;
    for (let i = 0; i < bank.length; i++) {
      for (const l of this.seqListeners) l(i, bank[i]!);
    }
  }

  private emitAllDrum(): void {
    const bank = this.drumBanks[this._drumEdit]!;
    for (let t = 0; t < bank.length; t++) {
      for (let s = 0; s < bank[t]!.length; s++) {
        for (const l of this.drumListeners) l(t, s, bank[t]![s]!);
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
    };
  }

  restore(snap: Partial<PatternSnapshot>): void {
    if (snap.seqBanks) {
      for (let b = 0; b < BANK_COUNT; b++) {
        const incoming = snap.seqBanks[b];
        const bank = this.seqBanks[b]!;
        if (!incoming) continue;
        for (let i = 0; i < bank.length; i++) {
          const step = incoming[i];
          if (step) Object.assign(bank[i]!, step);
        }
      }
    }
    if (snap.drumBanks) {
      for (let b = 0; b < BANK_COUNT; b++) {
        const incoming = snap.drumBanks[b];
        const bank = this.drumBanks[b]!;
        if (!incoming) continue;
        for (let t = 0; t < bank.length; t++) {
          const row = incoming[t];
          if (!row) continue;
          for (let s = 0; s < bank[t]!.length; s++) {
            const cell = row[s];
            if (cell) Object.assign(bank[t]![s]!, cell);
          }
        }
      }
    }
    if (typeof snap.seqEditBank === 'number') this._seqEdit = clampBank(snap.seqEditBank);
    if (typeof snap.drumEditBank === 'number') this._drumEdit = clampBank(snap.drumEditBank);
    // Repaint whatever bank is now selected for editing.
    this.emitAllSeq();
    this.emitAllDrum();
    for (const l of this.editBankListeners) l();
  }
}
