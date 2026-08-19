import type { ParamBus } from '../../state/params';
import { SEQ_LENGTH } from '../../state/patterns';
import { cellIndex, DEFAULT_LANE_RATE } from '../../state/meter';
import type { TickSubscriber } from './tick-source';

/**
 * Live performance / DJ effects. Owned by the Engine; the sequencer and
 * drum machine consult `mapStep`/`fillActive`, and the Song panel drives
 * the momentary controls.
 *
 * - Stutter / beat-repeat: loops a short slice of the timeline.
 * - Fill: drum machine plays a roll instead of the pattern.
 * - Filter Drop: momentary lowpass dive on the master `djFilter`.
 * - DJ Filter: manual bipolar sweep on the same node (LP ← 0 → HP).
 * - Tape Stop: ramps BPM down + pitch down, then recovers on release.
 */
const DJ_OPEN_HZ = 20000;
/** Where the highpass side rests: below the band, i.e. transparent. */
const DJ_HP_REST_HZ = 20;
/** Resting resonance for both sides. */
const DJ_REST_Q = 0.7;

export class Performance {
  fillActive = false;

  /**
   * Gate for Tape Stop's clock-BPM ramp (per-frame *and* the final restore).
   * Default allows it; the Engine sets it to `() => sync.mode !== 'slave'` so a
   * slaved instance's Tape Stop bends pitch only and never fights the followed
   * clock (midi-clock-sync REQ-13). The pitch-bend ramp is unaffected.
   */
  clockRampAllowed: () => boolean = () => true;

  private stutterOn = false;
  private stutterSize = 2; // sixteenths
  private anchor = 0;

