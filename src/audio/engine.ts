import { LadderFilterNode } from './ladder-filter/node';
import { Voice } from './voice';
import { LFO } from './lfo';
import { Compressor } from './effects/compressor';
import { createSynthChain, createDrumChain, createSamplerChain } from './effects/fx-chain';
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
import { MotionMachine } from './transport/motion-machine';
import { Arrangement } from './transport/arrangement';
import { Performance } from './transport/performance';
import { SyncController } from './transport/sync/sync-controller';
import { WebRtcSyncTransport } from './webrtc-sync-transport';
import { RecorderNode } from './recorder/node';
import { RecorderController } from './recorder/recorder-controller';
import { BankRenderController } from './recorder/bank-render';
import { PatternStore, DRUM_TRACK_COUNT, SEQ_TRACK_COUNT, MOTION_TRACK_COUNT } from '../state/patterns';
import { XyPadStore } from '../state/xy-pad';
import { IosAudioSession, shouldResumeContext, type IosAudioDiagnostics } from './ios-audio-session';
import { MediaSessionKeepAlive, type MediaSessionDiagnostics } from './media-session';

const VOICE_COUNT = 8;
const PITCH_BEND_RANGE_CENTS = 200;

/**
 * Master fade-in applied whenever the context is actually resumed
 * (audio-lifecycle.md REQ-1). Long enough to swallow the output stream's own
 * start transient and the worklets' first block, short enough to be inaudible
 * as a fade after a deliberate tap.
 */
