import { Osc } from './oscillator';
import { Envelope } from './envelope';
import { LadderFilterNode } from './ladder-filter/node';
import { clamp, midiToHz } from '../utils/math';
import { rampTo, RAMP_FAST, RAMP_MEDIUM, RAMP_BYPASS } from './param-utils';

export type VoiceState = 'idle' | 'playing' | 'releasing';

/** The note at which key tracking contributes nothing (key-tracking.md REQ-keytrack-offset-is-relative-to-key-centre). */
const KEY_CENTER = 60;
/** The worklet's own `cutoffNote` range — key tracking is clamped to it (REQ-keytrack-is-clamped-to-range). */
const CUTOFF_MIN = 0;
const CUTOFF_MAX = 135;

/** A voice that is following no track's pan knob (sequencer.md REQ-a-seq-track-carries-a-pan). */
const NO_PAN_GROUP = -1;

/**
 * The panned edge's engaged gain: the equal-power law's centre is 3.01 dB down,
 * and this is what makes centre equal unity again so the stage can be spliced in
 * and out inaudibly (sequencer.md REQ-the-spread-stage-engages-off-centre).
 */
const SPREAD_UNITY = Math.SQRT2;

export class Voice {
  readonly out: GainNode;
  readonly osc1: Osc;
  readonly osc2: Osc;
  readonly sub: Osc;
  readonly noiseGain: GainNode;
  readonly mix: GainNode;
  readonly filter: LadderFilterNode;
  readonly tremolo: GainNode;
  readonly ampVCA: GainNode;
  readonly ampEnv: Envelope;
  readonly filEnv: Envelope;
  readonly filEnvScale: GainNode;

  /**
   * The spread stage (sequencer.md REQ-the-spread-stage-engages-off-centre, ADR-023):
   * `out` fans into a dry edge and a panned one, and the panned one is
   * **disconnected** from the bus unless some sequencer track is off centre. A
   * channel count follows connections rather than gains, so leaving it attached
   * at gain 0 would hold the whole insert chain at two channels and keep paying
   * for them — hence a real disconnect, exactly as ADR-012 bypasses an effect.
   *
   * The panner is fed **mono**, deliberately, so it uses the equal-power law —
   * the one that places a mono source at constant power, `cos/sin` across the
   * sweep. Feeding it stereo instead would put it in the *fold* law, where hard
   * left is `L + R` on one side: measured +3 dB of total power for a hard-panned
   * track, i.e. a pan knob that is also a volume knob.
   *
   * Equal-power costs 3.01 dB at centre, so `spreadWet` carries `SPREAD_UNITY`
   * (= sqrt(2)) to put it back. That is what makes the crossfade below
   * transparent: at centre the panned edge delivers `0.7071x * sqrt(2) = x` per
   * channel, exactly what the dry edge delivers, so two complementary
   * `setTargetAtTime` ramps of equal time constant sum to exactly the input the
   * whole way across — and a hard-panned track keeps the power it had centred.
   */
  readonly spreadDry: GainNode;
  readonly spreadWet: GainNode;
  readonly panner: StereoPannerNode;

  /**
   * Per-voice modulation sources for the mod matrix (mod-matrix.md REQ-per-voice-sources-cannot-drive-bus-destinations).
   *
   * `ConstantSourceNode`s rather than the plain scalars the envelope depth uses,
   * because the matrix routes them as *signals* into summing `AudioParam`s. Both are
   * set once at `noteOn` and then hold, so they cost nothing while a note sustains.
   * `velocitySource` carries 0..1; `keySource` carries the note as -1..1 around
   * middle C, so a route's depth reads the same way on every destination.
   */
  readonly velocitySource: ConstantSourceNode;
  readonly keySource: ConstantSourceNode;

  currentNote = -1;
  state: VoiceState = 'idle';
  noteOnAt = 0;
  noteOffAt = 0;

