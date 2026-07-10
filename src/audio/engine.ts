import { LadderFilterNode } from './ladder-filter/node';
import { Voice } from './voice';
import { LFO } from './lfo';
import { Distortion } from './effects/distortion';
import { Wah } from './effects/wah';
import { Phaser } from './effects/phaser';
import { Delay } from './effects/delay';
import { Reverb } from './effects/reverb';
import { Compressor } from './effects/compressor';
import { chain } from './effects/effect';
import { CompressorNode } from './compressor/node';
import { ParamBus, registerDefaults } from '../state/params';
import { rampTo, RAMP_FAST, RAMP_MEDIUM } from './param-utils';
import { Polyphony } from './polyphony';
import { LaneMixer } from './lane-mixer';
import type { SynthOutput } from './transport/note-output';
import { Clock } from './transport/clock';
import { Arpeggiator } from './transport/arpeggiator';
import { StepSequencer } from './transport/sequencer';
import { DrumMachine } from './transport/drum-machine';
import { SamplerMachine } from './transport/sampler-machine';
import { Arrangement } from './transport/arrangement';
import { Performance } from './transport/performance';
import { SyncController } from './transport/sync/sync-controller';
import { WebRtcSyncTransport } from './webrtc-sync-transport';
import { RecorderNode } from './recorder/node';
import { RecorderController } from './recorder/recorder-controller';
import { PatternStore, DRUM_TRACK_COUNT } from '../state/patterns';
import { IosAudioSession, shouldResumeContext, type IosAudioDiagnostics } from './ios-audio-session';

const VOICE_COUNT = 8;
const PITCH_BEND_RANGE_CENTS = 200;

/**
 * Boot-time tuning chosen by Performance mode (see `state/perf-mode.ts`). Both
 * fields can only be applied when the `AudioContext`/voice pool are built, so
 * they are passed once at construction and cannot change without a reload.
 */
export interface EngineOptions {
  /** AudioContext buffer hint; 'playback' trades latency for a larger, glitch-resistant buffer. */
  latencyHint?: AudioContextLatencyCategory;
  /** Size of the voice pool (defaults to VOICE_COUNT). */
  voiceCount?: number;
  /** Transport look-ahead horizon (s); wider on weak tiers (defaults to the Clock's own). */
  scheduleAheadS?: number;
  /** Longest reverb IR the banks render (s); caps always-on convolution cost (default 4). */
  reverbIrMaxS?: number;
  /** Allow WaveShaper oversampling in the distortions + drum tracks (default true). */
  fxOversample?: boolean;
  /** fftSize for the 3 scope analysers; smaller on weak cuts always-on FFT cost (default 2048). */
  analyserFftSize?: number;
}

export class Engine {
  readonly ctx: AudioContext;
  readonly voices: Voice[] = [];
  readonly voiceBus: GainNode;
  readonly master: GainNode;
  readonly analyser: AnalyserNode;
  /** Per-channel analysers for the scope's stereo view (left / right). */
  readonly analyserL: AnalyserNode;
  readonly analyserR: AnalyserNode;

  readonly distortion: Distortion;
  readonly wah: Wah;
  readonly phaser: Phaser;
  readonly delay: Delay;
  readonly reverb: Reverb;

  readonly drumPhaser: Phaser;
  readonly drumDelay: Delay;
  readonly drumReverb: Reverb;
  readonly drumComp: Compressor;
  readonly masterComp: Compressor;

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
  sync!: SyncController;
  rtcSync!: WebRtcSyncTransport;
  private recorderNode!: RecorderNode;

  readonly lfo: LFO;
  private readonly pitchBend: ConstantSourceNode;
  private readonly noise: AudioBufferSourceNode;

  // Voice allocation + voicing (poly/unison/glide/drift) and the Song-tab lane
  // mixer (mute/solo/volume) are delegated out of the Engine (ADR-008).
  private polyphony!: Polyphony;
  private laneMixer!: LaneMixer;

  /** When true, bus.noteOn/Off do not directly play notes — arp/seq do. */
  passthroughSuppressed = false;
  /** True when the arpeggiator is suppressing direct note input. */
  get arpPassthroughSuppressed(): boolean { return this.arp?.passthroughSuppressed ?? false; }

