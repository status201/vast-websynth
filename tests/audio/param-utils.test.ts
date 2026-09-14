import { describe, it, expect, vi } from 'vitest';
import {
  RAMP_FAST,
  RAMP_MEDIUM,
  RAMP_SMOOTH,
  RAMP_BYPASS,
  rampTo,
} from '../../src/audio/param-utils';

function mockAudioParam(): AudioParam {
  return {
    value: 0,
    defaultValue: 0,
    minValue: 0,
    maxValue: 1,
    automationRate: 'a-rate',
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    cancelAndHoldAtTime: vi.fn(),
  } as unknown as AudioParam;
}

describe('param-utils', () => {
  it('exports named time constants', () => {
    expect(RAMP_FAST).toBe(0.005);
    expect(RAMP_MEDIUM).toBe(0.01);
    expect(RAMP_SMOOTH).toBe(0.02);
    expect(RAMP_BYPASS).toBe(0.025);
  });

  it('rampTo calls setTargetAtTime with the correct args', () => {
    const param = mockAudioParam();
    const ctx = { currentTime: 42 } as AudioContext;
    rampTo(param, 0.8, ctx, RAMP_MEDIUM);
    expect(param.setTargetAtTime).toHaveBeenCalledWith(0.8, 42, 0.01);
  });

  it('rampTo uses default time constant when omitted', () => {
    const ctx = { currentTime: 10 } as AudioContext;
    const param = mockAudioParam();
    rampTo(param, 0.5, ctx);
    expect(param.setTargetAtTime).toHaveBeenCalledWith(0.5, 10, 0.005);
  });

  // No cancel-then-ramp helper (architecture.md): rampTo retargets from wherever
  // the curve has reached, so the smoothing vocabulary never cancels.
  it('rampTo never cancels scheduled values', () => {
    const ctx = { currentTime: 7 } as AudioContext;
    const param = mockAudioParam();
    rampTo(param, 0.3, ctx, RAMP_SMOOTH);
    expect(param.cancelScheduledValues).not.toHaveBeenCalled();
  });
});
