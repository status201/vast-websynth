/**
 * A frequency `AudioParam` driven note by note, with optional glide — the maths
 * `Osc` has always used, lifted out so the sync pair's `frequency` follows the
 * exact same curve as the native oscillators it replaces
 * (oscillator-sync.md REQ-the-pair-follows-every-osc-control).
 */
export class FrequencyLine {
  /** The last frequency commanded, and the param's own starting value until one is. */
  private lastFreq: number;
  /** The glide in flight, so `at` can compute where the curve has reached
   *  rather than reading `AudioParam.value` back — see `set`. */
  private glide: { from: number; to: number; at: number; tau: number } | null = null;

  constructor(private readonly param: AudioParam, initialHz: number) {
    this.lastFreq = initialHz;
  }

  /** Set the frequency. Optional glide via setTargetAtTime.
   *
   *  Non-finite input is dropped rather than written: an `AudioParam` value is a
   *  WebIDL *restricted* float, so `setValueAtTime(Infinity)` throws a TypeError
   *  — and `midiToHz` returns Infinity for a big enough note. Import validation
   *  bounds notes to 0..127 and the clock isolates a throwing listener
   *  (ADR-015); this is the third, cheapest layer, and it keeps a silent note
   *  from becoming an exception in the first place. */
  set(hz: number, when: number, glideSec: number): void {
    if (!Number.isFinite(hz)) return;
    const f = this.param;
    const from = this.at(when);
    if (glideSec <= 0.001) {
      f.cancelScheduledValues(when);
      f.setValueAtTime(hz, when);
      this.glide = null;
    } else {
      const tau = glideSec / 3;
      // ANCHORED cancel (architecture.md "Never cancel automation without
      // anchoring it"). The cancel itself is load-bearing: the frequency is
      // written only from here, so a voice stolen from the sequencer still has
      // that note's pitch scheduled up to a lookahead ahead, and without the
      // cancel it would fire mid-glide. But a bare cancel leaves no event at
      // `when`, and `setTargetAtTime` then starts from "the param's value" —
      // which Blink reads off the automation curve and Gecko reads as the last
      // explicitly assigned value. That is the documented divergence, and on
      // Firefox it made a glide slide from the wrong origin (often the 440 Hz
      // the node was constructed with) instead of from the note being left.
      f.cancelScheduledValues(when);
      f.setValueAtTime(from, when);
      f.setTargetAtTime(hz, when, tau);
      this.glide = { from, to: hz, at: when, tau };
    }
    this.lastFreq = hz;
  }

  /**
   * The frequency the curve has actually reached at `t`, computed rather than
   * read back: `AudioParam.value` is not reliable mid-automation on Gecko, which
   * is the same reason `SamplerMachine.cutHit` derives its gain analytically
   * instead of sampling it.
   *
   * `setTargetAtTime` is a one-pole approach, so the value is closed-form.
   */
  at(t: number): number {
    const g = this.glide;
    if (!g) return this.lastFreq;
    if (t <= g.at) return g.from;
    return g.to + (g.from - g.to) * Math.exp(-(t - g.at) / g.tau);
  }
}
