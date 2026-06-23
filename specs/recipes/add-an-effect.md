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
}
```

### 2. Construct + splice into a bus — `src/audio/engine.ts`

Build it in the constructor and connect it into the chain (synth voice bus shown):

```ts
this.myFx = new MyFx(this.ctx);
// voiceBus → distortion → wah → phaser → delay → reverb → preMaster
// insert MyFx by re-pointing the two connects around your chosen slot
prev.output.connect(this.myFx.input);
this.myFx.output.connect(next.input);
```

### 3. Add params + subscribe

Register the params ([add-a-parameter](add-a-parameter.md)) — always a `<id>.on`
toggle defaulting to **off** (no-op), then in `subscribeParams()`:

```ts
bus.subscribe('fx.myfx.on',  (x) => this.myFx.setBypass(x < 0.5));
bus.subscribe('fx.myfx.mix', (x) => this.myFx.setMix(x));
// … your other params
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

## Acceptance (BDD)

```gherkin
Scenario: The new effect bypasses cleanly when off
  Given fx.myfx.on is 0
  Then dry = 1, wet = 0 and the effect is inaudible (no click on toggle)
# pinned by: tests/state/params.test.ts (wiring), e2e/controls.spec.ts
```

## Tests & verification

- `tests/state/params.test.ts` (params registered + wired); optionally a unit test
  against `tests/audio/mock-audio-context.ts`. `npm test` / `npm run typecheck`.
