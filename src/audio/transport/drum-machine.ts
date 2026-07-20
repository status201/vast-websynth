import type { Arrangement } from './arrangement';
import type { Performance } from './performance';
import type { PatternStore } from '../../state/patterns';
import { DRUM_TRACK_COUNT, SEQ_LENGTH } from '../../state/patterns';
import { Kick, Snare, HiHat, Tom, Clap, Conga, Bongo, Cowbell, Clave, Shaker, makeNoiseBuffer, type DrumSynth } from '../drums/drum-synths';
import { rampTo, RAMP_MEDIUM } from '../param-utils';
import { chokeAt, forEachActiveHit } from './step-hits';
import type { TickSubscriber } from './tick-source';
import { ListenerSet } from '../../utils/listeners';

export type DrumStepListener = (step: number) => void;

/**
 * Selectable voice algorithms per track (drum-machine.md REQ-11). Indices 0-7
 * are the classic voices in track order — a track's default model is its own
 * index, so pre-model songs/presets reproduce the classic kit exactly.
 * The label list lives in state (`DRUM_MODEL_LABELS`); MODEL_BUILDERS below
 * must stay index-aligned with it.
 */
const MODEL_BUILDERS: readonly ((ctx: AudioContext, noise: AudioBuffer) => DrumSynth)[] = [
  (ctx) => new Kick(ctx),
  (ctx, noise) => new Snare(ctx, noise),
  (ctx, noise) => new HiHat(ctx, noise, false), // closed
  (ctx, noise) => new HiHat(ctx, noise, true),  // open
  (ctx) => new Tom(ctx, 110),                    // low
  (ctx) => new Tom(ctx, 165),                    // mid
  (ctx) => new Tom(ctx, 240),                    // high
  (ctx, noise) => new Clap(ctx, noise),
  (ctx) => new Conga(ctx),
  (ctx, noise) => new Bongo(ctx, noise),
  (ctx) => new Cowbell(ctx),
  (ctx) => new Clave(ctx),
  (ctx, noise) => new Shaker(ctx, noise),
];

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
  // Current model per track + cached tune/decay, replayed onto a swapped-in voice.
  private readonly trackModels: number[] = Array.from({ length: DRUM_TRACK_COUNT }, (_, i) => i);
  private readonly trackTunes: number[] = Array(DRUM_TRACK_COUNT).fill(0);
  private readonly trackDecays: number[] = Array(DRUM_TRACK_COUNT).fill(0.3);
  private readonly noise: AudioBuffer;

  private enabled = false;
  private readonly stepListeners = new ListenerSet<[number]>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly clock: TickSubscriber,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly perf: Performance,
    private readonly drumBus: GainNode,
    private readonly fxOversample = true,
  ) {
    this.noise = makeNoiseBuffer(this.ctx, 2);

    // Track order must match DRUM_TRACKS in patterns.ts; each track boots on
    // its classic voice (model index = track index, REQ-11).
    this.tracks = this.trackModels.map((m) => MODEL_BUILDERS[m]!(this.ctx, this.noise));

    for (const t of this.tracks) {
      // Per-track channel: voice → drive → tone → volume → pan → drumBus.
      // The voice's own envelope + choke (chokeRoute) stay upstream and intact.
      const drivePre = this.ctx.createGain();
      const shaper = this.ctx.createWaveShaper();
      shaper.curve = driveCurve(0); // identity at drive 0 (no-op)
      // Oversampling an identity curve is pure waste — setTrackDrive steps it
      // up to 2x only while actually driven (performance-mode.md REQ-11).
      shaper.oversample = 'none';
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
    return this.stepListeners.add(fn);
  }

  setTrackVolume(track: number, v: number): void {
    const g = this.trackGains[track];
    if (g) rampTo(g.gain, v, this.ctx, RAMP_MEDIUM);
  }

  setTrackMute(track: number, muted: boolean): void {
    this.muted[track] = muted;
  }

  setTrackTune(track: number, semi: number): void {
    this.trackTunes[track] = semi;
    this.tracks[track]?.setTune(semi);
  }

  setTrackDecay(track: number, sec: number): void {
    this.trackDecays[track] = sec;
    this.tracks[track]?.setDecay(sec);
  }

  /**
   * Swap the track's voice algorithm (REQ-11). Only the voice changes: the old
   * voice's output is disconnected and the new one wired into the same
   * per-track channel head (`drivePre`); cached tune/decay are replayed.
   * In-flight one-shots keep their own `disposeAfter` teardown.
   */
  setTrackModel(track: number, model: number): void {
    const m = Math.round(model);
    const builder = MODEL_BUILDERS[m];
    const drivePre = this.trackDrivePre[track];
    if (!builder || !drivePre || this.trackModels[track] === m) return;
    this.trackModels[track] = m;
    this.tracks[track]?.output.disconnect();
    const voice = builder(this.ctx, this.noise);
    voice.setTune(this.trackTunes[track]!);
    voice.setDecay(this.trackDecays[track]!);
    voice.output.connect(drivePre);
    this.tracks[track] = voice;
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
    shaper.oversample = amt > 0 && this.fxOversample ? '2x' : 'none';
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
    const idx = this.perf.stepIndex(step);
    this.stepListeners.emit(idx);

    // Arrangement rest bar: keep the playhead moving but trigger nothing.
    if (this.arrangement.drumResting) return;

    if (this.perf.fillActive) {
      this.playFill(step % SEQ_LENGTH, when);
      return;
    }

    const bank = this.patterns.drumBank(this.arrangement.drumPlayBank);
    const stepDur = this.clock.sixteenthDuration();
    forEachActiveHit(bank, idx, when, stepDur, this.muted, (t, h, cell) => {
      this.tracks[t]?.trigger(h.t, cell.velocity, chokeAt(cell, h));
    });
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
