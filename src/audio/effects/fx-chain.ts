import type { ParamBus } from '../../state/params';
import { chain, type Effect } from './effect';
import { Compressor } from './compressor';
import { Delay } from './delay';
import { Distortion } from './distortion';
import { Ducker } from './ducker';
import { Equalizer } from './eq';
import { Phaser } from './phaser';
import { Reverb } from './reverb';
import { Wah } from './wah';

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
 * Synth voice bus: eq → distortion → wah → phaser → delay → reverb → duck.
 *
 * The **EQ heads every chain** (equalizer.md REQ-one-equalizer-per-lane): it shapes what the drive
 * bites on rather than filtering the result, and on this bus it is also the
 * cheap position — the synth path is 1-channel until the reverb, so ten
 * 1-channel biquads instead of ten 2-channel ones.
 *
 * The ducker sits **last** so the reverb tail ducks with everything else —
 * that is the sound (sidechain-ducking.md REQ-the-ducker-is-last-in-the-chain).
 */
export function createSynthChain(
  ctx: AudioContext,
  opts: FxChainOpts = {},
): FxChain<{
  eq: Equalizer; dist: Distortion; wah: Wah; phaser: Phaser; delay: Delay; reverb: Reverb; duck: Ducker;
}> {
  const fx = {
    eq: new Equalizer(ctx),
    dist: new Distortion(ctx, opts.dist),
    wah: new Wah(ctx),
    phaser: new Phaser(ctx),
    delay: new Delay(ctx),
    reverb: new Reverb(ctx, opts.reverb),
    duck: new Ducker(ctx),
  };
  return makeChain(fx, ['eq', 'dist', 'wah', 'phaser', 'delay', 'reverb', 'duck'], (bus) => {
    fx.eq.bind(bus, 'fx.eq');
    fx.dist.bind(bus, 'fx.dist');
    fx.wah.bind(bus, 'fx.wah');
    fx.phaser.bind(bus, 'fx.phaser');
    fx.delay.bind(bus, 'fx.delay');
    fx.reverb.bind(bus, 'fx.reverb');
    fx.duck.bind(bus, 'fx.duck');
  });
}

/**
 * Drum bus: eq → compressor → phaser → delay → reverb. The 1176-style FET
 * compressor sits first among the *effects* so it smashes the dry hits, not the
 * FX wash — and the EQ sits ahead of even that, which is the point: a highpass
 * before the compressor stops the kick pumping the whole kit (equalizer.md
 * REQ-one-equalizer-per-lane). Filtering a compressor's input is a different tool from filtering its
 * output, and this is the one worth having.
 */
export function createDrumChain(
  ctx: AudioContext,
  opts: FxChainOpts = {},
): FxChain<{ eq: Equalizer; comp: Compressor; phaser: Phaser; delay: Delay; reverb: Reverb }> {
  const fx = {
    eq: new Equalizer(ctx),
    comp: new Compressor(ctx, 'fet'),
    phaser: new Phaser(ctx),
    delay: new Delay(ctx),
    reverb: new Reverb(ctx, opts.reverb),
  };
  return makeChain(fx, ['eq', 'comp', 'phaser', 'delay', 'reverb'], (bus) => {
    fx.eq.bind(bus, 'fx.drum.eq');
    fx.phaser.bind(bus, 'fx.drum.phaser');
    fx.delay.bind(bus, 'fx.drum.delay');
    fx.reverb.bind(bus, 'fx.drum.reverb');
    // Ratio index → real ratio; 100 = "all buttons in".
    fx.comp.bind(bus, 'fx.drum.comp', [4, 8, 12, 20, 100]);
  });
}

/** Sampler bus: eq → distortion → phaser → delay → reverb → duck (no wah). */
export function createSamplerChain(
  ctx: AudioContext,
  opts: FxChainOpts = {},
): FxChain<{
  eq: Equalizer; dist: Distortion; phaser: Phaser; delay: Delay; reverb: Reverb; duck: Ducker;
}> {
  const fx = {
    eq: new Equalizer(ctx),
    dist: new Distortion(ctx, opts.dist),
    phaser: new Phaser(ctx),
    delay: new Delay(ctx),
    reverb: new Reverb(ctx, opts.reverb),
    duck: new Ducker(ctx),
  };
  return makeChain(fx, ['eq', 'dist', 'phaser', 'delay', 'reverb', 'duck'], (bus) => {
    fx.eq.bind(bus, 'fx.sampler.eq');
    fx.dist.bind(bus, 'fx.sampler.dist');
    fx.phaser.bind(bus, 'fx.sampler.phaser');
    fx.delay.bind(bus, 'fx.sampler.delay');
    fx.reverb.bind(bus, 'fx.sampler.reverb');
    fx.duck.bind(bus, 'fx.sampler.duck');
  });
}
