// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Polyphony } from '../../src/audio/polyphony';
import type { Voice } from '../../src/audio/voice';
import { makeMockAudioContext } from './mock-audio-context';
import { LIVE_MARGIN_MAX_S } from '../../src/audio/param-utils';

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
    noteOn: vi.fn((_n: number, _v: number, _t: number, _o?: { retriggerAmp?: boolean; retriggerFil?: boolean }) => { v.state = 'playing'; }),
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
   * voicing.md REQ-a-stolen-voice-leaves-the-held-list. `heldNotes` maps a note to the voices playing it, and
   * `releaseNote` sends noteOff to whatever that entry names — so a stolen voice
   * left in its old note's entry means releasing the old key stops the new note.
   * Reachable by holding VOICE_COUNT notes and playing one more.
   */
  describe('voice stealing keeps heldNotes honest (REQ-a-stolen-voice-leaves-the-held-list, regression)', () => {
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

  it('runs the drift interval only while drift > 0 (voicing.md REQ-analogue-drift-is-off-by-default)', () => {
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
  // v6 regression (voicing.md REQ-a-stolen-voice-leaves-the-held-list). In mono
  // every note plays the SAME voices, so each held key left an entry naming
  // them — two keys down meant two entries pointing at one voice, and releasing
  // the older one sent noteOff to the voice sounding the newer note. Letting go
  // of a key you could no longer hear stopped the one you could.
  describe('mono holds the invariant too', () => {
    it('releasing an older key does not cut the note that is sounding', () => {
      const { voices, poly } = build();
      poly.setPoly(false);

      poly.playNote(48, 0.8, 0);   // C3
      poly.playNote(52, 0.8, 0);   // E3 — same voice, mono
      voices[0]!.noteOff.mockClear();

      poly.releaseNote(48, 0);     // let go of the key that is no longer heard

      expect(voices[0]!.noteOff).not.toHaveBeenCalled();
      expect(voices[0]!.state).toBe('playing');
    });

    it('releasing the sounding key still stops it', () => {
      const { voices, poly } = build();
      poly.setPoly(false);

      poly.playNote(48, 0.8, 0);
      poly.playNote(52, 0.8, 0);
      poly.releaseNote(52, 0);

      expect(voices[0]!.noteOff).toHaveBeenCalledTimes(1);
    });

    it('still releases a single held note', () => {
      const { voices, poly } = build();
      poly.setPoly(false);

      poly.playNote(48, 0.8, 0);
      poly.releaseNote(48, 0);

      expect(voices[0]!.noteOff).toHaveBeenCalledTimes(1);
    });
  });

  describe('a live note starts ahead of the render (voicing.md REQ-a-live-note-starts-ahead-of-the-render)', () => {
    // Anchored at bare currentTime, a note could land a render burst in the
    // past, and its attack then rendered most of the way to peak on its first
    // sample: 22 of 110 live note-ons clicked through the real graph, 0 of 92
    // scheduled 3-50 ms ahead.
    const at = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)![2] as number;

    it('places an unscheduled note and its release one burst (baseLatency) ahead', () => {
      const { ctx, voices, poly } = build();
      ctx.currentTime = 5;
      (ctx as unknown as { baseLatency: number }).baseLatency = 0.01;
      poly.playNote(60, 0.8);
      expect(at(voices[0]!.noteOn)).toBeCloseTo(5.01, 12);
      poly.releaseNote(60);
      // Same margin, so the release never lands before the attack.
      expect(voices[0]!.noteOff.mock.calls.at(-1)![0]).toBeCloseTo(5.01, 12);
    });

    it('takes one render quantum on an offline context, which has no burst to outrun', () => {
      // The mock has no getOutputTimestamp, which only a realtime AudioContext has.
      const { ctx, voices, poly } = build();
      ctx.currentTime = 1;
      poly.playNote(60, 0.8);
      expect(at(voices[0]!.noteOn)).toBeCloseTo(1 + 128 / ctx.sampleRate, 12);
    });

    it('takes the ceiling on a realtime context that reports no burst (Gecko: baseLatency 0)', () => {
      // 10 ms was measured too short in Gecko (2 of 9 onsets still clicked); 20 ms held.
      const { ctx, voices, poly } = build();
      ctx.currentTime = 1;
      Object.assign(ctx, { baseLatency: 0, getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) });
      poly.playNote(60, 0.8);
      expect(at(voices[0]!.noteOn)).toBeCloseTo(1 + LIVE_MARGIN_MAX_S, 12);
    });

    it('never adds more than LIVE_MARGIN_MAX_S, whatever the device reports', () => {
      const { ctx, voices, poly } = build();
      ctx.currentTime = 1;
      (ctx as unknown as { baseLatency: number }).baseLatency = 0.5;
      poly.playNote(60, 0.8);
      expect(at(voices[0]!.noteOn)).toBeCloseTo(1 + LIVE_MARGIN_MAX_S, 12);
    });

    it('leaves a note that carries its own time exactly where it was put', () => {
      const { ctx, voices, poly } = build();
      ctx.currentTime = 2;
      (ctx as unknown as { baseLatency: number }).baseLatency = 0.01;
      poly.playNote(60, 0.8, 2.1); // a sequencer step, a look-ahead away
      expect(at(voices[0]!.noteOn)).toBe(2.1);
    });
  });
  type Call = [number, number, number, { retriggerAmp?: boolean; retriggerFil?: boolean }?];
  /** What each noteOn on `v` asked of the AMP envelope: true = struck, false = continued. */
  const strikes = (v: ReturnType<typeof fakeVoice>) =>
    (v.noteOn.mock.calls as unknown as Call[]).map(([, , , o]) => o?.retriggerAmp ?? true);
  /** The same, for the FILTER envelope. */
  const sweeps = (v: ReturnType<typeof fakeVoice>) =>
    (v.noteOn.mock.calls as unknown as Call[]).map(([, , , o]) => o?.retriggerFil ?? true);

  describe('a legato note takes over the held voices (voicing.md REQ-a-legato-note-takes-over-the-held-voices)', () => {
    it('moves the held voice to the new pitch without striking it', () => {
      const { voices, poly } = build();
      poly.playNote(60, 0.8, 0);
      poly.playNote(64, 0.8, 0.125, { legatoFrom: 60 });
      expect(voices[0]!.noteOn.mock.calls.map(([n]) => n)).toEqual([60, 64]);
      expect(strikes(voices[0]!)).toEqual([true, false]);
      expect(sweeps(voices[0]!)).toEqual([true, false]);
      // No second voice was taken.
      expect(voices.slice(1).every((v) => v.noteOn.mock.calls.length === 0)).toBe(true);
    });

    it('files the voice under the new note: releasing 64 stops it, releasing 60 does nothing', () => {
      const { voices, poly } = build();
      poly.playNote(60, 0.8, 0);
      poly.playNote(64, 0.8, 0.125, { legatoFrom: 60 });
      poly.releaseNote(60, 0.2);
      expect(voices[0]!.noteOff).not.toHaveBeenCalled();
      poly.releaseNote(64, 0.25);
      expect(voices[0]!.noteOff).toHaveBeenCalledWith(0.25);
    });

    it('continues a same-pitch note on its own voices', () => {
      const { voices, poly } = build();
      poly.setUnisonCount(2);
      poly.playNote(60, 0.8, 0);
      poly.playNote(60, 0.3, 0.125, { legatoFrom: 60 });
      expect(strikes(voices[0]!)).toEqual([true, false]);
      expect(strikes(voices[1]!)).toEqual([true, false]);
      poly.releaseNote(60, 0.3);
      expect(voices[0]!.noteOff).toHaveBeenCalledTimes(1);
      expect(voices[1]!.noteOff).toHaveBeenCalledTimes(1);
    });

    it('joins a pitch another track already holds, so one release stops both (edge)', () => {
      const { voices, poly } = build();
      poly.playNote(64, 0.8, 0); // another track's note → voice0
      poly.playNote(60, 0.8, 0); // the tied note → voice1
      poly.playNote(64, 0.8, 0.125, { legatoFrom: 60 });
      expect(strikes(voices[1]!)).toEqual([true, false]);
      poly.releaseNote(64, 0.3);
      expect(voices[0]!.noteOff).toHaveBeenCalledWith(0.3);
      expect(voices[1]!.noteOff).toHaveBeenCalledWith(0.3);
    });

    it('falls back to a struck note when the held voices were stolen (edge)', () => {
      const { voices, poly } = build(1);
      poly.playNote(60, 0.8, 0);   // the tied note
      poly.playNote(67, 0.8, 0.1); // another track steals the only voice
      voices[0]!.noteOn.mockClear();
      poly.playNote(64, 0.8, 0.125, { legatoFrom: 60 });
      expect(strikes(voices[0]!)).toEqual([true]);
      // Nothing still claims 60, so a later release of it touches no voice.
      voices[0]!.noteOff.mockClear();
      poly.releaseNote(60, 0.2);
      expect(voices[0]!.noteOff).not.toHaveBeenCalled();
    });

    it('releases what is left of the old note when it cannot continue it (edge)', () => {
      const { voices, poly } = build();
      poly.playNote(60, 0.8, 0);
      voices[0]!.state = 'releasing'; // a voice no longer playing cannot be continued
      poly.playNote(64, 0.8, 0.125, { legatoFrom: 60 });
      expect(voices[0]!.noteOff).toHaveBeenCalledWith(0.125);
      expect(voices.some((v) => v.noteOn.mock.calls.some(([n]) => n === 64))).toBe(true);
    });

    it('continues in mono on the fixed voices', () => {
      const { voices, poly } = build();
      poly.setPoly(false);
      poly.playNote(60, 0.8, 0);
      poly.playNote(64, 0.8, 0.125, { legatoFrom: 60 });
      expect(strikes(voices[0]!)).toEqual([true, false]);
    });

    /** The levelGlide each noteOn on `v` carried. */
    const glides = (v: ReturnType<typeof fakeVoice>) =>
      (v.noteOn.mock.calls as unknown as [number, number, number, { levelGlide?: number }?][])
        .map(([, , , o]) => o?.levelGlide);

    it('hands the legato glide to the continued voices, in poly and mono', () => {
      for (const poly_ of [true, false]) {
        const { voices, poly } = build();
        poly.setPoly(poly_);
        poly.playNote(60, 0.2, 0);
        poly.playNote(60, 0.6, 0.125, { legatoFrom: 60, legatoGlide: 0.125 });
        expect(glides(voices[0]!)).toEqual([undefined, 0.125]);
      }
    });

    it('a single-trigger overlap carries no glide: live legato keeps its first level', () => {
      const { voices, poly } = build();
      poly.setPoly(false);
      poly.setSingleTrigger('amp', true);
      poly.playNote(48, 0.2, 0);
      poly.playNote(52, 0.9, 0.1); // 48 still held, no legatoFrom
      expect(strikes(voices[0]!)).toEqual([true, false]);
      expect(glides(voices[0]!)).toEqual([undefined, undefined]);
    });

    it('a stolen tie strikes fresh, so it carries no glide either (edge)', () => {
      const { voices, poly } = build(1);
      poly.playNote(60, 0.8, 0);
      poly.playNote(67, 0.8, 0.1); // steals the only voice
      voices[0]!.noteOn.mockClear();
      poly.playNote(64, 0.3, 0.125, { legatoFrom: 60, legatoGlide: 0.125 });
      expect(strikes(voices[0]!)).toEqual([true]);
      expect(glides(voices[0]!)).toEqual([undefined]);
    });
  });

  describe('single trigger legatos a mono line (voicing.md REQ-single-trigger-legatos-a-mono-line)', () => {
    it('does not re-strike a note played over a held one', () => {
      const { voices, poly } = build();
      poly.setPoly(false);
      poly.setSingleTrigger('amp', true);
      poly.setSingleTrigger('fil', true);
      poly.playNote(48, 0.8, 0);
      poly.playNote(52, 0.8, 0.1); // C3 still held
      expect(strikes(voices[0]!)).toEqual([true, false]);
      expect(sweeps(voices[0]!)).toEqual([true, false]);
    });

    it('keeps each envelope on its own switch: single amp, multi filter', () => {
      const { voices, poly } = build();
      poly.setPoly(false);
      poly.setSingleTrigger('amp', true);
      poly.playNote(48, 0.8, 0);
      poly.playNote(52, 0.8, 0.1);
      expect(strikes(voices[0]!)).toEqual([true, false]); // the level runs on
      expect(sweeps(voices[0]!)).toEqual([true, true]);   // the filter re-sweeps
    });

    it('and the reverse: multi amp, single filter', () => {
      const { voices, poly } = build();
      poly.setPoly(false);
      poly.setSingleTrigger('fil', true);
      poly.playNote(48, 0.8, 0);
      poly.playNote(52, 0.8, 0.1);
      expect(strikes(voices[0]!)).toEqual([true, true]);
      expect(sweeps(voices[0]!)).toEqual([true, false]);
    });

    it('a legato tie continues both, whatever the switches say', () => {
      const { voices, poly } = build();
      poly.setPoly(false);
      poly.playNote(48, 0.8, 0);
      poly.playNote(52, 0.8, 0.1, { legatoFrom: 48 });
      expect(strikes(voices[0]!)).toEqual([true, false]);
      expect(sweeps(voices[0]!)).toEqual([true, false]);
    });

    it('re-strikes a detached note, played after every key is up', () => {
      const { voices, poly } = build();
      poly.setPoly(false);
      poly.setSingleTrigger('amp', true);
      poly.setSingleTrigger('fil', true);
      poly.playNote(48, 0.8, 0);
      poly.releaseNote(48, 0.05);
      poly.playNote(52, 0.8, 0.1);
      expect(strikes(voices[0]!)).toEqual([true, true]);
    });

    it('changes nothing at multi, the default (back-compat)', () => {
      const { voices, poly } = build();
      poly.setPoly(false);
      poly.playNote(48, 0.8, 0);
      poly.playNote(52, 0.8, 0.1);
      expect(strikes(voices[0]!)).toEqual([true, true]);
    });

    it('is ignored in poly, where every note has its own voice', () => {
      const { voices, poly } = build();
      poly.setSingleTrigger('amp', true);
      poly.setSingleTrigger('fil', true);
      poly.playNote(48, 0.8, 0);
      poly.playNote(52, 0.8, 0.1);
      expect(strikes(voices[0]!)).toEqual([true]);
      expect(strikes(voices[1]!)).toEqual([true]);
    });
  });
});
