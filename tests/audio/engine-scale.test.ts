import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../../src/audio/engine';
import { ScaleQuantizer } from '../../src/audio/transport/scale-quantizer';
import { SCALE_LABELS, CHORD_LABELS, EXTRA_LABELS } from '../../src/utils/music';

/**
 * The keyboard/MIDI note passthrough under an active key and chord memory
 * (voicing.md REQ-passthrough-remembers-what-it-played, scale-quantization.md REQ-resolve-once-release-the-stored-note, chord-tools.md REQ-chord-memory-is-diatonic/REQ-mono-gates-the-live-chord-path).
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
    heldIn: new Map<number, unknown>(),
    arpPassthroughSuppressed: suppressed,
    playNote,
    releaseNote,
    handleNote: Engine.prototype.handleNote,
  } as unknown as Engine;
  return {
    playNote,
    releaseNote,
    heldIn: (stub as unknown as { heldIn: Map<number, unknown> }).heldIn,
    noteOn: (n: number, v = 0.8, source?: string) => stub.handleNote(true, n, v, source),
    noteOff: (n: number, source?: string) => stub.handleNote(false, n, 0, source),
    /** Switch the arp's gate mid-test (voicing.md REQ-passthrough-remembers-what-it-played v8). */
    setSuppressed: (on: boolean) => { (stub as unknown as { arpPassthroughSuppressed: boolean }).arpPassthroughSuppressed = on; },
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

  it('releases what it started when the key changes mid-hold (REQ-resolve-once-release-the-stored-note, regression)', () => {
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

  it('turns one held key into a triad (chord-tools.md REQ-chord-memory-is-diatonic)', () => {
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

  it('does not expand in mono (chord-tools.md REQ-mono-gates-the-live-chord-path)', () => {
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

// scale-quantization.md REQ-an-extra-note-is-admitted-not-a-degree (v4).
describe('note passthrough — the extra note', () => {
  function eDorianBlue(voicing = 'off'): ScaleQuantizer {
    const s = inKey('dorian', 4);
    s.setExtra(EXTRA_LABELS.indexOf('blue b5'));
    s.setChord(CHORD_LABELS.indexOf(voicing));
    return s;
  }

  it('plays a blue b5 as written, where plain E dorian snaps it to A', () => {
    const plain = engineLike(inKey('dorian', 4));
    plain.noteOn(46);
    expect(notes(plain.playNote)).toEqual([45]);

    const blue = engineLike(eDorianBlue());
    blue.noteOn(46);
    expect(notes(blue.playNote)).toEqual([46]);
  });

  it('plays the extra note alone under chord memory — a passing tone has no chord', () => {
    const { playNote, releaseNote, noteOn, noteOff } = engineLike(eDorianBlue('triad'));
    noteOn(46);
    noteOff(46);
    expect(notes(playNote)).toEqual([46]);
    expect(notes(releaseNote)).toEqual([46]);
  });

  it('still stacks a chord on a real degree beside it', () => {
    const { playNote, noteOn } = engineLike(eDorianBlue('triad'));
    noteOn(40);                                  // E -> E G B
    expect(notes(playNote)).toEqual([40, 43, 47]);
  });
});

// voicing.md REQ-passthrough-remembers-what-it-played (v8) — the arp gate used to swallow note-offs as well.
describe('Engine.handleNote across the arp switching on', () => {
  it('releases a key held as the arp came on (regression)', () => {
    const e = engineLike();
    e.noteOn(60);                 // sounds through the passthrough
    e.setSuppressed(true);        // the arp is switched on mid-hold
    e.noteOff(60);                // the bug: this release was dropped and the voice rang on
    expect(notes(e.releaseNote)).toEqual([60]);
    expect(e.heldIn.size).toBe(0);
  });

  it('neither plays nor releases a key pressed while the arp owns the stream', () => {
    const e = engineLike(new ScaleQuantizer(), true);
    e.noteOn(64);
    e.noteOff(64);
    expect(e.playNote).not.toHaveBeenCalled();
    expect(e.releaseNote).not.toHaveBeenCalled();
  });
});

// voicing.md REQ-a-note-sounds-while-any-source-holds-it (regression): the
// on-screen key stayed lit until the last finger lifted, but the note stopped at
// the first — one heldIn entry per key, released by whichever note-off came first.
describe('Engine.handleNote with a key held by two sources', () => {
  it('keeps sounding until the last source lets go', () => {
    const e = engineLike();
    e.noteOn(60, 0.8, 'pointer:1');
    e.noteOn(60, 0.8, 'pointer:2'); // a second finger on the same key
    e.noteOff(60, 'pointer:1');
    expect(e.releaseNote).not.toHaveBeenCalled();
    e.noteOff(60, 'pointer:2');
    expect(notes(e.releaseNote)).toEqual([60]);
    expect(e.heldIn.size).toBe(0);
  });

  it('a finger and the computer key work the same way', () => {
    const e = engineLike();
    e.noteOn(60, 0.8, 'keys');
    e.noteOn(60, 0.8, 'pointer:7');
    e.noteOff(60, 'keys');
    expect(e.releaseNote).not.toHaveBeenCalled();
    e.noteOff(60, 'pointer:7');
    expect(notes(e.releaseNote)).toEqual([60]);
  });

  it('a source repeating its note-on (a MIDI retrigger) is released by its one note-off', () => {
    const e = engineLike();
    e.noteOn(60, 0.8, 'midi');
    e.noteOn(60, 0.8, 'midi');
    expect(notes(e.playNote)).toEqual([60, 60]); // re-struck, as before
    e.noteOff(60, 'midi');
    expect(notes(e.releaseNote)).toEqual([60]);
    expect(e.heldIn.size).toBe(0);
  });

  it('a note-off from a source that never pressed the key releases nothing', () => {
    const e = engineLike();
    e.noteOn(60, 0.8, 'keys');
    e.noteOff(60, 'midi');
    expect(e.releaseNote).not.toHaveBeenCalled();
    e.noteOff(60, 'keys');
    expect(notes(e.releaseNote)).toEqual([60]);
  });

  it('a second press re-strikes what the key is sounding, even after a key change', () => {
    const scale = new ScaleQuantizer();
    const e = engineLike(scale);
    e.noteOn(61, 0.8, 'pointer:1');          // chromatic: C#4
    scale.setScale(SCALE_LABELS.indexOf('major')); // now C major would map 61 elsewhere
    e.noteOn(61, 0.8, 'pointer:2');
    expect(notes(e.playNote)).toEqual([61, 61]);
    e.noteOff(61, 'pointer:1');
    e.noteOff(61, 'pointer:2');
    expect(notes(e.releaseNote)).toEqual([61]); // nothing stranded
  });
});
