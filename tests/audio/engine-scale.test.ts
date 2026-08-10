import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../src/audio/engine';
import { ScaleQuantizer } from '../../src/audio/transport/scale-quantizer';
import { SCALE_LABELS, CHORD_LABELS } from '../../src/utils/music';

/**
 * The keyboard/MIDI note passthrough under an active key and chord memory
 * (voicing.md REQ-8, scale-quantization.md REQ-6, chord-tools.md REQ-5/REQ-7).
 *
 * A real `Engine` needs an AudioContext, worklet modules and an async `init()`, none
 * of which `handleNote` touches — it reads `scale` / `heldIn` and calls
 * `playNote`/`releaseNote`. So it runs against a structural stub via
 * `Engine.prototype`, pinning the **production** method rather than a copy of it —
 * the same shape as `engine-seek.test.ts`.
 */
function engineLike(scale = new ScaleQuantizer(), suppressed = false) {
  const playNote = vi.fn();
  const releaseNote = vi.fn();
  const stub = {
    scale,
    heldIn: new Map<number, number[]>(),
    arpPassthroughSuppressed: suppressed,
    playNote,
    releaseNote,
    handleNote: Engine.prototype.handleNote,
  } as unknown as Engine;
  return {
    playNote,
    releaseNote,
    heldIn: (stub as unknown as { heldIn: Map<number, number[]> }).heldIn,
    noteOn: (n: number, v = 0.8) => stub.handleNote(true, n, v),
    noteOff: (n: number) => stub.handleNote(false, n, 0),
  };
}

function inKey(name: string, root = 0): ScaleQuantizer {
  const s = new ScaleQuantizer();
  s.setRoot(root);
  s.setScale(SCALE_LABELS.indexOf(name));
  return s;
}

/** The note arg of each call, in order. */
function notes(fn: ReturnType<typeof vi.fn>): number[] {
  return fn.mock.calls.map((c) => c[0] as number);
}

describe('note passthrough — key quantization', () => {
  it('plays nothing itself while the arp owns the note stream', () => {
    const { playNote, noteOn } = engineLike(inKey('major'), true);
    noteOn(61);
    expect(playNote).not.toHaveBeenCalled();
  });

  it('is a pure passthrough while chromatic (back-compat)', () => {
    const { playNote, releaseNote, noteOn, noteOff } = engineLike();
    noteOn(61, 0.7);
    noteOff(61);
    expect(playNote).toHaveBeenCalledWith(61, 0.7);
    expect(releaseNote).toHaveBeenCalledWith(61);
  });

  it('quantizes the played note and releases the SAME note', () => {
    const { playNote, releaseNote, noteOn, noteOff } = engineLike(inKey('major'));
    noteOn(61);
    noteOff(61);
    expect(notes(playNote)).toEqual([60]);
    expect(notes(releaseNote)).toEqual([60]);
  });

  it('releases what it started when the key changes mid-hold (REQ-6, regression)', () => {
    // THE hanging-note bug this map exists to prevent: re-deriving the mapping on
    // release would look up a note Polyphony never started, and the voice would
    // ring forever.
    const scale = inKey('major');
    const { playNote, releaseNote, noteOn, noteOff } = engineLike(scale);
    noteOn(61);
    expect(notes(playNote)).toEqual([60]);

    scale.setRoot(1);           // the player changes key while still holding
    noteOff(61);
    expect(notes(releaseNote)).toEqual([60]); // not 61, and not the new key's answer
  });

  it('releases what it started when chord memory is switched on mid-hold (edge)', () => {
    const scale = inKey('major');
    const { releaseNote, noteOn, noteOff } = engineLike(scale);
    noteOn(60);
    scale.setChord(CHORD_LABELS.indexOf('triad'));
    noteOff(60);
    expect(notes(releaseNote)).toEqual([60]); // one note in, one note out
  });

  it('forgets the key once it is released, so the map cannot grow', () => {
    const { heldIn, noteOn, noteOff } = engineLike(inKey('major'));
    noteOn(61);
    expect(heldIn.size).toBe(1);
    noteOff(61);
    expect(heldIn.size).toBe(0);
  });

  it('still releases a note-off that never had a note-on (edge)', () => {
    // A stuck MIDI message, or a key held across a panic that cleared the map.
    const { releaseNote, noteOff } = engineLike(inKey('major'));
    noteOff(61);
    expect(notes(releaseNote)).toEqual([60]);
  });
});

describe('note passthrough — chord memory', () => {
  function withChord(voicing: string, poly = true) {
    const scale = inKey('major');
    scale.setChord(CHORD_LABELS.indexOf(voicing));
    scale.setPoly(poly);
    return engineLike(scale);
  }

  it('turns one held key into a triad (chord-tools.md REQ-5)', () => {
    const { playNote, noteOn } = withChord('triad');
    noteOn(60);
    expect(notes(playNote)).toEqual([60, 64, 67]);
  });

  it('builds the chord on the key that was pressed, not the scale root', () => {
    const { playNote, noteOn } = withChord('triad');
    noteOn(62);                                  // D -> ii in C major
    expect(notes(playNote)).toEqual([62, 65, 69]);
  });

  it('releases every note the chord started (regression)', () => {
    const { releaseNote, noteOn, noteOff } = withChord('7th');
    noteOn(60);
    noteOff(60);
    expect(notes(releaseNote)).toEqual([60, 64, 67, 71]);
  });

  it('does not expand in mono (chord-tools.md REQ-7)', () => {
    const { playNote, noteOn } = withChord('triad', false);
    noteOn(60);
    expect(notes(playNote)).toEqual([60]);
  });

  it('carries the note-on velocity to every note of the chord', () => {
    const { playNote, noteOn } = withChord('triad');
    noteOn(60, 0.4);
    for (const call of playNote.mock.calls) expect(call[1]).toBe(0.4);
  });

  it('roots the chord on the quantized note when the key is out of scale (edge)', () => {
    const { playNote, noteOn } = withChord('triad');
    noteOn(61);                                  // C# -> C, so the chord is C E G
    expect(notes(playNote)).toEqual([60, 64, 67]);
  });
});
