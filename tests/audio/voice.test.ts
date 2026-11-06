// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Voice } from '../../src/audio/voice';
import {
  makeMockAudioContext,
  installMockAudioWorkletNode,
  MockAudioWorkletNode,
} from './mock-audio-context';

/**
 * Voice lifecycle → ladder-filter idle gating (ladder-filter.md REQ-the-filter-idles-when-gated,
 * voicing.md REQ-voice-lifecycle-gates-the-ladder). The filter worklet is the mock node; we assert the
 * writes to its `active` param — scheduled, never a port message
 * (REQ-the-gate-is-scheduled-not-messaged).
 */
describe('Voice filter idle gating', () => {
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
    const node = MockAudioWorkletNode.instances[0]!;
    const gate = node.parameters.get('active').setValueAtTime;
    return { ctx, voice, node, gate };
  }

  it('boots idle: closes the gate at construction', async () => {
    const { gate } = await build();
    expect(gate).toHaveBeenLastCalledWith(0, 0);
  });

  it('noteOn opens the gate unconditionally on every call', async () => {
    const { voice, gate } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.noteOn(62, 0.8, 1); // retrigger while playing — still writes
    expect(gate.mock.calls.map((c) => c[0])).toEqual([0, 1, 1]);
  });

  it("wakes the filter on the envelope's clock, not by message (REQ-the-gate-is-scheduled-not-messaged)", async () => {
    // A port message landed whenever the audio thread got to it; when that was
    // a block or two after the attack began, the note started on silence and
    // jumped in under an open VCA — 9 of 12 note-ons to idle voices clicked.
    const { ctx, voice, node, gate } = await build();
    ctx.currentTime = 2;
    const attack = voice.ampEnv.out.gain.setValueAtTime as unknown as ReturnType<typeof vi.fn>;
    attack.mockClear();
    voice.noteOn(60, 0.8, 2.05); // a sequencer note, a look-ahead away
    expect(gate).toHaveBeenLastCalledWith(1, 2);
    // The attack's anchor is at or after the gate's time, so the filter is
    // awake by the block the VCA opens in.
    const anchorAt = attack.mock.calls.at(-1)![1] as number;
    expect(anchorAt).toBeGreaterThanOrEqual(2);
    expect(node.port.postMessage).not.toHaveBeenCalled();
  });

  it('release completion deactivates the filter', async () => {
    const { voice, gate } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.noteOff(0);
    vi.runAllTimers(); // the releaseTimer
    expect(voice.state).toBe('idle');
    expect(gate).toHaveBeenLastCalledWith(0, expect.any(Number));
  });

  it('kill deactivates after the fade window', async () => {
    const { voice, gate } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.kill(0);
    vi.advanceTimersByTime(50);
    expect(gate).toHaveBeenLastCalledWith(0, expect.any(Number));
  });

  it('a noteOn inside the kill fade window wins — no late deactivate', async () => {
    const { voice, gate } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.kill(0);
    voice.noteOn(64, 0.8, 0); // voice re-claimed before the fade timer fires
    vi.advanceTimersByTime(50);
    expect(gate).toHaveBeenLastCalledWith(1, expect.any(Number));
  });
});

/**
 * Key tracking: the played note offsets cutoff in semitone space
 * (key-tracking.md). Note 60 is the centre, so the offset there is always zero.
 */
