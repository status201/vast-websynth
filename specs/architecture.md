# Architecture — VAST G1-J5

```yaml
id: architecture
status: implemented
version: 2
owner: core
related: []
source:
  - src/main.ts
  - src/state/params.ts
  - src/audio/engine.ts
  - src/state/patterns.ts
  - src/state/song.ts
```

The system-wide source of truth. Read this before any feature spec — the feature
specs assume the contracts and conventions defined here.

## Background / Why

VAST G1-J5 is a polyphonic Web Audio synthesizer (+ drum machine + sampler) in
**vanilla TypeScript**. There is **no UI framework and zero runtime
dependencies**; build tooling is Vite + `tsc` only. The one third-party runtime
component is the MIT `lamejs` MP3 encoder, **vendored** (not an npm dependency)
under `src/vendor/lamejs/`.

The defining design choice is a hard separation between UI and audio: **they never
call each other directly.** All scalar state flows through one bus (`ParamBus`),
which both the UI (writers) and the `Engine` (readers/appliers) talk to. This keeps
the audio graph testable, makes presets/songs a trivial snapshot of the bus, and
means a UI control and its audio effect can be reasoned about independently.

## Requirements (system invariants)

- **REQ-1** — UI components write parameters via `bus.set(...)`; the `Engine`
  reads them via `bus.subscribe(...)`. No direct UI↔audio calls.
- **REQ-2** — Every scalar parameter is registered exactly once in
  `registerDefaults()` with `min/max/default` (and optional `taper`/`format`).
- **REQ-3** — Audio cannot start without a user gesture; the whole graph is wired
  inside the "Tap to start" handler in `main.ts`.
- **REQ-4** — New parameters default to a **no-op** value, so existing
  presets/songs are unaffected (see Conventions).
- **REQ-5** — Non-scalar state (step grids) lives in `PatternStore`, not the bus.

## Tech stack

```yaml
language: TypeScript            # ^6.0.3, strict + noUncheckedIndexedAccess
build:      Vite                # ^8.0.16  (vite build) + tsc --noEmit
unit_tests: Vitest              # ^4.1.9   (jsdom env)
e2e_tests:  "@playwright/test"  # ^1.61.0  (headless Chromium)
dom_env:    jsdom               # ^29.1.1  (unit-test DOM)
runtime_deps: none              # zero — no `dependencies` block in package.json
vendored:
  lamejs: src/vendor/lamejs/    # MIT MP3 encoder, NOT an npm dependency
release: scripts/release.mjs    # zero-dep bump+build+zip; see DEPLOYMENT.md
commands:
  dev: vite --host
  build: tsc --noEmit && vite build
  typecheck: tsc --noEmit       # primary check
  test: vitest run
  e2e: playwright test
```

## Technical design

### The two long-lived objects

Created once in `main.ts` and threaded everywhere:

- **`ParamBus`** (`src/state/params.ts`) — single source of truth for every scalar
  parameter.
- **`Engine`** (`src/audio/engine.ts`) — owns the `AudioContext`, the 8-voice pool,
  the FX chain, and the transport modules.

Non-scalar state lives in **`PatternStore`** (`src/state/patterns.ts`).

### Module dependency graph

*Who owns and depends on whom* — module ownership + data-flow direction (distinct
from the signal-flow **audio graph** below, which is audio routing). The spine is
the UI/audio separation (REQ-1): the UI writes state, the `Engine` reads it; they
never call each other directly.

```
   UI  (ui/app.ts · panels · components)
    │
    │  writes: bus.set(id, v) · patterns.*       (UI writes params via the bus, not the Engine)
    ▼
   ParamBus (scalars) ◄─── Song.capture/restore ───► PatternStore (step grids)
    │
    │  Engine.subscribe(...) · bus.onNote      (+ Transport reads PatternStore grids)
    ▼
   Engine  (owns the AudioContext)
    ├─ Voices      — 8-voice pool
    ├─ FX          — insert chain + drum/master compressors
    ├─ Transport   — Clock, Arrangement, Performance, Sequencer,
    │                DrumMachine, SamplerMachine, Arpeggiator
    └─ Recorder    — RecorderController (audio export), taps master
```

`main.ts` constructs `ParamBus` then `Engine(bus)` and threads both everywhere;
`Song` is the only thing that snapshots `ParamBus` **and** `PatternStore` together.

