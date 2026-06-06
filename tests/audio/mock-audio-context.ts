import { vi } from 'vitest';

/**
 * Minimal mock AudioContext for unit-testing transport modules that build a
 * Web Audio graph in their constructor (DrumMachine, SamplerMachine,
 * Performance) without a real `AudioContext`.
 *
 * Every node is a generic chainable stub: `connect(target)` returns its
 * argument so production `a.connect(b).connect(c)` chains build silently, and
 * `AudioParam`-like fields expose the scheduling methods as `vi.fn()` so tests
 * can assert ramp calls. It is intentionally permissive — it satisfies the
 * graph wiring, not audio correctness.
 */

export interface MockAudioParam {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

export function makeParam(value = 0): MockAudioParam {
  return {
    value,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

function baseNode(): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  // connect returns its target so chains build; disconnect is a no-op spy.
  node.connect = vi.fn((target: unknown) => target);
  node.disconnect = vi.fn();
  return node;
}

export function makeMockBiquadFilter() {
  return {
    ...baseNode(),
    type: 'lowpass' as BiquadFilterType,
    frequency: makeParam(350),
    Q: makeParam(1),
    detune: makeParam(0),
    gain: makeParam(0),
  };
}

export interface MockAudioContext {
  currentTime: number;
  sampleRate: number;
  createGain: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
  createBiquadFilter: ReturnType<typeof vi.fn>;
  createConstantSource: ReturnType<typeof vi.fn>;
  createWaveShaper: ReturnType<typeof vi.fn>;
  createBuffer: ReturnType<typeof vi.fn>;
}

export function makeMockAudioContext(sampleRate = 44100): MockAudioContext {
  const ctx = {
    currentTime: 0,
    sampleRate,
    createGain: vi.fn(() => ({ ...baseNode(), gain: makeParam(1) })),
    createOscillator: vi.fn(() => ({
      ...baseNode(),
      type: 'sine' as OscillatorType,
      frequency: makeParam(440),
      detune: makeParam(0),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createBufferSource: vi.fn(() => ({
      ...baseNode(),
      buffer: null as AudioBuffer | null,
      loop: false,
      playbackRate: makeParam(1),
      onended: null as (() => void) | null,
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createBiquadFilter: vi.fn(() => makeMockBiquadFilter()),
    createConstantSource: vi.fn(() => ({
      ...baseNode(),
      offset: makeParam(0),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createWaveShaper: vi.fn(() => ({
      ...baseNode(),
      curve: null as Float32Array | null,
      oversample: 'none' as OverSampleType,
    })),
    createBuffer: vi.fn((channels: number, length: number, sr: number) => {
      const data: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate: sr,
        duration: length / sr,
        getChannelData: (ch: number) => data[ch]!,
      };
    }),
  };
  return ctx as unknown as MockAudioContext;
}

/** A throwaway AudioBuffer-shaped object for sampler-slot tests. */
export function makeStubBuffer(length = 100, sampleRate = 44100, channels = 1): AudioBuffer {
  const data: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (ch: number) => data[ch]!,
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
}
