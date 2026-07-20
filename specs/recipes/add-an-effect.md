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
click-free **dry/wet crossfade** (`BypassWrapper`) — never a reconnect. Reusing
`BypassWrapper` means you only write the DSP, and bypass/mix come for free.

## Steps

### 1. Implement `Effect` — `src/audio/effects/<name>.ts`

Model it on `delay.ts`:

```ts
import { BypassWrapper, type Effect } from './effect';

export class MyFx implements Effect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  private readonly wrap: BypassWrapper;
  constructor(private readonly ctx: AudioContext) {
    this.wrap = new BypassWrapper(ctx, /* initialMix */ 0.5);
    this.input = this.wrap.input;
    this.output = this.wrap.output;
    // wire the DSP between the wrapper's processed nodes:
    //   this.wrap.processedIn → <your nodes> → this.wrap.processedOut
  }
  setBypass(b: boolean): void { this.wrap.setBypass(b); }
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
```

## Tests & verification

- `tests/state/params.test.ts` (params registered + wired); optionally a unit test
  against `tests/audio/mock-audio-context.ts`. `npm test` / `npm run typecheck`.
