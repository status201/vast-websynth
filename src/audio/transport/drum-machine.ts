import type { Arrangement } from './arrangement';
import type { Performance } from './performance';
import type { PatternStore } from '../../state/patterns';
import { DRUM_TRACK_COUNT } from '../../state/patterns';
import { LaneMeter } from './lane-meter';
import { Kick, Snare, HiHat, Tom, Clap, Conga, Bongo, Cowbell, Clave, Shaker, makeNoiseBuffer, type DrumSynth } from '../drums/drum-synths';
import { rampTo, RAMP_MEDIUM, toneCutoff } from '../param-utils';
import { memoizeDriveCurve } from '../drive-curve';
import { chokeAt, forEachActiveHit } from './step-hits';
import type { TickSubscriber } from './tick-source';
import { ListenerSet } from '../../utils/listeners';

export type DrumStepListener = (step: number) => void;
/**
 * A hit that actually sounded, at the absolute time it will sound
 * (sidechain-ducking.md REQ-9). Distinct from `DrumStepListener`, which reports
 * a performance-mapped step index with no time and drives the UI playhead.
 */
export type DrumHitListener = (track: number, when: number, velocity: number) => void;

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

/**
 * The hat choke group (REQ-12), by **model index** into MODEL_BUILDERS above —
 * not by track, since REQ-11 lets any track hold any voice.
 */
const CLOSED_HAT_MODEL = 2;
const OPEN_HAT_MODEL = 3;
/** Short enough to read as a cut, long enough not to click. */
const CHOKE_GROUP_FADE = 0.006;

/**
 * How long the choke group takes to come back up (REQ-16). Short enough that the
 * next open hat is at full level, long enough that returning does not itself step.
 */
const CHOKE_GROUP_RESTORE = 0.004;

export class DrumMachine {
  readonly tracks: DrumSynth[] = [];
  readonly trackGains: GainNode[] = [];
  // Per-track channel processors (one entry per track, downstream of the voice).
  private readonly trackTones: BiquadFilterNode[] = [];
  private readonly trackPans: StereoPannerNode[] = [];
  /** Per-track choke gain, directly after the voice (REQ-12). Normally 1; a
   *  closed hat ramps the open hats' to 0 and straight back. */
  private readonly trackChokes: GainNode[] = [];
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
  /** The lane mixer's audibility verdict (mute/solo). See `setLaneAudible`. */
  private laneAudible = true;
  /** REQ-12. Off by default — switching it on changes how a song sounds. */
  private chokeEnabled = false;
  private readonly stepListeners = new ListenerSet<[number]>();
  private readonly hitListeners = new ListenerSet<[number, number, number]>();
  /** This machine's loop length + step rate (meter.md REQ-10/REQ-14). */
  readonly lane: LaneMeter;

