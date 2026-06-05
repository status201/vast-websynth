import { LadderFilterNode } from './ladder-filter/node';
import { Voice } from './voice';
import { LFO } from './lfo';
import { Distortion } from './effects/distortion';
import { Wah } from './effects/wah';
import { Phaser } from './effects/phaser';
import { Delay } from './effects/delay';
import { Reverb } from './effects/reverb';
import { ParamBus, registerDefaults } from '../state/params';
import { rampTo, RAMP_FAST, RAMP_MEDIUM } from './param-utils';
import { assertIndex } from '../utils/array';
import type { SynthOutput } from './transport/note-output';
import { Clock } from './transport/clock';
import { Arpeggiator } from './transport/arpeggiator';
import { StepSequencer } from './transport/sequencer';
import { DrumMachine } from './transport/drum-machine';
import { SamplerMachine } from './transport/sampler-machine';
import { Arrangement } from './transport/arrangement';
import { Performance } from './transport/performance';
import { RecorderNode } from './recorder/node';
import { RecorderController } from './recorder/recorder-controller';
import { PatternStore } from '../state/patterns';

const VOICE_COUNT = 8;
const PITCH_BEND_RANGE_CENTS = 200;

export class Engine {
  readonly ctx: AudioContext;
  readonly voices: Voice[] = [];
  readonly voiceBus: GainNode;
  readonly master: GainNode;
  readonly analyser: AnalyserNode;

  readonly distortion: Distortion;
  readonly wah: Wah;
  readonly phaser: Phaser;
  readonly delay: Delay;
  readonly reverb: Reverb;

  readonly drumPhaser: Phaser;
  readonly drumDelay: Delay;

  readonly samplerDist: Distortion;
  readonly samplerPhaser: Phaser;
  readonly samplerDelay: Delay;
  readonly samplerReverb: Reverb;

  readonly preMaster!: GainNode;
  readonly drumBus!: GainNode;
  readonly samplerBus!: GainNode;

  readonly patterns: PatternStore;
  readonly clock: Clock;
  readonly djFilter: BiquadFilterNode;
  arp!: Arpeggiator;
  seq!: StepSequencer;
  drums!: DrumMachine;
  sampler!: SamplerMachine;
  arrangement!: Arrangement;
  perf!: Performance;
  recorder!: RecorderController;
  private recorderNode!: RecorderNode;

  readonly lfo: LFO;
  private readonly pitchBend: ConstantSourceNode;
  private readonly drift: ConstantSourceNode;
  private readonly noise: AudioBufferSourceNode;
  private polyMode = true;
  private heldNotes = new Map<number, Voice[]>();

  private driftAmount = 0;
  private driftTimer: number | null = null;
  private unisonCount = 1;
  private unisonDetune = 12;
  private glideMode = 1; // 0 off · 1 always · 2 legato
  /** When true, bus.noteOn/Off do not directly play notes — arp/seq do. */
  passthroughSuppressed = false;
  /** True when the arpeggiator is suppressing direct note input. */
  get arpPassthroughSuppressed(): boolean { return this.arp?.passthroughSuppressed ?? false; }

