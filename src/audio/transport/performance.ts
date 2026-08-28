import type { ParamBus } from '../../state/params';
import { RAMP_SMOOTH } from '../param-utils';
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
 * - Filter Drop: momentary lowpass dive on the master `djLow`.
 * - DJ Filter: manual bipolar sweep on the same pair (LP ← 0 → HP).
 * - Tape Stop: ramps BPM down + pitch down, then recovers on release.
 */
const DJ_OPEN_HZ = 20000;
/** Where the highpass side rests: below the band, i.e. transparent. */
const DJ_HP_REST_HZ = 20;
/** Resting resonance for both sides. */
const DJ_REST_Q = 0.7;

/**
 * The sweep is `detune`, in cents, not `frequency` in Hz (performance.md REQ-10).
 * Each node's frequency is a fixed reference the Engine sets once; these spans
 * are how far detune travels to reach the ends of the curve v6 drew with
 * `Math.pow`. Cents are log-frequency, so a linear approach in cents *is* that
 * curve — which is what lets the whole path use `setTargetAtTime` and so never
 * cancel (an unanchored cancel restarts the ramp from the constructed value on
 * Gecko: the crackle REQ-10 fixes).
 */
const DJ_LP_SPAN_CENTS = 1200 * Math.log2(130 / DJ_OPEN_HZ);      // ≈ -8800
const DJ_HP_SPAN_CENTS = 1200 * Math.log2(4000 / DJ_HP_REST_HZ);  // ≈ +9171
/** Filter Drop's 160 Hz target on the lowpass side. */
const DJ_DROP_CENTS = 1200 * Math.log2(160 / DJ_OPEN_HZ);         // ≈ -8368
/** Resonance at the bottom of a Filter Drop. */
const DJ_DROP_Q = 9;

/**
 * Time constants. `setTargetAtTime` reaches ~95% of its target in 3τ, so these
 * are a third of the ramp durations v6 scheduled. Dialled by ear (ADR-010).
 */
const DJ_KNOB_TAU = RAMP_SMOOTH;  // the hand-swept / automated sweep
const DJ_DROP_TAU = 0.17;         // Filter Drop's dive, ~0.5 s
const DJ_RESTORE_TAU = 0.12;      // returning to the knob when Drop releases

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
  /** Last commanded (cents, Q) per side, so an unchanged side is not rewritten. */
  private lastLow: { cents: number; q: number } | null = null;
  private lastHigh: { cents: number; q: number } | null = null;
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
    if (on) {
      // REQ-3 — the drop OVERRIDES the knob, so the highpass side is opened back
      // out as the lowpass dives. Leaving it where the knob had it would band-pass
      // the dive instead of replacing it (which is what the single-node version
      // did implicitly, by owning the only filter there was).
      //
      // The dive glides from wherever the filter is (REQ-10). v6 forced it to
      // start at >=400 Hz, which from a knob already parked at 130 Hz was an
      // instantaneous jump *up* — the coefficient step REQ-9 exists to abolish —
      // and read a live `.value` to do it, which Gecko does not keep current.
      this.side(this.djLow, DJ_DROP_CENTS, DJ_DROP_Q, DJ_DROP_TAU);
      this.side(this.djHigh, 0, DJ_REST_Q, DJ_DROP_TAU);
    } else {
      // Return to whatever the manual DJ-filter knob currently dictates.
      this.applyDjFilter(this.bus.get('fx.djfilter'), DJ_RESTORE_TAU);
    }
  }

  // ---- Manual DJ filter knob (param fx.djfilter, -1..1) ----

  setDjFilter(x: number): void {
    if (this.dropActive) return; // Drop overrides the knob while held
    this.applyDjFilter(x, DJ_KNOB_TAU);
  }

  /**
   * Drive both sides of the pair (REQ-9). Neither node's `type` is touched: the
   * side that is not working is retargeted to transparency instead, so crossing
   * centre is two continuous sweeps rather than a coefficient swap on a live
   * biquad. Each side's own curve is exactly what it was when this was one node,
   * so the sweep is unchanged either side of zero — the mapping is the same, read
   * in cents rather than Hz (REQ-10).
   */
  private applyDjFilter(x: number, tau: number): void {
    const lo = -Math.min(0, x); // 0..1 of lowpass
    const hi = Math.max(0, x);  // 0..1 of highpass
    const dead = Math.abs(x) < 0.02;
    this.side(this.djLow, dead ? 0 : lo * DJ_LP_SPAN_CENTS,
      dead ? DJ_REST_Q : DJ_REST_Q + lo * 3, tau);
    this.side(this.djHigh, dead ? 0 : hi * DJ_HP_SPAN_CENTS,
      dead ? DJ_REST_Q : DJ_REST_Q + hi * 3, tau);
  }

  /**
   * Retarget one side. `setTargetAtTime` only (REQ-10): it continues from the
   * value the previous curve has reached, so it needs no `cancelScheduledValues`
   * and may be re-issued at any rate — which is the whole fix, since a cancel
   * that pins nothing restarts the ramp from the constructed value on Gecko.
   *
   * Only one side moves per gesture, but `applyDjFilter` has to consider both, so
   * the last commanded pair is cached and an unchanged side is not written at all
   * (runtime-performance.md). `dropActive` flips outside this path, so `setDrop`
   * commands through here too and the cache stays honest.
   */
  private side(node: BiquadFilterNode, cents: number, q: number, tau: number): void {
    const last = node === this.djLow ? this.lastLow : this.lastHigh;
    if (last && last.cents === cents && last.q === q) return;
    const now = this.ctx.currentTime;
    node.detune.setTargetAtTime(cents, now, tau);
    node.Q.setTargetAtTime(q, now, tau);
    if (node === this.djLow) this.lastLow = { cents, q };
    else this.lastHigh = { cents, q };
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
