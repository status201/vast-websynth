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
  - src/audio/effects/effect.ts
  - src/audio/effects/delay.ts          # reference implementation
  - src/audio/engine.ts
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

  // self-wire your params (ADR-008): Engine calls this.myFx.bind(bus, 'fx.myfx')
  bind(bus: ParamBus, prefix: string): void {
    bus.subscribe(`${prefix}.on`,  (x) => this.setBypass(x < 0.5));
    bus.subscribe(`${prefix}.mix`, (x) => this.setMix(x));
    // … your other params
  }
}
```

### 2. Construct + add to a bus chain — `src/audio/engine.ts`

Build it in the constructor and add it to the relevant bus's `chain([...])` list:

```ts
this.myFx = new MyFx(this.ctx);
// synth voice bus, in order:
chain(this.voiceBus, [this.distortion, this.wah, this.phaser, this.myFx, this.delay, this.reverb], this.preMaster);
```

### 3. Bind params

Register the params ([add-a-parameter](add-a-parameter.md)) — always a `<id>.on`
toggle defaulting to **off** (no-op) — then call your effect's `bind` once in
`Engine.subscribeParams()`:

```ts
this.myFx.bind(bus, 'fx.myfx');
```

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