  constructor(private readonly bus: ParamBus) {
    registerDefaults(bus);
    this.ctx = new AudioContext({ latencyHint: 'interactive' });

    this.voiceBus = this.ctx.createGain();
    this.voiceBus.gain.value = 1;

    this.distortion = new Distortion(this.ctx);
    this.wah = new Wah(this.ctx);
    this.phaser = new Phaser(this.ctx);
    this.delay = new Delay(this.ctx);
    this.reverb = new Reverb(this.ctx);

    this.drumPhaser = new Phaser(this.ctx);
    this.drumDelay = new Delay(this.ctx);

    this.samplerDist = new Distortion(this.ctx);
    this.samplerPhaser = new Phaser(this.ctx);
    this.samplerDelay = new Delay(this.ctx);
    this.samplerReverb = new Reverb(this.ctx);

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.2;

    // Sum bus where synth FX chain and drum bus meet before master volume.
    // Tapping the analyser here (pre-master) keeps the scope amplitude
    // independent of the master-volume knob.
    this.preMaster = this.ctx.createGain();
    this.preMaster.gain.value = 1;

    this.drumBus = this.ctx.createGain();
    this.drumBus.gain.value = 1;

    this.samplerBus = this.ctx.createGain();
    this.samplerBus.gain.value = 1;

    // Synth FX chain
    this.voiceBus.connect(this.distortion.input);
    this.distortion.output.connect(this.wah.input);
    this.wah.output.connect(this.phaser.input);
    this.phaser.output.connect(this.delay.input);
    this.delay.output.connect(this.reverb.input);
    this.reverb.output.connect(this.preMaster);

    // Drum FX chain: phaser → delay
    this.drumBus.connect(this.drumPhaser.input);
    this.drumPhaser.output.connect(this.drumDelay.input);
    this.drumDelay.output.connect(this.preMaster);

    // Sampler FX chain: distortion → phaser → delay → reverb
    this.samplerBus.connect(this.samplerDist.input);
    this.samplerDist.output.connect(this.samplerPhaser.input);
    this.samplerPhaser.output.connect(this.samplerDelay.input);
    this.samplerDelay.output.connect(this.samplerReverb.input);
    this.samplerReverb.output.connect(this.preMaster);

    // DJ performance filter — transparent by default, swept live.
    this.djFilter = this.ctx.createBiquadFilter();
    this.djFilter.type = 'lowpass';
    this.djFilter.frequency.value = 20000;
    this.djFilter.Q.value = 0.7;

    this.preMaster.connect(this.djFilter);
    this.djFilter.connect(this.analyser);
    this.analyser.connect(this.master);
    this.master.connect(this.ctx.destination);

    this.lfo = new LFO(this.ctx);

    this.pitchBend = this.ctx.createConstantSource();
    this.pitchBend.offset.value = 0;
    this.pitchBend.start();

    // Analogue oscillator drift — slow random detune summed into all oscs.
    this.drift = this.ctx.createConstantSource();
    this.drift.offset.value = 0;
    this.drift.start();

    this.noise = this.createNoiseSource();

    this.patterns = new PatternStore();
    this.clock = new Clock(this.ctx);
  }

  async init(): Promise<void> {
    await LadderFilterNode.loadModule(this.ctx);
    await RecorderNode.loadModule(this.ctx);

    for (let i = 0; i < VOICE_COUNT; i++) {
      const v = await Voice.create(this.ctx);
      v.out.connect(this.voiceBus);
      this.noise.connect(v.noiseGain);

      // LFO routing
      this.lfo.toPitch.connect(v.osc1.detuneParam);
      this.lfo.toPitch.connect(v.osc2.detuneParam);
      this.lfo.toPitch.connect(v.sub.detuneParam);
      this.lfo.toCutoff.connect(v.filter.cutoffNote);
      this.lfo.toAmp.connect(v.tremolo.gain);

      // Pitch bend
      this.pitchBend.connect(v.osc1.detuneParam);
      this.pitchBend.connect(v.osc2.detuneParam);
      this.pitchBend.connect(v.sub.detuneParam);

      // Analogue drift
      this.drift.connect(v.osc1.detuneParam);
      this.drift.connect(v.osc2.detuneParam);
      this.drift.connect(v.sub.detuneParam);

      this.voices.push(v);
    }

    // Arrangement first so its clock tick runs before the machines read
    // the play banks for the same tick.
    this.arrangement = new Arrangement(this.patterns, this.clock);
    this.perf = new Performance(this.ctx, this.clock, this.bus, this.djFilter);

    // Transport modules — created after voices so they can call engine.playNote
    const synthOutput: SynthOutput = {
      playNote: (n, v, w) => this.playNote(n, v, w),
      releaseNote: (n, w) => this.releaseNote(n, w),
    };
    this.arp = new Arpeggiator(synthOutput, this.bus, this.clock);
    this.seq = new StepSequencer(synthOutput, this.clock, this.patterns, this.arrangement, this.perf);
    this.drums = new DrumMachine(this.ctx, this.clock, this.patterns, this.arrangement, this.perf, this.drumBus);
    this.sampler = new SamplerMachine(this.ctx, this.clock, this.patterns, this.arrangement, this.perf, this.samplerBus);

    // Audio capture: tap master (post master-volume). The recorder node has
    // zero outputs so it is a pure sink and never doubles into destination.
    this.recorderNode = await RecorderNode.create(this.ctx);
    this.master.connect(this.recorderNode.input);
    this.recorder = new RecorderController(this.clock, this.arrangement, this.recorderNode);

    this.driftTimer = window.setInterval(this.driftStep, 110);

    this.subscribeParams();
    this.bus.onNote((on, note, vel) => {
      if (this.arpPassthroughSuppressed) return;
      if (on) this.playNote(note, vel);
      else this.releaseNote(note);
    });
  }