const RESUME_FADE_S = 0.15;

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

  /** Master-bus compressor — not a chain member; it sits djFilter → here → analyser. */
  readonly masterComp: Compressor;

  /** The drum-bus compressor. Kept as a named accessor for `StudioApi`. */
  get drumComp(): Compressor { return this.drumFx.fx.comp; }

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
  motion!: MotionMachine;
  arrangement!: Arrangement;
  perf!: Performance;
  recorder!: RecorderController;
  bankRender!: BankRenderController;
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
  /** XY Pad axis assignment consumed by the motion sequencer (EngineOptions.xy). */
  private readonly xyStore: XyPadStore;
  private readonly motionFps: number | undefined;

  /** iOS-only audio-session workarounds; inert (no-op) on every other platform. */
  private readonly iosSession: IosAudioSession;
  /** Android-only Media Session keep-alive; inert on every other platform. */
  private readonly media: MediaSessionKeepAlive;

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
    // notification tap, long after (media-session.md REQ-4).
    this.media = new MediaSessionKeepAlive({
      play: () => { void this.resume(); this.clock.start(); },
      pause: () => this.panic(),
      stop: () => this.panic(),
    });

    this.voiceBus = this.ctx.createGain();
    this.voiceBus.gain.value = 1;

    // Perf-tier FX-cost knobs (performance-mode.md REQ-11); defaults are no-ops.
    this.fxOversample = opts.fxOversample ?? true;
    const reverbOpts = { maxIrS: opts.reverbIrMaxS ?? 4 };
    const distOpts = { oversample: this.fxOversample };

    const chainOpts = { dist: distOpts, reverb: reverbOpts };
    this.synthFx = createSynthChain(this.ctx, chainOpts);
    this.drumFx = createDrumChain(this.ctx, chainOpts);
    this.samplerFx = createSamplerChain(this.ctx, chainOpts);
    this.masterComp = new Compressor(this.ctx, 'vca');

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;

    // fftSize is perf-tier-dependent (performance-mode.md REQ-12): 256/512/1024 for
    // weak/medium/strong, cutting the always-pulled analyser FFT + per-draw copy cost
    // on weaker tiers. This is the BOOT seed only — the scope applies later tier
    // changes live via setFftSize. All three share one value so the scope's
    // per-channel buffers stay uniform (scope.md REQ-2).
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

    // Each chain owns its own effect order + param prefixes (effects/fx-chain.ts).
    this.synthFx.wire(this.voiceBus, this.preMaster);
    this.drumFx.wire(this.drumBus, this.preMaster);
    this.samplerFx.wire(this.samplerBus, this.preMaster);

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
    // Motion writes params (not audio), evaluated against the audio clock's now.
    this.motion = new MotionMachine(this.clock, this.patterns, this.arrangement, this.xyStore, this.bus, {
      now: () => this.ctx.currentTime,
      ...(this.motionFps !== undefined ? { fps: this.motionFps } : {}),
    });

    // Lane mixer — needs the sequencer (mute = stop triggering) + the drum/
    // sampler buses (mute = cut bus gain), so it is built after the machines.
    this.laneMixer = new LaneMixer(this.ctx, this.seq, this.drumBus, this.samplerBus);

    // Audio capture: tap master (post master-volume). The recorder node has
    // zero outputs so it is a pure sink and never doubles into destination.
    this.recorderNode = await RecorderNode.create(this.ctx);
    this.master.connect(this.recorderNode.input);
    this.recorder = new RecorderController(this.clock, this.arrangement, this.recorderNode);

    // Bank resample (render-to-sampler.md): a second zero-output tap on the
    // synth FX chain output (post-reverb, pre-preMaster) — the drum/sampler
    // buses never enter it. Engine keeps the state juggling (REQ-5) in the
    // prepare closure so LaneMixer/private state stays out of the controller.
    const bankRenderNode = await RecorderNode.create(this.ctx);
    this.synthFx.tail.connect(bankRenderNode.input);
    this.bankRender = new BankRenderController(
      this.clock,
      bankRenderNode,
      () => this.prepareBankRender(),
      // Any capture, manual or automatic: both drive the transport, and a bank
      // render would fight whichever one is holding it.
      () => this.recorder.isCapturing(),
    );

    // Stop cuts the sampler's in-flight one-shots (sampler.md REQ-8). A tied (or
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
      // One-shot tempo handoff when a link drops mid-play (REQ-21).
      setLocalBpm: (b) => this.bus.set('transport.bpm', b),
    });

    // WiFi sync (WebRTC DataChannel) coexists with the MIDI transport; no RTC
    // objects until the user pairs (webrtc-sync.md). initMIDI adds 'midi' later.
    this.rtcSync = new WebRtcSyncTransport();
    this.sync.addTransport('wifi', this.rtcSync);

    // While slaved, Tape Stop skips its clock-BPM ramp (pitch ramp still sounds)
    // so incoming clock keeps driving the tempo (midi-clock-sync REQ-13).
    this.perf.clockRampAllowed = () => this.sync.activeMode !== 'slave';

    this.subscribeParams();
    this.bus.onNote((on, note, vel) => {
      if (this.arpPassthroughSuppressed) return;
      if (on) this.playNote(note, vel);
      else this.releaseNote(note);
    });

    this.installContextRearm();
  }

  /**
   * Force the bank-render preconditions (render-to-sampler REQ-5) and return
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

  /**
   * Resume the AudioContext. Browsers create it suspended until a user
   * gesture, so `init()` can run (and the UI can mount) before this is
   * called — this must be invoked from within the start-button gesture.
   *
   * `iosSession.unlock()` runs first (synchronously, inside the gesture) to
   * switch iOS off the silent-switch-respecting *ambient* category; it is a
   * no-op elsewhere. `shouldResumeContext` then covers `'suspended'` and the
   * iOS-only `'interrupted'` state alike — and gates the fade with it, so
   * resuming an already-running context can never dip live audio.
   */
  async resume(): Promise<void> {
    this.iosSession.unlock();
    // Android: become a media player the OS protects (media-session.md). Like
    // the iOS call above it must run inside the gesture, and it is a no-op off
    // its own platform — so both run before the state check.
    this.media.unlock();
    if (!shouldResumeContext(this.ctx.state)) return;
    this.fadeInMaster();
    try { await this.ctx.resume(); } catch { /* stays suspended until gesture */ }
  }

  /**
   * Ramp the master up from silence so a start doesn't click
   * (audio-lifecycle.md REQ-1). The graph is fine; what clicks is the step from
   * "not rendering" to "rendering at full gain" — the device's own stream-start
   * transient, the worklets' first block, or an underrun while the start
   * handler is still working all arrive at once otherwise.
   *
   * Scheduled *before* `ctx.resume()` is awaited: `currentTime` is frozen while
   * a context is suspended, so this ramp is guaranteed to cover the very first
   * rendered blocks rather than landing somewhere inside them (REQ-3).
   */
  private fadeInMaster(): void {
    const t = this.ctx.currentTime;
    // Same law as the master.volume subscription, so the fade lands exactly
    // where the knob says — and its setTargetAtTime (scheduled while suspended
    // by the boot patch) is superseded by the events below.
    const v = this.bus.get('master.volume');
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(0, t);
    this.master.gain.linearRampToValueAtTime(v * v, t + RESUME_FADE_S);
  }

  /**
   * Recover the context after the OS takes it away. Android suspends a hidden
   * page's context (screen off, app switch) and leaves it suspended on return;
   * iOS drops it into `'suspended'`/`'interrupted'` on calls, Siri and
   * app-switching. Both are fixed by resuming when the page comes back.
   *
   * The `statechange` listener is iOS-only on purpose: `'interrupted'` arrives
   * *while visible* and nothing else recovers from it, whereas elsewhere
   * auto-resuming on state change would instantly undo the Debug panel's
   * deliberate Suspend (audio-lifecycle.md REQ-4/REQ-5). Some iOS versions still
   * require a fresh gesture — the next tap is the natural fallback.
   */
  private installContextRearm(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      // The Android keep-alive first: if the OS paused our element while we were
      // away, the session it holds needs to come back too (media-session REQ-6).
      this.media.rearm();
      // iOS re-arms unconditionally: even a context that survived needs the
      // silent loop replayed to hold the media-backed session category.
      if (this.iosSession.active || shouldResumeContext(this.ctx.state)) void this.resume();
    });
    if (!this.iosSession.active) return;
    this.ctx.addEventListener('statechange', () => {
      if (!document.hidden && shouldResumeContext(this.ctx.state)) void this.resume();
    });
  }

  /** iOS audio-session diagnostics for the Debug panel (see ios-audio.md / debug-panel.md). */
  get iosAudio(): IosAudioDiagnostics { return this.iosSession.diagnostics; }

  /** Android keep-alive diagnostics for the Debug panel (see media-session.md REQ-8). */
  get mediaSession(): MediaSessionDiagnostics { return this.media.diagnostics; }

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

  // ---------- Transport position (transport-position.md) ----------

  /**
   * Whether moving the playhead is currently allowed. Three states say no, and
   * they are all "something else owns the step counter right now"
   * (transport-position.md REQ-6):
   *  - **slaved** — the remote transport owns the playhead, and a local jump
   *    drives the slave's phase tracking into a re-anchor (midi-clock-sync REQ-24);
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
    this.clock.seek(Math.max(0, Math.round(step)));
    // Slaves count pulses from their own start, so a silent jump leaves them
    // permanently behind (midi-clock-sync REQ-23). A no-op unless mastering.
    this.sync.announcePosition();
    return true;
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
      rampTo(this.master.gain, x * x, this.ctx, RAMP_MEDIUM);
    });
    bus.subscribe('master.pitchBend', (x) => {
      rampTo(this.pitchBend.offset, x * PITCH_BEND_RANGE_CENTS, this.ctx, RAMP_FAST);
    });
    bus.subscribe('master.modWheel', () => updateLfoAmount());

    // ----- Transport -----
    // Gated while *actively* slaved: incoming MIDI clock owns the tempo then;
    // the knob's bus value is the restore target when the role ends
    // (midi-clock-sync REQ-4). `activeMode`, not `mode`, so a selected-but-
    // disconnected Slave leaves the knob in charge (REQ-19).
    bus.subscribe('transport.bpm', (b) => {
      if (this.sync.activeMode !== 'slave') this.clock.setBpm(b);
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
    // Tracks 2-4 only sound in poly voicing (sequencer.md REQ-9); each track
    // also has its own mute (REQ-10), independent of the lane-wide seq.mute.
    bus.subscribe('voicing.mode', (v) => this.seq.setPolyphonic(v >= 0.5));
    for (let t = 0; t < SEQ_TRACK_COUNT; t++) {
      const track = t;
      bus.subscribe(`seq.t${t}.mute`, (v) => this.seq.setTrackMuted(track, v >= 0.5));
    }
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
      bus.subscribe(`drum.t${i}.model`, (v) => this.drums.setTrackModel(track, v));
    }

    // ----- Sampler -----
    bus.subscribe('sampler.on', (v) => this.sampler.setEnabled(v >= 0.5));
    bus.subscribe('sampler.master', (v) => this.laneMixer.setSamplerVol(v));
    for (let i = 0; i < 8; i++) {
      const slot = i;
      bus.subscribe(`sampler.t${i}.mute`, (v) => this.sampler.setSlotMute(slot, v >= 0.5));
    }

    // ----- Motion sequencer -----
    bus.subscribe('motion.on', (v) => this.motion.setEnabled(v >= 0.5));
    bus.subscribe('motion.mute', (v) => this.motion.setMuted(v >= 0.5));
    bus.subscribe('motion.slide', (v) => this.motion.setSlide(v >= 0.5));
    // Each extra motion track interpolates on its own mode (REQ-2).
    for (let t = 0; t < MOTION_TRACK_COUNT; t++) {
      const track = t;
      bus.subscribe(`motion.t${t}.slide`, (v) => this.motion.setTrackSlide(track, v >= 0.5));
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
