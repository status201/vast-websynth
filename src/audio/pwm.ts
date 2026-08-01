import { LfoDest } from './lfo';
import { PWM_MAX_WIDTH, PWM_MIN_WIDTH, type Osc } from './oscillator';

/** Control-loop rate. Smoothness is `PWM_CONTROL_HZ / lfoRate` duty updates per
 *  cycle — 240 at 1 Hz, ~24 at the PWM_RATE_MAX cap (oscillators.md REQ-8). */
export const PWM_CONTROL_HZ = 240;

/** LFO rate ceiling on the PWM path (oscillators.md REQ-9). Above this the duty
 *  steps audibly; `lfo.rate`'s own registered range is deliberately untouched,
 *  so no saved patch is invalidated. */
export const PWM_RATE_MAX = 10;

/** Cap on the phase advance one tick may make. A background tab throttles this
 *  timer to ~1 Hz while audio keeps playing (oscillators.md REQ-10); without a
 *  cap the first tick back would jump the duty an arbitrary distance and click.
 *  With it, the sweep effectively freezes and resumes where it left off. */
const MAX_TICK_S = 4 / PWM_CONTROL_HZ;

/** The pair of oscillators PWM applies to. The sub is deliberately excluded —
 *  PWM on the low anchor muddies the fundamental (oscillators.md REQ-5). */
export interface PwmVoice {
  readonly osc1: Osc;
  readonly osc2: Osc;
}

/** One LFO cycle, evaluated in JS. Shapes mirror `WAVE_TYPES` in `lfo.ts`:
 *  sine / triangle / sawtooth / square, each bipolar and starting at 0 (or +1
 *  for square), matching the phase convention of the native OscillatorNode. */
function shape(wave: number, p: number): number {
  switch (wave) {
    case 1: return 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5);   // triangle
    case 2: return 2 * ((p + 0.5) % 1) - 1;                     // sawtooth
    case 3: return p < 0.5 ? 1 : -1;                            // square
    default: return Math.sin(2 * Math.PI * p);                  // sine
  }
}

/**
 * Pulse-width modulation driver (oscillators.md REQ-6..REQ-10).
 *
 * PWM is the one modulation path that is *not* an audio-node connection: a
 * native `OscillatorNode` has no width `AudioParam`, and `setPeriodicWave` is an
 * immediate call rather than schedulable automation. So the LFO shape is
 * mirrored here in JS and applied as a parameter write on a timer.
 *
 * The timer exists **only while the destination is `pulse`** — every other patch
 * pays nothing. It owns its own interval rather than riding the render loop,
 * because the weak perf tier caps that at 15 fps (runtime-performance.md).
 */
export class PwmDriver {
  /** `window.setInterval`, as `Polyphony`'s drift timer does: the bare global
   *  resolves to Node's under a test runner, whose `Timeout` holds the event
   *  loop open and stalls worker teardown. */
  private timer: number | null = null;
  private phase = 0;
  private lastT = 0;

  private dest: LfoDest = LfoDest.Off;
  private amount = 0;
  private rate = 4;
  private wave = 0;
  /** Per-oscillator base width, straight from the `osc{N}.pulseWidth` knobs. */
  private base: [number, number] = [PWM_MIN_WIDTH, PWM_MIN_WIDTH];

  constructor(
    private readonly voices: readonly PwmVoice[],
    private readonly now: () => number,
  ) {}

  setDest(d: number): void {
    this.dest = Math.round(d);
    this.sync();
  }

  setAmount(a: number): void {
    this.amount = Math.max(0, Math.min(1, a));
  }

  setRate(hz: number): void {
    if (Number.isFinite(hz)) this.rate = hz;
  }

  setWave(idx: number): void {
    this.wave = Math.max(0, Math.min(3, Math.round(idx)));
  }

  /** `i` is 0 for osc1, 1 for osc2. Writing a base while PWM is idle applies it
   *  straight away — that is the knob's own behaviour, sweep or no sweep. */
  setBase(i: 0 | 1, width: number): void {
    if (!Number.isFinite(width)) return;
    this.base[i] = Math.max(PWM_MIN_WIDTH, Math.min(PWM_MAX_WIDTH, width));
    if (!this.timer) this.applyBase();
  }

  dispose(): void {
    this.stop();
  }

  /** Start or stop the loop to match the destination. */
  private sync(): void {
    if (this.dest === LfoDest.Pulse) {
      if (this.timer) return;
      this.lastT = this.now();
      this.timer = window.setInterval(() => this.tick(), 1000 / PWM_CONTROL_HZ);
    } else {
      this.stop();
    }
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    // Leave the oscillators at their knob positions, not wherever the sweep
    // happened to stop.
    this.applyBase();
  }

  private applyBase(): void {
    for (const v of this.voices) {
      v.osc1.setPulseWidth(this.base[0]);
      v.osc2.setPulseWidth(this.base[1]);
    }
  }

  private tick(): void {
    const t = this.now();
    const dt = Math.min(Math.max(t - this.lastT, 0), MAX_TICK_S);
    this.lastT = t;

    // Phase is accumulated rather than derived from absolute time, so changing
    // the rate bends the sweep instead of jumping it.
    this.phase = (this.phase + Math.min(this.rate, PWM_RATE_MAX) * dt) % 1;

    // Unipolar and upward from each base (oscillators.md REQ-7): duty `d` and
    // `1-d` share a magnitude spectrum, so a bipolar sweep through 0.5 would
    // sound like double the LFO rate.
    const u = (shape(this.wave, this.phase) + 1) / 2;
    const w0 = this.base[0] + this.amount * u * (PWM_MAX_WIDTH - this.base[0]);
    const w1 = this.base[1] + this.amount * u * (PWM_MAX_WIDTH - this.base[1]);

    for (const v of this.voices) {
      v.osc1.setPulseWidth(w0);
      v.osc2.setPulseWidth(w1);
    }
  }
}
