import type { Arrangement } from './arrangement';
import type { Performance } from './performance';
import type { PatternStore } from '../../state/patterns';
import { DRUM_TRACK_COUNT, SEQ_LENGTH } from '../../state/patterns';
import { Kick, Snare, HiHat, Tom, Clap, makeNoiseBuffer, type DrumSynth } from '../drums/drum-synths';
import { rampTo, RAMP_MEDIUM } from '../param-utils';
import { chokeAt, rollProb, stepHits } from './step-hits';
import type { TickSubscriber } from './tick-source';

export type DrumStepListener = (step: number) => void;

export class DrumMachine {
  readonly tracks: DrumSynth[] = [];
  readonly trackGains: GainNode[] = [];
  // Per-track channel processors (one entry per track, downstream of the voice).
  private readonly trackTones: BiquadFilterNode[] = [];
  private readonly trackPans: StereoPannerNode[] = [];
  private readonly trackDrivePre: GainNode[] = [];
  private readonly trackDriveShapers: WaveShaperNode[] = [];
  private readonly trackDrivePost: GainNode[] = [];
  readonly muted: boolean[] = Array(DRUM_TRACK_COUNT).fill(false);

  private enabled = false;
  private readonly stepListeners = new Set<DrumStepListener>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly clock: TickSubscriber,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly perf: Performance,
    private readonly drumBus: GainNode,
  ) {
    const noise = makeNoiseBuffer(this.ctx, 2);

    // Track order must match DRUM_TRACKS in patterns.ts
    this.tracks = [
      new Kick(this.ctx),
      new Snare(this.ctx, noise),
      new HiHat(this.ctx, noise, false), // closed
      new HiHat(this.ctx, noise, true),  // open
      new Tom(this.ctx, 110),             // low
      new Tom(this.ctx, 165),             // mid
      new Tom(this.ctx, 240),             // high
      new Clap(this.ctx, noise),
    ];

    for (const t of this.tracks) {
      // Per-track channel: voice → drive → tone → volume → pan → drumBus.
      // The voice's own envelope + choke (chokeRoute) stay upstream and intact.
      const drivePre = this.ctx.createGain();
      const shaper = this.ctx.createWaveShaper();
      shaper.curve = driveCurve(0); // identity at drive 0 (no-op)
      shaper.oversample = '2x';
      const drivePost = this.ctx.createGain();

      const tone = this.ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = toneCutoff(1); // open (no-op)
      tone.Q.value = 0.7;

      const g = this.ctx.createGain();
      g.gain.value = 0.85;
      const pan = this.ctx.createStereoPanner();

      t.output
        .connect(drivePre)
        .connect(shaper)
        .connect(drivePost)
        .connect(tone)
        .connect(g)
        .connect(pan)
        .connect(this.drumBus);

      this.trackDrivePre.push(drivePre);
      this.trackDriveShapers.push(shaper);
      this.trackDrivePost.push(drivePost);
      this.trackTones.push(tone);
      this.trackGains.push(g);
      this.trackPans.push(pan);
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
    if (g) rampTo(g.gain, v, this.ctx, RAMP_MEDIUM);
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

  /** Brightness: `amt` 1 = open (no-op), lower darkens the per-track lowpass. */
  setTrackTone(track: number, amt: number): void {
    const f = this.trackTones[track];
    if (f) rampTo(f.frequency, toneCutoff(amt), this.ctx, RAMP_MEDIUM);
  }

  /** Grit: `amt` 0 = clean (no-op), higher saturates the per-track waveshaper. */
  setTrackDrive(track: number, amt: number): void {
    const pre = this.trackDrivePre[track];
    const shaper = this.trackDriveShapers[track];
    const post = this.trackDrivePost[track];
    if (!pre || !shaper || !post) return;
    rampTo(pre.gain, 1 + amt * 8, this.ctx, RAMP_MEDIUM);
    shaper.curve = driveCurve(amt);
    rampTo(post.gain, 1 / (1 + amt * 1.5), this.ctx, RAMP_MEDIUM);
  }

  /** Stereo position: -1 hard-left … 0 centre (no-op) … +1 hard-right. */
  setTrackPan(track: number, p: number): void {
    const pan = this.trackPans[track];
    if (pan) rampTo(pan.pan, p, this.ctx, RAMP_MEDIUM);
  }

  /** Manual trigger (for UI auditioning). */
  triggerTrack(track: number, velocity = 0.9): void {
    this.tracks[track]?.trigger(this.ctx.currentTime, velocity);
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
    const stepDur = this.clock.sixteenthDuration();
    for (let t = 0; t < DRUM_TRACK_COUNT; t++) {
      if (this.muted[t]) continue;
      const cell = bank[t]?.[idx];
      if (!cell || !cell.on || !rollProb(cell.prob)) continue;
      for (const h of stepHits(cell, when, stepDur)) {
        this.tracks[t]?.trigger(h.t, cell.velocity, chokeAt(cell, h));
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

/**
 * Per-track waveshaper curve. `amount` 0 is the identity line (true bypass),
 * higher saturates via a normalised tanh — same shape as the synth FX
 * distortion, but anchored at a clean no-op so `drive` defaults silently.
 */
function driveCurve(amount: number, samples = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * Float32Array.BYTES_PER_ELEMENT));
  const k = amount * 50;
  const norm = k < 1e-6 ? 1 : Math.tanh(k);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = k < 1e-6 ? x : Math.tanh(k * x) / norm;
  }
  return curve;
}

/** Map a `tone` knob (0..1) to a lowpass cutoff in Hz; 1 = open (~no-op). */
function toneCutoff(tone: number): number {
  const min = 300, max = 20000;
  const t = tone < 0 ? 0 : tone > 1 ? 1 : tone;
  return min * Math.pow(max / min, t);
}