  private dropActive = false;
  private tapeRaf = 0;
  private tapeActive = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly clock: TickSubscriber,
    private readonly bus: ParamBus,
    private readonly djLow: BiquadFilterNode,
    private readonly djHigh: BiquadFilterNode,
  ) {
    // The stutter window is anchored to an absolute step, so after a playhead
    // jump `mapStep` would fold the new position back into the *old* window —
    // a backwards jump replaying it forever (performance.md REQ-7). Nothing to
    // do while stutter is off: mapStep is the identity then.
    clock.onSeek(() => { if (this.stutterOn) this.anchor = this.clock.step; });
  }

  // ---- Stutter ----

  setStutterSize(sixteenths: number): void {
    this.stutterSize = Math.max(1, Math.round(sixteenths));
  }

  setStutter(on: boolean): void {
    if (on && !this.stutterOn) this.anchor = this.clock.step;
    this.stutterOn = on;
  }

  /** Consulted by the sequencer + drum machine each tick. */
  mapStep(rawStep: number): number {
    if (!this.stutterOn) return rawStep;
    const n = this.stutterSize;
    const off = (((rawStep - this.anchor) % n) + n) % n;
    return this.anchor + off;
  }

  /**
   * The stutter-mapped step folded into a bank position — what the seq, drum
   * and sampler machines read each tick. (The motion sequencer deliberately
   * derives the same index from the *raw* step instead: automation must not
   * follow stutter remaps.)
   *
   * `mapStep` still folds the **absolute** step, so a stutter over a 12-cell
   * lane repeats 12-cell material and a stutter window is unaffected by the
   * lane's length or rate (meter.md REQ-17). Only the modulo that follows it is
   * lane-aware.
   */
  stepIndex(step: number, cells: number = SEQ_LENGTH, rateIdx: number = DEFAULT_LANE_RATE): number {
    return cellIndex(this.mapStep(step), cells, rateIdx);
  }

  // ---- Fill ----

  setFill(on: boolean): void {
    this.fillActive = on;
  }

  // ---- Filter Drop (momentary) ----

  setDrop(on: boolean): void {
    this.dropActive = on;
    const now = this.ctx.currentTime;
    const f = this.djLow.frequency;
    const q = this.djLow.Q;
    f.cancelScheduledValues(now);
    q.cancelScheduledValues(now);
    if (on) {
      // REQ-3 — the drop OVERRIDES the knob, so the highpass side is opened back
      // out as the lowpass dives. Leaving it where the knob had it would band-pass
      // the dive instead of replacing it (which is what the single-node version
      // did implicitly, by owning the only filter there was).
      this.rampSide(this.djHigh, now, 0.5, DJ_HP_REST_HZ, DJ_REST_Q);
      f.setValueAtTime(Math.max(f.value, 400), now);
      f.exponentialRampToValueAtTime(160, now + 0.5);
      q.setValueAtTime(q.value, now);
      q.linearRampToValueAtTime(9, now + 0.5);
    } else {
      // Return to whatever the manual DJ-filter knob currently dictates.
      this.applyDjFilter(this.bus.get('fx.djfilter'), 0.35);
    }
  }

  // ---- Manual DJ filter knob (param fx.djfilter, -1..1) ----

  setDjFilter(x: number): void {
    if (this.dropActive) return; // Drop overrides the knob while held
    this.applyDjFilter(x, 0.04);
  }

  /**
   * Drive both sides of the pair (REQ-9). Neither node's `type` is touched: the
   * side that is not working is ramped back to transparency instead, so crossing
   * centre is two continuous frequency ramps rather than a coefficient swap on a
   * live biquad. Each side's own curve is exactly what it was when this was one
   * node, so the sweep is unchanged either side of zero.
   */
  private applyDjFilter(x: number, smooth: number): void {
    const now = this.ctx.currentTime;
    const lo = -Math.min(0, x); // 0..1 of lowpass
    const hi = Math.max(0, x);  // 0..1 of highpass
    const dead = Math.abs(x) < 0.02;
    this.rampSide(this.djLow, now, smooth,
      dead || lo === 0 ? DJ_OPEN_HZ : DJ_OPEN_HZ * Math.pow(130 / DJ_OPEN_HZ, lo),
      dead ? DJ_REST_Q : DJ_REST_Q + lo * 3);
    this.rampSide(this.djHigh, now, smooth,
      dead || hi === 0 ? DJ_HP_REST_HZ : DJ_HP_REST_HZ * Math.pow(4000 / DJ_HP_REST_HZ, hi),
      dead ? DJ_REST_Q : DJ_REST_Q + hi * 3);
  }

  private rampSide(node: BiquadFilterNode, now: number, smooth: number, hz: number, q: number): void {
    node.frequency.cancelScheduledValues(now);
    node.Q.cancelScheduledValues(now);
    node.frequency.exponentialRampToValueAtTime(hz, now + smooth);
    node.Q.setTargetAtTime(q, now, smooth);
  }

  // ---- Tape Stop (momentary) ----

  setTapeStop(on: boolean): void {
    if (on === this.tapeActive) return;
    this.tapeActive = on;
    if (this.tapeRaf) cancelAnimationFrame(this.tapeRaf);

    const origBpm = this.bus.get('transport.bpm');
    const minBpm = 20;
    const startBpm = on ? origBpm : minBpm;
    const endBpm = on ? minBpm : origBpm;
    const startBend = this.bus.get('master.pitchBend');
    const endBend = on ? -1 : 0;
    const durMs = on ? 650 : 420;
    const t0 = performance.now();

    // The ramp is the machine bending the pitch, not the user editing a param, so
    // its per-frame writes stay off `bus.onChange` (runtime-performance.md REQ-5)
    // — otherwise a 650 ms tape stop re-arms the session autosave ~40 times and
    // can capture a mid-ramp pitchBend as the saved session. `ease` is carried on
    // the closure so the suppressed body is allocated once per gesture, not per
    // frame (REQ-6).
    let ease = 0;
    const applyEase = (): void => {
      // Skip the clock ramp while slaved — an incoming clock owns the tempo.
      if (this.clockRampAllowed()) this.clock.setBpm(startBpm + (endBpm - startBpm) * ease);
      this.bus.set('master.pitchBend', startBend + (endBend - startBend) * ease);
    };
    const settle = (): void => {
      // An ungated restore would stomp the followed tempo with the knob value.
      if (this.clockRampAllowed()) this.clock.setBpm(origBpm);
      this.bus.set('master.pitchBend', 0);
    };

    const tick = (): void => {
      const k = Math.min(1, (performance.now() - t0) / durMs);
      ease = on ? k * k : 1 - (1 - k) * (1 - k);
      this.bus.withoutChangeSignal(applyEase);
      if (k < 1) {
        this.tapeRaf = requestAnimationFrame(tick);
      } else {
        this.tapeRaf = 0;
        if (!on) this.bus.withoutChangeSignal(settle);
      }
    };
    this.tapeRaf = requestAnimationFrame(tick);
  }
}
