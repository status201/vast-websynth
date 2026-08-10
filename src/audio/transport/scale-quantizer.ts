import {
  buildQuantizeTable, chordDegrees, degreeOf, diatonicChord,
} from '../../utils/music';

/**
 * The live key: holds the quantize lookup and the chord-memory voicing, and hands both
 * to every note source. Built alongside `Arrangement` and injected by reference, so the
 * sequencer, the arpeggiator and the engine's keyboard passthrough all read one key.
 *
 * Spec: `specs/features/scale-quantization.md`, `specs/features/chord-tools.md`.
 *
 * Nothing here allocates on the note path except `chord()`, which runs per note-on
 * rather than per sample (scale-quantization.md REQ-7).
 */
export class ScaleQuantizer {
  private root = 0;
  private scale = 0;
  /** `null` while chromatic — the no-op default, and the early-return path. */
  private table: Uint8Array | null = null;
  private degrees: readonly number[] = [];
  private poly = true;

  /** True when a real scale is chosen. The UI gates the chord tools on this. */
  get active(): boolean { return this.table !== null; }

  /** True when chord memory would actually expand a note (chord-tools.md REQ-7). */
  get chordActive(): boolean {
    return this.table !== null && this.degrees.length > 0 && this.poly;
  }

  setRoot(root: number): void { this.root = root; this.rebuild(); }
  setScale(scale: number): void { this.scale = scale; this.rebuild(); }
  setChord(voicing: number): void { this.degrees = chordDegrees(voicing); }

  /** Mono suppresses chord expansion: four notes into one voice sound only the last. */
  setPoly(poly: boolean): void { this.poly = poly; }

  private rebuild(): void {
    this.table = buildQuantizeTable(this.root, this.scale);
  }

  /**
   * Snap a note to the key. The hot path: one array index, or an early return while
   * chromatic — mirroring `transposeNote`'s `if (semitones === 0) return note`.
   *
   * Out-of-range input passes through untouched rather than reading past the table;
   * callers clamp before this (`transposeNote` already does).
   */
  get(note: number): number {
    const t = this.table;
    if (t === null) return note;
    return t[note] ?? note;
  }

  /**
   * Expand one played note into a chord rooted on it, or `[note]` when chord memory is
   * off, mono, or the note is not in the scale.
   *
   * The result is diatonic by construction, so passing it back through `get()` is a
   * no-op (scale-quantization.md REQ-3) — which is why the two features compose
   * without an ordering rule.
   */
  chord(note: number): number[] {
    const q = this.get(note);
    if (!this.chordActive) return [q];
    const deg = degreeOf(q, this.root, this.scale);
    if (deg < 0) return [q];
    const notes = diatonicChord(q, this.root, this.scale, this.degrees, deg);
    return notes.length > 0 ? notes : [q];
  }
}