  constructor(
    private readonly ctx: AudioContext,
    private readonly clock: TickSubscriber,
    private readonly patterns: PatternStore,
    private readonly arrangement: Arrangement,
    private readonly perf: Performance,
    private readonly drumBus: GainNode,
    private readonly fxOversample = true,
  ) {
    this.lane = new LaneMeter(clock, (s) => perf.mapStep(s));
    this.noise = makeNoiseBuffer(this.ctx, 2);

    // Track order must match DRUM_TRACKS in patterns.ts; each track boots on
    // its classic voice (model index = track index, REQ-11).
    this.tracks = this.trackModels.map((m) => MODEL_BUILDERS[m]!(this.ctx, this.noise));

    for (const t of this.tracks) {
      // Per-track channel: voice → choke → drive → tone → volume → pan → drumBus.
      // The voice's own envelope + per-hit gate (chokeRoute) stay upstream and
      // intact; `choke` is the *group* cut (REQ-12), placed before drive so a
      // cut tail is never saturated on its way out.
      const choke = this.ctx.createGain();
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
        .connect(choke)
        .connect(drivePre)
        .connect(shaper)
        .connect(drivePost)
        .connect(tone)
        .connect(g)
        .connect(pan)
        .connect(this.drumBus);

      this.trackChokes.push(choke);
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

  /** Every hit that sounds, as it is scheduled (sidechain-ducking.md REQ-9). */
  onHit(fn: DrumHitListener): () => void {
    return this.hitListeners.add(fn);
  }

  /**
   * Whether the drum bus is audible, per the lane mixer's mute/solo verdict
   * (REQ-13 v8). The machine keeps *playing* while inaudible — that is what
   * makes un-mute instant — but stops reporting, because a hit into a silenced
   * bus is not a hit anyone hears.
   */
  setLaneAudible(on: boolean): void {
    this.laneAudible = on;
  }

  /**
   * The one place a drum voice is triggered. Fires the voice and reports the
   * hit, so no trigger path — pattern sweep, fill or manual audition — can
   * report a hit that did not sound or forget one that did.
   */
  private fire(track: number, when: number, velocity: number, choke?: number): void {
    const voice = this.tracks[track];
    if (!voice) return;
    voice.trigger(when, velocity, choke);
    // Play but stay quiet about it: the bus is silenced, so nothing sounds.
    if (!this.laneAudible) return;
    this.hitListeners.emit(track, when, velocity);
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
    const curve = driveCurve(amt);
    if (shaper.curve !== curve) shaper.curve = curve;
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
    this.fire(track, this.ctx.currentTime, velocity);
  }

  private onTick(step: number, when: number): void {
    if (!this.enabled) return;
    this.lane.forEachHit(step, when, (idx, at, cellDur) => {
      this.stepListeners.emit(idx);

      // Arrangement rest bar: keep the playhead moving but trigger nothing.
      if (this.arrangement.drumResting) return;

      if (this.perf.fillActive) {
        this.playFill(idx, this.lane.cells, at);
        return;
      }

      const bank = this.patterns.drumBank(this.arrangement.drumPlayBank);
      forEachActiveHit(bank, idx, at, cellDur, this.muted, (t, h, cell) => {
        this.fire(t, h.t, cell.velocity, chokeAt(cell, h));
        // A closed hat ends whatever the open hat was doing (REQ-12). Fired from
        // the hit's own `h.t`, not `at`, so a ratcheted closed hat chokes on
        // every sub-hit exactly as a real one would.
        this.chokeOpenHats(t, h.t);
      });
    });
  }

  /**
   * Cut every ringing open hat when a **closed** hat fires (REQ-12).
   *
   * Keyed on the voice **model**, not the track index: models are swappable
   * (REQ-11), so the group has to follow the sound, not the slot. Off unless
   * `drum.choke` is on, because turning it on changes how existing songs sound.
   *
   * The gain is ramped down and restored inside the same call, so nothing has to
   * remember to undo it and a later open-hat hit is at full level. `when` is a
   * scheduled transport time, so this lands sample-accurately like every other
   * drum event.
   */
  private chokeOpenHats(sourceTrack: number, when: number): void {
    if (!this.chokeEnabled) return;
    if (this.trackModels[sourceTrack] !== CLOSED_HAT_MODEL) return;
    for (let t = 0; t < this.trackModels.length; t++) {
      if (this.trackModels[t] !== OPEN_HAT_MODEL) continue;
      const g = this.trackChokes[t];
      if (!g) continue;
      g.gain.cancelScheduledValues(when);
      g.gain.setValueAtTime(1, when);
      g.gain.linearRampToValueAtTime(0, when + CHOKE_GROUP_FADE);
      // Back up, but on a RAMP (REQ-16). The cut still belongs to the tail that
      // was ringing rather than to the track, so the gain has to return for the
      // next hit — but returning with a bare setValueAtTime moved it 0 -> 1 in a
      // single sample while the open hat was still ringing underneath, which is
      // the very click the down-fade above was chosen to avoid.
      g.gain.setValueAtTime(0, when + CHOKE_GROUP_FADE);
      g.gain.linearRampToValueAtTime(1, when + CHOKE_GROUP_FADE + CHOKE_GROUP_RESTORE);
    }
  }

  /** REQ-12 — `drum.choke`. */
  setChokeEnabled(on: boolean): void { this.chokeEnabled = on; }

  /**
   * Momentary drum fill — snare ramp + tom cascade on the last beat.
   *
   * Written against the lane's own length `n` rather than a hard-coded 16
   * (meter.md REQ-9), so a fill in 7/8 anchors, rolls and claps on that bar's
   * own steps instead of landing mid-bar or never. At `n === 16` every branch
   * evaluates exactly as the 16-step original did: the kick anchor was `s % 8`,
   * the roll began at 12, the toms were L/M/H/H and the clap was step 15.
   */
  private playFill(s: number, n: number, when: number): void {
    const half = Math.max(1, Math.round(n / 2));
    const rollStart = n - Math.max(1, Math.round(n / 4));
    if (s % half === 0) this.fire(0, when, 0.85); // kick anchor
    if (s >= rollStart) {
      const tom = 4 + Math.min(2, s - rollStart); // L→M→H tom roll
      this.fire(tom, when, 0.95);
      if (s === n - 1) this.fire(7, when, 0.9); // clap accent on the bar's last step
    } else {
      this.fire(1, when, 0.5 + 0.45 * (s / Math.max(1, rollStart - 1))); // snare ramp
      if (s % 2 === 0) this.fire(2, when, 0.35); // hats
    }
  }
}

/**
 * Per-track waveshaper curve. `amount` 0 is the identity line (true bypass),
 * higher saturates via a normalised tanh — same shape as the synth FX
 * distortion, but anchored at a clean no-op so `drive` defaults silently.
 *
 * Bucketed + memoized (drive-curve.ts): eight tracks' worth of DRIVE knobs are
 * dragged like any other, and each drag used to allocate a fresh 1024-tap table
 * per bus tick. Identity-stable, so `setTrackDrive` can skip an unchanged one.
 */
function buildDriveCurve(amount: number, samples = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * Float32Array.BYTES_PER_ELEMENT));
  const k = amount * 50;
  const norm = k < 1e-6 ? 1 : Math.tanh(k);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = k < 1e-6 ? x : Math.tanh(k * x) / norm;
  }
  return curve;
}

const driveCurve = memoizeDriveCurve((amount) => buildDriveCurve(amount));

