import { describe, it, expect } from 'vitest';
import { Wah } from '../../src/audio/effects/wah';
import { Phaser } from '../../src/audio/effects/phaser';
import { Delay } from '../../src/audio/effects/delay';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { SYNC_LABELS } from '../../src/utils/tempo';
import { makeMockAudioContext, type MockAudioParam } from './mock-audio-context';

/**
 * The wah / phaser / delay tempo lock (tempo-lock.md REQ-7).
 *
 * All three go through `bindTempoLocked`, so what is under test is really one
 * mechanism seen from three angles — plus the two quantities it dispatches on
 * (`freq` for the two LFO-driven effects, `time` for the delay).
 *
 * The setters are `setTargetAtTime`, so the value in force is the last one that
 * `AudioParam` was targeted at, exactly as `tests/audio/lfo.test.ts` reads it.
 */

const QUARTER = SYNC_LABELS.indexOf('1/4');
const EIGHTH = SYNC_LABELS.indexOf('1/8');

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

/** The most recent value this param was targeted at. */
function targeted(p: MockAudioParam): number | undefined {
  const calls = p.setTargetAtTime.mock.calls;
  return calls.length === 0 ? undefined : (calls[calls.length - 1]![0] as number);
}

describe('FX tempo lock', () => {
  describe('a rate effect (freq)', () => {
    it('takes its rate from the tempo while locked, and follows a tempo change', () => {
      const ctx = makeMockAudioContext();
      const b = bus();
      const wah = new Wah(ctx as unknown as AudioContext);
      const lfoFreq = (ctx.createOscillator.mock.results[0]!.value as { frequency: MockAudioParam })
        .frequency;
      wah.bind(b, 'fx.wah');

      b.set('fx.wah.sync', QUARTER);
      expect(targeted(lfoFreq)).toBeCloseTo(2, 6); // 120 BPM: a quarter is 0.5 s

      b.set('transport.bpm', 60);
      expect(targeted(lfoFreq)).toBeCloseTo(1, 6); // and it tracks the tempo down
    });

    it('leaves the knob value alone, so unlocking restores it exactly', () => {
      const ctx = makeMockAudioContext();
      const b = bus();
      const phaser = new Phaser(ctx as unknown as AudioContext);
      const lfoFreq = (ctx.createOscillator.mock.results[0]!.value as { frequency: MockAudioParam })
        .frequency;
      phaser.bind(b, 'fx.phaser');

      b.set('fx.phaser.rate', 1.7);
      b.set('fx.phaser.sync', EIGHTH);
      expect(targeted(lfoFreq)).toBeCloseTo(4, 6); // 120 BPM: an eighth is 0.25 s
      expect(b.get('fx.phaser.rate')).toBe(1.7); // never rewritten

      b.set('fx.phaser.sync', 0);
      expect(targeted(lfoFreq)).toBeCloseTo(1.7, 6);
    });
  });

  describe('the delay (time)', () => {
    it('takes its time from the tempo in seconds, not Hz', () => {
      const ctx = makeMockAudioContext();
      const b = bus();
      const delay = new Delay(ctx as unknown as AudioContext);
      const delayTime = (ctx.createDelay.mock.results[0]!.value as { delayTime: MockAudioParam })
        .delayTime;
      delay.bind(b, 'fx.delay');

      b.set('fx.delay.sync', EIGHTH);
      expect(targeted(delayTime)).toBeCloseTo(0.25, 6); // 0.25 s, not 4 Hz

      b.set('transport.bpm', 60);
      expect(targeted(delayTime)).toBeCloseTo(0.5, 6);
    });
  });

  // ADR-006: the whole back-compat story is that `free` changes nothing.
  it('is an exact no-op while free — a tempo change moves nothing', () => {
    const ctx = makeMockAudioContext();
    const b = bus();
    const delay = new Delay(ctx as unknown as AudioContext);
    const delayTime = (ctx.createDelay.mock.results[0]!.value as { delayTime: MockAudioParam })
      .delayTime;
    delay.bind(b, 'fx.delay');
    b.set('fx.delay.time', 0.42);

    const before = delayTime.setTargetAtTime.mock.calls.length;
    b.set('transport.bpm', 90);
    b.set('transport.bpm', 140);

    // The subscription still fires; what it applies is the knob's own value, so
    // nothing about the sound moves.
    for (const call of delayTime.setTargetAtTime.mock.calls.slice(before)) {
      expect(call[0]).toBeCloseTo(0.42, 6);
    }
  });

  // The delay is the one param whose range a division can leave: 1/1 at 60 BPM
  // is 4 s against a registered max of 1.5. The UI greys that row (REQ-6); audio
  // clamps nothing new, so the DelayNode's own pre-existing 2 s ceiling is what
  // holds — and no patch that already stored such a value changes.
  it('does not clamp a division to the registered range', () => {
    const ctx = makeMockAudioContext();
    const b = bus();
    const delay = new Delay(ctx as unknown as AudioContext);
    const delayTime = (ctx.createDelay.mock.results[0]!.value as { delayTime: MockAudioParam })
      .delayTime;
    delay.bind(b, 'fx.delay');

    b.set('transport.bpm', 60);
    b.set('fx.delay.sync', SYNC_LABELS.indexOf('1/1'));
    expect(targeted(delayTime)).toBe(2); // 4 s, held at the DelayNode's own ceiling
    expect(b.def('fx.delay.time')!.max).toBe(1.5);
  });
});
