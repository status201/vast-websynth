import type { Engine } from '../engine';
import type { Clock } from './clock';
import type { Arrangement } from './arrangement';
import type { Performance } from './performance';
import type { PatternStore } from '../../state/patterns';
import { DRUM_TRACK_COUNT, SEQ_LENGTH } from '../../state/patterns';
import { Kick, Snare, HiHat, Tom, Clap, makeNoiseBuffer, type DrumSynth } from '../drums/drum-synths';

export type DrumStepListener = (step: number) => void;

export class DrumMachine {
  readonly tracks: DrumSynth[] = [];
  readonly trackGains: GainNode[] = [];
  readonly muted: boolean[] = Array(DRUM_TRACK_COUNT).fill(false);

  private enabled = false;
  private readonly stepListeners = new Set<DrumStepListener>();

  constructor(
    private readonly engine: Engine,
    private readonly clock: Clock,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly perf: Performance,
  ) {
    const ctx = engine.ctx;
    const noise = makeNoiseBuffer(ctx, 2);

    // Track order must match DRUM_TRACKS in patterns.ts
    this.tracks = [
      new Kick(ctx),
      new Snare(ctx, noise),
      new HiHat(ctx, noise, false), // closed
      new HiHat(ctx, noise, true),  // open
      new Tom(ctx, 110),             // low
      new Tom(ctx, 165),             // mid
      new Tom(ctx, 240),             // high
      new Clap(ctx, noise),
    ];

    for (const t of this.tracks) {
      const g = ctx.createGain();
      g.gain.value = 0.85;
      t.output.connect(g).connect(engine.drumBus);
      this.trackGains.push(g);
    }

    clock.onTick((step, when) => this.onTick(step, when));
  }

  setEnabled(on: boolean): void { this.enabled = on; }

  onStep(fn: DrumStepListener): () => void {
    this.stepListeners.add(fn);
    return () => { this.stepListeners.delete(fn); };
  }

  setTrackVolume(track: number, v: number): void {
    const g = this.trackGains[track];
    if (g) g.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.01);
  }

  setTrackMute(track: number, muted: boolean): void {
    this.muted[track] = muted;
  }

  setTrackTune(track: number, semi: number): void {
    this.tracks[track]?.setTune(semi);
  }

  setTrackDecay(track: number, sec: number): void {
    this.tracks[track]?.setDecay(sec);
  }

  /** Manual trigger (for UI auditioning). */
  triggerTrack(track: number, velocity = 0.9): void {
    this.tracks[track]?.trigger(this.engine.ctx.currentTime, velocity);
  }

  private onTick(step: number, when: number): void {
    if (!this.enabled) return;
    const idx = this.perf.mapStep(step) % SEQ_LENGTH;
    for (const l of this.stepListeners) l(idx);

    if (this.perf.fillActive) {
      this.playFill(step % SEQ_LENGTH, when);
      return;
    }

    const bank = this.patterns.drumBank(this.arrangement.drumPlayBank);
    for (let t = 0; t < DRUM_TRACK_COUNT; t++) {
      if (this.muted[t]) continue;
      const cell = bank[t]?.[idx];
      if (cell && cell.on) {
        this.tracks[t]?.trigger(when, cell.velocity);
      }
    }
  }

  /** Momentary drum fill — snare ramp + tom cascade on the last beat. */
  private playFill(s: number, when: number): void {
    if (s % 8 === 0) this.tracks[0]?.trigger(when, 0.85); // kick anchor
    if (s >= 12) {
      const tom = s === 12 ? 4 : s === 13 ? 5 : 6; // L→M→H tom roll
      this.tracks[tom]?.trigger(when, 0.95);
      if (s === 15) this.tracks[7]?.trigger(when, 0.9); // clap accent
    } else {
      this.tracks[1]?.trigger(when, 0.5 + 0.45 * (s / 11)); // snare ramp
      if (s % 2 === 0) this.tracks[2]?.trigger(when, 0.35); // hats
    }
  }
}
