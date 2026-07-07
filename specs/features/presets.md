# Presets

```yaml
id: presets
status: implemented
version: 3
owner: core
related:
  - architecture
  - song-mode
  - param-reset-baseline
  - dialog
source:
  - src/state/preset.ts
  - src/state/serialize.ts              # roundParams (export precision)
  - src/state/preset-session.ts
  - src/audio/engine.ts                 # main.ts seeds on boot
  - src/ui/app.ts                       # preset-select dropdown
```

Save/recall of a **sound** (the scalar param snapshot only) — distinct from a
[song](song-mode.md), which also captures patterns and chains.

## Background / Why

A preset is just a `ParamBus.snapshot()` (a `Record<string, number>`), so saving
and loading are trivial bus operations and any new param is captured automatically.
Factory presets are seeded into `localStorage` on first boot so the dropdown is
never empty. Presets deliberately **do not** include pattern/song state — that is
what songs are for.

## Requirements

- **REQ-1** — A preset is a `Snapshot` (`Record<string, number>`) = `bus.snapshot()`.
- **REQ-2** — The 16 factory presets (`acid`, `b3`, `basic`, `bass`, `bells`,
  `brass`, `lead`, `pad`, `pbass`, `piano`, `pluck`, `reese`, `rhodes`, `solina`,
  `upright`, `wobble`) are seeded by `ensureFactoryPresets()` on boot (only if
  absent). Together they cover the core instrument families: basses (`bass`,
  `upright`, `pbass`, `reese`, `acid`), keys (`piano`, `rhodes`, `b3`, `bells`),
  ensemble/poly (`pad`, `solina`, `brass`), leads/plucks (`lead`, `pluck`) and
  FX basses (`wobble`).
- **REQ-2b** — Every factory preset sets the **full sound** (all osc/sub/unison/
  drift/mixer/glide/filter/env/LFO params plus every synth-FX `.on` flag), so
  switching between factory presets is deterministic — no param from the previous
  patch leaks through (per the [add-a-factory-preset](../recipes/add-a-factory-preset.md)
  recipe).
- **REQ-3** — `list()` merges factory names with stored user names, sorted.
- **REQ-4** — Loading a preset restores params via the bus (a bulk apply, not seen
  as an edit). The bulk apply also refreshes the per-param **reset baseline**, so a
  knob double-tap returns to the loaded preset value (see
  [param-reset-baseline](param-reset-baseline.md)). Save-preset marks the baseline too.
- **REQ-5** — The active preset name is tracked by the session (shared with songs).
- **REQ-6** — `save()` rounds the snapshot to 4 significant figures (`roundParams`,
  shared with song export per [ADR-011](../decisions/adr-011-export-precision-and-default-sparse-serialization.md))
  before writing — clean JSON, no audible change. `capture()` stays full-precision
  (live state is untouched; rounding is a serialization-boundary concern).

## Technical design

### Contract / public interface

```yaml
Presets:  # src/state/preset.ts
  factory(): FactoryBank
  list(): string[]                    # factory ∪ stored, sorted
  ensureFactoryPresets(): void        # seed missing factory presets
  save / load / delete (localStorage websynth.preset.*)
PresetSession:  # src/state/preset-session.ts — active name, shared with songs
Snapshot = Record<string, number>
```

### Persistence

```yaml
localStorage:
  websynth.preset.<name> : a Snapshot (JSON), values rounded to 4 sig-figs on save()
  websynth.preset.index  : user preset name index
NOT in a preset: patterns / banks / chains (those belong to a SongFile)
```

### Layer touchpoints

```yaml
boot: ensureFactoryPresets() runs on startup (main.ts)
load: bus.restore(snapshot)  # suppresses the onChange "edit" signal
ui: preset-select dropdown (testid preset-select); Save names via the custom
    promptDialog (see dialog.md), not a native prompt()
```

## Scenarios (BDD)

```gherkin
Scenario: Saving then loading a preset round-trips the sound
  Given the user tweaks several knobs and saves "MyLead"
  When they load another preset then reload "MyLead"
  Then bus values match the saved snapshot
# pinned by: tests/state/preset.test.ts, e2e/presets.spec.ts

Scenario: Save names the preset via the custom prompt dialog
  Given the header Preset Save button
  When the user clicks it, types a name in dialog-input, and clicks dialog-confirm
  Then the preset persists under that name (no native prompt is used)
# pinned by: e2e/presets.spec.ts

Scenario: Factory presets seed once (edge)
  Given a fresh localStorage
  When the app boots
  Then the 16 factory presets exist; a second boot does not overwrite edited copies
# pinned by: tests/state/preset.test.ts
```

## Tests & verification

- `tests/state/preset.test.ts`, `tests/state/preset-session.test.ts`,
  `e2e/presets.spec.ts` (uses an in-memory Storage mock).
- `npm test` / `npm run e2e`.

## Open questions / future

- New params join presets automatically via `snapshot()`; their **no-op defaults**
  keep old presets sounding the same (see [add-a-parameter](../recipes/add-a-parameter.md)).