For **non-param** interactions (transport, pattern grids, recorder, GR meters,
sample decode) the UI does not get the whole `Engine` — it depends on the narrow
**`StudioApi`** facade (`src/ui/studio-api.ts`), which exposes only the curated
collaborators and hides Engine's internals (voices, LFO, `Polyphony`, `LaneMixer`,
the bus nodes, `subscribeParams`). `Engine` satisfies it **structurally**; see
[ADR-009](decisions/adr-009-ui-depends-on-studio-api-facade.md).

### Layer contracts (public surfaces)

```yaml
ParamBus:        # src/state/params.ts
  set(id, value, silent?)        # clamps to [min,max]; notifies subscribers
  get(id)                        # current value (or default)
  def(id)                        # the ParamDef
  subscribe(id, fn) -> unsub     # fires immediately with current value
  onChange(fn)                   # global "an edit happened" signal
  snapshot() / restore(snap)     # bulk save/load (restore suppresses onChange)
  resetDefaults()                # every param back to default
  onNote / noteOn / noteOff      # note event path

Engine:          # src/audio/engine.ts
  init()                         # async: loads worklets, builds voices + transport
  subscribeParams()              # wires params to the audio graph (once); FX/comps
                                 #   self-wire via Effect.bind(bus, prefix) — ADR-008
  playNote / releaseNote         # thin delegators to Polyphony (SynthOutput surface)
  # owns: AudioContext, voices[8], FX chain, arrangement, perf, seq, drums, sampler
  # delegates: Polyphony (voice alloc + unison/glide/drift), LaneMixer (mute/solo/vol)

StudioApi:       # src/ui/studio-api.ts  (the UI's narrow view of Engine — ADR-009)
  # patterns, arrangement, clock, perf, seq, drums, sampler, recorder, sync,
  # analyser, analyserL, analyserR, ctx, drumComp, masterComp + panic()/resume().
  # Engine satisfies it structurally;
  # UI signatures take StudioApi so Engine internals stay invisible to the UI.

PatternStore:    # src/state/patterns.ts
  # 4 seq + 4 drum + 4 sampler banks; edit-bank (UI) vs play-bank (transport)
  snapshot() / restore(...)

Song:            # src/state/song.ts
  capture / apply / toJSON / fromJSON / download / readFile
  list / saveSlot / loadSlot / deleteSlot

Arrangement / Performance:  # src/audio/transport/
  # chain lanes (seq/drum/sampler) and live DJ FX, respectively
```

### Event flow / propagation

The dependency graph above is the *static* view (who owns whom). This is the
*dynamic* view — **what fires what, and in what order**. The forward param path
is the obvious half; the **reverse (repaint) path and the bulk-load suppression
are where the subtlety lives**, so they're spelled out here.

**Two notification channels** (both on `ParamBus`):

- `subscribe(id, fn)` — **per-param**. Fires immediately with the current value,
  then on every non-`silent` `set(id, …)`. This is the **convergence point**:
  the `Engine`'s audio appliers (`subscribeParams` / `Effect.bind`) *and* every
  UI control (`knob`, `switch`, `segmented`, `strip`, `param-dropdown`) register
  here. One channel drives **both** audio and visuals, and neither side knows
  about the other (REQ-1).
- `onChange(id, v)` — **global** "an edit happened" signal. One consumer:
  `main.ts` → `session.markDirty()` (the active preset becomes dirty). Suppressed
  during bulk applies via an internal `suppressChange` counter.

**1 — Live edit** (forward + repaint; the common case)

```
knob drag ─→ bus.set(id, v)
               ├─ per-param listeners ─┬─→ Engine applier ─→ audio graph update
               │                       └─→ bound controls re-render (the editing
               │                            control + any other UI bound to id)
               └─ onChange(id) ─→ session.markDirty()   (preset now dirty)
```

**2 — Song / preset load** (bulk apply) — `Song.apply`:

```
Song.apply ─→ bus.resetDefaults()      (clear stale params; onChange suppressed)
          ─→ bus.restore(file.params)  (per-param listeners FIRE → audio + UI
          │                              repaint; onChange SUPPRESSED → not an edit)
          ─→ patterns.restore(...)     (re-emits every step → panels repaint)
          ─→ arr.set{Seq,Drum,Sampler}Chain → arrangement.onChange → chain panels
```