describe('Voice filter key tracking', () => {
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
    const cutoff = MockAudioWorkletNode.instances[0]!.parameters.get('cutoffNote');
    return { voice, cutoff };
  }

  /** The last value `rampTo` (setTargetAtTime) aimed the base cutoff at. */
  const ramped = (p: { setTargetAtTime: ReturnType<typeof vi.fn> }) =>
    p.setTargetAtTime.mock.calls.at(-1)?.[0] as number | undefined;
  /** The last value scheduled instantly — how a note applies its offset. */
  const stepped = (p: { setValueAtTime: ReturnType<typeof vi.fn> }) =>
    p.setValueAtTime.mock.calls.at(-1)?.[0] as number | undefined;

  it('raises cutoff with the note, in semitones (REQ-cutoff-is-note-units)', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(90);
    voice.setFilterKeytrack(0.5);
    voice.noteOn(72, 0.8, 0); // an octave above centre
    // 90 + 0.5 * (72 - 60) = 96, landed at the note rather than ramped (REQ-filter-modulation-is-additive-semitones).
    expect(stepped(cutoff)).toBe(96);
  });

  it('lowers it below the centre note by the same rule', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(90);
    voice.setFilterKeytrack(0.5);
    voice.noteOn(48, 0.8, 0);
    expect(stepped(cutoff)).toBe(84);
  });

  it('is a no-op at its default, whatever the note (REQ-four-filter-params)', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(90);
    voice.noteOn(96, 0.8, 0);
    // keytrack 0 writes nothing at all — the base value stands alone.
    expect(stepped(cutoff)).toBeUndefined();
    expect(ramped(cutoff)).toBe(90);
  });

  it('leaves the centre note untouched at any amount (REQ-cutoff-is-note-units)', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(90);
    voice.noteOn(60, 0.8, 0);
    for (const amt of [0.25, 0.5, 1]) {
      voice.setFilterKeytrack(amt);
      expect(ramped(cutoff)).toBe(90);
    }
  });

  it('recomputes under a held note rather than waiting for the next one (REQ-input-and-poles-are-saturated)', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(90);
    voice.noteOn(72, 0.8, 0);
    voice.setFilterKeytrack(1); // knob drag mid-note → ramped, not stepped
    expect(ramped(cutoff)).toBe(102);
    voice.setFilterCutoff(80); // and the cutoff knob keeps the offset
    expect(ramped(cutoff)).toBe(92);
  });

  it('clamps an extreme note to the cutoff range (REQ-the-filter-worklet-module-is-awaited)', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(130);
    voice.setFilterKeytrack(1);
    voice.noteOn(127, 0.8, 0); // 130 + 67 = 197, far past the worklet's max
    expect(stepped(cutoff)).toBe(135);
  });
});

/**
 * Velocity → filter (envelopes.md REQ-filter-env-follows-velocity). The bug this closes: `noteOn`
 * triggered the amp envelope at the note's velocity and the filter envelope at a
 * hard-coded 1, so playing harder got louder and never brighter.
 *
 * Asserted at the envelope's PEAK, because that is what scales the sweep: the
 * filter envelope feeds `filEnvScale` (the `envAmount` semitone gain), which
 * sums onto the worklet's `cutoffNote`.
 */
describe('Voice velocity → filter envelope (REQ-the-filter-worklet-module-is-awaited)', () => {
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
    return { voice };
  }

  /** The peak each envelope was triggered at, captured via a spy on trigger. */
  function spyPeaks(voice: Voice) {
    const amp = vi.spyOn(voice.ampEnv, 'trigger');
    const fil = vi.spyOn(voice.filEnv, 'trigger');
    return {
      ampPeak: () => amp.mock.calls.at(-1)?.[1] as number | undefined,
      filPeak: () => fil.mock.calls.at(-1)?.[1] as number | undefined,
    };
  }

  it('leaves the filter envelope at full depth by default (ADR-006)', async () => {
    const { voice } = await build();
    const { filPeak } = spyPeaks(voice);
    voice.noteOn(60, 0.2, 0);
    expect(filPeak()).toBe(1);
    voice.noteOn(60, 1, 0);
    expect(filPeak()).toBe(1); // identical to the pre-v3 hard-coded 1
  });

  it('scales the sweep straight with velocity at full amount', async () => {
    const { voice } = await build();
    voice.setFilterVelAmount(1);
    const { filPeak, ampPeak } = spyPeaks(voice);
    voice.noteOn(60, 0.25, 0);
    expect(filPeak()).toBeCloseTo(0.25, 10);
    // The amp envelope is untouched by the setting — this shapes brightness,
    // not loudness.
    expect(ampPeak()).toBeCloseTo(0.25, 10);
  });

  it('interpolates at a partial amount, and never reaches silence', async () => {
    const { voice } = await build();
    voice.setFilterVelAmount(0.5);
    const { filPeak } = spyPeaks(voice);
    voice.noteOn(60, 0, 0);
    expect(filPeak()).toBeCloseTo(0.5, 10); // half depth, not none
    voice.noteOn(60, 1, 0);
    expect(filPeak()).toBeCloseTo(1, 10);
  });

  it('clamps the amount, so a bad param write cannot invert the sweep', async () => {
    const { voice } = await build();
    voice.setFilterVelAmount(5);
    const { filPeak } = spyPeaks(voice);
    voice.noteOn(60, 0.5, 0);
    expect(filPeak()).toBeCloseTo(0.5, 10); // as if amount were exactly 1
  });

  it('takes effect on the next note, not under a held one', async () => {
    const { voice } = await build();
    const { filPeak } = spyPeaks(voice);
    voice.noteOn(60, 0.4, 0);
    expect(filPeak()).toBe(1);
    voice.setFilterVelAmount(1); // knob moves while the note rings
    expect(filPeak()).toBe(1);   // the ringing note's sweep is already scheduled
    voice.noteOn(62, 0.4, 0.5);
    expect(filPeak()).toBeCloseTo(0.4, 10);
  });
});

