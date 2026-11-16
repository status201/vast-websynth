import { LadderFilterNode } from './ladder-filter/node';
import { Voice } from './voice';
import { LFO } from './lfo';
import { SampleHold } from './sample-hold';
import { PwmDriver } from './pwm';
import { OscPairPolicy } from './osc-pair-policy';
import { bindVoiceParams, bindMachineParams } from './engine-params';
import { Compressor } from './effects/compressor';
import { createSynthChain, createDrumChain, createSamplerChain } from './effects/fx-chain';
import { CompressorNode } from './compressor/node';
import { ParamBus, registerDefaults } from '../state/params';
import { masterLevel } from '../state/master-level';
import { rampTo, RAMP_FAST, RAMP_MEDIUM } from './param-utils';
import { forceStereo } from './stereo';
import { DISCONNECT_DELAY_MS, butterworth } from './effects/effect';
import { Polyphony } from './polyphony';
import { LaneMixer } from './lane-mixer';
import type { SynthOutput, NoteOptions } from './transport/note-output';
import { Clock } from './transport/clock';
import { Arpeggiator } from './transport/arpeggiator';
import { StepSequencer } from './transport/sequencer';
import { DrumMachine } from './transport/drum-machine';
import { makeNoiseBuffer } from './drums/drum-synths';
import { SamplerMachine } from './transport/sampler-machine';
import { MotionMachine } from './transport/motion-machine';
import { Arrangement } from './transport/arrangement';
import { ScaleQuantizer } from './transport/scale-quantizer';
import { ModMatrix } from './mod-matrix';
import { MOD_ROWS, MOD_SRC, MOD_DST } from '../state/mod-routing';
import { Performance } from './transport/performance';
import { SyncController } from './transport/sync/sync-controller';
import { TransportLoop } from './transport/transport-loop';
import { LoopDriver } from './transport/loop-driver';
import { WifiSyncTransport, type WifiLink } from './transport/sync/wifi-sync';
import { RecorderNode } from './recorder/node';
import { RecorderController } from './recorder/recorder-controller';
import { BankRenderController } from './recorder/bank-render';
import { ClipPreview } from './recorder/clip-preview';
import { PatternStore, SEQ_TRACK_COUNT } from '../state/patterns';
import { barTicks, ticksPerBeat } from '../state/meter';
import { XyPadStore } from '../state/xy-pad';
import { IosAudioSession, type IosAudioDiagnostics } from './ios-audio-session';
import { MediaSessionKeepAlive, transportMediaHandlers, type MediaSessionDiagnostics } from './media-session';
import { BackgroundAudioWatchdog, type WatchdogDiagnostics } from './background-watchdog';
import { AudioLifecycle, type AudioRecoveryState } from './lifecycle';

export type { AudioRecoveryState } from './lifecycle';

const VOICE_COUNT = 8;
const PITCH_BEND_RANGE_CENTS = 200;


/**
 * Fan one LFO's per-voice outputs into a voice (lfo.md REQ-duplicated-destinations-sum-and-stay-bounded). Every target is
 * a summing `AudioParam`, so calling this for both LFOs is what makes two of
 * them on one destination add rather than fight. `pan` is bus-wide and wired
 * once in the constructor instead; `pulse` has no node at all.
 */
function connectLfoToVoice(lfo: LFO, v: Voice): void {
  for (const t of v.pitchTargets()) lfo.toPitch.connect(t);
  lfo.toSync.connect(v.syncTarget);
  lfo.toCutoff.connect(v.filter.cutoffNote);
  lfo.toShape.connect(v.filter.shape);
  lfo.toAmp.connect(v.tremolo.gain);
}

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
  /** Allow WaveShaper oversampling in the two Dirts + drum tracks (default true). */
  fxOversample?: boolean;
  /** fftSize for the 3 scope analysers; smaller on weak cuts always-on FFT cost (default 1024). */
  analyserFftSize?: number;
  /** XY Pad axis assignment (main.ts's instance, shared with the UI) — consumed
   *  by the motion sequencer. Defaults to a private store (tests). */
  xy?: XyPadStore;
  /** Frame-rate cap for the motion sequencer's write loop (perf-tier fps). */
  motionFps?: number;
}

export class Engine {
  readonly ctx: AudioContext;
  readonly voices: Voice[] = [];

  /**
   * The four sequencer track pans, mirrored here so the spread stage can be
   * decided from all of them at once (sequencer.md REQ-the-spread-stage-engages-off-centre).
   * `seq` holds the same values for scheduling; this copy answers a different
   * question — "is ANY track off centre?" — and keeping it beside the timer that
   * acts on it is cheaper than asking the bus for four params on every write.
   */
  private readonly seqPans: number[] = Array.from({ length: SEQ_TRACK_COUNT }, () => 0);
  private spreadOn = false;
  private spreadTimer: number | null = null;
  readonly voiceBus: GainNode;
  readonly master: GainNode;
  readonly analyser: AnalyserNode;
  /** Per-channel analysers for the scope's stereo view (left / right). */
  readonly analyserL: AnalyserNode;
  readonly analyserR: AnalyserNode;

  /** The three insert chains, each self-wiring its own params (ADR-008). */
  readonly synthFx: ReturnType<typeof createSynthChain>;
  readonly drumFx: ReturnType<typeof createDrumChain>;
  readonly samplerFx: ReturnType<typeof createSamplerChain>;

  /** Synth-bus auto-panner, swept by the LFO's `pan` destination (lfo.md REQ-pan-sweeps-a-stereo-panner).
   *  Sits *after* the insert chain so the chain stays 1-channel; centred (a
   *  no-op) unless the LFO is routed here. */
  readonly synthPan: StereoPannerNode;

  /** Master-bus compressor — not a chain member; it sits djFilter → here → analyser. */
  readonly masterComp: Compressor;

