# Recipe — add a scalar parameter

```yaml
id: add-a-parameter
status: implemented
version: 1
owner: core
related:
  - architecture
  - ../features/ladder-filter
source:
  - src/state/params.ts
  - src/audio/engine.ts
  - src/ui/app.ts
```

A repeatable **playbook**, not a feature. Any new scalar parameter follows the same
three edits, because of the strict `ParamBus ↔ Engine` separation. The concrete
worked instance is [`ladder-filter`](../features/ladder-filter.md).

## Background / Why

UI and audio never talk directly — a parameter is the contract between them. Adding
one therefore always touches exactly three places, in order: define it, apply it,
expose it. Following the pattern keeps presets/songs working automatically (they
snapshot/restore the whole bus) and keeps the audio graph testable.

## The three edits

### 1. Define it — `src/state/params.ts`

Add a `ParamDef` inside `registerDefaults()`'s `bus.registerMany([...])`:

```ts
{ id: 'fx.myThing.amount', min: 0, max: 1, default: 0, format: fmtPct }
```

- Pick a dotted, namespaced `id` (`fx.…`, `osc1.…`, `env.…`).
- Set `min/max/default`. **Default to a no-op** so existing presets/songs are
  unaffected (see `architecture.md` → Conventions).
- Use `taper: 'discrete'` + `labels: [...]` for switch/segmented params,
  `taper: 'exp'` for wide-range time/frequency knobs (needs `min > 0`),
  `taper: 'power'` + `curve` for a 0-based knob that needs finer resolution at
  one end (e.g. `filter.resonance` near self-oscillation), and a `format` for
  the readout.

### 2. Apply it

Where you subscribe depends on **who owns the param** (see
[ADR-008](../decisions/adr-008-components-self-wire-params.md) — components
self-wire their params):

```ts
// per-voice (osc/filter/env): in Engine.subscribeParams(), fan out via all(...)
bus.subscribe('osc1.level', all((v, x) => v.osc1.setLevel(x)));

// an insert effect's param: add it to that Effect's own bind(bus, prefix)
//   src/audio/effects/<name>.ts
bind(bus: ParamBus, prefix: string): void {
  bus.subscribe(`${prefix}.amount`, (x) => this.setAmount(x));
}
// Engine just calls this.myFx.bind(bus, 'fx.myThing') once.

// engine-global one-off (transport/master/etc.): subscribe directly in Engine
bus.subscribe('master.volume', (x) => rampTo(this.master.gain, x * x, this.ctx, RAMP_MEDIUM));
```

- `all(fn)` (`(v, x) => …` for each `Voice`) is for per-voice params and stays
  in `Engine.subscribeParams()`.
- For an **insert effect**, add the subscribe to that effect's `bind(bus, prefix)`
  so the param contract lives with the component that owns it (the same class
  binds at `fx.drum.*` / `fx.sampler.*` for the bus variants).
- For voicing params (poly/unison/glide/drift) call the `Polyphony` setter; for
  lane mute/solo/volume call the `LaneMixer` setter.
- `subscribe` fires immediately with the current value, so the graph initialises
  correctly without extra code.

### 3. Expose it — `src/ui/app.ts` (or the relevant panel)

Add a control bound by `paramId`:

```ts
new Knob({ bus, paramId: 'fx.myThing.amount', label: 'AMOUNT' }).el
// or: new Switch({ bus, paramId: 'fx.myThing.on' })
// or: new Segmented({ bus, paramId: 'fx.myThing.mode' })
```

The component writes on interaction (`bus.set`) and repaints on `bus.subscribe`.
It auto-mints a `data-testid` (`knob-<paramId>` / `switch-<paramId>` / `seg-…`).

### 4. Verify

```bash
npm run typecheck   # primary gate
npm test            # add a registration/behaviour case (see tests/state/params.test.ts)
```

## Gotchas

- **Forgetting edit 2 or 3 is caught by a test.** `tests/state/param-wiring.test.ts`
  fails, naming the id, if a param is registered but referenced nowhere else in
  `src/`. That is the failure this recipe exists to prevent: registration alone
  typechecks, publishes the param to `public/params.json`, and writes it into every
  preset and song from then on (ADR-006/ADR-011) while driving nothing. The guard
  understands the two ways an id legitimately never appears as a literal — an index
  family built from a template (`drum.t${i}.vol`) and ADR-008 self-wiring, where a
  component gets a prefix and subscribes ``  `${prefix}.on`  `` itself. It proves
  reachability, not correctness: wiring a param to the *wrong* setter still passes,
  and only listening catches that (ADR-010).
- **No-op default** is mandatory for backward compatibility — a non-zero default
  silently changes every existing preset and song.
- Discrete params that index a real-value table (ratios, release times) are mapped
  in the Engine, not the registry — see
  [`compressor`](../features/compressor.md) → "Index → real-value mapping".
- If the param drives an `AudioWorklet`, remember worklets must `loadModule()` before
  use; wire the node in the async `init()` path, not the constructor.

## Scenarios (BDD)

```gherkin
Scenario: A newly added param is live and persisted
  Given a ParamDef registered in registerDefaults
  And a matching subscribe in subscribeParams
  And a control bound to its paramId in the UI
  When the user moves the control
  Then bus.get(id) reflects the value and the audio graph applies it
  And saving a preset/song snapshots it automatically
# pinned by: tests/state/params.test.ts (+ the feature's own test)

Scenario: An old preset without the new param still works (backward compat)
  Given the param's default is a no-op
  When an existing preset (lacking the param) loads
  Then the param sits at its no-op default and the preset sounds unchanged
# pinned by: tests/state/preset.test.ts
```

## Tests & verification

- `tests/state/params.test.ts` — registration/clamp/subscribe contract.
- The feature's own unit/E2E spec for the audio behaviour.
- `npm run typecheck` / `npm test`.
