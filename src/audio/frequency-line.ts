/**
 * A frequency `AudioParam` driven note by note, with optional glide — the maths
 * `Osc` has always used, lifted out so the sync pair's `frequency` follows the
 * exact same curve as the native oscillators it replaces
 * (oscillator-sync.md REQ-the-pair-follows-every-osc-control).
 */
export class FrequencyLine {
  /**
   * The last move commanded: from `from` to `to` starting at `at`, a step when
   * `tau` is 0 and a one-pole glide otherwise. Kept so `at` can compute where
   * the curve has reached rather than reading `AudioParam.value` back (see
   * `set`), and so `follow` can schedule the same curve elsewhere.
   */
  private seg: { from: number; to: number; at: number; tau: number };

  constructor(private readonly param: AudioParam, initialHz: number) {
    this.seg = { from: initialHz, to: initialHz, at: 0, tau: 0 };
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
      this.seg = { from, to: hz, at: when, tau: 0 };
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
      this.seg = { from, to: hz, at: when, tau };
    }
  }

  /**
   * Take over `src`'s curve from `now` on, as it is scheduled: a glide in flight
   * carries on to its target, and a move set ahead of `now` still lands at its
   * own time (oscillator-sync.md REQ-the-pair-follows-every-osc-control). A
   * one-pole glide is memoryless, so restarting it at `now` from where it has
   * reached is the same curve.
   */
  follow(src: FrequencyLine, now: number): void {
    const s = src.seg;
    const f = this.param;
    f.cancelScheduledValues(now);
    if (s.at > now) {
      f.setValueAtTime(s.from, now);
      f.setValueAtTime(s.tau > 0 ? s.from : s.to, s.at);
      if (s.tau > 0) f.setTargetAtTime(s.to, s.at, s.tau);
      this.seg = { ...s };
    } else {
      const v = src.at(now);
      f.setValueAtTime(v, now);
      if (s.tau > 0) f.setTargetAtTime(s.to, now, s.tau);
      this.seg = { from: v, to: s.to, at: now, tau: s.tau };
    }
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
    const s = this.seg;
    if (t < s.at) return s.from;
    if (s.tau === 0) return s.to;
    return s.to + (s.from - s.to) * Math.exp(-(t - s.at) / s.tau);
  }
}
