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