The load-bearing move: `restore()` is **not** `silent`, so per-param listeners
fire and the UI repaints through the *same* `subscribe` channel as a live edit —
there is **no explicit "repaint the UI" call anywhere**. Only the global
`onChange` is gated, so loading a song isn't seen as an edit. (`resetDefaults`
runs first to make the apply *authoritative*: a param absent from the file snaps
back to its default instead of lingering from the previous patch — see REQ-4 /
[ADR-006](decisions/adr-006-no-op-param-defaults.md).)

**3 — Note trigger**

```
bus.onNote ─→ Engine.playNote / releaseNote ─→ Polyphony
   (unless passthroughSuppressed — then the arpeggiator/sequencer own triggering)
```

The arp sets `passthroughSuppressed` when it takes ownership of held notes, so
raw key passthrough is gated while it (or the sequencer) drives the voices.

**Ordering that matters**: `Arrangement` is constructed **before** the
sequencer/drum/sampler machines in `Engine.init()`, so its `clock.onTick` runs
first and the **play banks are settled before the machines read them on the same
tick**. And transport modules are built **after** the voices so they can call
back into the engine.

### Audio graph (system diagram)

```
voices ─→ voiceBus ─→ distortion → wah → phaser → delay → reverb ─┐
            drumBus ─→ drumComp → drumPhaser → drumDelay → drumReverb ─┤
            samplerBus  (+ sampler dist/phaser/delay/reverb) ─────┤
                                                                   ▼
        preMaster ─→ djFilter ─→ masterComp ─→ analyser ─→ master ─→ destination
```

- The **drum bus and the sampler bus join at `preMaster`**, bypassing the synth FX
  chain.
- The **analyser taps pre-master**, so the scope is independent of the master
  volume knob. The tap is a lossless `splitter → analyserL/analyserR → merger →
  analyser` so the scope can also show per-channel L/R (see
  [`features/scope.md`](features/scope.md)).
- `drumComp` is a **FET**-mode compressor; `masterComp` is a **VCA**-mode
  compressor (see [`features/compressor.md`](features/compressor.md)).

### State model (the "schemas")

```yaml
ParamDef:                # the scalar "schema" — src/state/params.ts
  id: string
  min: number
  max: number
  default: number
  step?: number
  taper?: linear | exp | power | discrete
  curve?: number         # exponent for the power taper (see ladder-filter.md)
  unit?: string
  format?: (v) => string
  labels?: string[]      # for discrete params

PatternStore step types: # src/state/patterns.ts
  StepSettings: { velocity, gate, prob, ratchet, tie }
  SeqStep:     StepSettings + { on, note }
  TriggerCell: StepSettings + { on }   # DrumCell / SamplerStep
```

`SongFile` (the persistence schema) is specified in
[`features/song-mode.md`](features/song-mode.md).

### Persistence

```yaml
localStorage:
  websynth.preset.*   : factory + user presets   # state/preset.ts
  websynth.song.*     : saved song slots          # state/song.ts
  websynth.song.index : slot name index
  websynth.perf       : performance-mode pref (auto|weak|medium|strong)  # state/perf-mode.ts — device-scoped, NOT a patch param
not_persisted:
  decoded audio buffers  # sampler stores only filenames (sampleNames); reloaded
```

## Global conventions (constrain every feature)

- **Filter cutoff is a MIDI note number, not Hz.** The ladder filter worklet takes
  `cutoffNote` so envelope/LFO modulators sum in **semitones** via Web Audio's
  native `AudioParam` input summation. Keep modulation additive in semitone space.
- **AudioWorklets** (`ladder-filter`, `hardware-compressor`, `recorder`) live as
  plain JS in `public/worklets/` and must be `loadModule()`-ed (awaited) before the
  nodes that use them are created. `Engine.init()` is async for this reason.
- **DSP worklets favour _musical, stable, cheap_ over physical accuracy** —
  perceived behaviour first, bounded/no-NaN output always, minimal per-sample cost
  (it runs across 8-voice polyphony × 2 channels). This governs the ladder filter
  and the compressors; "academically correct" DSP (ZDF, oversampling, thermal
  models) is declined unless it is *also* cheap and stable. See
  [ADR-010](decisions/adr-010-musical-stable-cheap-dsp.md).
