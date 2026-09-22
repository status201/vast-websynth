// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Voice } from '../../src/audio/voice';
import { Engine } from '../../src/audio/engine';
import {
  makeMockAudioContext,
  installMockAudioWorkletNode,
} from './mock-audio-context';

/**
 * The per-voice spread stage (sequencer.md REQ-the-spread-stage-engages-off-centre,
 * ADR-023). The claim under test is the expensive one: while every sequencer
 * track is centred the panned edge is not merely silent but **disconnected**, so
 * the voice bus stays 1-channel and the insert chain keeps its mono cost.
 */
describe('Voice spread stage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installMockAudioWorkletNode();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function build() {
    const ctx = makeMockAudioContext();
    const voice = await Voice.create(ctx as unknown as AudioContext);
    const bus = ctx.createGain();
    return { ctx, voice, bus };
  }

  it('connectTo wires the dry edge only, leaving the bus mono', async () => {
    const { voice, bus } = await build();
    voice.connectTo(bus as unknown as AudioNode);

    expect(voice.spreadDry.connect).toHaveBeenCalledWith(bus);
    expect(voice.panner.connect).not.toHaveBeenCalled();
  });

  it('feeds the panner MONO, so panning is constant power', async () => {
    const { voice } = await build();
    // Deliberately NOT forced to stereo. A StereoPanner given a stereo input
    // uses the FOLD law, where hard left is L + R on one side — measured at
    // +1.34 dB of mix power for one hard-panned track, i.e. a pan knob that is
    // also a volume knob. Mono gets the equal-power cos/sin law instead.
    expect(voice.spreadWet.channelCountMode).not.toBe('explicit');
  });

  it('compensates the equal-power centre so the stage splices in inaudibly', async () => {
    const { voice, bus } = await build();
    voice.connectTo(bus as unknown as AudioNode);
    voice.setSpread(true);
    // Equal-power centre is 0.7071; sqrt(2) puts it back to unity, which is what
    // the dry edge delivers — so the crossfade sums to the input throughout.
    expect(voice.spreadWet.gain.setTargetAtTime)
      .toHaveBeenCalledWith(Math.SQRT2, 0, expect.any(Number));
    expect(Math.SQRT2 * Math.cos(Math.PI / 4)).toBeCloseTo(1, 12);
  });

  it('engaging attaches the panned edge and crossfades onto it', async () => {
    const { voice, bus } = await build();
    voice.connectTo(bus as unknown as AudioNode);
    voice.setSpread(true);

    expect(voice.panner.connect).toHaveBeenCalledWith(bus);
    // Complementary targets, so at centre the two edges sum to exactly 1 the
    // whole way across and the splice is inaudible.
    expect(voice.spreadWet.gain.setTargetAtTime)
      .toHaveBeenCalledWith(Math.SQRT2, 0, expect.any(Number));
    expect(voice.spreadDry.gain.setTargetAtTime).toHaveBeenCalledWith(0, 0, expect.any(Number));
  });

  it('engaging twice does not re-attach the edge', async () => {
    const { voice, bus } = await build();
    voice.connectTo(bus as unknown as AudioNode);
    voice.setSpread(true);
    voice.setSpread(true);
    expect((voice.panner.connect as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('dropSpread cuts the edge, and only after it has been attached', async () => {
    const { voice, bus } = await build();
    voice.connectTo(bus as unknown as AudioNode);

    voice.dropSpread();                     // never engaged — nothing to cut
    expect(voice.panner.disconnect).not.toHaveBeenCalled();

    voice.setSpread(true);
    voice.setSpread(false);
    voice.dropSpread();
    expect(voice.panner.disconnect).toHaveBeenCalled();
  });

  it('a note carries its pan, written AT the note rather than now', async () => {
    const { voice } = await build();
    voice.noteOn(60, 0.8, 2.5, { pan: -0.75, panGroup: 1 });
    // The time argument is the note's own start: a voice stolen from another
    // track must not drag its new position back over the tail it replaces.
    expect(voice.panner.pan.setTargetAtTime)
      .toHaveBeenCalledWith(-0.75, 2.5, expect.any(Number));
  });

  it('a note with no pan opts is centred, which is what live keys and the arp send', async () => {
    const { voice } = await build();
    voice.noteOn(60, 0.8, 0);
    expect(voice.panner.pan.setTargetAtTime).toHaveBeenCalledWith(0, 0, expect.any(Number));
  });

  it('only the voices sounding that track follow its knob', async () => {
    const { voice } = await build();
    voice.noteOn(60, 0.8, 0, { pan: 0.5, panGroup: 2 });
    const before = (voice.panner.pan.setTargetAtTime as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    voice.setGroupPan(3, -1);   // a different track's knob
    expect((voice.panner.pan.setTargetAtTime as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(before);

    voice.setGroupPan(2, -1);   // its own
    expect(voice.panner.pan.setTargetAtTime).toHaveBeenLastCalledWith(-1, expect.any(Number), expect.any(Number));
  });
});

/**
 * The pan has to survive **four** hand-offs to reach a voice: sequencer →
 * `SynthOutput` → `Engine.playNote` → `Polyphony` → `Voice`. Dropping it at any
 * one of them is silent: every unit test still passes, the param still
 * registers, `param-wiring` still sees the id referenced, and the knob still
 * moves. It is only audible.
 *
 * That is not hypothetical — the `SynthOutput` adapter really was written
 * `(n, v, w) => this.playNote(n, v, w)` and swallowed the opts, and nothing but
 * a rendered take caught it. Hence a pin on each end of that seam.
 */
describe('the pan survives the hand-off to the voice pool', () => {
  it('Engine.playNote forwards the opts to Polyphony', () => {
    const playNote = vi.fn();
    const stub = {
      polyphony: { playNote },
      playNote: Engine.prototype.playNote,
    };
    stub.playNote.call(stub as unknown as Engine, 60, 0.8, 1.5, { pan: -1, panGroup: 2 });
    expect(playNote).toHaveBeenCalledWith(60, 0.8, 1.5, { pan: -1, panGroup: 2 });
  });

  // The other end of the seam — the adapter closure itself — is pinned in
  // `engine-stereo.test.ts`, which runs under node and can read the source
  // (jsdom does not hand this file a file: URL).
});

/**
 * `Engine.updateSpread` decides for the whole pool. It runs against a structural
 * stub on `Engine.prototype` — the shape `engine-scale.test.ts` and
 * `engine-seek.test.ts` use — because the decision touches no audio node itself.
 */
describe('Engine spread decision', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function engineLike() {
    const setSpread = vi.fn();
    const dropSpread = vi.fn();
    const stub = {
      seqPans: [0, 0, 0, 0],
      spreadOn: false,
      spreadTimer: null,
      polyphony: { setSpread, dropSpread },
      updateSpread: (Engine.prototype as unknown as { updateSpread: () => void }).updateSpread,
    };
    return {
      setSpread,
      dropSpread,
      pan: (track: number, v: number) => {
        stub.seqPans[track] = v;
        (stub.updateSpread as () => void).call(stub);
      },
    };
  }

  it('stays out of circuit while every track is centred', () => {
    const { setSpread, dropSpread } = engineLike();
    expect(setSpread).not.toHaveBeenCalled();
    expect(dropSpread).not.toHaveBeenCalled();
  });

  it('engages on the first track to leave centre, once', () => {
    const e = engineLike();
    e.pan(0, -0.4);
    e.pan(2, 0.9);
    expect(e.setSpread).toHaveBeenCalledTimes(1);
    expect(e.setSpread).toHaveBeenCalledWith(true);
  });

  it('drops only after every track is back at centre, and only after the crossfade', () => {
    const e = engineLike();
    e.pan(0, 1);
    e.pan(1, 1);
    e.pan(0, 0);
    expect(e.setSpread).toHaveBeenCalledTimes(1);   // track 1 still off centre

    e.pan(1, 0);
    expect(e.setSpread).toHaveBeenLastCalledWith(false);
    expect(e.dropSpread).not.toHaveBeenCalled();    // the edge carries the fade out
    vi.advanceTimersByTime(1000);
    expect(e.dropSpread).toHaveBeenCalledTimes(1);
  });

  it('a motion lane sweeping across centre never tears the graph down at frame rate', () => {
    const e = engineLike();
    // `seq.t<i>.pan` is a registered param, so a motion lane can automate it at
    // 60fps (ADR-017 — automation is a bus concern). Crossing centre on every
    // frame must not connect/disconnect on every frame.
    for (let f = 0; f < 60; f++) {
      e.pan(0, f % 2 === 0 ? 0.5 : 0);
      vi.advanceTimersByTime(16);   // one frame at ~60fps
    }
    // 30 crossings of centre in a second, and the edge was never cut: each
    // disengage only SCHEDULES the drop, and the next frame's re-engage cancels
    // it well inside DISCONNECT_DELAY_MS.
    expect(e.dropSpread).not.toHaveBeenCalled();

    // A sustained return to centre is the only thing that does drop it.
    e.pan(0, 0);
    vi.advanceTimersByTime(1000);
    expect(e.dropSpread).toHaveBeenCalledTimes(1);
  });

  it('a knob wiggled back across centre cancels the pending drop', () => {
    const e = engineLike();
    e.pan(0, 0.5);
    e.pan(0, 0);        // schedules the drop
    e.pan(0, 0.5);      // changed their mind before it fired
    vi.advanceTimersByTime(1000);
    expect(e.dropSpread).not.toHaveBeenCalled();
  });
});