  private readonly voiceCount: number;
  private readonly fxOversample: boolean;

  /** iOS-only audio-session workarounds; inert (no-op) on every other platform. */
  private readonly iosSession: IosAudioSession;

  constructor(private readonly bus: ParamBus, opts: EngineOptions = {}) {
    registerDefaults(bus);
    this.voiceCount = opts.voiceCount ?? VOICE_COUNT;
    this.ctx = new AudioContext({ latencyHint: opts.latencyHint ?? 'interactive' });
    // Built here (after ctx) so the silent loop can be routed through the context.
    this.iosSession = new IosAudioSession(this.ctx);

    this.voiceBus = this.ctx.createGain();
    this.voiceBus.gain.value = 1;

    // Perf-tier FX-cost knobs (performance-mode.md REQ-11); defaults are no-ops.
    this.fxOversample = opts.fxOversample ?? true;
    const reverbOpts = { maxIrS: opts.reverbIrMaxS ?? 4 };
    const distOpts = { oversample: this.fxOversample };

    this.distortion = new Distortion(this.ctx, distOpts);
    this.wah = new Wah(this.ctx);
    this.phaser = new Phaser(this.ctx);
    this.delay = new Delay(this.ctx);
    this.reverb = new Reverb(this.ctx, reverbOpts);

    this.drumPhaser = new Phaser(this.ctx);
    this.drumDelay = new Delay(this.ctx);
    this.drumReverb = new Reverb(this.ctx, reverbOpts);
    this.drumComp = new Compressor(this.ctx, 'fet');
    this.masterComp = new Compressor(this.ctx, 'vca');

    this.samplerDist = new Distortion(this.ctx, distOpts);
    this.samplerPhaser = new Phaser(this.ctx);
    this.samplerDelay = new Delay(this.ctx);
    this.samplerReverb = new Reverb(this.ctx, reverbOpts);

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;

    // fftSize is perf-tier-dependent (performance-mode.md REQ-12): 512/1024/2048 for
    // weak/medium/strong, cutting the always-pulled analyser FFT + per-draw copy cost
    // on weaker tiers. This is the BOOT seed only — the scope applies later tier
    // changes live via setFftSize. All three share one value so the scope's
    // per-channel buffers stay uniform (scope.md REQ-2).
    const fft = opts.analyserFftSize ?? 2048;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = fft;
    this.analyser.smoothingTimeConstant = 0.2;

    // Per-channel analysers for the scope's stereo view. Same fftSize/smoothing
    // as the mono analyser so all three buffers are uniform and comparable.
    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();
    for (const a of [this.analyserL, this.analyserR]) {
      a.fftSize = fft;
      a.smoothingTimeConstant = 0.2;
    }

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
    chain(this.voiceBus, [this.distortion, this.wah, this.phaser, this.delay, this.reverb], this.preMaster);

    // Drum FX chain: compressor → phaser → delay → reverb. The 1176-style
    // compressor sits first so it smashes the dry hits, not the FX wash.
    chain(this.drumBus, [this.drumComp, this.drumPhaser, this.drumDelay, this.drumReverb], this.preMaster);

    // Sampler FX chain: distortion → phaser → delay → reverb
    chain(this.samplerBus, [this.samplerDist, this.samplerPhaser, this.samplerDelay, this.samplerReverb], this.preMaster);

    // DJ performance filter — transparent by default, swept live.
    this.djFilter = this.ctx.createBiquadFilter();
    this.djFilter.type = 'lowpass';
    this.djFilter.frequency.value = 20000;
    this.djFilter.Q.value = 0.7;

    // SSL-style bus compressor after the DJ filter (sweeps breathe through
    // it) and before the analyser (the scope shows the compression).
    this.preMaster.connect(this.djFilter);
    this.djFilter.connect(this.masterComp.input);
    // Split the post-compressor stereo signal into per-channel analysers, then
    // merge it back losslessly so the mono `analyser` reads the same down-mix as
    // before and every analyser stays in the live path to destination (so they
    // are pulled — an AnalyserNode off a dead-end tap is not guaranteed to run).
    const scopeSplitter = this.ctx.createChannelSplitter(2);
    const scopeMerger = this.ctx.createChannelMerger(2);
    this.masterComp.output.connect(scopeSplitter);
    scopeSplitter.connect(this.analyserL, 0);
    scopeSplitter.connect(this.analyserR, 1);
    this.analyserL.connect(scopeMerger, 0, 0);
    this.analyserR.connect(scopeMerger, 0, 1);
    scopeMerger.connect(this.analyser);
    this.analyser.connect(this.master);
    this.master.connect(this.ctx.destination);

    this.lfo = new LFO(this.ctx);

    this.pitchBend = this.ctx.createConstantSource();
    this.pitchBend.offset.value = 0;
    this.pitchBend.start();

    this.noise = this.createNoiseSource();

    this.patterns = new PatternStore();
    this.clock = new Clock(this.ctx, { scheduleAheadS: opts.scheduleAheadS });
  }

