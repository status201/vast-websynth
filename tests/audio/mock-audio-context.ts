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
  audioWorklet: { addModule: ReturnType<typeof vi.fn> };
  createGain: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
  createBiquadFilter: ReturnType<typeof vi.fn>;
  createConstantSource: ReturnType<typeof vi.fn>;
  createWaveShaper: ReturnType<typeof vi.fn>;
  createStereoPanner: ReturnType<typeof vi.fn>;
  createBuffer: ReturnType<typeof vi.fn>;
}

export function makeMockAudioContext(sampleRate = 44100): MockAudioContext {
  // Nodes carry a back-reference to their context (production code reads
  // `node.context.currentTime`, e.g. BypassWrapper), assigned after `ctx`
  // exists via this helper.
  const withCtx = (node: Record<string, unknown>) => {
    node.context = ctx;
    return node;
  };
  const ctx = {
    currentTime: 0,
    sampleRate,
    audioWorklet: { addModule: vi.fn(async () => {}) },
    createGain: vi.fn(() => withCtx({ ...baseNode(), gain: makeParam(1) })),
    createOscillator: vi.fn(() => withCtx({
      ...baseNode(),
      type: 'sine' as OscillatorType,
      frequency: makeParam(440),
      detune: makeParam(0),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createBufferSource: vi.fn(() => withCtx({
      ...baseNode(),
      buffer: null as AudioBuffer | null,
      loop: false,
      playbackRate: makeParam(1),
      onended: null as (() => void) | null,
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createBiquadFilter: vi.fn(() => withCtx(makeMockBiquadFilter())),
    createConstantSource: vi.fn(() => withCtx({
      ...baseNode(),
      offset: makeParam(0),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createWaveShaper: vi.fn(() => withCtx({
      ...baseNode(),
      curve: null as Float32Array | null,
      oversample: 'none' as OverSampleType,
    })),
    createStereoPanner: vi.fn(() => withCtx({ ...baseNode(), pan: makeParam(0) })),
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

/**
 * A stand-in for the (jsdom-absent) global `AudioWorkletNode`. `parameters`
 * auto-creates a `MockAudioParam` per name so it works for any worklet, and
 * the constructor options (incl. `processorOptions`) are captured for
 * assertions.
 */
export class MockAudioWorkletNode {
  readonly parameters: { get: (name: string) => MockAudioParam };
  readonly port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: vi.fn() };
  readonly connect = vi.fn((target: unknown) => target);
  readonly disconnect = vi.fn();
  private readonly params = new Map<string, MockAudioParam>();

  constructor(
    readonly context: unknown,
    readonly workletName: string,
    readonly options?: { processorOptions?: Record<string, unknown> } & Record<string, unknown>,
  ) {
    this.parameters = {
      get: (name: string) => {
        let p = this.params.get(name);
        if (!p) { p = makeParam(); this.params.set(name, p); }
        return p;
      },
    };
    MockAudioWorkletNode.instances.push(this);
  }

  static instances: MockAudioWorkletNode[] = [];
}

/** Stub the global `AudioWorkletNode`; pair with `vi.unstubAllGlobals()`. */
export function installMockAudioWorkletNode(): typeof MockAudioWorkletNode {
  MockAudioWorkletNode.instances = [];
  vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);
  return MockAudioWorkletNode;
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