  private readonly ctx: AudioContext;
  private glideTime = 0;
  private releaseTimer: number | null = null;
  /** Where `connectTo` wired this voice, so the panned edge can be re-attached. */
  private spreadDest: AudioNode | null = null;
  private spreadAttached = false;
  /**
   * Which sequencer track's pan knob this voice is currently following, so a
   * knob turned over a ringing note moves it instead of waiting for the next
   * one. `NO_PAN_GROUP` for live keys, MIDI and the arpeggiator — they are
   * centred and stay centred.
   */
  private panGroup = NO_PAN_GROUP;
  // Key tracking's two cached scalars (key-tracking.md). The effective cutoff
  // is derived from these plus `currentNote`, never stored.
  private baseCutoff = 90;
  private keytrack = 0;
  /**
   * How much of the filter envelope's depth velocity controls (envelopes.md
   * REQ-filter-env-follows-velocity). A plain scalar, not an `AudioParam`: it is only ever read at
   * `noteOn`, so there is nothing to ramp — the value in force when a note
   * starts shapes that note, and the next note picks up any change.
   */
  private filVelAmount = 0;

  static async create(ctx: AudioContext): Promise<Voice> {
    const filter = await LadderFilterNode.create(ctx);
    return new Voice(ctx, filter);
  }

  private constructor(ctx: AudioContext, filter: LadderFilterNode) {
    this.ctx = ctx;
    this.osc1 = new Osc(ctx);
    this.osc2 = new Osc(ctx);
    this.sub = new Osc(ctx);
    this.sub.setWave(0);     // sine by default
    this.sub.setOctave(-1);
    this.sub.setLevel(0);    // silent until the SUB level is raised

    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;

    this.mix = ctx.createGain();
    this.mix.gain.value = 0.5;

    this.filter = filter;

    this.tremolo = ctx.createGain();
    this.tremolo.gain.value = 1;

    this.ampVCA = ctx.createGain();
    this.ampVCA.gain.value = 0;

    this.ampEnv = new Envelope(ctx);
    this.filEnv = new Envelope(ctx);

    this.filEnvScale = ctx.createGain();
    this.filEnvScale.gain.value = 24;

    this.out = ctx.createGain();
    this.out.gain.value = 1 / 4;

    // Spread stage — boots disengaged, i.e. dry at unity and the panned edge
    // unconnected, which is bit-for-bit the pre-v12 voice output.
    this.spreadDry = ctx.createGain();
    this.spreadDry.gain.value = 1;
    this.spreadWet = ctx.createGain();
    this.spreadWet.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = 0;

    this.velocitySource = ctx.createConstantSource();
    this.velocitySource.offset.value = 0;
    this.velocitySource.start();
    this.keySource = ctx.createConstantSource();
    this.keySource.offset.value = 0;
    this.keySource.start();

    // Signal path
    this.osc1.out.connect(this.mix);
    this.osc2.out.connect(this.mix);
    this.sub.out.connect(this.mix);
    this.noiseGain.connect(this.mix);
    this.mix.connect(this.filter.input);
    this.filter.output.connect(this.tremolo);
    this.tremolo.connect(this.ampVCA);
    this.ampVCA.connect(this.out);
    this.out.connect(this.spreadDry);
    this.out.connect(this.spreadWet).connect(this.panner);
    // Neither edge reaches a bus yet — `connectTo` does that, and the panned one
    // only while the stage is engaged.

    // Modulation
    this.ampEnv.out.connect(this.ampVCA.gain);
    this.filEnv.out.connect(this.filEnvScale);
    this.filEnvScale.connect(this.filter.cutoffNote);

    // Pool voices boot idle — no note yet, so the filter can sleep (REQ-the-filter-idles-when-gated).
    this.filter.setActive(false);
  }

  /**
   * Wire both output edges to the voice bus. The panned one is held back until
   * {@link setSpread} engages it (sequencer.md REQ-the-spread-stage-engages-off-centre).
   */
  connectTo(dest: AudioNode): void {
    this.spreadDest = dest;
    this.spreadDry.connect(dest);
    if (this.spreadAttached) this.panner.connect(dest);
  }

