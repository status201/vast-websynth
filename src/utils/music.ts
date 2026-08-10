// Music theory: scale tables, the quantize lookup, and diatonic chord building.
// Pure and dependency-free apart from the shared MIDI bounds — no AudioContext, no
// store, no DOM — so every rule here is unit-testable on its own.
// Spec: specs/features/scale-quantization.md, specs/features/chord-tools.md

import { MIDI_NOTE_MIN, MIDI_NOTE_MAX } from '../state/limits';

/** Pitch-class names, index 0 = C. Display only; the stored value is the index. */
export const NOTE_LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Scale names, indexed by the `scale.type` param.
 *
 * **APPEND-ONLY.** A song stores the *index*, so inserting or reordering silently
 * re-keys every song that predates the change. Index 0 must stay `chromatic`: it is
 * the no-op default that keeps pre-feature presets and songs byte-identical
 * (ADR-006, scale-quantization.md REQ-1).
 */
export const SCALE_LABELS = [
  'chromatic', 'major', 'minor', 'dorian', 'mixolydian', 'phrygian',
  'lydian', 'harm minor', 'pent maj', 'pent min', 'blues',
];

/**
 * Semitone offsets from the root, parallel to `SCALE_LABELS`. `chromatic` is left
 * empty — it is never consulted, because index 0 short-circuits everywhere.
 */
const SCALE_STEPS: readonly (readonly number[])[] = [
  [],                            // chromatic (unused)
  [0, 2, 4, 5, 7, 9, 11],        // major
  [0, 2, 3, 5, 7, 8, 10],        // minor (natural)
  [0, 2, 3, 5, 7, 9, 10],        // dorian
  [0, 2, 4, 5, 7, 9, 10],        // mixolydian
  [0, 1, 3, 5, 7, 8, 10],        // phrygian
  [0, 2, 4, 6, 7, 9, 11],        // lydian
  [0, 2, 3, 5, 7, 8, 11],        // harmonic minor
  [0, 2, 4, 7, 9],               // pentatonic major
  [0, 3, 5, 7, 10],              // pentatonic minor
  [0, 3, 5, 6, 7, 10],           // blues
];

/** True when the index names a real scale (i.e. anything but `chromatic`). */
export function isScaleActive(scale: number): boolean {
  return scale > 0 && scale < SCALE_STEPS.length;
}

/** How many tones the scale has — the modulus for degree arithmetic. */
export function scaleSize(scale: number): number {
  return SCALE_STEPS[scale]?.length ?? 0;
}

/**
 * The scale's pitch classes (0..11), ascending from `root`.
 * Returns `[]` for chromatic — callers gate on `isScaleActive` first.
 */
export function scaleTones(root: number, scale: number): number[] {
  const steps = SCALE_STEPS[scale];
  if (!steps) return [];
  const r = ((root % 12) + 12) % 12;
  return steps.map((s) => (r + s) % 12);
}

/**
 * A 128-entry map from input note → nearest scale tone, or `null` for chromatic so
 * the caller can skip the lookup entirely.
 *
 * Built once per (root, scale) change and then indexed per note, which is what keeps
 * the tick path allocation-free (runtime-performance.md REQ-6). `Uint8Array`, not
 * `Int8Array`: 127 is exactly `Int8Array`'s ceiling, so it would work today and
 * silently wrap the day MIDI_NOTE_MAX moved.
 *
 * **Ties break downward** (scale-quantization.md REQ-2). C# in C major is 1 semitone
 * from both C and D; we take C. That is a deliberate musical choice — it matches the
 * convention on hardware quantizers and favours the more stable tone — so the search
 * below walks outward and tests the *lower* candidate first at each distance.
 *
 * Worth knowing: in **any 7-note scale** (major, the modes, harmonic minor) every step
 * is 1 or 2 semitones, so every out-of-scale note is equidistant and the tie rule
 * decides *all* of them — quantizing to major always flattens. Genuine nearest-tone
 * choices only arise in the gapped scales (pentatonic, blues).
 *
 * Notes near the MIDI extremes are clamped into range rather than dropped: the search
 * simply never accepts an out-of-range candidate, so it keeps widening until it finds
 * an in-range tone (scale-quantization.md REQ-3).
 */
export function buildQuantizeTable(root: number, scale: number): Uint8Array | null {
  if (!isScaleActive(scale)) return null;
  const tones = scaleTones(root, scale);
  const inScale = new Array<boolean>(12).fill(false);
  for (const t of tones) inScale[t] = true;

  const table = new Uint8Array(128);
  for (let n = MIDI_NOTE_MIN; n <= MIDI_NOTE_MAX; n++) {
    table[n] = n; // overwritten below unless the note is already in the scale
    if (inScale[n % 12]) continue;
    // Walk outward from the note. `d` is the distance; the lower candidate is tested
    // first so an exact tie resolves flat.
    for (let d = 1; d <= 12; d++) {
      const down = n - d;
      if (down >= MIDI_NOTE_MIN && inScale[((down % 12) + 12) % 12]) { table[n] = down; break; }
      const up = n + d;
      if (up <= MIDI_NOTE_MAX && inScale[up % 12]) { table[n] = up; break; }
    }
  }
  return table;
}

