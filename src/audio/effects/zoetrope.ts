import { BypassWrapper, bindBypassMix, type Effect } from './effect';
import { ZoetropeNode, type CycleMeter } from '../zoetrope/node';
import { clamp } from '../../utils/math';
import type { ParamBus } from '../../state/params';

export interface ZoetropeOpts {
  /** Perf-tier ceiling on the sieve tap count — the only cost that scales. */
  maxTaps?: number;
}

/**
 * Period-locked cycle splicer — the last insert on the synth chain. See
 * `public/worklets/zoetrope.js` for the DSP and `specs/features/zoetrope.md`
 * for the contract.
 *
 * Like `Compressor`, the constructor builds only the BypassWrapper plumbing so
 * the effect can be wired into a chain synchronously before the worklet module
 * is loaded; call `attachWorklet()` from `Engine.init()` after
 * `ZoetropeNode.loadModule()`. Setters cache their values and are replayed onto
 * the live AudioParams at attach time.
 *
 * Two things here are not in the standard effect shape:
 *
 * - `extInput` is the external (drum bus) feed. The Engine connects the drum
 *   chain's tail to it; `attachWorklet` routes it into the worklet's **second**
 *   input, and the `source` param connects/disconnects it so the processor
 *   never writes the external store while on Self. True bypass still covers it
 *   for free: Web Audio renders backwards from the destination, so once the
 *   wrapper cuts `processedOut → wet` the worklet and its feed both go dormant
 *   (ADR-012 — no second disconnect mechanism).
 * - `setPitchSource` takes the `ConstantSourceNode` carrying the sounding
 *   pitch. While `pitchlock` is on it drives the worklet's `frequency` param;
 *   off, it is disconnected and `frequency` returns to 0, which makes the
 *   processor fall back to zero-crossing detection.
 */