  async init(): Promise<void> {
    await LadderFilterNode.loadModule(this.ctx);
    await RecorderNode.loadModule(this.ctx);
    await CompressorNode.loadModule(this.ctx);
    this.drumComp.attachWorklet();
    this.masterComp.attachWorklet();

    // Polyphony owns the voice pool + the analogue-drift source; it shares the
    // `this.voices` array (Engine fans per-voice params over the same array).
    this.polyphony = new Polyphony(this.ctx, this.voices);

    for (let i = 0; i < this.voiceCount; i++) {
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

      // Analogue drift (source owned by Polyphony)
      this.polyphony.connectDrift(v);

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
    this.drums = new DrumMachine(this.ctx, this.clock, this.patterns, this.arrangement, this.perf, this.drumBus, this.fxOversample);
    this.sampler = new SamplerMachine(this.ctx, this.clock, this.patterns, this.arrangement, this.perf, this.samplerBus);

    // Lane mixer — needs the sequencer (mute = stop triggering) + the drum/
    // sampler buses (mute = cut bus gain), so it is built after the machines.
    this.laneMixer = new LaneMixer(this.ctx, this.seq, this.drumBus, this.samplerBus);

    // Audio capture: tap master (post master-volume). The recorder node has
    // zero outputs so it is a pure sink and never doubles into destination.
    this.recorderNode = await RecorderNode.create(this.ctx);
    this.master.connect(this.recorderNode.input);
    this.recorder = new RecorderController(this.clock, this.arrangement, this.recorderNode);

    // MIDI clock sync (master/slave). Built before subscribeParams() so the
    // gated transport.bpm subscription can read `this.sync.mode`. The Web MIDI
    // transport is attached later by initMIDI (post-gesture); until then the
    // controller is inert. Converters bridge the two time domains: Clock
    // schedules in AudioContext seconds, MIDI timestamps are performance.now() ms.
    this.sync = new SyncController(this.clock, {
      toPerfMs: (t) => performance.now() + (t - this.ctx.currentTime) * 1000,
      toAudioTime: (ms) => this.ctx.currentTime + (ms - performance.now()) / 1000,
      localBpm: () => this.bus.get('transport.bpm'),
    });

    // WiFi sync (WebRTC DataChannel) coexists with the MIDI transport; no RTC
    // objects until the user pairs (webrtc-sync.md). initMIDI adds 'midi' later.
    this.rtcSync = new WebRtcSyncTransport();
    this.sync.addTransport('wifi', this.rtcSync);

    // While slaved, Tape Stop skips its clock-BPM ramp (pitch ramp still sounds)
    // so incoming clock keeps driving the tempo (midi-clock-sync REQ-13).
    this.perf.clockRampAllowed = () => this.sync.mode !== 'slave';

    this.subscribeParams();
    this.bus.onNote((on, note, vel) => {
      if (this.arpPassthroughSuppressed) return;
      if (on) this.playNote(note, vel);
      else this.releaseNote(note);
    });

    this.installIosRearm();
  }

  /**
   * Resume the AudioContext. Browsers create it suspended until a user
   * gesture, so `init()` can run (and the UI can mount) before this is
   * called — this must be invoked from within the start-button gesture.
   *
   * `iosSession.unlock()` runs first (synchronously, inside the gesture) to
   * switch iOS off the silent-switch-respecting *ambient* category; it is a
   * no-op elsewhere. `shouldResumeContext` then covers `'suspended'` and the
   * iOS-only `'interrupted'` state alike.
   */
  async resume(): Promise<void> {
    this.iosSession.unlock();
    if (shouldResumeContext(this.ctx.state)) {
      try { await this.ctx.resume(); } catch { /* stays suspended until gesture */ }
    }
  }

  /**
   * iOS drops the context into `'suspended'`/`'interrupted'` on calls, Siri, and
   * app-switching, and audio stays dead until resumed. On iOS only, re-resume
   * (which also replays the silent loop) when the page returns to the foreground
   * or the context reports a non-running state while visible. Some iOS versions
   * still require a fresh gesture — the next tap is the natural fallback.
   */
  private installIosRearm(): void {
    if (!this.iosSession.active) return;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void this.resume();
    });
    this.ctx.addEventListener('statechange', () => {
      if (!document.hidden && shouldResumeContext(this.ctx.state)) void this.resume();
    });
  }

  /** iOS audio-session diagnostics for the Debug panel (see ios-audio.md / debug-panel.md). */
  get iosAudio(): IosAudioDiagnostics { return this.iosSession.diagnostics; }

  // ---------- Note handling ----------

  /** Play a note at the given audio time (defaults to now). Delegates to Polyphony. */
  playNote(note: number, velocity = 0.8, when?: number): void {
    this.polyphony.playNote(note, velocity, when);
  }

  /** Release a note at the given audio time (defaults to now). */
  releaseNote(note: number, when?: number): void {
    this.polyphony.releaseNote(note, when);
  }

  /** Stop the transport AND silence everything (Panic button / Esc). */
  panic(): void {
    this.clock.stop();
    this.polyphony.killAll();
  }

  // ---------- Param subscriptions ----------

  private subscribeParams(): void {
    const bus = this.bus;
    const all = (fn: (v: Voice, value: number) => void) =>
      (value: number) => { for (const v of this.voices) fn(v, value); };

    // Voicing (poly/mono, unison, glide, drift all live in Polyphony)
    bus.subscribe('voicing.mode', (v) => this.polyphony.setPoly(v >= 0.5));

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
    bus.subscribe('unison.voices', (x) => this.polyphony.setUnisonCount(x));
    bus.subscribe('unison.detune', (x) => this.polyphony.setUnisonDetune(x));

    // Analogue drift / glide mode
    bus.subscribe('analog.drift', (x) => this.polyphony.setDrift(x));
    bus.subscribe('glide.mode', (x) => this.polyphony.setGlideMode(x));

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

    // Insert effects self-wire their own params (ADR-008); the same class binds
    // at a different prefix for the drum/sampler bus variants.
    this.distortion.bind(bus, 'fx.dist');
    this.wah.bind(bus, 'fx.wah');
    this.phaser.bind(bus, 'fx.phaser');
    this.delay.bind(bus, 'fx.delay');
    this.reverb.bind(bus, 'fx.reverb');

    // Drum FX (compressor: 1176 FET; ratio index → real ratio, 100 = ALL)
    this.drumPhaser.bind(bus, 'fx.drum.phaser');
    this.drumDelay.bind(bus, 'fx.drum.delay');
    this.drumReverb.bind(bus, 'fx.drum.reverb');
    this.drumComp.bind(bus, 'fx.drum.comp', [4, 8, 12, 20, 100]);

    // Sampler FX
    this.samplerDist.bind(bus, 'fx.sampler.dist');
    this.samplerPhaser.bind(bus, 'fx.sampler.phaser');
    this.samplerDelay.bind(bus, 'fx.sampler.delay');
    this.samplerReverb.bind(bus, 'fx.sampler.reverb');

    // DJ filter (manual sweep; Drop overrides it while held)
    bus.subscribe('fx.djfilter', (x) => this.perf.setDjFilter(x));

    // Master FX: Compressor (SSL G bus VCA; release index past the table = auto)
    this.masterComp.bind(bus, 'fx.master.comp', [2, 4, 10], [0.1, 0.3, 0.6, 1.2]);

    // Master
    bus.subscribe('master.volume', (x) => {
      rampTo(this.master.gain, x * x, this.ctx, RAMP_MEDIUM);
    });
    bus.subscribe('master.pitchBend', (x) => {
      rampTo(this.pitchBend.offset, x * PITCH_BEND_RANGE_CENTS, this.ctx, RAMP_FAST);
    });
    bus.subscribe('master.modWheel', () => updateLfoAmount());

    // ----- Transport -----
    // Gated while slaved: incoming MIDI clock owns the tempo then; the knob's
    // bus value is the restore target when slave mode ends (midi-clock-sync REQ-4).
    bus.subscribe('transport.bpm', (b) => {
      if (this.sync.mode !== 'slave') this.clock.setBpm(b);
    });
    bus.subscribe('transport.swing', (s) => this.clock.setSwing(s));

    // ----- Arpeggiator -----
    bus.subscribe('arp.on', (v) => this.arp.setEnabled(v >= 0.5));
    bus.subscribe('arp.pattern', (v) => this.arp.setPattern(v));
    bus.subscribe('arp.rate', (v) => this.arp.setRate(v));
    bus.subscribe('arp.octaves', (v) => this.arp.setOctaves(v));
    bus.subscribe('arp.gate', (v) => this.arp.setGate(v));

    // ----- Sequencer -----
    bus.subscribe('seq.on', (v) => this.seq.setEnabled(v >= 0.5));
    // Synth voice-bus volume (independent of mute: seq mute stops triggering,
    // not the bus, so live keys keep playing at this level).
    bus.subscribe('seq.master', (v) => rampTo(this.voiceBus.gain, v, this.ctx, RAMP_MEDIUM));

    // ----- Song-tab lane mixer (mute + solo across all three machines) -----
    bus.subscribe('seq.mute', (v) => this.laneMixer.setMute('seq', v >= 0.5));
    bus.subscribe('drum.mute', (v) => this.laneMixer.setMute('drum', v >= 0.5));
    bus.subscribe('sampler.mute', (v) => this.laneMixer.setMute('sampler', v >= 0.5));
    bus.subscribe('seq.solo', (v) => this.laneMixer.setSolo('seq', v >= 0.5));
    bus.subscribe('drum.solo', (v) => this.laneMixer.setSolo('drum', v >= 0.5));
    bus.subscribe('sampler.solo', (v) => this.laneMixer.setSolo('sampler', v >= 0.5));

    // ----- Drums -----
    bus.subscribe('drum.on', (v) => this.drums.setEnabled(v >= 0.5));
    bus.subscribe('drum.master', (v) => this.laneMixer.setDrumVol(v));
    for (let i = 0; i < DRUM_TRACK_COUNT; i++) {
      const track = i;
      bus.subscribe(`drum.t${i}.vol`, (v) => this.drums.setTrackVolume(track, v));
      bus.subscribe(`drum.t${i}.tune`, (v) => this.drums.setTrackTune(track, v));
      bus.subscribe(`drum.t${i}.decay`, (v) => this.drums.setTrackDecay(track, v));
      bus.subscribe(`drum.t${i}.tone`, (v) => this.drums.setTrackTone(track, v));
      bus.subscribe(`drum.t${i}.drive`, (v) => this.drums.setTrackDrive(track, v));
      bus.subscribe(`drum.t${i}.pan`, (v) => this.drums.setTrackPan(track, v));
      bus.subscribe(`drum.t${i}.mute`, (v) => this.drums.setTrackMute(track, v >= 0.5));
    }

    // ----- Sampler -----
    bus.subscribe('sampler.on', (v) => this.sampler.setEnabled(v >= 0.5));
    bus.subscribe('sampler.master', (v) => this.laneMixer.setSamplerVol(v));
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