/**
 * Chord sizes in **scale degrees** from the chord root, indexed by `chord.voicing`.
 *
 * Stacking degrees rather than semitones is what makes the quality come out right for
 * free — in a major scale `ii` lands minor and `V` major because the scale's own
 * interval pattern produces them, with no chord-quality table anywhere
 * (chord-tools.md REQ-1).
 */
export const CHORD_LABELS = ['off', 'triad', '7th', 'sus4', 'power'];
const CHORD_DEGREES: readonly (readonly number[])[] = [
  [],              // off
  [0, 2, 4],       // triad
  [0, 2, 4, 6],    // 7th
  [0, 3, 4],       // sus4 — root, 4th, 5th
  [0, 4],          // power — root + 5th degree
];

/** Degree offsets for a `chord.voicing` index; `[]` when off or out of range. */
export function chordDegrees(voicing: number): readonly number[] {
  return CHORD_DEGREES[voicing] ?? [];
}

/**
 * The absolute MIDI note for scale `degree`, in the octave that contains `anchor`.
 *
 * Degrees beyond the scale size wrap and carry an octave, which is what lets
 * `diatonicChord` stack `[0, 2, 4, 6]` without special-casing the wrap.
 */
function degreeToNote(anchor: number, root: number, scale: number, degree: number): number {
  const steps = SCALE_STEPS[scale];
  const size = steps?.length ?? 0;
  if (!steps || size === 0) return anchor;
  const octave = Math.floor(degree / size);
  const within = ((degree % size) + size) % size;
  const r = ((root % 12) + 12) % 12;
  // The C-relative pitch of the scale's own root, in the octave containing `anchor`.
  const base = Math.floor((anchor - r) / 12) * 12 + r;
  return base + steps[within]! + octave * 12;
}

/**
 * Which scale degree `note` is, or `-1` when its pitch class is not in the scale.
 * Chord memory needs this to build a chord *rooted on the key the player pressed*.
 */
export function degreeOf(note: number, root: number, scale: number): number {
  const steps = SCALE_STEPS[scale];
  if (!steps) return -1;
  const r = ((root % 12) + 12) % 12;
  const rel = ((note - r) % 12 + 12) % 12;
  return steps.indexOf(rel);
}

/**
 * Build a chord by stacking scale degrees from `base`, anchored so the chord's root
 * lands in the octave of `anchor` — writing a chord should not jump the line an octave
 * (chord-tools.md REQ-10).
 *
 * `base` shifts every degree, so the caller can reuse one shared `degrees` array
 * (`[0,2,4]`) for any chord root without allocating a shifted copy per note.
 *
 * Returns notes ascending, clamped into the MIDI range and de-duplicated (clamping at
 * the ceiling can collapse two tones onto one; emitting the same note twice would make
 * two tracks fight over one voice).
 */
export function diatonicChord(
  anchor: number, root: number, scale: number, degrees: readonly number[], base = 0,
): number[] {
  if (!isScaleActive(scale) || degrees.length === 0) return [];
  const out: number[] = [];
  for (const d of degrees) {
    const n = degreeToNote(anchor, root, scale, d + base);
    const c = n < MIDI_NOTE_MIN ? MIDI_NOTE_MIN : n > MIDI_NOTE_MAX ? MIDI_NOTE_MAX : n;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/**
 * A degree's label for the writer's menu — e.g. `ii — Dm`, `V — G`, `vii° — B°`.
 *
 * Case and the `°` are **derived from the intervals the stacking actually produced**
 * (a 3-semitone third is minor, a 6-semitone fifth diminished), not stored per scale,
 * so a scale appended to `SCALE_LABELS` labels itself correctly with no new data
 * (chord-tools.md REQ-9).
 */
export function degreeLabel(root: number, scale: number, degree: number): string {
  const notes = diatonicChord(60, root, scale, [degree, degree + 2, degree + 4]);
  const tonic = notes[0];
  if (tonic === undefined) return '';
  const name = NOTE_LABELS[tonic % 12]!;
  const third = notes[1] === undefined ? -1 : notes[1] - tonic;
  const fifth = notes[2] === undefined ? -1 : notes[2] - tonic;
  const minor = third === 3;
  const dim = fifth === 6;
  const aug = fifth === 8;
  const numeral = ROMAN[degree % 7] ?? '';
  const roman = minor || dim ? numeral.toLowerCase() : numeral;
  const mark = dim ? '°' : aug ? '+' : '';
  const quality = dim ? '°' : aug ? '+' : minor ? 'm' : '';
  return `${roman}${mark} — ${name}${quality}`;
}
