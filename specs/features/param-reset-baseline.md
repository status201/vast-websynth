# Param reset baseline

```yaml
id: param-reset-baseline
status: implemented
version: 1
owner: core
related:
  - architecture
  - presets
  - song-mode
source:
  - src/state/params.ts                 # baselines map + reset/resetValue/setBaselines
  - src/ui/components/knob.ts            # double-tap → bus.reset
  - src/ui/panels/drum-panel.ts         # per-track Reset button → bus.reset
  - src/ui/app.ts                       # Save preset → bus.setBaselines
  - src/ui/panels/song-panel.ts         # Save song → bus.setBaselines
```

Double-tapping a knob (or hitting the drum panel's per-track **Reset**) returns a
param to its *reset baseline* — the value the active preset/song set — falling
back to the global `ParamDef.default` when no preset/song has set it.

## Background / Why

A knob double-tap resets a param, letting users undo a tweak. It used to reset to
the static registered `ParamDef.default`, so after loading a preset (e.g. `acid`
with `filter.cutoff` 60) a double-tap jumped to the factory default (90) instead
of back to the loaded sound. The fix stores a per-param **baseline** on the
`ParamBus`, refreshed whenever a preset/song is loaded or saved, and resets to
that. Params no preset/song has touched keep resetting to their registered
default, exactly as before.

## Requirements

- **REQ-1** — `ParamBus` keeps a per-param **baseline** map, separate from the
  live `values`. Baselines are never persisted (they are derived from whatever
  preset/song is active).
- **REQ-2** — `reset(id)` sets the param to its baseline if one exists, else the
  registered `def.default`. `resetValue(id)` returns that target without applying
  it. Unregistered ids fall back to `0` (as `get`/`set` already do).
- **REQ-3** — `restore(snapshot)` **merges** baselines: every *registered* id in
  the snapshot records its clamped value as the baseline; ids absent from the
  snapshot keep their existing baseline. (A factory preset only covers the synth
  patch, so it must not wipe song-set drum/sampler baselines.)
- **REQ-4** — `resetDefaults()` **clears** all baselines. Because `Song.apply`
  does `resetDefaults()` then `restore(fullSnapshot)`, a song load replaces every
  baseline; a preset load (`restore` only) merges.
- **REQ-5** — `setBaselines(snapshot)` applies the REQ-3 merge without touching
  live values, so **saving** a preset/song makes the just-saved state the new
  reset target. Called by the Save-preset and Save-song handlers.
- **REQ-6** — The knob double-tap and the drum per-track Reset button both go
  through `bus.reset(id)`, so they share one baseline. A **disabled** knob
  (`Knob.setDisabled(true)`, e.g. the BPM knob while sync-slaved) blocks the
  double-tap along with dragging — no reset fires (see
  [midi-clock-sync](midi-clock-sync.md) REQ-14).
- **REQ-7** — Setting a baseline never fires per-param listeners or the global
  `onChange` signal (it is not an edit); `reset()` fires them like any `set()`.
- **REQ-8** — Boot emergent behaviour: `main.ts` applies the `basic` preset via
  `restore`, so a fresh session's baselines match `basic` (the active sound shown
  in the header). This is intended, not special-cased.

## Technical design

### Contract / public interface

```yaml
ParamBus:  # src/state/params.ts — additions
  reset(id): void                       # set to resetValue(id)
  resetValue(id): number                # baseline ?? def.default ?? 0
  setBaselines(snapshot): void          # merge clamped, registered-only; no notify
  restore(snapshot): void               # (existing) now also setBaselines(snapshot)
  resetDefaults(): void                 # (existing) now also clears baselines
```

### Layer touchpoints

```yaml
baseline set: restore()/setBaselines() (preset+song load, preset+song save, boot)
baseline clear: resetDefaults() (Song.apply, before its restore)
baseline read: bus.reset(id) from knob double-tap + drum Reset button
NOT a baseline source: direct bus.set (knob drag, applyKit, randomizeKit, spring-back strip)
```

Direct edits — knob drag, the drum kit picker (`applyKit`), randomize
(`randomizeKit`), and the spring-back `Strip` (pitch bend / DJ filter, which
physically springs to its centre default) — go through `bus.set` and deliberately
do **not** move baselines.

### Persistence

Baselines hold no persistent state — they are recomputed from the active
preset/song on every load/save. Nothing new is written to `localStorage` or song
files.

## Scenarios (BDD)

```gherkin
Scenario: Double-tap returns to the loaded preset value
  Given the "acid" preset (filter.cutoff 60) is loaded
  And the user drags filter.cutoff to 110
  When the user double-taps the cutoff knob
  Then filter.cutoff is 60, not the registered default 90
# pinned by: tests/state/preset.test.ts, tests/ui/knob.test.ts

Scenario: A param the preset did not set resets to the global default
  Given a preset that omits transport.bpm is loaded
  And the user changes transport.bpm to 200
  When the user resets transport.bpm
  Then transport.bpm is the registered default 120
# pinned by: tests/state/preset.test.ts

Scenario: Loading a preset over a song keeps the song's drum baselines
  Given a song whose params set drum.t0.tune to 5 is loaded
  When a factory preset (patch-only, no drum params) is loaded
  Then resetting drum.t0.tune yields 5 (the song baseline survives)
# pinned by: tests/state/params.test.ts

Scenario: Saving marks the saved state as the new baseline
  Given the user tweaks filter.cutoff and saves the preset
  And then drags filter.cutoff away
  When the user double-taps the cutoff knob
  Then filter.cutoff returns to the saved value
# pinned by: tests/state/params.test.ts

Scenario: No preset/song loaded resets to the global default (regression)
  Given a fresh bus with only registerDefaults and no restore/setBaselines
  When the user resets filter.cutoff after changing it
  Then filter.cutoff is the registered default 90
# pinned by: tests/state/params.test.ts, tests/ui/knob.test.ts

Scenario: A New song (resetDefaults) drops baselines back to defaults
  Given a song was loaded (baselines set to its values)
  When resetDefaults() runs (New song)
  Then resetting any param yields its registered default
# pinned by: tests/state/params.test.ts
```

## Tests & verification

- Unit: `tests/state/params.test.ts` (reset/resetValue/setBaselines, merge vs
  clear), `tests/state/preset.test.ts` (apply then reset), `tests/ui/knob.test.ts`
  (double-tap targets baseline vs default) — `npm test`.
- Typecheck: `npm run typecheck`.
- Dev-bridge: load `acid`, drag then double-tap cutoff, assert
  `window.__synth.bus.get('filter.cutoff')` is 60.

## Open questions / future

- Song **Export** (download) does not mark a baseline — it is a file export, not
  a change of the active sound. Only Save-slot / Save-preset do.