  /** The drum-bus compressor. Kept as a named accessor for `StudioApi`. */
  get drumComp(): Compressor { return this.drumFx.fx.comp; }

  private readonly preMaster: GainNode;
  private readonly drumBus: GainNode;
  private readonly samplerBus: GainNode;

  readonly patterns: PatternStore;
  readonly clock: Clock;
  /**
   * The DJ filter is a SERIES pair, not one node whose type flips (performance.md
   * REQ-the-dj-filter-is-a-series-pair). Each keeps its constructed type forever and rests transparent; only
   * `detune` moves, so crossing centre cannot click.
   *
   * The frequencies set below are fixed *references* the sweep is measured from
   * and are never written again (REQ-the-dj-sweep-rides-detune) — `Performance` retargets `detune` in
   * cents instead, which is log-frequency and so needs only `setTargetAtTime`.
   */
  readonly djLow: BiquadFilterNode;
  readonly djHigh: BiquadFilterNode;
  arp!: Arpeggiator;
  seq!: StepSequencer;
  drums!: DrumMachine;
  sampler!: SamplerMachine;
  motion!: MotionMachine;
  arrangement!: Arrangement;
  /** The live key — shared by the sequencer, the arp and the note passthrough. */
  scale!: ScaleQuantizer;
  /** Modulation routing (mod-matrix.md). Lives in the graph; costs nothing per frame. */
  readonly modMatrix: ModMatrix;
  perf!: Performance;
  recorder!: RecorderController;
  bankRender!: BankRenderController;
  /** The sample editor's audition player (sample-recorder.md REQ-the-preview-fades-like-the-slot). */
  readonly clipPreview: ClipPreview;
  sync!: SyncController;
  rtcSync!: WifiLink;
  /** The Song transport's loop — on/off, range, pending pick (transport-loop.md).
   *  A model only; `loopDriver` is what bends the clock with it. */
  readonly loop = new TransportLoop();
  private loopDriver!: LoopDriver;
  private recorderNode!: RecorderNode;

  readonly lfo: LFO;
  /** The second LFO (lfo.md REQ-there-are-two-lfos). Identical to `lfo` except that the mod
   *  wheel does not reach it (REQ-the-mod-wheel-feeds-lfo-one-only). Off by default, so it costs an idle
   *  oscillator and nothing else until a patch arms it. */
  readonly lfo2: LFO;
  /** Drives whichever LFO holds the `pulse` destination. Built in `init()` — it
   *  writes to the voices, so it needs the pool to exist (oscillators.md REQ-set-periodic-wave-is-immediate).
   *  One driver, two possible sources: it arbitrates by index (lfo.md REQ-pulse-is-arbitrated). */
  pwm!: PwmDriver;
  private readonly pitchBend: ConstantSourceNode;
  /** Global matrix sources with no other home (mod-matrix.md). */
  private readonly modWheelSource: ConstantSourceNode;
  private readonly randomSource: SampleHold;
  private readonly noise: AudioBufferSourceNode;
  private readonly noiseBuffer: AudioBuffer;

  // Voice allocation + voicing (poly/unison/glide/drift) and the Song-tab lane
  // mixer (mute/solo/volume) are delegated out of the Engine (ADR-008).
  private polyphony!: Polyphony;
  private laneMixer!: LaneMixer;

  /**
   * The oscillator-sync pairs and when the voices use them — built the first
   * time `osc2.sync` leaves `off` or a pulse carrier frees them, and never before
   * (oscillator-sync.md REQ-the-pair-is-built-on-first-use; cross-modulation.md
   * REQ-an-fm-carrier-with-a-pulse-width-runs-in-the-pair). Built in `init()`,
   * once the pool exists.
   */
  private pairs!: OscPairPolicy;

  /**
   * Raw key/MIDI note → the notes it actually sounded, so a note-off releases exactly
   * what its note-on started even if the key or chord voicing changed mid-hold
   * (voicing.md REQ-passthrough-remembers-what-it-played). Bounded at 128 keys × ≤4 notes, and cleared with the voices.
   */
  private readonly heldIn = new Map<number, number[]>();

  /** True when the arpeggiator is suppressing direct note input — the only
   *  thing that gates the passthrough (arpeggiator.md; the sequencer never does). */
  get arpPassthroughSuppressed(): boolean { return this.arp?.passthroughSuppressed ?? false; }

  private readonly voiceCount: number;
  private readonly fxOversample: boolean;
  /** XY Pad axis assignment consumed by the motion sequencer (EngineOptions.xy). */
  private readonly xyStore: XyPadStore;
  private readonly motionFps: number | undefined;

  /** iOS-only audio-session workarounds; inert (no-op) on every other platform. */
  private readonly iosSession: IosAudioSession;
  /** Android-only Media Session keep-alive; inert on every other platform. */
  private readonly media: MediaSessionKeepAlive;
  /** Watches a backgrounded context for real underruns (audio-lifecycle REQ-breaking-up-background-audio-is-suspended). */
  private watchdog!: BackgroundAudioWatchdog;
  /** Resume, retry, gesture re-arm, the click-free fade and the glitch suspend (audio-lifecycle.md). */
  private readonly lifecycle: AudioLifecycle;


