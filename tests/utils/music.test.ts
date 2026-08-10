import { describe, it, expect } from 'vitest';
import {
  NOTE_LABELS, SCALE_LABELS, CHORD_LABELS, isScaleActive, scaleSize, scaleTones,
  buildQuantizeTable, chordDegrees, diatonicChord, degreeLabel,
} from '../../src/utils/music';

// specs/features/scale-quantization.md, specs/features/chord-tools.md

const MAJOR = SCALE_LABELS.indexOf('major');
const MINOR = SCALE_LABELS.indexOf('minor');
const PENT_MAJ = SCALE_LABELS.indexOf('pent maj');
const C = 0, D = 2, A = 9;

/** Quantize through the table the engine would build, for readability below. */
function q(note: number, root: number, scale: number): number {
  const t = buildQuantizeTable(root, scale);
  return t ? t[note]! : note;
}

describe('scale tables', () => {
  it('keeps chromatic at index 0 as the no-op (REQ-1)', () => {
    // ADR-006: this index is what every pre-feature preset/song falls back to.
    expect(SCALE_LABELS[0]).toBe('chromatic');
    expect(isScaleActive(0)).toBe(false);
    expect(buildQuantizeTable(0, 0)).toBeNull();
  });

  it('has twelve note names and a step row per scale label', () => {
    expect(NOTE_LABELS).toHaveLength(12);
    for (let i = 1; i < SCALE_LABELS.length; i++) expect(scaleSize(i)).toBeGreaterThan(0);
  });

  it('transposes its tones with the root', () => {
    expect(scaleTones(C, MAJOR)).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(scaleTones(D, MAJOR)).toEqual([2, 4, 6, 7, 9, 11, 1]);
  });
});

describe('buildQuantizeTable', () => {
  it('leaves an in-scale note alone', () => {
    expect(q(60, C, MAJOR)).toBe(60); // C
    expect(q(64, C, MAJOR)).toBe(64); // E
    expect(q(67, C, MAJOR)).toBe(67); // G
  });

  it('breaks an equidistant tie downward (REQ-2)', () => {
    // C# is 1 semitone from both C and D; the flat side wins.
    expect(q(61, C, MAJOR)).toBe(60);
    expect(q(66, C, MAJOR)).toBe(65); // F# -> F, not G
  });

  it('takes the genuinely nearer tone in a gapped scale (REQ-2)', () => {
    // C pentatonic major = C D E G A. F# is 1 below G and 2 above E.
    expect(q(66, C, PENT_MAJ)).toBe(67);
    // F is 1 above E and 2 below G, so it goes down — not the tie rule, the distance.
    expect(q(65, C, PENT_MAJ)).toBe(64);
  });

  it('is idempotent for every note, root and scale (REQ-3)', () => {
    // The stability property chord tools rely on: diatonic output survives the filter.
    for (let scale = 1; scale < SCALE_LABELS.length; scale++) {
      for (let root = 0; root < 12; root++) {
        const t = buildQuantizeTable(root, scale)!;
        for (let n = 0; n < 128; n++) expect(t[t[n]!]).toBe(t[n]);
      }
    }
  });

  it('always lands in the MIDI range, clamped rather than dropped (REQ-3)', () => {
    for (let scale = 1; scale < SCALE_LABELS.length; scale++) {
      for (let root = 0; root < 12; root++) {
        const t = buildQuantizeTable(root, scale)!;
        for (let n = 0; n < 128; n++) {
          expect(t[n]).toBeGreaterThanOrEqual(0);
          expect(t[n]).toBeLessThanOrEqual(127);
        }
      }
    }
  });

  it('never moves a note more than 2 semitones', () => {
    // A quantizer that jumped further would be re-composing, not correcting.
    for (let scale = 1; scale < SCALE_LABELS.length; scale++) {
      for (let root = 0; root < 12; root++) {
        const t = buildQuantizeTable(root, scale)!;
        for (let n = 2; n < 126; n++) expect(Math.abs(t[n]! - n)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('handles the extremes without escaping the range (edge)', () => {
    // B major contains no C, so note 127 (G) and note 0 must still resolve in range.
    for (let root = 0; root < 12; root++) {
      const t = buildQuantizeTable(root, MAJOR)!;
      expect(t[127]).toBeLessThanOrEqual(127);
      expect(t[0]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('diatonicChord', () => {
  it('stacks thirds into the right quality without a quality table (REQ-1)', () => {
    const triad = chordDegrees(CHORD_LABELS.indexOf('triad'));
    // C major: I = C E G, ii = D F A, V = G B D.
    expect(diatonicChord(60, C, MAJOR, [0, 2, 4])).toEqual([60, 64, 67]);
    expect(diatonicChord(60, C, MAJOR, triad.map((d) => d + 1))).toEqual([62, 65, 69]);
    expect(diatonicChord(60, C, MAJOR, triad.map((d) => d + 4))).toEqual([67, 71, 74]);
  });

  it('builds a 7th by carrying the degree past the scale size', () => {
    expect(diatonicChord(60, C, MAJOR, [0, 2, 4, 6])).toEqual([60, 64, 67, 71]);
  });

  it('anchors the chord in the octave being edited (REQ-10)', () => {
    expect(diatonicChord(72, C, MAJOR, [0, 2, 4])).toEqual([72, 76, 79]);
    expect(diatonicChord(48, C, MAJOR, [0, 2, 4])).toEqual([48, 52, 55]);
  });

  it('returns notes that are already in the scale, so the filter is a no-op (REQ-5)', () => {
    const t = buildQuantizeTable(A, MINOR)!;
    for (const n of diatonicChord(60, A, MINOR, [0, 2, 4, 6])) expect(t[n]).toBe(n);
  });

  it('is empty without a scale or without a voicing (REQ-8)', () => {
    expect(diatonicChord(60, C, 0, [0, 2, 4])).toEqual([]);
    expect(diatonicChord(60, C, MAJOR, [])).toEqual([]);
    expect(chordDegrees(0)).toEqual([]);
  });

  it('de-duplicates when clamping collapses two tones (edge)', () => {
    const notes = diatonicChord(127, C, MAJOR, [0, 2, 4, 6]);
    expect(new Set(notes).size).toBe(notes.length);
  });
});

describe('degreeLabel', () => {
  it('cases the numeral from the interval the stacking produced (REQ-9)', () => {
    expect(degreeLabel(C, MAJOR, 0)).toBe('I — C');
    expect(degreeLabel(C, MAJOR, 1)).toBe('ii — Dm');
    expect(degreeLabel(C, MAJOR, 4)).toBe('V — G');
    expect(degreeLabel(C, MAJOR, 6)).toBe('vii° — B°');
  });

  it('labels a minor scale from the same rule, with no per-scale data', () => {
    expect(degreeLabel(A, MINOR, 0)).toBe('i — Am');
    expect(degreeLabel(A, MINOR, 2)).toBe('III — C');
  });
});
