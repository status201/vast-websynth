import { describe, it, expect } from 'vitest';
import { Osc } from '../../src/audio/oscillator';
import { makeMockAudioContext, type MockAudioParam } from './mock-audio-context';

/**
 * voicing.md REQ-glide-controls-portamento (v5). The bug this pins: the glide
 * branch of `Osc.setFrequency` cancelled and then went straight to
 * `setTargetAtTime`. A cancel leaves **no event** at `when`, so the approach
 * began at "the param's value" — which Blink reads off the automation curve and
 * Gecko reads as the last value *explicitly assigned*. On Firefox a glide
 * therefore left from the wrong pitch (often the 440 Hz the node is constructed
 * with) instead of from the note being left.
 *
 * The cancel itself has to stay: `osc.frequency` is written only from this
 * method, so a voice stolen from the sequencer still has that note's pitch
 * scheduled a lookahead ahead. So it is anchored instead — and the anchor is
 * COMPUTED, because `AudioParam.value` is the very thing that is unreliable
 * here.
 *
 * The behavioural half of this is by ear (recipes/verify-audio-by-ear.md): the
 * mock param has a static `value` and no event list, so only the shape of the
 * automation can be asserted here.
 */

const TAU = (glideSec: number): number => glideSec / 3;

function osc() {
  const ctx = makeMockAudioContext();
  const o = new Osc(ctx as unknown as AudioContext);
  // `createOscillator` is a spy returning the node the Osc kept.
  const node = ctx.createOscillator.mock.results[0]!.value as { frequency: MockAudioParam };
  return { o, freq: node.frequency };
}

/** The order calls were made in, as `name` strings. */
function order(freq: MockAudioParam): string[] {
  const calls: Array<{ name: string; order: number }> = [];
  for (const name of ['cancelScheduledValues', 'setValueAtTime', 'setTargetAtTime'] as const) {
    const fn = freq[name];
    fn.mock.invocationCallOrder.forEach((n) => calls.push({ name, order: n }));
  }
  return calls.sort((a, b) => a.order - b.order).map((c) => c.name);
}

describe('Osc.setFrequency glide anchoring', () => {
  it('pins a value between the cancel and the approach', () => {
    const { o, freq } = osc();
    o.setFrequency(220, 1, 0.3);

    expect(order(freq)).toEqual(['cancelScheduledValues', 'setValueAtTime', 'setTargetAtTime']);
    expect(freq.setTargetAtTime).toHaveBeenCalledWith(220, 1, TAU(0.3));
  });

  it('anchors the first glide at the node’s own starting frequency', () => {
    const { o, freq } = osc();
    o.setFrequency(220, 1, 0.3);
    // Nothing has played yet, so the curve is still where the constructor left it.
    expect(freq.setValueAtTime).toHaveBeenCalledWith(440, 1);
  });

  it('anchors a retrigger at the pitch the glide had actually reached', () => {
    const { o, freq } = osc();
    o.setFrequency(220, 0, 0.3); // 440 -> 220, tau = 0.1
    freq.setValueAtTime.mockClear();

    o.setFrequency(880, 0.1, 0.3); // one tau in: ~63% of the way from 440 to 220

    const [value, when] = freq.setValueAtTime.mock.calls[0] as [number, number];
    expect(when).toBe(0.1);
    // The closed form of a one-pole approach: 220 + (440-220)*e^-1 ≈ 300.9.
    expect(value).toBeCloseTo(220 + (440 - 220) * Math.exp(-1), 3);
    // Emphatically NOT the two values a broken implementation would use:
    // 440 (the last explicitly assigned value — the Gecko reading) or 220.
    expect(value).not.toBeCloseTo(440, 1);
    expect(value).not.toBeCloseTo(220, 1);
  });

  it('treats a settled glide as having arrived', () => {
    const { o, freq } = osc();
    o.setFrequency(220, 0, 0.3);
    freq.setValueAtTime.mockClear();

    o.setFrequency(880, 10, 0.3); // 100 tau later — arrived for any audible purpose

    const [value] = freq.setValueAtTime.mock.calls[0] as [number];
    expect(value).toBeCloseTo(220, 6);
  });

  it('still snaps, with no approach, when glide is off', () => {
    const { o, freq } = osc();
    o.setFrequency(330, 2, 0);

    expect(freq.setValueAtTime).toHaveBeenCalledWith(330, 2);
    expect(freq.setTargetAtTime).not.toHaveBeenCalled();
  });

  it('leaves a snap as the origin of the next glide', () => {
    const { o, freq } = osc();
    o.setFrequency(330, 0, 0);   // snap to 330
    freq.setValueAtTime.mockClear();

    o.setFrequency(660, 1, 0.3); // glide should start from 330, not 440

    expect(freq.setValueAtTime).toHaveBeenCalledWith(330, 1);
  });

  it('drops a non-finite frequency without touching the param', () => {
    const { o, freq } = osc();
    o.setFrequency(Number.POSITIVE_INFINITY, 1, 0.3);

    expect(freq.cancelScheduledValues).not.toHaveBeenCalled();
    expect(freq.setValueAtTime).not.toHaveBeenCalled();
    expect(freq.setTargetAtTime).not.toHaveBeenCalled();
  });
});