  constructor(private readonly bus: ParamBus, opts: EngineOptions = {}) {
    registerDefaults(bus);
    this.voiceCount = opts.voiceCount ?? VOICE_COUNT;
    this.xyStore = opts.xy ?? new XyPadStore();
    this.motionFps = opts.motionFps;
    this.ctx = new AudioContext({ latencyHint: opts.latencyHint ?? 'interactive' });
    // Built here (after ctx) so the silent loop can be routed through the context.
    this.iosSession = new IosAudioSession(this.ctx);
    // The OS's transport controls. The closures reach `this.clock`, which is
    // built at the end of this constructor — they only ever run from a
    // notification tap, long after. Pause is the real Pause; only stop panics
    // (media-session.md REQ-notification-controls-work).
    this.media = new MediaSessionKeepAlive(transportMediaHandlers({
      resume: () => this.resume(),
      start: () => this.clock.start(),
      pause: () => this.clock.pause(),
      panic: () => this.panic(),
    }));

    this.voiceBus = this.ctx.createGain();
    this.voiceBus.gain.value = 1;

    // Perf-tier FX-cost knobs (performance-mode.md REQ-weak-tier-reduces-fx-cost); defaults are no-ops.
    this.fxOversample = opts.fxOversample ?? true;
    const reverbOpts = { maxIrS: opts.reverbIrMaxS ?? 4 };
    const dirtOpts = { oversample: this.fxOversample };

    const chainOpts = { dirt: dirtOpts, reverb: reverbOpts };
    this.synthFx = createSynthChain(this.ctx, chainOpts);
    this.drumFx = createDrumChain(this.ctx, chainOpts);
    this.samplerFx = createSamplerChain(this.ctx, chainOpts);
    this.masterComp = new Compressor(this.ctx, 'vca');

    this.master = this.ctx.createGain();
    // Seeded SILENT (audio-lifecycle.md REQ-nothing-is-audible-before-the-first-start). An autoplay-permitted browser
    // hands us a context that is already rendering, so the whole boot — worklet
    // loading, ~50 node constructions, the boot patch, the session restore —
    // runs into an open output stream; at 0.8 that arrived as the stream-start
    // transient at full level, which is the click REQ-a-start-is-click-free's fade exists to swallow
    // and which REQ-the-fade-never-dips-live-audio's state gate skipped. `fadeInMaster()` is now the only
    // thing that ever raises this, and it reads `master.volume` at fade time.
    this.master.gain.value = 0;

    // fftSize is perf-tier-dependent (performance-mode.md REQ-analyser-fft-size-follows-the-tier): 256/512/1024 for
    // weak/medium/strong, cutting the always-pulled analyser FFT + per-draw copy cost
    // on weaker tiers. This is the BOOT seed only — the scope applies later tier
    // changes live via setFftSize. All three share one value so the scope's
    // per-channel buffers stay uniform (scope.md REQ-all-analysers-share-fft-settings).
    const fft = opts.analyserFftSize ?? 1024;
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

    // Synth auto-pan (lfo.md REQ-pan-sweeps-a-stereo-panner): last stage of the synth channel, so one
    // node pans instead of one per voice and the inserts ahead of the reverb
    // stay 1-channel (ADR-010, cheap). The reverb, the last insert before the duck,
    // is where the channel otherwise becomes stereo: its IR has 2 decorrelated channels,
    // so a mono input convolves to two. Centred until the LFO's `pan` drives it.
    this.synthPan = this.ctx.createStereoPanner();
    this.synthPan.pan.value = 0;
    // A StereoPanner is only transparent at centre for a STEREO input; a mono one
    // gets the equal-power law and loses 3.01 dB. Whether this node saw one
    // channel or two used to depend on the REVERB — the only thing in the chain
    // that makes a second — so switching the reverb on raised the dry synth by
    // 3 dB, and the sweep changed law with it (measured: -40.03 dB against
    // -37.02 dB, ratio 0.7075). Pinning the input to two channels makes the
    // channel's level and the sweep's law independent of anything upstream, which
    // is also what lets the spread stage splice in and out inaudibly
    // (lfo.md REQ-the-auto-pan-reads-a-stereo-input, ADR-023).
    forceStereo(this.synthPan);

    // Each chain owns its own effect order + param prefixes (effects/fx-chain.ts).
    this.synthFx.wire(this.voiceBus, this.synthPan);
    this.synthPan.connect(this.preMaster);
    this.drumFx.wire(this.drumBus, this.preMaster);
    this.samplerFx.wire(this.samplerBus, this.preMaster);

    // DJ performance filter — transparent by default, swept live via detune.
    // Frequencies are references only, never written again; Butterworth at rest.
    this.djLow = butterworth(this.ctx, 'lowpass', 20000);
    this.djHigh = butterworth(this.ctx, 'highpass', 20);

    // SSL-style bus compressor after the DJ filter (sweeps breathe through
    // it) and before the analyser (the scope shows the compression).
    this.preMaster.connect(this.djLow);
    this.djLow.connect(this.djHigh);
    this.djHigh.connect(this.masterComp.input);
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
    this.lfo2 = new LFO(this.ctx);
    // Pan is the one destination that is bus-wide rather than per-voice, so it
    // is wired here and not in the per-voice loop below. `pan` is a-rate.
    // Two GainNodes into one AudioParam sum, and the panner clamps to ±1, so
    // both LFOs on `pan` stays bounded (lfo.md REQ-duplicated-destinations-sum-and-stay-bounded).
    this.lfo.toPan.connect(this.synthPan.pan);
    this.lfo2.toPan.connect(this.synthPan.pan);

    this.pitchBend = this.ctx.createConstantSource();
    this.pitchBend.offset.value = 0;
    this.pitchBend.start();

    // Two global matrix sources that have no node of their own yet (mod-matrix.md).
    // The mod wheel is otherwise only a depth scalar on LFO 1 (lfo.md REQ-the-mod-wheel-feeds-lfo-one-only); as a
    // matrix source it becomes a signal, so a performance gesture can drive anything.
    this.modWheelSource = this.ctx.createConstantSource();
    this.modWheelSource.offset.value = 0;
    this.modWheelSource.start();
    // Sample & hold: one value, re-rolled per clock tick (wired in init()). Bipolar,
    // so a route's depth reads like every other source's; smoothed, so a roll is
    // a slew rather than a click (mod-matrix.md REQ-random-steps-are-smoothed).
    this.randomSource = new SampleHold(this.ctx);

    this.modMatrix = new ModMatrix(this.ctx, {
      lfo1: this.lfo.modTap,
      lfo2: this.lfo2.modTap,
      modWheel: this.modWheelSource,
      random: this.randomSource.out,
    });
    this.modMatrix.setPanTarget(this.synthPan.pan);

    this.lifecycle = new AudioLifecycle(this.ctx, this.master, this.bus, this.iosSession, this.media);
    this.clipPreview = new ClipPreview(this.ctx);

    // One 2 s white-noise buffer: the noise oscillator loops it, the drum voices read it.
    this.noiseBuffer = makeNoiseBuffer(this.ctx);
    this.noise = this.createNoiseSource(this.noiseBuffer);

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
      // Wires the dry edge now and the panned one only once a track leaves
      // centre (sequencer.md REQ-the-spread-stage-engages-off-centre).
      v.connectTo(this.voiceBus);
      this.noise.connect(v.noiseGain);

      // LFO routing — every target is a summing AudioParam, so both LFOs can
      // land on the same one and simply add (lfo.md REQ-duplicated-destinations-sum-and-stay-bounded).
      connectLfoToVoice(this.lfo, v);
      connectLfoToVoice(this.lfo2, v);
      // The matrix builds this voice's six route gains here, for the same reason:
      // the fan-out is created once at boot and never touched per note or per frame
      // (mod-matrix.md REQ-one-gain-per-route-rewired-while-silent).
      this.modMatrix.connectVoice(v);

      // Pitch bend
      for (const t of v.pitchTargets()) this.pitchBend.connect(t);

      // Analogue drift (source owned by Polyphony)
      this.polyphony.connectDrift(v);

      this.voices.push(v);
    }

