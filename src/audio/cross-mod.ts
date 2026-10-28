import type { Osc } from './oscillator';
import { FrequencyLine } from './frequency-line';
import { rampTo, RAMP_FAST, RAMP_MEDIUM } from './param-utils';
import { DISCONNECT_DELAY_MS } from './effects/effect';

/**
 * The ring product's gain against an oscillator at the same knob value
 * (cross-modulation.md REQ-ring-is-its-own-level). Two unit waves multiply to
 * something quieter than either, and √2 restores the sine case exactly: measured
 * through the real graph on Blink and Gecko, ring 70% of sine×sine sits within
 * 0.2 dB of one sine at LEVEL 70%. Saw×saw lands 3.7–4.7 dB under a saw — left
 * there, since ring's home is the sine and triangle bell; whether the saw case
 * wants more is a by-ear call (ADR-010).
 */
export const RING_MAKEUP = Math.SQRT2;

/** The ring path's DC blocker (REQ-ring-is-dc-free): below any fundamental, above
 *  the beat rate of two near-unison oscillators. */
export const RING_HP_HZ = 20;

/** Butterworth, flat to the corner. Web Audio reads a high-pass biquad's `Q` in
 *  **dB**, so this is 20·log10(1/√2) ≈ −3.01, not 0.7071 — which read as dB is a
 *  linear Q of ~1.09 and a small bump at 20 Hz, the very wobble the filter is
 *  there to remove (cross-modulation.md REQ-ring-is-dc-free). */
export const RING_HP_Q_DB = 20 * Math.log10(Math.SQRT1_2);

/**
 * A set of edges that exist only while their path can be heard (ADR-012,
 * REQ-cross-mod-disconnects-when-unused). Engaging connects at once — before the
 * caller's gain rises; disengaging waits `DISCONNECT_DELAY_MS` for the gain to
 * reach 0, and a re-engage inside that window keeps the edges instead of racing
 * the cut.
 */
class Edges {
  private engaged = false;
  private connected = false;
  private timer: number | null = null;

  constructor(private readonly connect: () => void, private readonly disconnect: () => void) {}

  set(on: boolean): void {
    if (on === this.engaged) return;
    this.engaged = on;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (on) {
      if (!this.connected) {
        this.connect();
        this.connected = true;
      }
      return;
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.disconnect();
      this.connected = false;
    }, DISCONNECT_DELAY_MS);
  }
}

/**
 * One voice's cross-modulation: linear FM of OSC 2 by OSC 1, and their ring
 * product as a third mixer source (cross-modulation.md). Its own class so
 * `Voice` keeps one job, the same split as `SyncEngagement`.
 *
 * Both read the oscillators' pre-level `signal` taps, so they follow whichever
 * path is sounding — native or the sync pair — and a modulator at LEVEL 0 still
 * modulates (REQ-oscillator-signals-are-tapped-pre-level).
 */
export class CrossMod {
  /**
   * The FM index junction: offset is the knob, matrix `fm` routes sum into it
   * (REQ-fm-is-a-modulation-destination). Its output is β as a signal, which both
   * the native chain and the sync pair's `fm` param read.
   */
  private readonly fmMod: ConstantSourceNode;
  /** osc1 × β. */
  private readonly fmAmt: GainNode;
  /** × f_note · k, in Hz — the deviation fed to osc2's frequency. */
  private readonly fmHz: GainNode;
  /** The note's frequency as a signal, through the oscillators' own glide maths. */
  private readonly hzSrc: ConstantSourceNode;
  private readonly hz: FrequencyLine;
  /** k = 2^((cents1 − cents2)/1200) (REQ-fm-index-is-relative-to-the-modulator). */
  private readonly kGain: GainNode;
  private readonly fmEdges: Edges;

  /** osc2 × osc1: the input is osc2, the gain is driven by osc1 around a base of 0. */
  private readonly ringVCA: GainNode;
  private readonly ringHP: BiquadFilterNode;
  private readonly ringLevel: GainNode;
  private readonly ringEdges: Edges;

