import { describe, it, expect } from 'vitest';
import { keyRole, onKeyChange, readKeyState } from '../../src/ui/key-roles';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { SCALE_LABELS, CHORD_LABELS } from '../../src/utils/music';

/**
 * The one owner of the role vocabulary (scale-quantization.md REQ-9 / REQ-10).
 *
 * Two surfaces colour keys by musical role — the KEY tab's map and the playable
 * keyboard — and the reason this module exists is that they must never disagree about
 * which note is the root. So the derivation and the precedence are pinned here, once,
 * rather than twice against two DOM trees.
 */

const MAJOR = SCALE_LABELS.indexOf('major');
const TRIAD = CHORD_LABELS.indexOf('triad');

function bus(): ParamBus {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

const sorted = (s: ReadonlySet<number>) => [...s].sort((a, b) => a - b);

describe('readKeyState', () => {
  it('reports chromatic as inactive, with every pitch class admitted', () => {
    // Both halves matter and they are read by different surfaces: the map lights
    // everything (REQ-9), while `active` is what tells the keyboard to show nothing
    // at all (REQ-10).
    const s = readKeyState(bus());
    expect(s.active).toBe(false);
    expect(sorted(s.tones)).toHaveLength(12);
    expect(s.chord.size).toBe(0);
  });

  it('narrows to the scale once one is chosen', () => {
    const b = bus();
    b.set('scale.type', MAJOR);
    const s = readKeyState(b);
    expect(s.active).toBe(true);
    expect(sorted(s.tones)).toEqual([0, 2, 4, 5, 7, 9, 11]); // C major
  });

  it('follows the root', () => {
    const b = bus();
    b.set('scale.type', MAJOR);
    b.set('scale.root', 2); // D major
    const s = readKeyState(b);
    expect(s.root).toBe(2);
    expect(sorted(s.tones)).toEqual([1, 2, 4, 6, 7, 9, 11]);
  });

  it('previews the tonic chord of the current voicing, and nothing while it is off', () => {
    // Chord memory has no chord until a key is held, so the tonic stands in — that is
    // what lets the voicing control show its effect before anything is played.
    const b = bus();
    b.set('scale.type', MAJOR);
    expect(readKeyState(b).chord.size).toBe(0);

    b.set('chord.voicing', TRIAD);
    expect(sorted(readKeyState(b).chord)).toEqual([0, 4, 7]); // C E G
  });

  it('has no chord while chromatic, whatever the voicing says', () => {
    const b = bus();
    b.set('chord.voicing', TRIAD);
    expect(readKeyState(b).chord.size).toBe(0);
  });
});

describe('keyRole precedence', () => {
  it('reads root, then chord tone, then in scale, then out', () => {
    const b = bus();
    b.set('scale.type', MAJOR);
    b.set('chord.voicing', TRIAD);
    const s = readKeyState(b);

    expect(keyRole(0, s)).toBe('root');    // C — also a chord tone and a scale tone
    expect(keyRole(4, s)).toBe('chord');   // E
    expect(keyRole(2, s)).toBe('scale');   // D
    expect(keyRole(1, s)).toBe('out');     // C#
  });

  it('calls every pitch class in-scale while chromatic', () => {
    const s = readKeyState(bus());
    for (let pc = 1; pc < 12; pc++) expect(keyRole(pc, s)).toBe('scale');
    expect(keyRole(0, s)).toBe('root');
  });
});

describe('onKeyChange', () => {
  it('paints exactly once on wire-up, not once per param', () => {
    const b = bus();
    let calls = 0;
    onKeyChange(b, () => { calls++; });
    expect(calls).toBe(1);
  });

  it('repaints on each of the three params', () => {
    const b = bus();
    let calls = 0;
    onKeyChange(b, () => { calls++; });
    calls = 0;

    b.set('scale.root', 5);
    b.set('scale.type', MAJOR);
    b.set('chord.voicing', TRIAD);
    expect(calls).toBe(3);
  });

  it('does not repaint on voicing.mode — mono changes nothing about the picture', () => {
    const b = bus();
    let calls = 0;
    onKeyChange(b, () => { calls++; });
    calls = 0;

    b.set('voicing.mode', 0);
    expect(calls).toBe(0);
  });
});