    // PWM writes params on every voice, so it is built once the pool exists.
    // Its timer only runs while an LFO is on `pulse` (oscillators.md REQ-set-periodic-wave-is-immediate).
    this.pairs = new OscPairPolicy({
      ctx: this.ctx,
      voices: this.voices,
      fmRouted: () => this.modMatrix.usesDest(MOD_DST.fm),
      pwmOwned: () => this.pwm.pwmOwner !== null,
    });
    this.pwm = new PwmDriver(this.voices, () => this.ctx.currentTime, () => this.pairs.refreshPairFree());

    // Arrangement first so its clock tick runs before the machines read
    // the play banks for the same tick.
    this.arrangement = new Arrangement(this.patterns, this.clock);
    // The key, built before the machines so seq/arp can hold it by reference.
    this.scale = new ScaleQuantizer();
    this.perf = new Performance(this.ctx, this.clock, this.bus, this.djLow, this.djHigh);

    // Transport modules — created after voices so they can call engine.playNote
    const synthOutput: SynthOutput = {
      playNote: (n, v, w, o) => this.playNote(n, v, w, o),
      releaseNote: (n, w) => this.releaseNote(n, w),
    };
    this.arp = new Arpeggiator(synthOutput, this.bus, this.clock, this.scale);
    this.seq = new StepSequencer(synthOutput, this.clock, this.patterns, this.arrangement, this.perf, this.scale);
    this.drums = new DrumMachine(this.ctx, this.clock, this.patterns, this.arrangement, this.perf, this.drumBus, this.fxOversample, this.noiseBuffer);
    this.sampler = new SamplerMachine(this.ctx, this.clock, this.patterns, this.arrangement, this.perf, this.samplerBus);
    // Motion writes params (not audio), evaluated against the audio clock's now.
    this.motion = new MotionMachine(this.clock, this.patterns, this.arrangement, this.xyStore, this.bus, {
      now: () => this.ctx.currentTime,
      ...(this.motionFps !== undefined ? { fps: this.motionFps } : {}),
    });

    // Sidechain ducking (sidechain-ducking.md REQ-the-duck-is-keyed-by-scheduled-hits): the duckers are chain
    // members built in the constructor, the drum machine only exists here, so
    // the trigger is wired at this seam rather than injected. Each ducker
    // filters on its own `.src` and early-outs while bypassed.
    this.drums.onHit((track, when) => {
      this.synthFx.fx.duck.onDrumHit(track, when);
      this.samplerFx.fx.duck.onDrumHit(track, when);
    });

    // Lane mixer — needs the sequencer (mute = stop triggering) + the drum/
    // sampler buses (mute = cut bus gain), so it is built after the machines.
    this.laneMixer = new LaneMixer(this.ctx, this.seq, this.drumBus, this.samplerBus, this.drums);

    // Audio capture: tap master (post master-volume). The recorder node has
    // zero outputs so it is a pure sink and never doubles into destination.
    this.recorderNode = await RecorderNode.create(this.ctx);
    this.master.connect(this.recorderNode.input);
    // A capture waits for a bank render (audio-export.md REQ-a-capture-waits-for-a-bank-render), the reverse of the
    // guard the renderer takes below. Read lazily: the renderer is built next.
    this.recorder = new RecorderController(
      this.clock, this.arrangement, this.recorderNode,
      () => this.bankRender.isRendering(),
    );

    // Bank resample (render-to-sampler.md): a second zero-output tap on the
    // synth channel output (post-reverb, post-pan, pre-preMaster) — the drum/
    // sampler buses never enter it. Tapping the panner rather than the FX tail
    // keeps a rendered bank identical to what was heard (lfo.md REQ-pan-sweeps-a-stereo-panner). Engine
    // keeps the state juggling (REQ-render-preconditions-are-forced-then-restored) in the prepare closure so LaneMixer/
    // private state stays out of the controller.
    const bankRenderNode = await RecorderNode.create(this.ctx);
    this.synthPan.connect(bankRenderNode.input);
    this.bankRender = new BankRenderController(
      this.clock,
      bankRenderNode,
      () => this.prepareBankRender(),
      // Any capture, manual or automatic: both drive the transport, and a bank
      // render would fight whichever one is holding it.
      () => this.recorder.isCapturing(),
    );

