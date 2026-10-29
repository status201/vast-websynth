# Recipe — add an AudioWorklet

```yaml
id: add-an-audioworklet
status: implemented
version: 2   # v2: a lazily loaded insert holds its bypass instead of a passthrough, and its
             #     JS can be a lazy chunk too (the flanger, flanger.md)
owner: core
related:
  - architecture
  - compressor
  - ladder-filter
  - ../decisions/adr-010-musical-stable-cheap-dsp
source:
  - public/worklets/compressor.js        # reference DSP
  - src/audio/compressor/node.ts          # reference wrapper
  - src/audio/engine.ts                   # init() ordering
```

How to add a custom DSP node that runs on the audio thread, following the
`ladder-filter` / `compressor` / `recorder` worklets.

## Background / Why

An `AudioWorklet` is the only way to do per-sample / non-linear DSP in Web Audio.
The processor is **plain JS** (no TS, no imports — it runs on the audio render
thread) under `public/worklets/`, which Vite serves verbatim at `/worklets/…`. A
thin TS wrapper in `src/audio/<name>/node.ts` loads the module, constructs the node,
and exposes its `AudioParam`s + a `port` for messaging the main thread.

**Design stance** — a DSP worklet here is tuned *musical, stable, cheap*, in that
priority order: perceived behaviour over circuit accuracy, bounded/no-NaN output
always, and minimal per-sample cost — multiplied by however many instances and
channels *your* node runs at, so be exact about it: the ladder filter is one
per voice at 1 channel (8 voices, `channelCount: 1` — see
[ladder-filter](../features/ladder-filter.md) REQ-the-filter-worklet-is-mono), the compressors are two bus
instances at 2 channels. Prefer a rational approximation to a transcendental, keep feedback
loops bounded (saturate the loop), and add a boundedness unit test. See
[ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md).

## Steps

### 1. The processor — `public/worklets/<name>.js`

```js
class MyProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'amount', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }
  process(inputs, outputs, params) { /* DSP; return true to stay alive */ return true; }
}
registerProcessor('my-node', MyProcessor);
```

No imports, no DOM. Post to the UI with `this.port.postMessage(...)` (throttle it —
the compressor posts at ~31 Hz).

### 2. The wrapper — `src/audio/<name>/node.ts`

```ts
export class MyNode {
  readonly amount: AudioParam;
  static async loadModule(ctx: AudioContext): Promise<void> {
    await ctx.audioWorklet.addModule('/worklets/my-node.js');  // public/ path
  }
  static create(ctx: AudioContext, opts?: unknown): MyNode {
    const node = new AudioWorkletNode(ctx, 'my-node', { processorOptions: opts });
    return new MyNode(node);
  }
  private constructor(node: AudioWorkletNode) {
    this.amount = node.parameters.get('amount')!;
    node.port.onmessage = (e) => { /* UI metering */ };
  }
}
```

### 3. Wire it in `Engine.init()`

`init()` is async — **await `loadModule` before creating anything that uses the
node**:

```ts
await MyNode.loadModule(this.ctx);
this.myNode = MyNode.create(this.ctx);
```

If the node must sit in a chain the **constructor** builds synchronously, use the
build-placeholder-then-attach pattern: wire a passthrough in the ctor, then splice
the real node in after `loadModule` and replay cached setter values (see
[compressor](../features/compressor.md) → `attachWorklet`).

If most patches never use the node, load it on **first use** instead of in `init()`
([runtime-performance](../features/runtime-performance.md) REQ-boot-cost-matches-the-request).
The worked example is [oscillator-sync](../features/oscillator-sync.md): one memoized
`ensureSync()` loads the module and builds every voice's node the first time the mode
leaves `off`, a failed load is logged and leaves the feature inert, and voices play
the native path until the nodes land.

For an **insert effect** loaded on first use, do not stand a passthrough in for the
node: the switch-on starts the bypass crossfade at once, and if the load outlasts the
start of the fade, swapping the passthrough for the node mid-fade steps the waveform.
Hold the bypass until the node is in instead, and the crossfade only ever fades in
the real wet ([flanger](../features/flanger.md) REQ-an-unloaded-flanger-stays-bypassed,
measured as a click on Blink). The flanger also puts its wrapper's JavaScript behind
an `import()`, leaving only a shell in the entry chunk: the shell owns the bypass,
the mix and the drain, and the lazy module binds the knobs itself, because a bus
subscription fires at once with the current value, so nothing has to be cached
([flanger](../features/flanger.md) REQ-the-flanger-loads-on-first-use). A lazy chunk
reached offline joins `main.ts`'s idle warm.

### 4. Precache it — `public/sw.js`

Add the file to `CORE_ASSETS`. A worklet is fetched by `addModule` at a stable URL,
not as a hashed asset, so the offline service worker only has it if it is precached
([pwa-install](../features/pwa-install.md) REQ-service-worker-is-registered) — and a
lazily loaded one matters most, since nothing fetched it at boot. List it in
`DEPLOYMENT.md`'s subfolder note too: worklets load by absolute path.

## Gotchas

- The processor file is **plain JS** on the audio thread — no TS, no `import`, no
  DOM. Type the wrapper, not the processor.
- `loadModule` **must** be awaited before node construction (the ladder filter is
  awaited before voices are created).
- A worklet with **no inputs** (a generator, like `sync-osc`) still runs while
  `process()` returns `true`, connected or not. Gate it with an active flag posted
  from the main thread, as the ladder filter and the sync pair do.
- A DSP test that renders many blocks should assert once per render, not once per
  sample: per-sample `expect` calls dominate the run and time out under a loaded
  suite.
- Discrete UI indices → real values are mapped in the **wrapper's `bind`**, not
  the worklet (see `Compressor.bind(bus, prefix, ratios, releases?)`).

## Scenarios (BDD)

```gherkin
Scenario: The worklet processes audio after init
  Given Engine.init() has awaited MyNode.loadModule
  When audio runs through the node
  Then it applies its DSP and (optionally) posts meter data on its port
# pinned by: a worklet DSP unit test (stub globals + import the .js)
```

## Tests & verification

- Unit-test the DSP directly by stubbing the worklet globals and importing the JS
  file — see `tests/audio/compressor-worklet.test.ts`. `npm test`.
