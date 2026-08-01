import { describe, it, expect, vi } from 'vitest';
import { Osc, PWM_BANK_SIZE, PWM_MIN_WIDTH, PWM_MAX_WIDTH } from '../../src/audio/oscillator';
import { makeMockAudioContext } from './mock-audio-context';

/**
 * Pulse-width modulation on the oscillator (oscillators.md REQ-5, REQ-6).
 *
 * The duty bank is `PeriodicWave`s swapped onto the *live* node, so the two
 * things worth pinning are: the default stays the native square (an exact
 * no-op for every existing preset), and a sweep never replaces the node.
 */

const SQUARE = 3;
const SAW = 2;

function build() {
  const ctx = makeMockAudioContext();
  // `createPeriodicWave` isn't part of the shared mock — PWM is the only caller.
  const waves: Array<{ real: Float32Array; imag: Float32Array }> = [];
  (ctx as unknown as Record<string, unknown>).createPeriodicWave = vi.fn(
    (real: Float32Array, imag: Float32Array) => {
      const w = { real, imag };
      waves.push(w);
      return w;
    },
  );
  const osc = new Osc(ctx as unknown as AudioContext);
  const node = ctx.createOscillator.mock.results[0]!.value as {
    type: string;
    setPeriodicWave: ReturnType<typeof vi.fn>;
  };
  node.setPeriodicWave = vi.fn();
  return { ctx, osc, node, waves };
}

describe('Osc pulse width', () => {
  it('defaults to the native square — an exact no-op (REQ-5)', () => {
    const { osc, node } = build();
    osc.setWave(SQUARE);
    expect(node.type).toBe('square');
    expect(node.setPeriodicWave).not.toHaveBeenCalled();
  });

  it('setting width back to 0.5 restores the native square', () => {
    const { osc, node } = build();
    osc.setWave(SQUARE);
    osc.setPulseWidth(0.8);
    expect(node.setPeriodicWave).toHaveBeenCalledTimes(1);

    osc.setPulseWidth(PWM_MIN_WIDTH);
    expect(node.type).toBe('square');
    expect(node.setPeriodicWave).toHaveBeenCalledTimes(1); // no second wave applied
  });

  it('ignores width on every waveform but square', () => {
    const { osc, node } = build();
    osc.setWave(SAW);
    osc.setPulseWidth(0.9);
    expect(node.type).toBe('sawtooth');
    expect(node.setPeriodicWave).not.toHaveBeenCalled();
  });

  it('applies a standing width when the wave becomes square', () => {
    const { osc, node } = build();
    osc.setWave(SAW);
    osc.setPulseWidth(0.9); // set while inert
    expect(node.setPeriodicWave).not.toHaveBeenCalled();

    osc.setWave(SQUARE); // …picked up without a further knob move
    expect(node.setPeriodicWave).toHaveBeenCalledTimes(1);
  });

  it('sweeps on the same live node, never replacing it', () => {
    const { ctx, osc, node } = build();
    osc.setWave(SQUARE);
    for (let i = 1; i <= 20; i++) osc.setPulseWidth(0.5 + i * 0.02);
    expect(node.setPeriodicWave.mock.calls.length).toBeGreaterThan(1);
    // One oscillator for the lifetime of the Osc — phase is preserved (REQ-6).
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
  });

  it('only touches the node when the duty moves to a new bank entry', () => {
    const { osc, node } = build();
    osc.setWave(SQUARE);
    osc.setPulseWidth(0.8);
    const after = node.setPeriodicWave.mock.calls.length;
    // The control loop calls this at PWM_CONTROL_HZ; identical values must be free.
    for (let i = 0; i < 50; i++) osc.setPulseWidth(0.8);
    expect(node.setPeriodicWave.mock.calls.length).toBe(after);
  });

  it('clamps out-of-range and non-finite widths', () => {
    const { osc, node } = build();
    osc.setWave(SQUARE);
    osc.setPulseWidth(99);
    const calls = node.setPeriodicWave.mock.calls.length;
    osc.setPulseWidth(PWM_MAX_WIDTH); // already there after the clamp
    expect(node.setPeriodicWave.mock.calls.length).toBe(calls);

    osc.setPulseWidth(Number.NaN); // dropped, not written
    expect(node.setPeriodicWave.mock.calls.length).toBe(calls);
  });
});

describe('the duty bank', () => {
  it('is built once per context and shared across oscillators', () => {
    const { ctx, osc, waves } = build();
    osc.setWave(SQUARE);
    osc.setPulseWidth(0.7);
    expect(waves.length).toBe(PWM_BANK_SIZE);

    const second = new Osc(ctx as unknown as AudioContext);
    const node2 = ctx.createOscillator.mock.results[1]!.value as Record<string, unknown>;
    node2.setPeriodicWave = vi.fn();
    second.setWave(SQUARE);
    second.setPulseWidth(0.7);
    expect(waves.length).toBe(PWM_BANK_SIZE); // no rebuild
  });

  it('carries no DC term, so the pulse stays centred at every width', () => {
    const { osc, waves } = build();
    osc.setWave(SQUARE);
    osc.setPulseWidth(0.7);
    for (const w of waves) {
      expect(w.real[0]).toBe(0);
      expect(w.imag[0]).toBe(0);
    }
  });

  it('is an exact square at index 0 and narrows from there', () => {
    const { osc, waves } = build();
    osc.setWave(SQUARE);
    osc.setPulseWidth(0.7);

    // a[1] = (2/pi)*sin(pi*d): maximal at d=0.5, shrinking as the pulse narrows.
    const first = waves[0]!.real[1]!;
    const last = waves[PWM_BANK_SIZE - 1]!.real[1]!;
    expect(first).toBeCloseTo(2 / Math.PI, 6);
    expect(last).toBeLessThan(first);
    expect(last).toBeGreaterThan(0);
  });
});
