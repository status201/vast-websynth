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

  /**
   * voicing.md REQ-9. `heldNotes` maps a note to the voices playing it, and
   * `releaseNote` sends noteOff to whatever that entry names — so a stolen voice
   * left in its old note's entry means releasing the old key stops the new note.
   * Reachable by holding VOICE_COUNT notes and playing one more.
   */
  describe('voice stealing keeps heldNotes honest (REQ-9, regression)', () => {
    it('releasing the robbed note does not stop the voice that stole it', () => {
      const { voices, poly } = build(2);
      poly.playNote(60, 0.8, 0); // → voice0
      poly.playNote(62, 0.8, 1); // → voice1
      voices[0]!.noteOnAt = 0;
      voices[1]!.noteOnAt = 1;
      poly.playNote(64, 0.8, 2); // pool full → steals voice0, which now plays 64
      voices[0]!.noteOff.mockClear();

      poly.releaseNote(60, 3);   // 60 is not sounding any more — nothing to stop
      expect(voices[0]!.noteOff).not.toHaveBeenCalled();
      expect(voices[0]!.state).toBe('playing');
    });

    it('still releases the note the stolen voice actually plays', () => {
      const { voices, poly } = build(2);
      poly.playNote(60, 0.8, 0);
      poly.playNote(62, 0.8, 1);
      voices[0]!.noteOnAt = 0;
      voices[1]!.noteOnAt = 1;
      poly.playNote(64, 0.8, 2); // voice0 now plays 64
      voices[0]!.noteOff.mockClear();

      poly.releaseNote(64, 3);
      expect(voices[0]!.noteOff).toHaveBeenCalledTimes(1);
    });

    it('leaves untouched notes owning their own voices', () => {
      const { voices, poly } = build(2);
      poly.playNote(60, 0.8, 0);
      poly.playNote(62, 0.8, 1);
      voices[0]!.noteOnAt = 0;
      voices[1]!.noteOnAt = 1;
      poly.playNote(64, 0.8, 2); // steals voice0 only
      voices[1]!.noteOff.mockClear();

      poly.releaseNote(62, 3);   // 62 still owns voice1
      expect(voices[1]!.noteOff).toHaveBeenCalledTimes(1);
    });

    it('does not disturb allocation while the pool has idle voices', () => {
      const { voices, poly } = build(4);
      poly.playNote(60, 0.8, 0);
      poly.playNote(62, 0.8, 1);
      poly.releaseNote(60, 2);
      poly.releaseNote(62, 2);
      expect(voices[0]!.noteOff).toHaveBeenCalledTimes(1);
      expect(voices[1]!.noteOff).toHaveBeenCalledTimes(1);
    });

    it('drops only the unison copies a new note actually took', () => {
      const { voices, poly } = build(4);
      poly.setUnisonCount(2);
      poly.playNote(60, 0.8, 0);  // takes voice0 + voice1
      poly.playNote(62, 0.8, 1);  // takes voice2 + voice3
      for (const [i, v] of voices.entries()) v.noteOnAt = i < 2 ? 0 : 1;
      // Pool full. The stub never advances noteOnAt, so both picks land on the
      // same oldest voice — 60 loses voice0 and keeps voice1.
      poly.playNote(64, 0.8, 2);
      voices[0]!.noteOff.mockClear();
      voices[1]!.noteOff.mockClear();

      poly.releaseNote(60, 3);
      // The stolen copy belongs to 64 now and must not be stopped...
      expect(voices[0]!.noteOff).not.toHaveBeenCalled();
      // ...while the copy 60 still owns is released normally.
      expect(voices[1]!.noteOff).toHaveBeenCalledTimes(1);
    });
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

  it('runs the drift interval only while drift > 0 (voicing.md REQ-4)', () => {
    const { ctx, poly } = build();
    const offset = ctx.createConstantSource.mock.results[0]!.value.offset;

    vi.advanceTimersByTime(1000); // default drift 0 — no timer at all
    expect(offset.setTargetAtTime).not.toHaveBeenCalled();

    poly.setDrift(0.5);
    vi.advanceTimersByTime(330); // 3 × 110 ms wander steps
    expect(offset.setTargetAtTime).toHaveBeenCalledTimes(3);

    poly.setDrift(0); // stops the timer and settles the detune back to 0
    expect(offset.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.12);
    const calls = offset.setTargetAtTime.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(offset.setTargetAtTime.mock.calls.length).toBe(calls);
  });
});