  /**
   * Crossfade between the dry and the panned edge, attaching the panned one on
   * the way in so signal never arrives at an edge that is about to be connected
   * (ADR-012's order). The two ramps share a time constant and complementary
   * targets, so at centre they sum to exactly 1 and the move is inaudible.
   *
   * Detaching is NOT done here: the edge has to keep carrying the crossfade out.
   * The caller drops it with {@link dropSpread} once the ramp has settled.
   */
  setSpread(on: boolean): void {
    if (on && !this.spreadAttached) {
      this.spreadAttached = true;
      if (this.spreadDest) this.panner.connect(this.spreadDest);
    }
    rampTo(this.spreadDry.gain, on ? 0 : 1, this.ctx, RAMP_BYPASS);
    rampTo(this.spreadWet.gain, on ? SPREAD_UNITY : 0, this.ctx, RAMP_BYPASS);
  }

  /** Cut the panned edge, so the bus goes back to one channel (and stops paying
   *  for the panner at all — an unreachable node is not rendered). */
  dropSpread(): void {
    if (!this.spreadAttached) return;
    this.spreadAttached = false;
    this.panner.disconnect();
  }

  /**
   * A track's pan knob moved. Only the voices currently sounding that track
   * follow it, which is what makes the knob live over a held or tied note
   * instead of taking effect on the next one.
   */
  setGroupPan(group: number, pan: number): void {
    if (this.panGroup !== group) return;
    rampTo(this.panner.pan, pan, this.ctx, RAMP_MEDIUM);
  }

  noteOn(
    note: number,
    velocity: number,
    when: number,
    opts?: { detuneCents?: number; glide?: boolean; pan?: number; panGroup?: number },
  ): void {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    // Unconditionally every call: a lost deactivate may cost CPU, never a note.
    this.filter.setActive(true);
    this.currentNote = note;
    this.state = 'playing';
    this.noteOnAt = when;
    // Pan lands AT the note, not now: a voice stolen from a differently panned
    // track must not drag its new position back over the tail it is replacing.
    // A short target rather than a step, so the hand-off glides (sequencer.md
    // REQ-two-tracks-on-one-pitch-share-a-pan). No cancel, so nothing needs
    // anchoring — each target simply supersedes the last from its own time.
    this.panGroup = opts?.panGroup ?? NO_PAN_GROUP;
    this.panner.pan.setTargetAtTime(opts?.pan ?? 0, when, RAMP_FAST);
    const detune = opts?.detuneCents ?? 0;
    const hz = midiToHz(note) * Math.pow(2, detune / 1200);
    const doGlide = opts?.glide ?? this.glideTime > 0;
    const g = doGlide ? this.glideTime : 0;
    this.osc1.setFrequency(hz, when, g);
    this.osc2.setFrequency(hz, when, g);
    this.sub.setFrequency(hz, when, g);
    // Key tracking lands with the note, not as a ramp from the previous note's
    // cutoff — a glide there would whoop (key-tracking.md REQ-keytrack-lands-at-note-on). A no-op write
    // when keytrack is 0, since the value then equals what setFilterCutoff set.
    if (this.keytrack !== 0) {
      this.filter.cutoffNote.setValueAtTime(this.effectiveCutoff(), when);
    }
    // Matrix sources land with the note, like key tracking above — they describe
    // *this* note, so a ramp from the previous note's values would smear two notes
    // together (mod-matrix.md REQ-per-voice-sources-cannot-drive-bus-destinations). Key is normalised around middle C over ±4
    // octaves, so a route's depth means the same thing on every destination.
    this.velocitySource.offset.setValueAtTime(velocity, when);
    this.keySource.offset.setValueAtTime(clamp((note - 60) / 48, -1, 1), when);
    this.ampEnv.trigger(when, Math.max(0.01, velocity));
    // Velocity → filter (envelopes.md REQ-filter-env-follows-velocity). `filVelAmount` 0 gives exactly the
    // hard-coded 1 this used to pass, so the default changes nothing; at 1 the
    // sweep scales straight with velocity. Scaling the envelope's PEAK scales the
    // sweep depth in semitones (filEnv → filEnvScale → cutoffNote), so a soft
    // note is duller without its base cutoff moving.
    this.filEnv.trigger(when, 1 - this.filVelAmount + this.filVelAmount * velocity);
  }

  setSubWave(idx: number): void { this.sub.setWave(idx); }
  setSubOctave(o: number): void { this.sub.setOctave(o); }
  setSubLevel(v: number): void { this.sub.setLevel(v); }