    // Stop cuts the sampler's in-flight one-shots (sampler.md REQ-a-stop-cuts-in-flight-one-shots). A tied (or
    // gate-1) cell schedules no choke of its own, so a long user sample used to
    // play on with nothing able to silence it — not even Panic, which only kills
    // synth voices. The policy lives here rather than in the machine because the
    // exception is Engine's to know: a stop that ends a capture is deliberately
    // rendering the tail, and chopping the last bar's one-shots out of an export
    // would be a worse bug than the one this fixes.
    this.clock.onStop(() => {
      if (this.recorder.isCapturing() || this.bankRender.isRendering()) return;
      this.sampler.stopAll();
    });

    // MIDI clock sync (master/slave). Built before subscribeParams() so the
    // gated transport.bpm subscription can read `this.sync.mode`. The Web MIDI
    // transport is attached later by initMIDI (post-gesture); until then the
    // controller is inert. Converters bridge the two time domains: Clock
    // schedules in AudioContext seconds, MIDI timestamps are performance.now() ms.
    this.sync = new SyncController(this.clock, {
      toPerfMs: (t) => performance.now() + (t - this.ctx.currentTime) * 1000,
      toAudioTime: (ms) => this.ctx.currentTime + (ms - performance.now()) / 1000,
      localBpm: () => this.bus.get('transport.bpm'),
      // One-shot tempo handoff when a link drops mid-play (REQ-tempo-handoff-on-release).
      setLocalBpm: (b) => this.bus.set('transport.bpm', b),
      // The meter travels the WiFi wire so peers agree what bar a Song Position
      // lands in (meter.md REQ-meter-travels-on-the-wifi-wire). Written to the bus like any other param, so
      // a followed meter shows in the picker and saves with the song.
      meter: () => ({
        beats: this.bus.get('transport.beats'),
        unit: this.bus.get('transport.beatUnit'),
      }),
      setMeter: (beats, unit) => {
        this.bus.set('transport.beats', beats);
        this.bus.set('transport.beatUnit', unit);
      },
    });

    // WiFi sync (WebRTC DataChannel) coexists with the MIDI transport; no RTC
    // objects until the user pairs, and no WebRTC code either: the facade loads
    // it at pairing (webrtc-sync.md REQ-the-wifi-transport-loads-at-pairing).
    // initMIDI adds 'midi' later.
    this.rtcSync = new WifiSyncTransport();
    this.sync.addTransport('wifi', this.rtcSync);

    // After sync, the recorder and the bank renderer: a wrap is a seek, refused
    // by the same `canSeek` those three feed (transport-loop.md REQ-a-loop-that-cannot-jump-does-not).
    this.loopDriver = new LoopDriver({
      clock: this.clock,
      loop: this.loop,
      songBars: () => this.arrangement.songBars(),
      canSeek: () => this.canSeek(),
      seekTo: (step) => this.seekTo(step),
    });

    // While slaved, Tape Stop skips its clock-BPM ramp (pitch ramp still sounds)
    // so incoming clock keeps driving the tempo (midi-clock-sync REQ-tape-stop-is-gated-while-slaved).
    this.perf.clockRampAllowed = () => this.sync.activeMode !== 'slave';

    // Sample & hold: one new value per 16th, scheduled at the tick's own time so it
    // lands with the beat rather than whenever the main thread got round to it
    // (mod-matrix.md). One write per tick, not per frame — and none at all while no
    // route reads `random`, which is the default (mod-matrix.md REQ-an-unselected-source-costs-nothing).
    this.clock.onTick((_step, when) => {
      if (!this.modMatrix.usesSource(MOD_SRC.random)) return;
      this.randomSource.roll(Math.random() * 2 - 1, when);
    });

    this.subscribeParams();
    this.bus.onNote((on, note, vel) => this.handleNote(on, note, vel));

    this.lifecycle.installContextRearm();

    // Built here, not in the constructor: `isBusy` reads the recorder and the
    // bank renderer, which only exist by now (audio-lifecycle.md REQ-the-trip-never-interrupts-a-capture).
    this.watchdog = new BackgroundAudioWatchdog(this.ctx, {
      onGlitch: () => this.lifecycle.suspendForGlitch(),
      isBusy: () => this.recorder.isCapturing() || this.bankRender.isRendering(),
      // Nothing sounding, nothing to protect from crackle — and a suspend/resume
      // cycle is exactly what went wrong on the device (audio-lifecycle REQ-nothing-suspends-for-silent-crackle).
      isSilent: () => !this.clock.playing,
    });
    this.watchdog.start();