export class Zoetrope implements Effect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** Where the Engine connects the drum bus (zoetrope.md REQ-4). */
  readonly extInput: GainNode;

  private readonly wrap: BypassWrapper;
  private readonly maxTaps: number;
  private node: ZoetropeNode | null = null;
  private cyclesCb: ((m: CycleMeter) => void) | null = null;
  private pitchSource: ConstantSourceNode | null = null;

  private scatter = 0;
  private chaos = 0.5;
  private smear = 0.25;
  private sieve = 0;
  private depth = 12;
  private freeze = 0;
  private source = 0;
  private taps = 8;
  private sub = 0;
  private xfadeFloor = 16;

  private pitchLock = true;
  private pitchConnected = false;
  private extConnected = false;
  private clearOnNote = false;
  private metering = false;

  constructor(private readonly ctx: AudioContext, opts: ZoetropeOpts = {}) {
    this.wrap = new BypassWrapper(ctx, 1);
    this.input = this.wrap.input;
    this.output = this.wrap.output;
    this.extInput = ctx.createGain();
    this.maxTaps = opts.maxTaps ?? 16;
  }

  /** Create the worklet node and splice it into the wet path. */
  attachWorklet(): void {
    if (this.node) return;
    const node = ZoetropeNode.create(this.ctx);
    this.wrap.processedIn.connect(node.input);
    node.output.connect(this.wrap.processedOut);
    node.onCycles = (m) => this.cyclesCb?.(m);
    this.node = node;

    const t = this.ctx.currentTime;
    node.scatter.setValueAtTime(this.scatter, t);
    node.chaos.setValueAtTime(this.chaos, t);
    node.smear.setValueAtTime(this.smear, t);
    node.sieve.setValueAtTime(this.sieve, t);
    node.depth.setValueAtTime(this.depth, t);
    node.freeze.setValueAtTime(this.freeze, t);
    node.source.setValueAtTime(this.source, t);
    node.taps.setValueAtTime(this.taps, t);
    node.sub.setValueAtTime(this.sub, t);
    node.xfadeFloor.setValueAtTime(this.xfadeFloor, t);
    node.setMetering(this.metering);

    // Replay the two routing decisions the setters could not act on yet.
    this.syncExt();
    this.syncPitch();
  }

  /** Subscribe to cycle-library telemetry (the strip + the Hz readout). */
  onCycles(cb: (m: CycleMeter) => void): void {
    this.cyclesCb = cb;
  }

  /**
   * Telemetry is off until the UI asks, and it asks only while the module can
   * actually be seen (zoetrope.md REQ-9).
   */
  setMetering(on: boolean): void {
    this.metering = on;
    this.node?.setMetering(on);
  }

  /** The sounding-pitch signal; connected only while pitch lock is on. */
  setPitchSource(src: ConstantSourceNode): void {
    this.pitchSource = src;
    this.syncPitch();
  }

  setBypass(b: boolean): void {
    this.wrap.setBypass(b);
  }

  setMix(m: number): void {
    this.wrap.setMix(m);
  }

  setScatter(v: number): void {
    this.scatter = v;
    this.apply(this.node?.scatter, v);
  }

  setChaos(v: number): void {
    this.chaos = v;
    this.apply(this.node?.chaos, v);
  }

  setSmear(v: number): void {
    this.smear = v;
    this.apply(this.node?.smear, v);
  }

  setSieve(v: number): void {
    this.sieve = v;
    this.apply(this.node?.sieve, v);
  }

  setDepth(v: number): void {
    this.depth = Math.round(v);
    // Stepped counts jump, so write them directly rather than gliding through
    // the values in between.
    this.node?.depth.setValueAtTime(this.depth, this.ctx.currentTime);
  }

  setFreeze(on: boolean): void {
    this.freeze = on ? 1 : 0;
    this.node?.freeze.setValueAtTime(this.freeze, this.ctx.currentTime);
  }

  /** 0 = self (the synth chain), 1 = the external drum-bus feed. */
  setSource(v: number): void {
    this.source = v >= 0.5 ? 1 : 0;
    this.node?.source.setValueAtTime(this.source, this.ctx.currentTime);
    this.syncExt();
  }

  setPitchLock(on: boolean): void {
    this.pitchLock = on;
    this.syncPitch();
  }

  setTaps(v: number): void {
    this.taps = clamp(Math.round(v), 2, this.maxTaps);
    this.node?.taps.setValueAtTime(this.taps, this.ctx.currentTime);
  }

  setSub(v: number): void {
    this.sub = v;
    this.apply(this.node?.sub, v);
  }

  setXfadeFloor(v: number): void {
    this.xfadeFloor = Math.round(v);
    this.node?.xfadeFloor.setValueAtTime(this.xfadeFloor, this.ctx.currentTime);
  }

  setClearOnNote(on: boolean): void {
    this.clearOnNote = on;
  }

  /**
   * Called by the Engine for every note, from any source. The library is
   * audio-thread state, so the reset travels as a port message rather than a
   * param — and `bus.onNote` would have missed sequencer and arpeggiator notes,
   * which bypass it (they call `Engine.playNote` directly).
   */
  noteOn(): void {
    if (this.clearOnNote) this.clear();
  }

  /** Drop the stored library. */
  clear(): void {
    this.node?.clear();
  }

  /** Self-wire every param at this instance's prefix (ADR-008). */
  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    bus.subscribe(`${prefix}.scatter`, (x) => this.setScatter(x));
    bus.subscribe(`${prefix}.chaos`, (x) => this.setChaos(x));
    bus.subscribe(`${prefix}.smear`, (x) => this.setSmear(x));
    bus.subscribe(`${prefix}.sieve`, (x) => this.setSieve(x));
    bus.subscribe(`${prefix}.depth`, (x) => this.setDepth(x));
    bus.subscribe(`${prefix}.freeze`, (x) => this.setFreeze(x >= 0.5));
    bus.subscribe(`${prefix}.source`, (x) => this.setSource(x));
    bus.subscribe(`${prefix}.pitchlock`, (x) => this.setPitchLock(x >= 0.5));
    bus.subscribe(`${prefix}.taps`, (x) => this.setTaps(x));
    bus.subscribe(`${prefix}.sub`, (x) => this.setSub(x));
    bus.subscribe(`${prefix}.xfadeFloor`, (x) => this.setXfadeFloor(x));
    bus.subscribe(`${prefix}.clearOnNote`, (x) => this.setClearOnNote(x >= 0.5));
  }

  /** Connect the drum feed only while it is actually the selected source. */
  private syncExt(): void {
    const node = this.node;
    if (!node) return;
    const want = this.source === 1;
    if (want === this.extConnected) return;
    if (want) this.extInput.connect(node.node, 0, 1);
    else this.extInput.disconnect(node.node, 0, 1);
    this.extConnected = want;
  }

  private syncPitch(): void {
    const node = this.node;
    const src = this.pitchSource;
    if (!node || !src) return;
    const want = this.pitchLock;
    if (want === this.pitchConnected) return;
    if (want) {
      src.connect(node.frequency);
    } else {
      src.disconnect(node.frequency);
      // Back to 0 so the processor switches to zero-crossing detection.
      node.frequency.setValueAtTime(0, this.ctx.currentTime);
    }
    this.pitchConnected = want;
  }

  private apply(param: AudioParam | undefined, v: number): void {
    param?.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }
}