  noteOff(when: number): void {
    if (this.state === 'idle') return;
    this.state = 'releasing';
    this.noteOffAt = when;
    this.ampEnv.release_(when);
    this.filEnv.release_(when);
    // `when` may be up to the transport look-ahead in the future — count the
    // timer from the scheduled release, not from now, so the voice isn't
    // marked idle (stealable) while its tail is still sounding.
    const untilRelease = Math.max(0, when - this.ctx.currentTime);
    const delayMs = (untilRelease + this.ampEnv.releaseDuration() + 0.1) * 1000;
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = null;
      if (this.state === 'releasing') {
        this.state = 'idle';
        this.currentNote = -1;
        this.filter.setActive(false);
      }
    }, delayMs);
  }

  /** Force-silence the voice quickly (voice stealing). */
  kill(when: number): void {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    // Through the envelope, never on its gain param directly — the envelope's
    // scheduled-automation model must see every write (envelopes.md REQ-envelope-scheduling-is-future-time-safe).
    this.ampEnv.cutFast(when);
    this.state = 'idle';
    this.currentNote = -1;
    // Deactivate only after the 3 ms kill fade has passed, and only if no
    // noteOn re-claimed the voice meanwhile (it posts its own true) (REQ-the-filter-idles-when-gated).
    window.setTimeout(() => {
      if (this.state === 'idle') this.filter.setActive(false);
    }, 30);
  }

  setGlide(seconds: number): void {
    this.glideTime = Math.max(0, seconds);
  }

  setNoiseLevel(v: number): void {
    rampTo(this.noiseGain.gain, v, this.ctx, RAMP_MEDIUM);
  }

  setFilterCutoff(note: number): void {
    this.baseCutoff = note;
    rampTo(this.filter.cutoffNote, this.effectiveCutoff(), this.ctx, RAMP_FAST);
  }

  setFilterResonance(r: number): void {
    rampTo(this.filter.resonance, r, this.ctx, RAMP_FAST);
  }

  setFilterDrive(d: number): void {
    this.filter.drive.setValueAtTime(d, this.ctx.currentTime);
  }

  setFilterEnvAmount(semi: number): void {
    rampTo(this.filEnvScale.gain, semi, this.ctx, RAMP_MEDIUM);
  }

  /** 0 = LADDER, 1 = POLY (filter-models.md REQ-filter-model-is-a-discrete-param). k-rate, so no ramp. */
  setFilterModel(m: number): void {
    this.filter.model.setValueAtTime(Math.round(m), this.ctx.currentTime);
  }

  setFilterShape(s: number): void {
    rampTo(this.filter.shape, s, this.ctx, RAMP_FAST);
  }

  /** envelopes.md REQ-filter-env-follows-velocity. Takes effect on the NEXT note — a held note's sweep is
   *  already scheduled, and re-shaping it mid-flight would click. */
  setFilterVelAmount(amount: number): void {
    this.filVelAmount = Math.max(0, Math.min(1, amount));
  }

  setFilterKeytrack(amount: number): void {
    this.keytrack = amount;
    // A held note must follow the knob rather than wait for the next noteOn
    // (key-tracking.md REQ-keytrack-updates-held-voices); ramped, because this one is a knob drag.
    rampTo(this.filter.cutoffNote, this.effectiveCutoff(), this.ctx, RAMP_FAST);
  }

  /**
   * Base cutoff plus key tracking, in semitones
   * (key-tracking.md REQ-keytrack-stays-in-semitone-space, over the
   * centre-relative REQ-keytrack-offset-is-relative-to-key-centre).
   * The single place the three cached scalars combine, so `noteOn` and both
   * knob paths cannot drift apart. Clamped to the worklet's `cutoffNote` range
   * (REQ-keytrack-is-clamped-to-range) — the envelope and LFO still sum on top
   * at the AudioParam.
   */
  private effectiveCutoff(): number {
    const note = this.currentNote < 0 ? KEY_CENTER : this.currentNote;
    const v = this.baseCutoff + this.keytrack * (note - KEY_CENTER);
    return Math.max(CUTOFF_MIN, Math.min(CUTOFF_MAX, v));
  }
}
