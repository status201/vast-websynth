import type { OscMirror } from '../oscillator';
import { FrequencyLine } from '../frequency-line';

/**
 * The oscillator-sync pair (oscillator-sync.md, ADR-026): one worklet per voice
 * that renders osc1 (master) and osc2 (slave) together while sync is engaged.
 *
 * Thin by design, like `LadderFilterNode` — the engagement crossfade belongs to
 * `SyncEngagement` and the modulation wiring to `Voice`. What lives here is the node, its params, the two
 * output fade gains (silent until the voice engages the pair) and a mirror per
 * oscillator, so each `Osc` can push its controls straight into the params.
 */
export class SyncOscNode {
  /** Output 0's fade gain — the master, feeding `osc1.signal`. */
  readonly master: GainNode;
  /** Output 1's fade gain — the slave, feeding `osc2.signal`. */
  readonly slave: GainNode;
  /** The voice's shared pitch modulation, cents (REQ-every-pitch-source-reaches-the-pair). */
  readonly detune: AudioParam;
  /** The sync sweep, semitones above the slave's own pitch (REQ-sync-pitch-is-the-sweep). */
  readonly syncPitch: AudioParam;
  /** Linear FM index on the slave, from the master (cross-modulation.md REQ-fm-reaches-the-sync-pair). */
  readonly fm: AudioParam;
  readonly freq: FrequencyLine;
  readonly masterMirror: OscMirror;
  readonly slaveMirror: OscMirror;

  /** k-rate: 1 hard, 2 soft (REQ-sync-has-hard-and-soft-modes); 0 free-runs, used only by tests. */
  private readonly mode: AudioParam;

  private constructor(private readonly node: AudioWorkletNode, ctx: BaseAudioContext) {
    const p = (name: string): AudioParam => node.parameters.get(name)!;
    this.detune = p('detune');
    this.syncPitch = p('syncPitch');
    this.fm = p('fm');
    this.mode = p('mode');
    // The processor's own `frequency` default; `SyncEngagement.attach` moves it to
    // wherever the voice's pitch curve has reached.
    this.freq = new FrequencyLine(p('frequency'), 440);

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.slave = ctx.createGain();
    this.slave.gain.value = 0;
    node.connect(this.master, 0);
    node.connect(this.slave, 1);

    // k-rate params written as plain values: a wave index or a duty step is a
    // per-block event that the processor band-limits itself (REQ-every-discontinuity-is-band-limited),
    // and the cents take effect at the next block, which no ear resolves.
    const mirror = (wave: string, cents: string, width: string): OscMirror => {
      const w = p(wave), c = p(cents), pw = p(width);
      return {
        wave: (i) => { w.value = i; },
        cents: (x) => { c.value = x; },
        width: (x) => { pw.value = x; },
      };
    };
    this.masterMirror = mirror('wave1', 'masterCents', 'width1');
    this.slaveMirror = mirror('wave2', 'slaveCents', 'width2');
  }

  /** Idle gate (REQ-the-pair-idles-with-the-voice) — the same message the ladder filter takes. */
  setActive(on: boolean): void {
    this.node.port.postMessage(on);
  }

  setMode(m: number): void {
    this.mode.value = m;
  }

  static create(ctx: BaseAudioContext): SyncOscNode {
    const node = new AudioWorkletNode(ctx, 'sync-osc', {
      numberOfInputs: 0,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });
    return new SyncOscNode(node, ctx);
  }

  static async loadModule(ctx: BaseAudioContext): Promise<void> {
    await ctx.audioWorklet.addModule('/worklets/sync-osc.js');
  }
}
