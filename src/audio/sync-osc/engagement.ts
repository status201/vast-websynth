import type { Osc } from '../oscillator';
import type { SyncOscNode } from './node';
import { rampTo, RAMP_BYPASS } from '../param-utils';
import { DISCONNECT_DELAY_MS } from '../effects/effect';

/**
 * Which of a voice's two sound sources is live — its native oscillators or its
 * sync pair — and the crossfade between them (oscillator-sync.md
 * REQ-engaging-sync-crossfades / REQ-the-pair-idles-with-the-voice).
 *
 * Its own class so `Voice` keeps one job: the voice owns the junctions every
 * modulation source reaches, and this owns the engagement state machine — the
 * mode, whether the pair is the sound, and the one pending disconnect.
 */
export class SyncEngagement {
  private pair: SyncOscNode | null = null;
  private mode = 0;
  /** Whether the pair, not the native oscillators, is (or is fading to be) the sound. */
  private engaged = false;
  /** The pending disconnect of whichever side went silent; a later toggle cancels it. */
  private timer: number | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly master: Osc,
    private readonly slave: Osc,
    /** Whether the voice is sounding now, so an engage over a held note wakes the pair. */
    private readonly sounding: () => boolean,
  ) {}

  /**
   * Take the pair, once (REQ-the-pair-is-built-on-first-use): both `Osc`s start
   * mirroring into it, it picks up wherever the pitch curve is now, and the
   * stored mode is applied.
   */
  attach(pair: SyncOscNode): void {
    if (this.pair) return;
    this.pair = pair;
    this.master.setMirror(pair.masterMirror);
    this.slave.setMirror(pair.slaveMirror);
    const now = this.ctx.currentTime;
    pair.freq.set(this.master.frequencyAt(now), now, 0);
    pair.setActive(false);
    this.apply();
  }

  /** `osc2.sync`: 0 off, 1 hard, 2 soft. Stored even before a pair exists. */
  setMode(m: number): void {
    this.mode = Math.round(m);
    this.apply();
  }

  /** Engaged or not, so that engaging over a held note starts at its pitch. */
  setFrequency(hz: number, when: number, glideSec: number): void {
    this.pair?.freq.set(hz, when, glideSec);
  }

  /** The pair's idle gate follows the voice, but only while it is the sound. */
  setVoiceActive(on: boolean): void {
    if (this.engaged) this.pair?.setActive(on);
  }

  /**
   * Crossfade between the native oscillators and the pair, then cut whichever
   * went silent (ADR-012). The incoming side is attached before it fades in; the
   * outgoing one is disconnected only once its ramp has settled, and a toggle
   * inside that window cancels the cut rather than racing it.
   */
  private apply(): void {
    const pair = this.pair;
    if (!pair) return;
    const on = this.mode !== 0;
    // A hard <-> soft change while engaged is just the mode param.
    if (on) pair.setMode(this.mode);
    if (on === this.engaged) return;
    this.engaged = on;
    if (this.timer !== null) clearTimeout(this.timer);

    if (on) {
      pair.master.connect(this.master.out);
      pair.slave.connect(this.slave.out);
      if (this.sounding()) pair.setActive(true);
    }
    rampTo(pair.master.gain, on ? 1 : 0, this.ctx, RAMP_BYPASS);
    rampTo(pair.slave.gain, on ? 1 : 0, this.ctx, RAMP_BYPASS);
    this.master.fadeNative(!on);
    this.slave.fadeNative(!on);

    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (on) {
        this.master.dropNative();
        this.slave.dropNative();
      } else {
        pair.master.disconnect();
        pair.slave.disconnect();
        pair.setActive(false);
      }
    }, DISCONNECT_DELAY_MS);
  }
}