  constructor(private readonly ctx: AudioContext, osc1: Osc, osc2: Osc, mix: AudioNode) {
    this.fmMod = ctx.createConstantSource();
    this.fmMod.offset.value = 0;
    this.fmMod.start();
    this.fmAmt = ctx.createGain();
    this.fmAmt.gain.value = 0;
    this.fmHz = ctx.createGain();
    this.fmHz.gain.value = 0;
    this.hzSrc = ctx.createConstantSource();
    this.hzSrc.offset.value = 440;
    this.hzSrc.start();
    this.hz = new FrequencyLine(this.hzSrc.offset, 440);
    this.kGain = ctx.createGain();
    this.kGain.gain.value = 1;

    this.fmMod.connect(this.fmAmt.gain);
    this.fmAmt.connect(this.fmHz);
    this.kGain.connect(this.fmHz.gain);
    // Inputs and output together, as for ring below: Blink skips a chain the
    // destination cannot reach, but Gecko renders every node it is given, so the
    // inputs are cut too. While the output edge is absent, osc2's frequency has no
    // input at all and the browser keeps its k-rate path.
    const osc2Freq = osc2.frequencyParam;
    this.fmEdges = new Edges(
      () => {
        osc1.signal.connect(this.fmAmt);
        this.hzSrc.connect(this.kGain);
        this.fmHz.connect(osc2Freq);
      },
      () => {
        osc1.signal.disconnect(this.fmAmt);
        this.hzSrc.disconnect(this.kGain);
        this.fmHz.disconnect(osc2Freq);
      },
    );

    this.ringVCA = ctx.createGain();
    this.ringVCA.gain.value = 0;
    this.ringHP = ctx.createBiquadFilter();
    this.ringHP.type = 'highpass';
    this.ringHP.frequency.value = RING_HP_HZ;
    this.ringHP.Q.value = RING_HP_Q_DB;
    this.ringLevel = ctx.createGain();
    this.ringLevel.gain.value = 0;
    this.ringVCA.connect(this.ringHP).connect(this.ringLevel);
    // Inputs and output together: while ring is off the path is unreachable from
    // both ends, so none of it renders.
    this.ringEdges = new Edges(
      () => {
        osc1.signal.connect(this.ringVCA.gain);
        osc2.signal.connect(this.ringVCA);
        this.ringLevel.connect(mix);
      },
      () => {
        osc1.signal.disconnect(this.ringVCA.gain);
        osc2.signal.disconnect(this.ringVCA);
        this.ringLevel.disconnect(mix);
      },
    );
  }

  /** Where `fm` modulation lands: the FM knob's junction. */
  get fmTarget(): AudioParam {
    return this.fmMod.offset;
  }

  /** β as a signal, for the sync pair's `fm` param (REQ-fm-reaches-the-sync-pair). */
  get fmSignal(): AudioNode {
    return this.fmMod;
  }

  /** `osc1.fm`: the modulation index β. */
  setFmIndex(beta: number): void {
    rampTo(this.fmMod.offset, beta, this.ctx, RAMP_FAST);
  }

  /** Whether anything can make FM heard — the knob, or a matrix route. Owned by
   *  the Engine, which is the one place both are visible. */
  setFmInUse(on: boolean): void {
    this.fmEdges.set(on);
  }

  /** Keep k current as either oscillator's octave or tune moves. */
  setRatio(cents1: number, cents2: number): void {
    rampTo(this.kGain.gain, Math.pow(2, (cents1 - cents2) / 1200), this.ctx, RAMP_FAST);
  }

  /** Every note, so the deviation tracks the note through glide. */
  setFrequency(hz: number, when: number, glideSec: number): void {
    this.hz.set(hz, when, glideSec);
  }

  /** `osc1.ring`: the ring product's level in the mix (REQ-ring-is-its-own-level). */
  setRing(level: number): void {
    const l = Number.isFinite(level) ? Math.max(0, level) : 0;
    rampTo(this.ringLevel.gain, l * RING_MAKEUP, this.ctx, RAMP_MEDIUM);
    this.ringEdges.set(l > 0);
  }
}
