import type { ParamBus } from '../../state/params';
import { chain, type Effect } from './effect';
import { Compressor } from './compressor';
import { Delay } from './delay';
import { Distortion } from './distortion';
import { Phaser } from './phaser';
import { Reverb } from './reverb';
import { Wah } from './wah';
import { Zoetrope } from './zoetrope';

/**
 * One bus's insert chain, built and self-wired as a unit.
 *
 * The three chains (synth / drum / sampler) are structurally alike but *not*
 * identical — the synth has a wah, the drum bus heads with a 1176-style
 * compressor, the sampler has neither — so these are three explicit factories
 * rather than a generic spec DSL. Each owns its effect order, its param
 * prefixes and (for the drum comp) its ratio table, which is exactly the
 * knowledge that used to sit spread across Engine's fields, constructor,
 * wiring and `subscribeParams`.
 *
 * `bind(bus)` self-wires every param (ADR-008); `tail` is the last effect's
 * output, which the bank-render tap needs (synth-only capture).
 */
export interface FxChain<E extends Record<string, Effect>> {
  /** Named access to the members, e.g. `drumFx.fx.comp`. */
  readonly fx: E;
  /** The last effect's output — the pre-`preMaster` tap point. */
  readonly tail: AudioNode;
  /** Series-wire `input → …effects… → output`. */
  wire(input: AudioNode, output: AudioNode): void;
  /** Subscribe every member's params at this chain's prefixes. */
  bind(bus: ParamBus): void;
}

export interface FxChainOpts {
  dist?: { oversample?: boolean };
  reverb?: { maxIrS?: number };
  zoetrope?: { maxTaps?: number };
}

/** Shared construction: keep the declared order as *the* signal order. */
function makeChain<E extends Record<string, Effect>>(
  fx: E,
  order: readonly (keyof E)[],
  bindAll: (bus: ParamBus) => void,
): FxChain<E> {
  const series = order.map((k) => fx[k]!);
  return {
    fx,
    get tail(): AudioNode { return series[series.length - 1]!.output; },
    wire: (input, output) => chain(input, series, output),
    bind: bindAll,
  };
}

/**
 * Synth voice bus: distortion → wah → phaser → delay → reverb → zoetrope.
 *
 * Zoetrope is last because it re-assembles whatever reaches it: put ahead of
 * the reverb it would splice a dry signal and the tail would smear the joins
 * back together, which is the opposite of the point. Being last also makes it
 * the chain's `tail`, so the bank-render tap captures it (render-to-sampler.md).
 */
export function createSynthChain(
  ctx: AudioContext,
  opts: FxChainOpts = {},
): FxChain<{
  dist: Distortion;
  wah: Wah;
  phaser: Phaser;
  delay: Delay;
  reverb: Reverb;
  zoetrope: Zoetrope;
}> {
  const fx = {
    dist: new Distortion(ctx, opts.dist),
    wah: new Wah(ctx),
    phaser: new Phaser(ctx),
    delay: new Delay(ctx),
    reverb: new Reverb(ctx, opts.reverb),
    zoetrope: new Zoetrope(ctx, opts.zoetrope),
  };
  return makeChain(fx, ['dist', 'wah', 'phaser', 'delay', 'reverb', 'zoetrope'], (bus) => {
    fx.dist.bind(bus, 'fx.dist');
    fx.wah.bind(bus, 'fx.wah');
    fx.phaser.bind(bus, 'fx.phaser');
    fx.delay.bind(bus, 'fx.delay');
    fx.reverb.bind(bus, 'fx.reverb');
    fx.zoetrope.bind(bus, 'fx.zoetrope');
  });
}

/**
 * Drum bus: compressor → phaser → delay → reverb. The 1176-style FET
 * compressor sits first so it smashes the dry hits, not the FX wash.
 */
export function createDrumChain(
  ctx: AudioContext,
  opts: FxChainOpts = {},
): FxChain<{ comp: Compressor; phaser: Phaser; delay: Delay; reverb: Reverb }> {
  const fx = {
    comp: new Compressor(ctx, 'fet'),
    phaser: new Phaser(ctx),
    delay: new Delay(ctx),
    reverb: new Reverb(ctx, opts.reverb),
  };
  return makeChain(fx, ['comp', 'phaser', 'delay', 'reverb'], (bus) => {
    fx.phaser.bind(bus, 'fx.drum.phaser');
    fx.delay.bind(bus, 'fx.drum.delay');
    fx.reverb.bind(bus, 'fx.drum.reverb');
    // Ratio index → real ratio; 100 = "all buttons in".
    fx.comp.bind(bus, 'fx.drum.comp', [4, 8, 12, 20, 100]);
  });
}

/** Sampler bus: distortion → phaser → delay → reverb (no wah). */
export function createSamplerChain(
  ctx: AudioContext,
  opts: FxChainOpts = {},
): FxChain<{ dist: Distortion; phaser: Phaser; delay: Delay; reverb: Reverb }> {
  const fx = {
    dist: new Distortion(ctx, opts.dist),
    phaser: new Phaser(ctx),
    delay: new Delay(ctx),
    reverb: new Reverb(ctx, opts.reverb),
  };
  return makeChain(fx, ['dist', 'phaser', 'delay', 'reverb'], (bus) => {
    fx.dist.bind(bus, 'fx.sampler.dist');
    fx.phaser.bind(bus, 'fx.sampler.phaser');
    fx.delay.bind(bus, 'fx.sampler.delay');
    fx.reverb.bind(bus, 'fx.sampler.reverb');
  });
}