- **No-op defaults for new params.** New analogue/song params default to a value
  that changes nothing (sub level 0, unison 1 voice, drift 0, djfilter 0,
  `seq.master` 1) so existing presets are unaffected. `glide.mode` defaults to
  `always` (1) for the same reason.
- **CSS Modules** for all component/panel styling (`src/ui/styles/*.module.css`);
  global CSS is only `base.css` / `theme.css` / `layout.css`. State classes
  (`.on`, `.active`, `.playing`, …) are global — match with `:global(...)`.
- **Stable `data-testid`s** are minted at the factory level (`knob-<paramId>`,
  `switch-<paramId>`, `seg-<paramId>`, `tab-<id>`, `seq-step-<i>`, …). E2E specs
  select by testid/text/role because CSS Module class names are hashed.
- **Dev bridge** — `main.ts` exposes `window.__synth = { engine, bus, patterns,
  session }` gated on `import.meta.env.DEV` (absent in production). Use it for E2E
  state assertions, e.g. `window.__synth.bus.get('filter.cutoff')`.
- **TypeScript is strict** with `noUncheckedIndexedAccess` — expect `arr[i]!`
  assertions; match that style. Tests live **outside `src/`** so `tsc` ignores
  them. So does this `specs/` folder.

## Key decisions (ADRs)

The *why* behind the choices above — and the alternatives each one rejected —
lives in [`decisions/`](decisions/) as Architecture Decision Records. The
load-bearing ones:

- [ADR-000](decisions/adr-000-spec-driven-development.md) — Spec-Driven Development
  as the working method (enforced, not optional).
- [ADR-001](decisions/adr-001-parambus-over-redux.md) — `ParamBus` over a state
  framework (the scalar single-source-of-truth behind REQ-1/REQ-2).
- [ADR-002](decisions/adr-002-audioworklet-compressor.md) — a custom AudioWorklet
  compressor over the native `DynamicsCompressorNode`.
- [ADR-003](decisions/adr-003-no-runtime-dependencies.md) — zero runtime
  dependencies (vanilla TS + the Web platform; `lamejs` vendored).
- [ADR-004](decisions/adr-004-patternstore-separate-from-parambus.md) —
  `PatternStore` separate from `ParamBus` (REQ-5; grids aren't scalars).
- [ADR-005](decisions/adr-005-cutoff-as-midi-note.md) — filter cutoff as a MIDI
  note number, for semitone-additive modulation.
- [ADR-006](decisions/adr-006-no-op-param-defaults.md) — no-op defaults for new
  params (REQ-4; existing presets/songs are unaffected).
- [ADR-007](decisions/adr-007-songfile-additive-versioning.md) — additive
  `SongFile` versioning (old songs keep loading and sounding the same).
- [ADR-008](decisions/adr-008-components-self-wire-params.md) — components
  self-wire their params (`Effect.bind`); voice allocation / lane mix extracted
  to `Polyphony` / `LaneMixer` so `Engine` coordinates rather than knows-all.
- [ADR-009](decisions/adr-009-ui-depends-on-studio-api-facade.md) — the UI
  depends on a narrow `StudioApi` facade, not the concrete `Engine` (Engine
  satisfies it structurally; internals stay invisible to the UI).
- [ADR-010](decisions/adr-010-musical-stable-cheap-dsp.md) — DSP worklets favour
  *musical, stable, cheap* over physical accuracy (the ladder filter + the
  compressors).
- [ADR-011](decisions/adr-011-export-precision-and-default-sparse-serialization.md) —
  song/preset export rounds to 4 sig-figs + writes default-sparse step cells
  (optimise only at the serialization boundary).
- [ADR-012](decisions/adr-012-true-bypass-disconnects.md) — bypassed effects
  disconnect their processed path after the crossfade settles (true bypass), so
  idle convolvers/shapers/compressor worklets cost zero audio-thread CPU.

## Tests & verification

- `npm run typecheck` — the primary gate.
- `npm test` — Vitest unit suite (pure logic + transport modules against a mock
  `AudioContext` + DOM components in jsdom).
- `npm run e2e` — Playwright smoke + control-surface + flow specs.

See `CLAUDE.md` for the exhaustive testid catalogue and testing notes.
