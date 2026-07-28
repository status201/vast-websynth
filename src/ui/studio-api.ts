import type { PatternStore } from '../state/patterns';
import type { Arrangement } from '../audio/transport/arrangement';
import type { Clock } from '../audio/transport/clock';
import type { Performance } from '../audio/transport/performance';
import type { StepSequencer } from '../audio/transport/sequencer';
import type { DrumMachine } from '../audio/transport/drum-machine';
import type { SamplerMachine } from '../audio/transport/sampler-machine';
import type { MotionMachine } from '../audio/transport/motion-machine';
import type { RecorderController } from '../audio/recorder/recorder-controller';
import type { BankRenderController } from '../audio/recorder/bank-render';
import type { SyncController } from '../audio/transport/sync/sync-controller';
import type { WebRtcSyncTransport } from '../audio/webrtc-sync-transport';
import type { Compressor } from '../audio/effects/compressor';
import type { Zoetrope } from '../audio/effects/zoetrope';
import type { IosAudioDiagnostics } from '../audio/ios-audio-session';

/**
 * The UI's narrow view of the `Engine` (ADR-009). UI panels/components depend on
 * this interface instead of the concrete `Engine`, so Engine's internals
 * (voices, LFO, Polyphony, LaneMixer, the bus nodes, subscribeParams) stay
 * invisible to the UI. The UI owns this contract; `Engine` satisfies it
 * **structurally** (no `implements`, so `src/audio` never imports `src/ui`) —
 * the check fires where `main.ts` passes the real `Engine` to `mountApp` /
 * `installShortcuts`.
 *
 * Scalar params still flow UI→audio through `ParamBus` (architecture REQ-1); this
 * facade is only for the non-param interactions: transport, pattern grids, the
 * recorder, GR meters, and sample decode/preview.
 */
export interface StudioApi {
  /** Step grids (4 seq + 4 drum + 4 sampler + 4 motion banks) and sample-name metadata. */
  readonly patterns: PatternStore;
  /** Song arrangement: the chain lanes (seq / drum / sampler / motion). */
  readonly arrangement: Arrangement;
  /** Look-ahead transport clock (toggle / playing / onTick / onStart / onStop). */
  readonly clock: Clock;
  /** Live DJ/performance FX (fill, stutter, drop, tape stop). */
  readonly perf: Performance;
  /** Step sequencer (onNote / onStep). */
  readonly seq: StepSequencer;
  /** Drum machine (triggerTrack / onStep). */
  readonly drums: DrumMachine;
  /** One-shot sampler (setBuffer / buffers / triggerSlot / onStep). */
  readonly sampler: SamplerMachine;
  /** Motion sequencer — XY param automation (onStep for the playhead). */
  readonly motion: MotionMachine;
  /** Audio export (exportSong / toggleManual / onState). */
  readonly recorder: RecorderController;
  /** Resample the seq edit bank into a bar-exact buffer (render / onState). */
  readonly bankRender: BankRenderController;
  /** MIDI clock sync master/slave (mode / setMode / status / onStatus). */
  readonly sync: SyncController;
  /** WebRTC WiFi sync transport — drives the pair modal (webrtc-sync.md). */
  readonly rtcSync: WebRtcSyncTransport;
  /** Pre-master analyser tap for the scope (mono down-mix). */
  readonly analyser: AnalyserNode;
  /** Per-channel pre-master analyser taps for the scope's stereo view. */
  readonly analyserL: AnalyserNode;
  readonly analyserR: AnalyserNode;
  /** AudioContext — for sample decode, mic capture, and preview playback. */
  readonly ctx: AudioContext;
  /** Drum-bus compressor; UI reads its gain reduction via `onGr`. */
  readonly drumComp: Compressor;
  /** Master-bus compressor; UI reads its gain reduction via `onGr`. */
  readonly masterComp: Compressor;
  /**
   * The synth chain's cycle splicer. Here for the same reason as the two
   * compressors: it pushes telemetry *upward* from the audio thread (the cycle
   * library), which `ParamBus` cannot carry. Its controls are all plain params.
   */
  readonly zoetrope: Zoetrope;

  /** iOS audio-session diagnostics (inert off iOS); read by the Debug panel. */
  readonly iosAudio: IosAudioDiagnostics;

  /** Stop the transport and silence every voice (Panic / Esc). */
  panic(): void;
  /**
   * Move the playhead to an absolute 16th; `false` when refused (slaved, or a
   * capture is in flight — transport-position.md REQ-6/REQ-8). UI surfaces call
   * this, never `clock.seek`, so the guard and the sync-master announce live in
   * exactly one place.
   */
  seekTo(step: number): boolean;
  /** Whether `seekTo` would be accepted — for disabling controls up front. */
  canSeek(): boolean;
  /** Resume the AudioContext from within a user gesture. */
  resume(): Promise<void>;
}
