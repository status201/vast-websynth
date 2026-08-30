# Recipe — add an insert effect

```yaml
id: add-an-effect
status: implemented
version: 1
owner: core
related:
  - effects
  - add-a-parameter
source:
  - src/audio/effects/effect.ts         # Effect + BypassWrapper + bindBypassMix
  - src/audio/effects/delay.ts          # reference implementation
  - src/audio/effects/fx-chain.ts       # the three chain factories
  - src/state/params.ts
```

How to add a bypass-able insert effect to a bus (synth / drum / sampler), following
the [effects](../features/effects.md) pattern.

## Background / Why

Every effect owns a fixed `input → DSP → output` graph wired once, and bypass is a
click-free **dry/wet crossfade** (`BypassWrapper`) followed by a delayed
**disconnect** of the processed path, so a bypassed effect costs no audio-thread
CPU ([ADR-012](../decisions/adr-012-true-bypass-disconnects.md)). Extending
`WrappedEffect` means you only write the DSP: bypass, mix and the two-stage
teardown come for free.

## Steps

### 1. Implement `Effect` — `src/audio/effects/<name>.ts`

Model it on `delay.ts`:

**Extend `WrappedEffect`** — every shipped effect does. It owns the wrapper,
publishes `input`/`output`, and routes the drain hooks below to your overrides;
hand-rolling `implements Effect` around a bare `BypassWrapper` silently opts out
of them, which is how a stateful effect ends up replaying the last song.

```ts
import { WrappedEffect, bindBypassMix } from './effect';

export class MyFx extends WrappedEffect {
  constructor(ctx: AudioContext) {
    super(ctx, /* initialMix */ 0.5);
    // wire the DSP between the wrapper's processed nodes:
    //   this.wrap.processedIn → <your nodes> → this.wrap.processedOut
  }
  setMix(m: number): void { this.wrap.setMix(m); }
  // + your own setters (setRate, setDepth, …) using setTargetAtTime to avoid zipper noise

  // self-wire your params (ADR-008); bindBypassMix opens the shared
  // `${prefix}.on` → setBypass and `${prefix}.mix` → setMix subscriptions.
  bind(bus: ParamBus, prefix: string): void {
    bindBypassMix(bus, prefix, this);
    // … your other params
  }
}
```

**Does your DSP remember anything?** A delay line, a convolver, any feedback loop
— if so it must declare how to empty itself, or re-enabling it replays whatever
was inside when it was switched off ([effects](../features/effects.md) REQ-2c):

```ts
  /** Longest the DSP can hold audio: feed it silence for this and it holds none. */
  protected override drainSeconds(): number { return 2; }

  /** Zero/restore an internal feedback path, or the memory never empties. */
  protected override quiesce(on: boolean): void {
    this.fbGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.fbGain.gain.setValueAtTime(on ? 0 : this.fb, this.ctx.currentTime);
  }
```

A memoryless effect (a shaper, a gain) overrides neither and takes the default.
A **biquad is only memoryless at low Q** — its ring-down is roughly `Q / (pi * f0)`,
so a resonant one (the wah's bandpass, a formant peak) holds audio for longer than
`DRAIN_DEFAULT_S` and should say so.

**Does switching it on change the level?** Bypass is a crossfade, which keeps the
samples continuous — it does *not* keep the loudness continuous, and a 16 dB step
in 20 ms is heard as a click no matter how smooth the waveform is
([effects](../features/effects.md) REQ-12). Two things to check before you ship:

- If your effect has **no `setMix`**, `initialMix` is 1 and enabling it replaces
  the dry signal outright. Whatever your DSP does to the level *is* the toggle.
- A **narrowing** filter throws away most of a broadband signal — a bandpass
  passes a share proportional to its bandwidth `f0 / Q`. Compensate it inside the
  processed path (the wah's `makeupFor(q)`), or the effect is both too quiet and
  a click.

Measure it rather than guessing: hold a note with the transport stopped, toggle
the effect, and compare short-window RMS either side. `verify-audio-by-ear.md`
has the method; a few dB is fine, a dozen is a defect.

### 2. Add it to a chain — `src/audio/effects/fx-chain.ts`

The three insert chains are built as units. Add your effect to the relevant
factory's `fx` object **and** to its order array (the order array *is* the
signal order), then bind it in that factory's `bindAll`:

```ts
const fx = { dist: …, wah: …, phaser: …, myFx: new MyFx(ctx), delay: …, reverb: … };
return makeChain(fx, ['dist', 'wah', 'phaser', 'myFx', 'delay', 'reverb'], (bus) => {
  …
  fx.myFx.bind(bus, 'fx.myfx');
});
```

Widen that factory's return type with your member so `engine.synthFx.fx.myFx`
stays typed. Engine needs no change — it just calls `wire()` and `bind()`.

### 3. Register the params

Register them ([add-a-parameter](add-a-parameter.md)) — always a `<id>.on`
toggle defaulting to **off** (no-op), plus `<id>.mix` if the effect has a
dry/wet. The chain's `bind(bus)` already reaches your effect, so
`Engine.subscribeParams()` is untouched.

### 4. UI + verify

Add controls in `app.ts` (or the drum/sampler panel for a bus variant), then
`npm run typecheck` + a test.

## Gotchas

- Default `<id>.on` to **off** so existing presets are unaffected.
- A drum/sampler variant is the *same class* on `drumBus`/`samplerBus` with a
  `fx.drum.*` / `fx.sampler.*` param prefix (see how `Phaser`/`Delay` are reused).
- A worklet-backed effect (like the [compressor](../features/compressor.md)) builds
  its `BypassWrapper` synchronously, then attaches the node after `loadModule` — see
  [add-an-audioworklet](add-an-audioworklet.md).

## Scenarios (BDD)

```gherkin
Scenario: The new effect bypasses cleanly when off
  Given fx.myfx.on is 0
  Then dry = 1, wet = 0 and the effect is inaudible (no click on toggle)
# pinned by: tests/state/params.test.ts (wiring), e2e/controls.spec.ts

Scenario: Re-enabling it does not replay what it held (REQ-2c)
  Given the effect was switched off while audio was passing through it
  When it is switched on again after its drain
  Then it comes back holding silence, and the wet ramp starts immediately
# pinned by: tests/audio/effects/bypass.test.ts
```

## Tests & verification

- `tests/state/params.test.ts` (params registered + wired); optionally a unit test
  against `tests/audio/mock-audio-context.ts`. `npm test` / `npm run typecheck`.