    // Last word on the autoplay verdict (REQ-the-gesture-is-required-only-when-required). `init()` has awaited three
    // worklet module loads by now, so an asynchronous transition to `running`
    // that happened before the `statechange` listener above existed is caught
    // here. The three reads together cover every ordering the spec permits.
    this.lifecycle.rereadAutoplay();
  }

  /**
   * Force the bank-render preconditions (render-to-sampler REQ-render-preconditions-are-forced-then-restored) and return
   * the restore. Live state is re-asserted from the bus, so a param change made
   * *during* the ~2-bar render is overwritten by its own pre-render value —
   * acceptable for a modal-ish action this short.
   */
  private prepareBankRender(): () => void {
    const on = this.bus.get('seq.on') >= 0.5;
    const muted = this.bus.get('seq.mute') >= 0.5;
    const seqSolo = this.bus.get('seq.solo') >= 0.5;
    const otherSolo = this.bus.get('drum.solo') >= 0.5 || this.bus.get('sampler.solo') >= 0.5;
    const chainSteps = [...this.arrangement.seq.steps];
    const chainEnabled = this.arrangement.seq.enabled;

    this.seq.setEnabled(true);
    if (muted) this.laneMixer.setMute('seq', false);
    // A drum/sampler solo silences the un-soloed seq lane; *joining* the solo
    // group renders seq audibly while the soloed lanes keep monitoring.
    if (otherSolo && !seqSolo) this.laneMixer.setSolo('seq', true);
    // An enabled chain advances banks per bar — pass 2 would render a different
    // bank. Disabled, the play bank follows the edit bank (the one on screen).
    this.arrangement.setSeqChain(chainSteps, false);

    return () => {
      this.seq.setEnabled(on);
      this.laneMixer.setMute('seq', muted);
      this.laneMixer.setSolo('seq', seqSolo);
      this.arrangement.setSeqChain(chainSteps, chainEnabled);
    };
  }

  // ---------- Context lifecycle (delegated to AudioLifecycle) ----------

  /** Resume the context — verified, retried, faded in (audio-lifecycle.md). Call from a user gesture. */
  resume(): Promise<void> { return this.lifecycle.resume(); }
  /** Run `fn` once on the next real user gesture; returns a disarm (REQ-post-gesture-work-is-deferred). */
  onFirstGesture(fn: () => void): () => void { return this.lifecycle.onFirstGesture(fn); }
  /** Subscribe to "audio is stuck and needs a tap" (REQ-a-stuck-context-is-visible). */
  onAudioBlocked(fn: (blocked: boolean) => void): () => void { return this.lifecycle.onAudioBlocked(fn); }
  /** Whether audio is unblocked without a gesture (REQ-the-gesture-is-required-only-when-required). */
  get autoplayAllowed(): boolean { return this.lifecycle.autoplayAllowed; }
  get audioRecovery(): AudioRecoveryState { return this.lifecycle.audioRecovery; }
  /** The Debug panel's Suspend — the only deliberate one (REQ-statechange-must-not-fight-a-deliberate-suspend). */
  suspendForDebug(): Promise<void> { return this.lifecycle.suspendForDebug(); }

  /** iOS audio-session diagnostics for the Debug panel (see ios-audio.md / debug-panel.md). */
  get iosAudio(): IosAudioDiagnostics { return this.iosSession.diagnostics; }

  /** Android keep-alive diagnostics for the Debug panel (see media-session.md REQ-session-is-observable-on-device). */
  get mediaSession(): MediaSessionDiagnostics { return this.media.diagnostics; }

  /** Background-watchdog readings for the Debug panel (audio-lifecycle.md REQ-the-measurement-is-visible-either-way). */
  get backgroundAudio(): WatchdogDiagnostics { return this.watchdog.diagnostics; }

  // ---------- Note handling ----------

  /**
   * Play a note at the given audio time (defaults to now). Delegates to Polyphony.
   *
   * `opts` carries the sequencer track's pan (sequencer.md REQ-a-seq-track-carries-a-pan).
   * Every other caller — live keys, MIDI, the arpeggiator — omits it and is centred.
   */
  playNote(note: number, velocity = 0.8, when?: number, opts?: NoteOptions): void {
    this.polyphony.playNote(note, velocity, when, opts);
  }

  /** Release a note at the given audio time (defaults to now). */
  releaseNote(note: number, when?: number): void {
    this.polyphony.releaseNote(note, when);
  }

  /**
   * The keyboard/MIDI note passthrough (voicing.md REQ-note-events-flow-through-the-bus/REQ-passthrough-remembers-what-it-played).
   *
   * A raw key no longer maps 1:1 to a sounding note — the key can re-pitch it and
   * chord memory can expand it — so what was played is **remembered** rather than
   * re-derived on release. Re-deriving would miss `Polyphony.heldNotes` (keyed by the
   * note passed in) the moment the key or voicing changed mid-hold, and strand the
   * voice forever. Same "resolve once, release through the stored note" rule the
   * sequencer states at sequencer.md REQ-every-note-is-shifted-by-the-slot-transpose.
   *
   * A method rather than an inline closure so it can be exercised against a
   * structural stub, as `seekTo`/`canSeek` are.
   */
  handleNote(on: boolean, note: number, velocity: number): void {
    const suppressed = this.arpPassthroughSuppressed;
    if (on) {
      if (suppressed) return; // an engaged arp owns the note stream
      const notes = this.scale.chord(note);
      this.heldIn.set(note, notes);
      for (const n of notes) this.playNote(n, velocity);
      return;
    }
    // Note-offs are NOT gated by the arp (voicing.md REQ-passthrough-remembers-what-it-played): a key held as
    // the arp came on already sounded through here, and dropping its release left
    // the voice ringing until Panic. What this path played, it always releases.
    const played = this.heldIn.get(note);
    // A key pressed while the arp owned the stream was never played here; its
    // release is the arp's business.
    if (!played && suppressed) return;
    // The fallback only matters for a note-off with no matching note-on (a stuck
    // MIDI message, or a key held across a panic) — otherwise the map always hits.
    const notes = played ?? [this.scale.get(note)];
    this.heldIn.delete(note);
    for (const n of notes) this.releaseNote(n);
  }

  /** Stop the transport AND silence everything (Panic button / Esc). */
  panic(): void {
    this.clock.stop();
    this.polyphony.killAll();
    // The map names voices that no longer exist; leaving entries would make the next
    // note-off release notes that were already killed (voicing.md REQ-passthrough-remembers-what-it-played).
    this.heldIn.clear();
  }

  // ---------- Transport position (transport-position.md) ----------

  /**
   * Whether moving the playhead is currently allowed. Three states say no, and
   * they are all "something else owns the step counter right now"
   * (transport-position.md REQ-seeking-is-refused-in-three-states):
   *  - **slaved** — the remote transport owns the playhead, and a local jump
   *    drives the slave's phase tracking into a re-anchor (midi-clock-sync REQ-a-slave-refuses-to-seek-locally);
   *  - **exporting / rendering** — both bound their capture by absolute step
   *    number, so a jump truncates or unbounds it silently.
   *
   * Deliberately `isExporting()`, not `isCapturing()`: a free-form manual take
   * is bounded by nothing, so it has no step arithmetic to protect — and jumping
   * around the arrangement mid-take is what recording one is for.
   */
  canSeek(): boolean {
    return this.sync.activeMode !== 'slave'
      && !this.recorder.isExporting()
      && !this.bankRender.isRendering();
  }

  /**
   * Move the playhead to an absolute 16th. Returns `false` when refused, so the
   * caller can fall through (a keyboard shortcut leaves the key alone) rather
   * than pretending it worked. The single entry point for every UI surface —
   * nothing reaches past this to `clock.seek`, or the guard and the master
   * announce would have to be re-implemented per control.
   */
  seekTo(step: number): boolean {
    if (!this.canSeek()) return false;
    // No announce here: SyncController hears every `clock.onSeek` — this one and
    // a loop wrap alike — and tells slaves itself (transport-position.md REQ-a-sync-master-announces-its-seek).
    this.clock.seek(Math.max(0, Math.round(step)));
    return true;
  }

  /**
   * The bar length in 16th ticks, as `transport.beats` + `transport.beatUnit`
   * currently say it (meter.md REQ-bar-ticks-is-the-arrangement-bar-line). Read by the UI's ruler and readouts, so
   * they measure a bar the same way the transport does.
   */
  get barTicks(): number {
    return barTicks(this.bus.get('transport.beats'), this.bus.get('transport.beatUnit'));
  }

  /** One beat in 16th ticks, as `transport.beatUnit` says it — what the
   *  metronome counts (metronome.md REQ-beats-follow-the-transport-while-playing). */
  get beatTicks(): number {
    return ticksPerBeat(this.bus.get('transport.beatUnit'));
  }

  /**
   * Push the resolved bar length everywhere a bar is counted. Idempotent, and
   * called from both meter params so the pair is always read together.
   *
   * The recorder is included because a bar-exact capture measures its bars in
   * ticks too (meter.md REQ-bar-exact-capture-follows-bar-ticks) — an export of a 7/8 song must be 7/8 bars long.
   */
  private applyMeter(): void {
    const ticks = this.barTicks;
    this.arrangement.setBarTicks(ticks);
    this.seq.lane.setBarTicks(ticks);
    this.drums.lane.setBarTicks(ticks);
    this.sampler.lane.setBarTicks(ticks);
    this.motion.lane.setBarTicks(ticks);
    this.arp.setBarTicks(ticks);
    this.recorder.setBarTicks(ticks);
    this.bankRender.setBarTicks(ticks);
    this.loopDriver.setBarTicks(ticks);
    // Peers number bars by their own meter, so a local change has to reach them
    // or the same Song Position means two different bars (meter.md REQ-meter-travels-on-the-wifi-wire).
    this.sync.announceMeter();
  }

  // ---------- Param subscriptions ----------

  /**
   * Engage the per-voice spread stage while any sequencer track is off centre,
   * and drop it again when they all come home (sequencer.md
   * REQ-the-spread-stage-engages-off-centre, ADR-023).
   *
   * The disconnect is delayed, and by the same constant a bypassed effect uses,
   * for the same reason: the panned edge has to stay attached long enough to
   * carry the crossfade out. Cutting it immediately would leave the fade
   * half-done and audible. One timer for the pool, not one per voice — the pool
   * moves in lockstep.
   *
   * Re-engaging cancels a pending drop, so a knob wiggled across centre does not
   * tear the graph down behind itself.
   */
  private updateSpread(): void {
    const wanted = this.seqPans.some((p) => p !== 0);
    if (wanted === this.spreadOn) return;
    this.spreadOn = wanted;
    if (this.spreadTimer !== null) {
      clearTimeout(this.spreadTimer);
      this.spreadTimer = null;
    }
    this.polyphony.setSpread(wanted);
    if (!wanted) {
      this.spreadTimer = window.setTimeout(() => {
        this.spreadTimer = null;
        this.polyphony.dropSpread();
      }, DISCONNECT_DELAY_MS);
    }
  }

  /**
   * Every param's subscriber, registered in boot order (engine-params.ts: order
   * is part of the contract). The synth voice's and the machines' blocks are
   * binders of their own; what stays inline crosses those boundaries.
   */
  private subscribeParams(): void {
    const bus = this.bus;

    // Voicing (poly/mono, unison, glide, drift all live in Polyphony)
    bus.subscribe('voicing.mode', (v) => this.polyphony.setPoly(v >= 0.5));

    // Mod matrix (mod-matrix.md). `src`/`dst` re-patch under a mute ramp; `amt` is a
    // gain write, so it is safe to drag. None of this runs per frame (ADR-017).
    for (let n = 0; n < MOD_ROWS; n++) {
      const row = n;
      bus.subscribe(`mod.${n}.src`, (v) => { this.modMatrix.setSource(row, v); this.pairs.refreshFm(); });
      bus.subscribe(`mod.${n}.dst`, (v) => { this.modMatrix.setDest(row, v); this.pairs.refreshFm(); });
      bus.subscribe(`mod.${n}.amt`, (v) => this.modMatrix.setAmount(row, v));
    }
    // The mod wheel is a depth scalar on LFO 1 (lfo.md REQ-the-mod-wheel-feeds-lfo-one-only) AND a matrix source.
    // Mirroring it into a node here is what lets one gesture drive anything.
    bus.subscribe('master.modWheel', (v) => {
      rampTo(this.modWheelSource.offset, v, this.ctx, RAMP_MEDIUM);
    });

    // The synth voice: key/scale through the filter envelope (engine-params.ts).
    bindVoiceParams(bus, {
      voices: this.voices, polyphony: this.polyphony, scale: this.scale, pairs: this.pairs,
    });

    // The LFOs self-wire their own params (ADR-008), including the tempo lock
    // and the `pulse` path's share of PwmDriver — which arbitrates between the
    // two by index, so neither can stop the other's sweep (lfo.md REQ-pulse-is-arbitrated).
    // Only LFO 1 takes the mod wheel (lfo.md REQ-the-mod-wheel-feeds-lfo-one-only).
    this.lfo.bind(bus, 'lfo', this.pwm, 0, 'master.modWheel');
    this.lfo2.bind(bus, 'lfo2', this.pwm, 1);
    // The base widths belong to the oscillators, not to an LFO, so they stay here.
    bus.subscribe('osc1.pulseWidth', (x) => this.pwm.setBase(0, x));
    bus.subscribe('osc2.pulseWidth', (x) => {
      // The predicate first: a width that frees the pair must not reach the
      // native nodes on its way there (cross-modulation.md
      // REQ-an-fm-carrier-with-a-pulse-width-runs-in-the-pair).
      this.pairs.setOsc2Width(x);
      this.pwm.setBase(1, x);
    });

    // Insert effects self-wire their own params (ADR-008); each chain carries
    // its own prefixes and (for the drum comp) its ratio table.
    this.synthFx.bind(bus);
    this.drumFx.bind(bus);
    this.samplerFx.bind(bus);

    // DJ filter (manual sweep; Drop overrides it while held)
    bus.subscribe('fx.djfilter', (x) => this.perf.setDjFilter(x));

    // Master FX: Compressor (SSL G bus VCA; release index past the table = auto)
    this.masterComp.bind(bus, 'fx.master.comp', [2, 4, 10], [0.1, 0.3, 0.6, 1.2]);

    // Master
    bus.subscribe('master.volume', (x) => {
      // Inert until audio has actually started (audio-lifecycle.md REQ-nothing-is-audible-before-the-first-start). This
      // subscription fires on registration and again for every boot-patch /
      // session-restore write, all of which land before the first start — and any
      // one of them would undo the seeded silence on a context the browser
      // created running. `fadeInMaster()` reads the bus at fade time, so the
      // first ramp lands on whatever the knob says by then; nothing is lost.
      if (!this.lifecycle.hasRun) return;
      rampTo(this.master.gain, masterLevel(x, this.bus.get('master.expression')), this.ctx, RAMP_MEDIUM);
    });
    // CC11 rides inside the volume (input-control.md REQ-cc11-is-expression) —
    // the same gain, the same gate, the same law.
    bus.subscribe('master.expression', (e) => {
      if (!this.lifecycle.hasRun) return;
      rampTo(this.master.gain, masterLevel(this.bus.get('master.volume'), e), this.ctx, RAMP_MEDIUM);
    });
    bus.subscribe('master.pitchBend', (x) => {
      rampTo(this.pitchBend.offset, x * PITCH_BEND_RANGE_CENTS, this.ctx, RAMP_FAST);
    });
    // `master.modWheel` is subscribed by LFO 1's own bind() above (REQ-the-mod-wheel-feeds-lfo-one-only).

    // ----- Transport -----
    // Gated while *actively* slaved: incoming MIDI clock owns the tempo then;
    // the knob's bus value is the restore target when the role ends
    // (midi-clock-sync REQ-slave-follows-tempo-from-pulses). `activeMode`, not `mode`, so a selected-but-
    // disconnected Slave leaves the knob in charge (REQ-selected-mode-versus-active-role).
    bus.subscribe('transport.bpm', (b) => {
      if (this.sync.activeMode !== 'slave') this.clock.setBpm(b);
      // A tempo-locked LFO tracks the tempo, including a slave's incoming clock
      // (lfo.md REQ-lfo-sync-locks-rate-to-tempo) — each LFO subscribes transport.bpm in its own bind().
    });
    bus.subscribe('transport.swing', (s) => this.clock.setSwing(s));

    // ----- Meter (meter.md REQ-meter-is-two-bus-scalars/REQ-bar-ticks-is-the-arrangement-bar-line, ADR-019) -----
    // The two scalars resolve to ONE number — the bar length in 16th ticks —
    // pushed to everything that counts a bar. Resolved here rather than in each
    // consumer so `beats` and `beatUnit` can never be read a tick apart and
    // disagree about how long the bar is.
    bus.subscribe('transport.beats', () => this.applyMeter());
    bus.subscribe('transport.beatUnit', () => this.applyMeter());
    // Per-machine loop length + step rate (REQ-each-machine-has-a-loop-length/REQ-each-machine-has-a-step-rate). Both defaults are
    // no-ops: `LEN_FOLLOW` follows the bar and the default rate is one cell per
    // tick, i.e. exactly the pre-meter 16-step bar.
    for (const [prefix, lane] of [
      ['seq', () => this.seq.lane],
      ['drum', () => this.drums.lane],
      ['sampler', () => this.sampler.lane],
      ['motion', () => this.motion.lane],
    ] as const) {
      bus.subscribe(`${prefix}.len`, (v) => lane().setLen(v));
      bus.subscribe(`${prefix}.rate`, (v) => lane().setRate(v));
    }

    // The arpeggiator, the four machines and the lane mixer (engine-params.ts).
    bindMachineParams(bus, {
      arp: this.arp, seq: this.seq, drums: this.drums, sampler: this.sampler,
      motion: this.motion, laneMixer: this.laneMixer, polyphony: this.polyphony,
      onSeqPan: (track, v) => { this.seqPans[track] = v; this.updateSpread(); },
      setSynthBusLevel: (v) => rampTo(this.voiceBus.gain, v, this.ctx, RAMP_MEDIUM),
    });
  }

  // ---------- Noise source ----------

  private createNoiseSource(buf: AudioBuffer): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start();
    return src;
  }
}
