# Recipe — add an AudioWorklet

```yaml
id: add-an-audioworklet
status: implemented
version: 1
owner: core
related:
  - architecture
  - compressor
  - ladder-filter
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

## Gotchas

- The processor file is **plain JS** on the audio thread — no TS, no `import`, no
  DOM. Type the wrapper, not the processor.
- `loadModule` **must** be awaited before node construction (the ladder filter is
  awaited before voices are created).
- Discrete UI indices → real values are mapped in the **engine**, not the worklet
  (see compressor's `subscribeCompressor`).

## Acceptance (BDD)

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