/**
 * An idle voice is off the bus entirely (voicing.md REQ-an-idle-voice-is-unplugged):
 * the renderer pulls only what reaches the destination, so a silent voice's three
 * oscillators, gains and filter cost nothing. Measured with `npm run bench:perf`:
 * idle audio load 15.7% -> 4.8% of the callback in Blink.
 */
describe('Voice output edges (REQ-an-idle-voice-is-unplugged)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installMockAudioWorkletNode();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function onBus() {
    const ctx = makeMockAudioContext();
    const voice = await Voice.create(ctx as unknown as AudioContext);
    const bus = ctx.createGain();
    voice.connectTo(bus as unknown as AudioNode);
    const dry = voice.spreadDry as unknown as { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
    const pan = voice.panner as unknown as { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
    const toBus = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter((c) => c[0] === bus).length;
    return { voice, bus, dry, pan, toBus };
  }

  it('boots unplugged: neither edge reaches the bus until a note arrives', async () => {
    const { dry, pan, toBus } = await onBus();
    expect(toBus(dry.connect)).toBe(0);
    expect(toBus(pan.connect)).toBe(0);
  });

  it('a note plugs it in within the call, and a second note connects nothing twice', async () => {
    const { voice, dry, toBus } = await onBus();
    voice.noteOn(60, 0.8, 0.05); // a note a look-ahead away still plugs NOW
    expect(toBus(dry.connect)).toBe(1);
    voice.noteOn(62, 0.8, 0.1);
    expect(toBus(dry.connect)).toBe(1);
  });

  it('release completion unplugs it', async () => {
    const { voice, dry, toBus } = await onBus();
    voice.noteOn(60, 0.8, 0);
    voice.noteOff(0);
    expect(toBus(dry.disconnect)).toBe(0); // still releasing
    vi.runAllTimers();
    expect(voice.state).toBe('idle');
    expect(toBus(dry.disconnect)).toBe(1);
  });

  it('kill unplugs it after the fade window — unless a note re-claims it first', async () => {
    const killed = await onBus();
    killed.voice.noteOn(60, 0.8, 0);
    killed.voice.kill(0);
    vi.advanceTimersByTime(50);
    expect(killed.toBus(killed.dry.disconnect)).toBe(1);

    const reclaimed = await onBus();
    reclaimed.voice.noteOn(60, 0.8, 0);
    reclaimed.voice.kill(0);
    reclaimed.voice.noteOn(64, 0.8, 0);
    vi.advanceTimersByTime(50);
    expect(reclaimed.toBus(reclaimed.dry.disconnect)).toBe(0);
  });

  it('the spread stage never plugs an idle voice back in (edge)', async () => {
    const { voice, dry, pan, toBus } = await onBus();
    voice.setSpread(true);                 // engaged while the voice is idle
    expect(toBus(pan.connect)).toBe(0);
    voice.noteOn(60, 0.8, 0);              // the note brings both edges
    expect(toBus(dry.connect)).toBe(1);
    expect(toBus(pan.connect)).toBe(1);
    voice.noteOff(0);
    vi.runAllTimers();                     // and idling takes both down
    expect(toBus(dry.disconnect)).toBe(1);
    expect(toBus(pan.disconnect)).toBe(1);
  });
});

/**
 * A retrigger-free noteOn CONTINUES the note (voicing.md
 * REQ-a-legato-note-takes-over-the-held-voices): the pitch moves, the envelopes
 * do not start again. This is what makes a legato tie one note rather than a
 * re-pluck (sequencer.md REQ-a-tie-continues-the-note-without-retriggering).
 */
