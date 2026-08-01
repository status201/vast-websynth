import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Voice } from '../../src/audio/voice';
import {
  makeMockAudioContext,
  installMockAudioWorkletNode,
  MockAudioWorkletNode,
} from './mock-audio-context';

/**
 * Voice lifecycle → ladder-filter idle gating (ladder-filter.md REQ-10,
 * voicing.md REQ-7). The filter worklet is the mock node; we assert the
 * active-flag posts on its port.
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
    const port = MockAudioWorkletNode.instances[0]!.port;
    return { voice, port };
  }

  it('boots idle: posts false at construction', async () => {
    const { port } = await build();
    expect(port.postMessage).toHaveBeenLastCalledWith(false);
  });

  it('noteOn posts true unconditionally on every call', async () => {
    const { voice, port } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.noteOn(62, 0.8, 1); // retrigger while playing — still posts
    const flags = port.postMessage.mock.calls.map((c) => c[0]);
    expect(flags).toEqual([false, true, true]);
  });

  it('release completion deactivates the filter', async () => {
    const { voice, port } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.noteOff(0);
    vi.runAllTimers(); // the releaseTimer
    expect(voice.state).toBe('idle');
    expect(port.postMessage).toHaveBeenLastCalledWith(false);
  });

  it('kill deactivates after the fade window', async () => {
    const { voice, port } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.kill(0);
    vi.advanceTimersByTime(50);
    expect(port.postMessage).toHaveBeenLastCalledWith(false);
  });

  it('a noteOn inside the kill fade window wins — no late deactivate', async () => {
    const { voice, port } = await build();
    voice.noteOn(60, 0.8, 0);
    voice.kill(0);
    voice.noteOn(64, 0.8, 0); // voice re-claimed before the fade timer fires
    vi.advanceTimersByTime(50);
    expect(port.postMessage).toHaveBeenLastCalledWith(true);
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

  it('raises cutoff with the note, in semitones (REQ-2)', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(90);
    voice.setFilterKeytrack(0.5);
    voice.noteOn(72, 0.8, 0); // an octave above centre
    // 90 + 0.5 * (72 - 60) = 96, landed at the note rather than ramped (REQ-4).
    expect(stepped(cutoff)).toBe(96);
  });

  it('lowers it below the centre note by the same rule', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(90);
    voice.setFilterKeytrack(0.5);
    voice.noteOn(48, 0.8, 0);
    expect(stepped(cutoff)).toBe(84);
  });

  it('is a no-op at its default, whatever the note (REQ-1)', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(90);
    voice.noteOn(96, 0.8, 0);
    // keytrack 0 writes nothing at all — the base value stands alone.
    expect(stepped(cutoff)).toBeUndefined();
    expect(ramped(cutoff)).toBe(90);
  });

  it('leaves the centre note untouched at any amount (REQ-2)', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(90);
    voice.noteOn(60, 0.8, 0);
    for (const amt of [0.25, 0.5, 1]) {
      voice.setFilterKeytrack(amt);
      expect(ramped(cutoff)).toBe(90);
    }
  });

  it('recomputes under a held note rather than waiting for the next one (REQ-6)', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(90);
    voice.noteOn(72, 0.8, 0);
    voice.setFilterKeytrack(1); // knob drag mid-note → ramped, not stepped
    expect(ramped(cutoff)).toBe(102);
    voice.setFilterCutoff(80); // and the cutoff knob keeps the offset
    expect(ramped(cutoff)).toBe(92);
  });

  it('clamps an extreme note to the cutoff range (REQ-5)', async () => {
    const { voice, cutoff } = await build();
    voice.setFilterCutoff(130);
    voice.setFilterKeytrack(1);
    voice.noteOn(127, 0.8, 0); // 130 + 67 = 197, far past the worklet's max
    expect(stepped(cutoff)).toBe(135);
  });
});
