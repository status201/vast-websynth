# Architecture — VAST G1-J5

```yaml
id: architecture
status: implemented
version: 1
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
  subscribeParams()              # wires every param to the audio graph (once)
  # owns: voices[8], FX chain, arrangement, perf, seq, drums, sampler

PatternStore:    # src/state/patterns.ts
  # 4 seq + 4 drum + 4 sampler banks; edit-bank (UI) vs play-bank (transport)
  snapshot() / restore(...)

Song:            # src/state/song.ts
  capture / apply / toJSON / fromJSON / download / readFile
  list / saveSlot / loadSlot / deleteSlot

Arrangement / Performance:  # src/audio/transport/
  # chain lanes (seq/drum/sampler) and live DJ FX, respectively
```

### Note flow

`bus.onNote` → `Engine.playNote` / `releaseNote`, **unless**
`passthroughSuppressed` is set — then the arpeggiator/sequencer own note
triggering instead.

### Audio graph (system diagram)

```
voices ─→ voiceBus ─→ distortion → wah → phaser → delay → reverb ─┐
            drumBus ─→ drumComp → drumPhaser → drumDelay ─────────┤
            samplerBus  (+ sampler dist/phaser/delay/reverb) ─────┤
                                                                   ▼
        preMaster ─→ djFilter ─→ masterComp ─→ analyser ─→ master ─→ destination
```

- The **drum bus and the sampler bus join at `preMaster`**, bypassing the synth FX
  chain.
- The **analyser taps pre-master**, so the scope is independent of the master
  volume knob.
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
  taper?: linear | exp | discrete
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

## Tests & verification

- `npm run typecheck` — the primary gate.
- `npm test` — Vitest unit suite (pure logic + transport modules against a mock
  `AudioContext` + DOM components in jsdom).
- `npm run e2e` — Playwright smoke + control-surface + flow specs.

See `CLAUDE.md` for the exhaustive testid catalogue and testing notes.
