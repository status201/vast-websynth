import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Polyphony } from '../../src/audio/polyphony';
import type { Voice } from '../../src/audio/voice';
import { makeMockAudioContext } from './mock-audio-context';

/**
 * A minimal Voice stub: Polyphony only reads `state`/`noteOnAt`/`noteOffAt` and
 * calls `noteOn`/`noteOff`/`kill` (+ `osc*.detuneParam` for drift wiring). Real
 * Voices need the ladder-filter worklet, so we fake them like the transport
 * suites fake the audio graph.
 */
function fakeVoice() {
  const v = {
    state: 'idle' as 'idle' | 'playing' | 'releasing',
    noteOnAt: 0,
    noteOffAt: 0,
    osc1: { detuneParam: {} },
    osc2: { detuneParam: {} },
    sub: { detuneParam: {} },
    noteOn: vi.fn(() => { v.state = 'playing'; }),
    noteOff: vi.fn(() => { v.state = 'releasing'; }),
    kill: vi.fn(() => { v.state = 'idle'; }),
  };
  return v;
}

function build(n = 4) {
  const ctx = makeMockAudioContext();
  const voices = Array.from({ length: n }, fakeVoice);
  const poly = new Polyphony(ctx as unknown as AudioContext, voices as unknown as Voice[]);
  return { ctx, voices, poly };
}

describe('Polyphony', () => {
  // Polyphony starts a drift interval in its ctor; fake timers keep it inert.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays a note on an idle voice (poly)', () => {
    const { voices, poly } = build();
    poly.playNote(60, 0.8, 0);
    expect(voices[0]!.noteOn).toHaveBeenCalledTimes(1);
    expect(voices[0]!.state).toBe('playing');
  });

  it('releases every voice held for a note', () => {
    const { voices, poly } = build();
    poly.playNote(60, 0.8, 0);
    poly.releaseNote(60, 0);
    expect(voices[0]!.noteOff).toHaveBeenCalledTimes(1);
  });

  it('steals the oldest playing voice when all are busy', () => {
    const { voices, poly } = build(2);
    poly.playNote(60, 0.8, 0); // → voice0
    poly.playNote(62, 0.8, 1); // → voice1
    voices[0]!.noteOnAt = 0;
    voices[1]!.noteOnAt = 1;
    poly.playNote(64, 0.8, 2); // both busy → steal oldest (voice0)
    expect(voices[0]!.noteOn).toHaveBeenCalledTimes(2);
  });

  it('unison stacks N voices per note', () => {
    const { voices, poly } = build(4);
    poly.setUnisonCount(3);
    poly.playNote(60, 0.8, 0);
    const played = voices.filter((v) => v.noteOn.mock.calls.length > 0).length;
    expect(played).toBe(3);
  });

  it('switching poly→mono kills all voices so none hang', () => {
    const { voices, poly } = build();
    poly.playNote(60, 0.8, 0);
    poly.setPoly(false); // changed from default poly(true)
    for (const v of voices) expect(v.kill).toHaveBeenCalled();
  });

  it('does not kill voices when the mode is unchanged', () => {
    const { voices, poly } = build();
    poly.setPoly(true); // already poly by default
    for (const v of voices) expect(v.kill).not.toHaveBeenCalled();
  });
});
