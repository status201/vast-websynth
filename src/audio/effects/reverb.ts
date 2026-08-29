import { WrappedEffect, bindBypassMix } from './effect';
import { rampTo, RAMP_MEDIUM } from '../param-utils';
import type { ParamBus } from '../../state/params';

/** The five selectable tail lengths (seconds), shortest → longest. */
const IR_DURATIONS = [0.4, 0.8, 1.5, 2.5, 4.0];

/** Index `setSize` starts on — the middle of the bank, and the default `size`. */
const DEFAULT_IR = 2;

/**
 * How long the effect's own output is ducked around an IR swap (effects.md
 * REQ-10) — ~4 time constants of `RAMP_MEDIUM`, the same window `ModMatrix.patch`
 * mutes for before it rewires, and for the same reason: the gain is inaudible
 * well before the edit lands.
 */
const IR_SWAP_MUTE_MS = 40;

/**
 * Process-wide IR cache (runtime-performance.md REQ-1/REQ-2). An IR is a pure
 * function of (sampleRate, duration) and a `ConvolverNode` only ever *reads* its
 * buffer, so the three chains that each own a Reverb — synth, drum, sampler —
 * share one bank instead of generating identical noise three times over.
 *
 * Generation is also **lazy**: only the size actually selected is built. Before
 * this, each Reverb rendered all five up front in the Engine constructor —
 * 9.2 s of stereo noise per instance, 2.65 M samples and ~10.6 MB across the
 * three, synchronously, on the boot path, for sizes most sessions never touch.
 * The comment this replaces was right that re-rendering on a knob *drag* is too
 * slow to do live; caching keeps that true after the first touch of each size.
 */
const irCache = new Map<string, AudioBuffer>();

function irFor(ctx: AudioContext, durationSec: number): AudioBuffer {
  const key = `${ctx.sampleRate}|${durationSec}`;
  let buf = irCache.get(key);
  if (!buf) {
    buf = generateIR(ctx, durationSec, 2);
    irCache.set(key, buf);
  }
  return buf;
}

/**
 * Algorithmic-feel reverb built on a ConvolverNode with a procedurally
 * generated impulse response. `size` selects from a small bank of IRs, each
 * generated once on first use and shared across every Reverb (see `irCache`).
 */
export class Reverb extends WrappedEffect {
  private readonly convolver: ConvolverNode;
  private readonly damp: BiquadFilterNode;
  /** Longest tail this instance may use; weak perf tiers shorten it. */
  private readonly maxIrS: number;
  /** Guards the ducked swap's timer so two size changes settle on the last. */
  private sizeGen = 0;

  constructor(ctx: AudioContext, opts?: { maxIrS?: number }) {
    super(ctx, 0.25);

    this.convolver = ctx.createConvolver();
    this.damp = ctx.createBiquadFilter();
    this.damp.type = 'lowpass';
    this.damp.frequency.value = 8000;
    this.damp.Q.value = 0.707;

    // Weak perf tiers cap the IR *durations*, never the bank size, so
    // setSize's 0..1 → index mapping and preset values keep their meaning
    // (performance-mode.md REQ-11). The cap is part of the cache key, so tiers
    // with different caps never share a buffer.
    this.maxIrS = opts?.maxIrS ?? 4;
    this.convolver.buffer = this.irAt(DEFAULT_IR);

    this.wrap.processedIn.connect(this.convolver).connect(this.damp).connect(this.wrap.processedOut);
  }

  /** The (shared, memoized) IR for bank index `idx`, honouring this tier's cap. */
  private irAt(idx: number): AudioBuffer {
    return irFor(this.ctx, Math.min(IR_DURATIONS[idx]!, this.maxIrS));
  }

  setMix(m: number): void { this.wrap.setMix(m); }

  /**
   * A convolver is FIR: one IR length of silence in and it holds nothing of what
   * came before (effects.md REQ-2c). `maxIrS` is this tier's cap, so it bounds
   * every IR in the bank.
   */
  protected override drainSeconds(): number { return this.maxIrS; }

  /**
   * Assigning `convolver.buffer` resets the node, severing whatever tail it was
   * ringing — audible when a song load changes the size under a tail still
   * sounding, and it fires twice per load (effects.md REQ-10). So the swap goes
   * through the mute-then-edit idiom `ModMatrix.patch` uses: duck this effect's
   * own output, swap once it is inaudible, ramp back. The identity guard keeps a
   * no-change write completely free, so a sweep only pays at bank boundaries.
   */
  setSize(v: number): void {
    const last = IR_DURATIONS.length - 1;
    const idx = Math.max(0, Math.min(last, Math.round(v * last)));
    const buf = this.irAt(idx);
    if (this.convolver.buffer === buf) return;

    rampTo(this.wrap.processedOut.gain, 0, this.ctx, RAMP_MEDIUM);
    // `gen` guards the timer: two size changes inside the window settle on the
    // last, rather than racing to restore a gain the other is still lowering.
    const gen = ++this.sizeGen;
    window.setTimeout(() => {
      if (gen !== this.sizeGen) return;
      this.convolver.buffer = buf;
      rampTo(this.wrap.processedOut.gain, 1, this.ctx, RAMP_MEDIUM);
    }, IR_SWAP_MUTE_MS);
  }
  setDamp(d: number): void {
    // 0 = bright (12 kHz), 1 = dark (1 kHz)
    const hz = 12000 - d * 11000;
    this.damp.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.05);
  }

  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    bus.subscribe(`${prefix}.size`, (x) => this.setSize(x));
    bus.subscribe(`${prefix}.damp`, (x) => this.setDamp(x));
  }
}

function generateIR(ctx: AudioContext, durationSec: number, channels = 2): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * durationSec));
  const buf = ctx.createBuffer(channels, len, sr);
  // Early reflections + exponentially decaying noise tail
  for (let ch = 0; ch < channels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, 2.5);
      // Mild stereo de-correlation
      const phase = ch === 1 ? 1 : 0;
      data[i] = (Math.random() * 2 - 1) * env * (0.9 + 0.1 * Math.sin(i * 0.001 + phase));
    }
  }
  return buf;
}
