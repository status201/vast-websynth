import type { ParamBus } from '../../state/params';
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
    private readonly djFilter: BiquadFilterNode,
  ) {}

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

  // ---- Fill ----

  setFill(on: boolean): void {
    this.fillActive = on;
  }

  // ---- Filter Drop (momentary) ----

  setDrop(on: boolean): void {
    this.dropActive = on;
    const now = this.ctx.currentTime;
    const f = this.djFilter.frequency;
    const q = this.djFilter.Q;
    f.cancelScheduledValues(now);
    q.cancelScheduledValues(now);
    if (on) {
      this.djFilter.type = 'lowpass';
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

  private applyDjFilter(x: number, smooth: number): void {
    const now = this.ctx.currentTime;
    const f = this.djFilter.frequency;
    const q = this.djFilter.Q;
    f.cancelScheduledValues(now);
    q.cancelScheduledValues(now);

    if (Math.abs(x) < 0.02) {
      this.djFilter.type = 'lowpass';
      f.exponentialRampToValueAtTime(DJ_OPEN_HZ, now + smooth);
      q.setTargetAtTime(0.7, now, smooth);
      return;
    }
    if (x < 0) {
      const t = -x; // 0..1
      this.djFilter.type = 'lowpass';
      f.exponentialRampToValueAtTime(DJ_OPEN_HZ * Math.pow(130 / DJ_OPEN_HZ, t), now + smooth);
      q.setTargetAtTime(0.7 + t * 3, now, smooth);
    } else {
      const t = x; // 0..1
      this.djFilter.type = 'highpass';
      f.exponentialRampToValueAtTime(20 * Math.pow(4000 / 20, t), now + smooth);
      q.setTargetAtTime(0.7 + t * 3, now, smooth);
    }
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

    const tick = (): void => {
      const k = Math.min(1, (performance.now() - t0) / durMs);
      const e = on ? k * k : 1 - (1 - k) * (1 - k); // ease
      // Skip the clock ramp while slaved — an incoming clock owns the tempo.
      if (this.clockRampAllowed()) this.clock.setBpm(startBpm + (endBpm - startBpm) * e);
      this.bus.set('master.pitchBend', startBend + (endBend - startBend) * e);
      if (k < 1) {
        this.tapeRaf = requestAnimationFrame(tick);
      } else {
        this.tapeRaf = 0;
        if (!on) {
          // An ungated restore would stomp the followed tempo with the knob value.
          if (this.clockRampAllowed()) this.clock.setBpm(origBpm);
          this.bus.set('master.pitchBend', 0);
        }
      }
    };
    this.tapeRaf = requestAnimationFrame(tick);
  }
}
