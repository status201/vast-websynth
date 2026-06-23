# Presets

```yaml
id: presets
status: implemented
version: 1
owner: core
related:
  - architecture
  - song-mode
source:
  - src/state/preset.ts
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
- **REQ-2** — Factory presets (`basic`, `bass`, `lead`, `pad`, `pluck`, `wobble`)
  are seeded by `ensureFactoryPresets()` on boot (only if absent).
- **REQ-3** — `list()` merges factory names with stored user names, sorted.
- **REQ-4** — Loading a preset restores params via the bus (a bulk apply, not seen
  as an edit).
- **REQ-5** — The active preset name is tracked by the session (shared with songs).

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
  websynth.preset.<name> : a Snapshot (JSON)
  websynth.preset.index  : user preset name index
NOT in a preset: patterns / banks / chains (those belong to a SongFile)
```

### Layer touchpoints

```yaml
boot: ensureFactoryPresets() runs on startup (main.ts)
load: bus.restore(snapshot)  # suppresses the onChange "edit" signal
ui: preset-select dropdown (testid preset-select); save via prompt
```

## Scenarios (BDD)

```gherkin
Scenario: Saving then loading a preset round-trips the sound
  Given the user tweaks several knobs and saves "MyLead"
  When they load another preset then reload "MyLead"
  Then bus values match the saved snapshot
# pinned by: tests/state/preset.test.ts, e2e/presets.spec.ts

Scenario: Factory presets seed once (edge)
  Given a fresh localStorage
  When the app boots
  Then the 6 factory presets exist; a second boot does not overwrite edited copies
# pinned by: tests/state/preset.test.ts
```

## Tests & verification

- `tests/state/preset.test.ts`, `tests/state/preset-session.test.ts`,
  `e2e/presets.spec.ts` (uses an in-memory Storage mock).
- `npm test` / `npm run e2e`.

## Open questions / future

- New params join presets automatically via `snapshot()`; their **no-op defaults**
  keep old presets sounding the same (see [add-a-parameter](../recipes/add-a-parameter.md)).
