import { describe, it, expect } from 'vitest';
import {
  NOTE_LABELS, SCALE_LABELS, CHORD_LABELS, EXTRA_LABELS, isScaleActive, scaleSize, scaleTones,
  buildQuantizeTable, chordDegrees, diatonicChord, degreeLabel, degreeOf, extraTone, invertChord, noteName,
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
  it('keeps chromatic at index 0 as the no-op (REQ-the-key-is-two-inert-params)', () => {
    // ADR-006: this index is what every pre-feature preset/song falls back to.
    expect(SCALE_LABELS[0]).toBe('chromatic');
    expect(isScaleActive(0)).toBe(false);
    expect(buildQuantizeTable(0, 0)).toBeNull();
  });

  it('has twelve note names and a step row per scale label', () => {
    expect(NOTE_LABELS).toHaveLength(12);
    for (let i = 1; i < SCALE_LABELS.length; i++) expect(scaleSize(i)).toBeGreaterThan(0);
  });

  it('names a MIDI note with its octave, C-1 = 0 — the one namer step labels and the MIDI reader share', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(0)).toBe('C-1');
    expect(noteName(46)).toBe('A#2');
    expect(noteName(127)).toBe('G9');
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

  it('breaks an equidistant tie downward (REQ-nearest-tone-ties-break-downward)', () => {
    // C# is 1 semitone from both C and D; the flat side wins.
    expect(q(61, C, MAJOR)).toBe(60);
    expect(q(66, C, MAJOR)).toBe(65); // F# -> F, not G
  });

  it('takes the genuinely nearer tone in a gapped scale (REQ-nearest-tone-ties-break-downward)', () => {
    // C pentatonic major = C D E G A. F# is 1 below G and 2 above E.
    expect(q(66, C, PENT_MAJ)).toBe(67);
    // F is 1 above E and 2 below G, so it goes down — not the tie rule, the distance.
    expect(q(65, C, PENT_MAJ)).toBe(64);
  });

  /**
   * The three sweeps below cover every (scale, root, note) — ~17k combinations.
   *
   * Each collects **offenders** and asserts once, rather than calling `expect` in the
   * inner loop: at ~30k assertions apiece they ran for seconds and went red on a
   * loaded parallel run, which is a flake that accuses innocent code. Coverage is
   * identical, and a failure now names the exact combination instead of just the
   * first one to trip.
   */
  const eachTable = (fn: (t: Uint8Array, scale: number, root: number) => void): void => {
    for (let scale = 1; scale < SCALE_LABELS.length; scale++) {
      for (let root = 0; root < 12; root++) fn(buildQuantizeTable(root, scale)!, scale, root);
    }
  };

  it('is idempotent for every note, root and scale (REQ-quantization-is-idempotent-and-bounded)', () => {
    // The stability property chord tools rely on: diatonic output survives the filter.
    const bad: string[] = [];
    eachTable((t, scale, root) => {
      for (let n = 0; n < 128; n++) {
        if (t[t[n]!] !== t[n]) bad.push(`${SCALE_LABELS[scale]} root ${root} note ${n}`);
      }
    });
    expect(bad).toEqual([]);
  });

  it('always lands in the MIDI range, clamped rather than dropped (REQ-quantization-is-idempotent-and-bounded)', () => {
    const bad: string[] = [];
    eachTable((t, scale, root) => {
      for (let n = 0; n < 128; n++) {
        const v = t[n]!;
        if (v < 0 || v > 127) bad.push(`${SCALE_LABELS[scale]} root ${root} note ${n} -> ${v}`);
      }
    });
    expect(bad).toEqual([]);
  });

  it('never moves a note more than 2 semitones', () => {
    // A quantizer that jumped further would be re-composing, not correcting.
    const bad: string[] = [];
    eachTable((t, scale, root) => {
      for (let n = 2; n < 126; n++) {
        if (Math.abs(t[n]! - n) > 2) bad.push(`${SCALE_LABELS[scale]} root ${root} note ${n}`);
      }
    });
    expect(bad).toEqual([]);
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
  it('stacks thirds into the right quality without a quality table (REQ-the-key-is-two-inert-params)', () => {
    const triad = chordDegrees(CHORD_LABELS.indexOf('triad'));
    // C major: I = C E G, ii = D F A, V = G B D.
    expect(diatonicChord(60, C, MAJOR, [0, 2, 4])).toEqual([60, 64, 67]);
    expect(diatonicChord(60, C, MAJOR, triad.map((d) => d + 1))).toEqual([62, 65, 69]);
    expect(diatonicChord(60, C, MAJOR, triad.map((d) => d + 4))).toEqual([67, 71, 74]);
  });

  it('builds a 7th by carrying the degree past the scale size', () => {
    expect(diatonicChord(60, C, MAJOR, [0, 2, 4, 6])).toEqual([60, 64, 67, 71]);
  });

  it('anchors the chord in the octave being edited (REQ-the-key-is-shown-where-you-play)', () => {
    expect(diatonicChord(72, C, MAJOR, [0, 2, 4])).toEqual([72, 76, 79]);
    expect(diatonicChord(48, C, MAJOR, [0, 2, 4])).toEqual([48, 52, 55]);
  });

  it('returns notes that are already in the scale, so the filter is a no-op (REQ-transpose-first-then-quantize)', () => {
    const t = buildQuantizeTable(A, MINOR)!;
    for (const n of diatonicChord(60, A, MINOR, [0, 2, 4, 6])) expect(t[n]).toBe(n);
  });

  it('is empty without a scale or without a voicing (REQ-snap-to-scale-is-the-destructive-opt-in)', () => {
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
  it('cases the numeral from the interval the stacking produced (REQ-the-key-is-drawn-not-just-named)', () => {
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

// scale-quantization.md REQ-an-extra-note-is-admitted-not-a-degree / REQ-bebop-is-relative-to-the-mode (v4).
describe('the extra note', () => {
  const E = 4;
  const DORIAN = SCALE_LABELS.indexOf('dorian');
  const MIXO = SCALE_LABELS.indexOf('mixolydian');
  const BLUES = SCALE_LABELS.indexOf('blues');
  const extra = (label: string): number => EXTRA_LABELS.indexOf(label);

  it('keeps none at index 0 as the no-op', () => {
    expect(EXTRA_LABELS[0]).toBe('none');
    for (let scale = 0; scale < SCALE_LABELS.length; scale++) {
      for (let root = 0; root < 12; root++) {
        expect(buildQuantizeTable(root, scale, 0)).toEqual(buildQuantizeTable(root, scale));
      }
    }
  });

  it('lets a blue b5 through as written — the 1979 case', () => {
    const plain = buildQuantizeTable(E, DORIAN)!;
    const blue = buildQuantizeTable(E, DORIAN, extra('blue b5'))!;
    expect(plain[46]).toBe(45);   // Bb2 -> A2 under plain E dorian
    expect(blue[46]).toBe(46);    // Bb2 stays Bb2
    // Every other note of E dorian is untouched by the addition.
    for (let n = 0; n < 128; n++) if (n % 12 !== 10) expect(blue[n]).toBe(plain[n]);
  });

  it('places the fixed extras over the root', () => {
    expect(extraTone(C, MAJOR, extra('blue b5'))).toBe(6);
    expect(extraTone(C, MAJOR, extra('blue b3'))).toBe(3);
    expect(extraTone(C, MAJOR, extra('b7'))).toBe(10);
    expect(extraTone(C, MIXO, extra('maj 7'))).toBe(11);
    expect(extraTone(E, DORIAN, extra('blue b5'))).toBe(10);   // A#/Bb over E
  });

  it('adds nothing when the note is already in the scale (edge)', () => {
    expect(extraTone(E, DORIAN, extra('b7'))).toBeNull();
    expect(extraTone(C, BLUES, extra('blue b5'))).toBeNull();
    expect(buildQuantizeTable(E, DORIAN, extra('b7'))).toEqual(buildQuantizeTable(E, DORIAN));
  });

  it('is inert without a scale', () => {
    expect(buildQuantizeTable(C, 0, extra('blue b5'))).toBeNull();
    expect(extraTone(C, 0, extra('blue b5'))).toBeNull();
  });

  it('adds the mode\'s own bebop passing tone (REQ-bebop-is-relative-to-the-mode)', () => {
    const bebop = extra('bebop');
    expect(extraTone(C, MAJOR, bebop)).toBe(8);     // G#: major bebop
    expect(extraTone(C, MIXO, bebop)).toBe(11);     // B: dominant bebop
    expect(extraTone(C, DORIAN, bebop)).toBe(4);    // E: dorian bebop
    expect(extraTone(C, MINOR, bebop)).toBe(11);
    expect(extraTone(C, SCALE_LABELS.indexOf('harm minor'), bebop)).toBe(10);
    expect(extraTone(C, PENT_MAJ, bebop)).toBeNull();
    expect(extraTone(C, BLUES, bebop)).toBeNull();
  });

  it('is never a degree', () => {
    const blue = extra('blue b5');
    expect(scaleTones(E, DORIAN)).not.toContain(10);
    expect(scaleSize(DORIAN)).toBe(7);
    expect(degreeOf(46, E, DORIAN)).toBe(-1);
    // The writer's menu still has the mode's seven degrees, labelled as before.
    expect(degreeLabel(E, DORIAN, 0)).toBe('i — Em');
    expect(extraTone(E, DORIAN, blue)).toBe(10);
  });

  it('stays idempotent and bounded for every scale, root and extra (stability)', () => {
    const bad: string[] = [];
    for (let scale = 1; scale < SCALE_LABELS.length; scale++) {
      for (let root = 0; root < 12; root++) {
        for (let x = 1; x < EXTRA_LABELS.length; x++) {
          const t = buildQuantizeTable(root, scale, x)!;
          for (let n = 0; n < 128; n++) {
            const v = t[n]!;
            if (t[v] !== v || v > 127) bad.push(`${SCALE_LABELS[scale]} root ${root} ${EXTRA_LABELS[x]} note ${n}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// chord-tools.md REQ-a-voicing-is-at-most-four-notes (v3).
describe('extension voicings', () => {
  const v = (label: string): readonly number[] => chordDegrees(CHORD_LABELS.indexOf(label));

  it('never asks for more than four notes', () => {
    for (let i = 0; i < CHORD_LABELS.length; i++) expect(chordDegrees(i).length).toBeLessThanOrEqual(4);
  });

  it('keeps the existing voicings at their indices (append-only)', () => {
    expect(CHORD_LABELS.slice(0, 5)).toEqual(['off', 'triad', '7th', 'sus4', 'power']);
  });

  it('voices a 9th as 1-3-7-9 — ii in C major from D4 is D F C E', () => {
    expect(diatonicChord(62, C, MAJOR, v('9th'), 1)).toEqual([62, 65, 72, 76]);
  });

  it('stacks add9, 6th and sus2 from the scale', () => {
    expect(diatonicChord(60, C, MAJOR, v('add9'))).toEqual([60, 64, 67, 74]);
    expect(diatonicChord(60, C, MAJOR, v('6th'))).toEqual([60, 64, 67, 69]);
    expect(diatonicChord(60, C, MAJOR, v('sus2'))).toEqual([60, 62, 67]);
  });

  it('stays diatonic, so the quantizer passes it untouched (chord-tools.md REQ-chord-memory-is-diatonic)', () => {
    const t = buildQuantizeTable(C, MAJOR)!;
    for (const label of ['sus2', '6th', 'add9', '9th']) {
      for (let deg = 0; deg < 7; deg++) {
        for (const n of diatonicChord(60, C, MAJOR, v(label), deg)) expect(t[n]).toBe(n);
      }
    }
  });
});

// chord-tools.md REQ-the-writer-can-invert.
describe('invertChord', () => {
  const cMajor = [60, 64, 67];   // C4 E4 G4

  it('raises the lowest tones an octave, keeping the chord ascending', () => {
    expect(invertChord(cMajor, 0)).toEqual([60, 64, 67]);
    expect(invertChord(cMajor, 1)).toEqual([64, 67, 72]);
    expect(invertChord(cMajor, 2)).toEqual([67, 72, 76]);
    expect(invertChord([60, 64, 67, 71], 3)).toEqual([71, 72, 76, 79]);
  });

  it('clamps an inversion past the chord to the last one it has', () => {
    expect(invertChord(cMajor, 3)).toEqual(invertChord(cMajor, 2));
    expect(invertChord([60, 67], 2)).toEqual([67, 72]);   // a power chord has only 1st
    expect(invertChord(cMajor, -1)).toEqual(cMajor);
  });

  it('clamps into the MIDI range and de-duplicates', () => {
    expect(invertChord([120, 124, 127], 2)).toEqual([127]);
  });

  it('works on what diatonicChord writes', () => {
    const MAJOR_ = SCALE_LABELS.indexOf('major');
    const triad = diatonicChord(60, C, MAJOR_, chordDegrees(1));
    expect(invertChord(triad, 1)).toEqual([64, 67, 72]);
  });
});