describe('Voice noteOn without a retrigger (REQ-a-legato-note-takes-over-the-held-voices)', () => {
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
    const amp = vi.spyOn(voice.ampEnv, 'trigger');
    const fil = vi.spyOn(voice.filEnv, 'trigger');
    const pitch = vi.spyOn(voice.osc1, 'setFrequency');
    return { voice, amp, fil, pitch };
  }

  it('moves the pitch but triggers neither envelope', async () => {
    const { voice, amp, fil, pitch } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.noteOn(64, 0.3, 0.125, { retriggerAmp: false, retriggerFil: false });
    expect(amp).toHaveBeenCalledTimes(1);
    expect(fil).toHaveBeenCalledTimes(1);
    expect(pitch).toHaveBeenCalledTimes(2);
    expect(voice.state).toBe('playing');
  });

  it('continues only the envelope it is told to (voicing.md REQ-single-trigger-legatos-a-mono-line)', async () => {
    const { voice, amp, fil } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.noteOn(64, 0.8, 0.125, { retriggerAmp: false }); // filter re-sweeps
    expect(amp).toHaveBeenCalledTimes(1);
    expect(fil).toHaveBeenCalledTimes(2);
    expect(voice.noteOnAt).toBe(0); // not a new strike: the level ran on
    voice.noteOn(67, 0.8, 0.25, { retriggerFil: false });  // level re-strikes
    expect(amp).toHaveBeenCalledTimes(2);
    expect(fil).toHaveBeenCalledTimes(2);
    expect(voice.noteOnAt).toBe(0.25);
  });

  it('keeps the first strike as its age, so the long tie is still the oldest note', async () => {
    const { voice } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.noteOn(64, 0.8, 0.125, { retriggerAmp: false, retriggerFil: false });
    expect(voice.noteOnAt).toBe(0);
  });

  it('still strikes by default', async () => {
    const { voice, amp, fil } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.noteOn(64, 0.8, 0.125);
    expect(amp).toHaveBeenCalledTimes(2);
    expect(fil).toHaveBeenCalledTimes(2);
    expect(voice.noteOnAt).toBe(0.125);
  });

  // sequencer.md REQ-a-tie-continues-the-note-without-retriggering: a continued
  // note follows the tied step's velocity over the step, without a new attack.
  const CONTINUE = { retriggerAmp: false, retriggerFil: false } as const;

  it('follows a new velocity: both envelopes rescale and the velocity source glides', async () => {
    const { voice, amp, fil } = await build();
    voice.setFilterVelAmount(1);
    const ampScale = vi.spyOn(voice.ampEnv, 'rescale');
    const filScale = vi.spyOn(voice.filEnv, 'rescale');
    const velGlide = voice.velocitySource.offset.setTargetAtTime as unknown as ReturnType<typeof vi.fn>;
    voice.noteOn(60, 0.2, 0);
    voice.noteOn(60, 0.6, 0.15, { ...CONTINUE, levelGlide: 0.15 });
    const tau = 0.15 / 3; // reaches ~95% by the step's end
    expect(ampScale).toHaveBeenCalledWith(0.15, 0.6, tau);
    expect(filScale).toHaveBeenCalledWith(0.15, 0.6, tau);
    expect(velGlide).toHaveBeenLastCalledWith(0.6, 0.15, tau);
    expect(amp).toHaveBeenCalledTimes(1); // never a new attack
    expect(fil).toHaveBeenCalledTimes(1);
    expect(voice.noteOnAt).toBe(0);
  });

  it('a ramp follows from where the last step left it, not from the first strike', async () => {
    const { voice } = await build();
    const ampScale = vi.spyOn(voice.ampEnv, 'rescale');
    voice.noteOn(60, 0.2, 0);
    voice.noteOn(60, 0.4, 0.15, { ...CONTINUE, levelGlide: 0.15 });
    voice.noteOn(60, 0.4, 0.30, { ...CONTINUE, levelGlide: 0.15 }); // unchanged: nothing
    voice.noteOn(60, 0.6, 0.45, { ...CONTINUE, levelGlide: 0.15 });
    expect(ampScale.mock.calls.map(([t, peak]) => [t, peak])).toEqual([[0.15, 0.4], [0.45, 0.6]]);
  });

  it('writes nothing at an unchanged velocity, or with no levelGlide', async () => {
    const { voice } = await build();
    const ampScale = vi.spyOn(voice.ampEnv, 'rescale');
    const filScale = vi.spyOn(voice.filEnv, 'rescale');
    const velGlide = voice.velocitySource.offset.setTargetAtTime as unknown as ReturnType<typeof vi.fn>;
    voice.noteOn(60, 0.5, 0);
    voice.noteOn(60, 0.5, 0.15, { ...CONTINUE, levelGlide: 0.15 }); // same velocity
    voice.noteOn(64, 0.9, 0.30, CONTINUE);                           // a single-trigger overlap
    expect(ampScale).not.toHaveBeenCalled();
    expect(filScale).not.toHaveBeenCalled();
    expect(velGlide).not.toHaveBeenCalled();
  });

  it('rescales only the envelope that is continued', async () => {
    const { voice } = await build();
    const ampScale = vi.spyOn(voice.ampEnv, 'rescale');
    const filScale = vi.spyOn(voice.filEnv, 'rescale');
    voice.noteOn(60, 0.2, 0);
    voice.noteOn(60, 0.6, 0.15, { retriggerAmp: false, levelGlide: 0.15 }); // filter re-sweeps
    expect(ampScale).toHaveBeenCalledTimes(1);
    expect(filScale).not.toHaveBeenCalled();
  });
});