  /**
   * Resume the AudioContext. Browsers create it suspended until a user
   * gesture, so `init()` can run (and the UI can mount) before this is
   * called — this must be invoked from within the start-button gesture.
   */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* stays suspended until gesture */ }
    }
  }

  // ---------- Note handling ----------

  /** Play a note at the given audio time (defaults to now). */
  playNote(note: number, velocity = 0.8, when?: number): void {
    const t = when ?? this.ctx.currentTime;
    const count = Math.max(1, Math.min(this.unisonCount, this.voices.length));
    // Legato = glide only when another note is already sounding.
    const anySounding = this.heldNotes.size > 0;
    const glide = this.glideMode === 1 ? true : this.glideMode === 2 ? anySounding : false;

    if (!this.polyMode) {
      const used: Voice[] = [];
      for (let i = 0; i < count; i++) {
        const v = this.voices[i]!;
        v.noteOn(note, velocity, t, { detuneCents: this.unisonOffset(i, count), glide });
        used.push(v);
      }
      this.heldNotes.set(note, used);
      return;
    }

    const existing = this.heldNotes.get(note);
    if (existing && existing.some((v) => v.state !== 'idle')) {
      for (let i = 0; i < existing.length; i++) {
        existing[i]!.noteOn(note, velocity, t, { detuneCents: this.unisonOffset(i, existing.length), glide });
      }
      return;
    }
    const used: Voice[] = [];
    for (let i = 0; i < count; i++) {
      const v = this.pickVoice();
      v.noteOn(note, velocity, t, { detuneCents: this.unisonOffset(i, count), glide });
      used.push(v);
    }
    this.heldNotes.set(note, used);
  }

  /** Release a note at the given audio time (defaults to now). */
  releaseNote(note: number, when?: number): void {
    const t = when ?? this.ctx.currentTime;
    const vs = this.heldNotes.get(note);
    if (vs) {
      for (const v of vs) v.noteOff(t);
      this.heldNotes.delete(note);
    }
  }

  /** Force-silence every voice and forget held notes (no transport change). */
  private killAllVoices(): void {
    const t = this.ctx.currentTime;
    for (const v of this.voices) v.kill(t);
    this.heldNotes.clear();
  }

  /** Stop the transport AND silence everything (Panic button / Esc). */
  panic(): void {
    this.clock.stop();
    this.killAllVoices();
  }

  /** Symmetric detune spread in cents for unison copy i of n. */
  private unisonOffset(i: number, n: number): number {
    if (n <= 1) return 0;
    return (i / (n - 1) - 0.5) * 2 * this.unisonDetune;
  }

  private driftStep = (): void => {
    const range = this.driftAmount * 12; // ±12 cents at full
    const target = range <= 0 ? 0 : (Math.random() * 2 - 1) * range;
    this.drift.offset.setTargetAtTime(target, this.ctx.currentTime, 0.12);
  };

  private pickVoice(): Voice {
    // Prefer idle voices, then oldest releasing, then oldest playing
    let idle: Voice | null = null;
    let oldestReleasing: Voice | null = null;
    let oldestPlaying: Voice | null = null;
    for (const v of this.voices) {
      if (v.state === 'idle') { idle = v; break; }
      if (v.state === 'releasing') {
        if (!oldestReleasing || v.noteOffAt < oldestReleasing.noteOffAt) oldestReleasing = v;
      } else {
        if (!oldestPlaying || v.noteOnAt < oldestPlaying.noteOnAt) oldestPlaying = v;
      }
    }
    if (idle) return idle;
    if (oldestReleasing) return oldestReleasing;
    return oldestPlaying ?? assertIndex(this.voices, 0, 'voices');
  }

  // ---------- Param subscriptions ----------

  private subscribeParams(): void {
    const bus = this.bus;
    const all = (fn: (v: Voice, value: number) => void) =>
      (value: number) => { for (const v of this.voices) fn(v, value); };

    // Voicing
    bus.subscribe('voicing.mode', (v) => {
      const wasPoly = this.polyMode;
      this.polyMode = v >= 0.5;
      if (wasPoly !== this.polyMode) this.killAllVoices();
    });

    // OSC 1
    bus.subscribe('osc1.wave', all((v, x) => v.osc1.setWave(x)));
    bus.subscribe('osc1.octave', all((v, x) => v.osc1.setOctave(x)));
    bus.subscribe('osc1.detune', all((v, x) => v.osc1.setDetuneCents(x)));
    bus.subscribe('osc1.level', all((v, x) => v.osc1.setLevel(x)));

    // OSC 2
    bus.subscribe('osc2.wave', all((v, x) => v.osc2.setWave(x)));
    bus.subscribe('osc2.octave', all((v, x) => v.osc2.setOctave(x)));
    bus.subscribe('osc2.detune', all((v, x) => v.osc2.setDetuneCents(x)));
    bus.subscribe('osc2.level', all((v, x) => v.osc2.setLevel(x)));

    // Sub oscillator
    bus.subscribe('sub.wave', all((v, x) => v.setSubWave(x)));
    bus.subscribe('sub.octave', all((v, x) => v.setSubOctave(x)));
    bus.subscribe('sub.level', all((v, x) => v.setSubLevel(x)));

    // Unison
    bus.subscribe('unison.voices', (x) => { this.unisonCount = Math.max(1, Math.round(x)); });
    bus.subscribe('unison.detune', (x) => { this.unisonDetune = x; });

    // Analogue drift / glide mode
    bus.subscribe('analog.drift', (x) => { this.driftAmount = x; });
    bus.subscribe('glide.mode', (x) => { this.glideMode = Math.round(x); });

    // Mixer
    bus.subscribe('mixer.noise', all((v, x) => v.setNoiseLevel(x)));
    bus.subscribe('mixer.glide', all((v, x) => v.setGlide(x)));

    // Filter
    bus.subscribe('filter.cutoff', all((v, x) => v.setFilterCutoff(x)));
    bus.subscribe('filter.resonance', all((v, x) => v.setFilterResonance(x)));
    bus.subscribe('filter.drive', all((v, x) => v.setFilterDrive(x)));
    bus.subscribe('filter.envAmount', all((v, x) => v.setFilterEnvAmount(x)));

    // Amp envelope
    bus.subscribe('env.amp.attack', all((v, x) => v.ampEnv.setAttack(x)));
    bus.subscribe('env.amp.decay', all((v, x) => v.ampEnv.setDecay(x)));
    bus.subscribe('env.amp.sustain', all((v, x) => v.ampEnv.setSustain(x)));
    bus.subscribe('env.amp.release', all((v, x) => v.ampEnv.setRelease(x)));

    // Filter envelope
    bus.subscribe('env.fil.attack', all((v, x) => v.filEnv.setAttack(x)));
    bus.subscribe('env.fil.decay', all((v, x) => v.filEnv.setDecay(x)));
    bus.subscribe('env.fil.sustain', all((v, x) => v.filEnv.setSustain(x)));
    bus.subscribe('env.fil.release', all((v, x) => v.filEnv.setRelease(x)));

    // LFO (amount = base knob + mod wheel, clamped to [0, 1])
    const updateLfoAmount = () => {
      const base = bus.get('lfo.amount');
      const mw = bus.get('master.modWheel');
      this.lfo.setAmount(Math.min(1, base + mw));
    };
    bus.subscribe('lfo.rate', (x) => this.lfo.setRate(x));
    bus.subscribe('lfo.amount', () => updateLfoAmount());
    bus.subscribe('lfo.wave', (x) => this.lfo.setWave(x));
    bus.subscribe('lfo.dest', (x) => this.lfo.setDest(x));

    // FX: Distortion
    bus.subscribe('fx.dist.on', (x) => this.distortion.setBypass(x < 0.5));
    bus.subscribe('fx.dist.drive', (x) => this.distortion.setDrive(x));
    bus.subscribe('fx.dist.tone', (x) => this.distortion.setTone(x));
    bus.subscribe('fx.dist.mix', (x) => this.distortion.setMix(x));

    // FX: Wah
    bus.subscribe('fx.wah.on', (x) => this.wah.setBypass(x < 0.5));
    bus.subscribe('fx.wah.rate', (x) => this.wah.setRate(x));
    bus.subscribe('fx.wah.depth', (x) => this.wah.setDepth(x));
    bus.subscribe('fx.wah.q', (x) => this.wah.setQ(x));

    // FX: Phaser
    bus.subscribe('fx.phaser.on', (x) => this.phaser.setBypass(x < 0.5));
    bus.subscribe('fx.phaser.rate', (x) => this.phaser.setRate(x));
    bus.subscribe('fx.phaser.depth', (x) => this.phaser.setDepth(x));
    bus.subscribe('fx.phaser.feedback', (x) => this.phaser.setFeedback(x));
    bus.subscribe('fx.phaser.mix', (x) => this.phaser.setMix(x));

    // FX: Delay
    bus.subscribe('fx.delay.on', (x) => this.delay.setBypass(x < 0.5));
    bus.subscribe('fx.delay.time', (x) => this.delay.setTime(x));
    bus.subscribe('fx.delay.feedback', (x) => this.delay.setFeedback(x));
    bus.subscribe('fx.delay.mix', (x) => this.delay.setMix(x));

    // FX: Reverb
    bus.subscribe('fx.reverb.on', (x) => this.reverb.setBypass(x < 0.5));
    bus.subscribe('fx.reverb.size', (x) => this.reverb.setSize(x));
    bus.subscribe('fx.reverb.damp', (x) => this.reverb.setDamp(x));
    bus.subscribe('fx.reverb.mix', (x) => this.reverb.setMix(x));

    // Drum FX: Phaser
    bus.subscribe('fx.drum.phaser.on', (x) => this.drumPhaser.setBypass(x < 0.5));
    bus.subscribe('fx.drum.phaser.rate', (x) => this.drumPhaser.setRate(x));
    bus.subscribe('fx.drum.phaser.depth', (x) => this.drumPhaser.setDepth(x));
    bus.subscribe('fx.drum.phaser.feedback', (x) => this.drumPhaser.setFeedback(x));
    bus.subscribe('fx.drum.phaser.mix', (x) => this.drumPhaser.setMix(x));

    // Drum FX: Delay
    bus.subscribe('fx.drum.delay.on', (x) => this.drumDelay.setBypass(x < 0.5));
    bus.subscribe('fx.drum.delay.time', (x) => this.drumDelay.setTime(x));
    bus.subscribe('fx.drum.delay.feedback', (x) => this.drumDelay.setFeedback(x));
    bus.subscribe('fx.drum.delay.mix', (x) => this.drumDelay.setMix(x));

    // Sampler FX: Distortion
    bus.subscribe('fx.sampler.dist.on', (x) => this.samplerDist.setBypass(x < 0.5));
    bus.subscribe('fx.sampler.dist.drive', (x) => this.samplerDist.setDrive(x));
    bus.subscribe('fx.sampler.dist.tone', (x) => this.samplerDist.setTone(x));
    bus.subscribe('fx.sampler.dist.mix', (x) => this.samplerDist.setMix(x));

    // Sampler FX: Phaser
    bus.subscribe('fx.sampler.phaser.on', (x) => this.samplerPhaser.setBypass(x < 0.5));
    bus.subscribe('fx.sampler.phaser.rate', (x) => this.samplerPhaser.setRate(x));
    bus.subscribe('fx.sampler.phaser.depth', (x) => this.samplerPhaser.setDepth(x));
    bus.subscribe('fx.sampler.phaser.feedback', (x) => this.samplerPhaser.setFeedback(x));
    bus.subscribe('fx.sampler.phaser.mix', (x) => this.samplerPhaser.setMix(x));

    // Sampler FX: Delay
    bus.subscribe('fx.sampler.delay.on', (x) => this.samplerDelay.setBypass(x < 0.5));
    bus.subscribe('fx.sampler.delay.time', (x) => this.samplerDelay.setTime(x));
    bus.subscribe('fx.sampler.delay.feedback', (x) => this.samplerDelay.setFeedback(x));
    bus.subscribe('fx.sampler.delay.mix', (x) => this.samplerDelay.setMix(x));

    // Sampler FX: Reverb
    bus.subscribe('fx.sampler.reverb.on', (x) => this.samplerReverb.setBypass(x < 0.5));
    bus.subscribe('fx.sampler.reverb.size', (x) => this.samplerReverb.setSize(x));
    bus.subscribe('fx.sampler.reverb.damp', (x) => this.samplerReverb.setDamp(x));
    bus.subscribe('fx.sampler.reverb.mix', (x) => this.samplerReverb.setMix(x));

    // DJ filter (manual sweep; Drop overrides it while held)
    bus.subscribe('fx.djfilter', (x) => this.perf.setDjFilter(x));

    // Master
    bus.subscribe('master.volume', (x) => {
      rampTo(this.master.gain, x * x, this.ctx, RAMP_MEDIUM);
    });
    bus.subscribe('master.pitchBend', (x) => {
      rampTo(this.pitchBend.offset, x * PITCH_BEND_RANGE_CENTS, this.ctx, RAMP_FAST);
    });
    bus.subscribe('master.modWheel', () => updateLfoAmount());

    // ----- Transport -----
    bus.subscribe('transport.bpm', (b) => this.clock.setBpm(b));

    // ----- Arpeggiator -----
    bus.subscribe('arp.on', (v) => this.arp.setEnabled(v >= 0.5));
    bus.subscribe('arp.pattern', (v) => this.arp.setPattern(v));
    bus.subscribe('arp.rate', (v) => this.arp.setRate(v));
    bus.subscribe('arp.octaves', (v) => this.arp.setOctaves(v));
    bus.subscribe('arp.gate', (v) => this.arp.setGate(v));

    // ----- Sequencer -----
    bus.subscribe('seq.on', (v) => this.seq.setEnabled(v >= 0.5));

    // ----- Drums -----
    bus.subscribe('drum.on', (v) => this.drums.setEnabled(v >= 0.5));
    bus.subscribe('drum.master', (v) => {
      rampTo(this.drumBus.gain, v, this.ctx, RAMP_MEDIUM);
    });
    for (let i = 0; i < 8; i++) {
      const track = i;
      bus.subscribe(`drum.t${i}.vol`, (v) => this.drums.setTrackVolume(track, v));
      bus.subscribe(`drum.t${i}.tune`, (v) => this.drums.setTrackTune(track, v));
      bus.subscribe(`drum.t${i}.decay`, (v) => this.drums.setTrackDecay(track, v));
      bus.subscribe(`drum.t${i}.mute`, (v) => this.drums.setTrackMute(track, v >= 0.5));
    }

    // ----- Sampler -----
    bus.subscribe('sampler.on', (v) => this.sampler.setEnabled(v >= 0.5));
    bus.subscribe('sampler.master', (v) => {
      rampTo(this.samplerBus.gain, v, this.ctx, RAMP_MEDIUM);
    });
    for (let i = 0; i < 8; i++) {
      const slot = i;
      bus.subscribe(`sampler.t${i}.mute`, (v) => this.sampler.setSlotMute(slot, v >= 0.5));
    }
  }

  // ---------- Noise source ----------

  private createNoiseSource(): AudioBufferSourceNode {
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, sr * 2, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start();
    return src;
  }
}
