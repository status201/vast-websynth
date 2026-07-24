# Presets

```yaml
id: presets
status: implemented
version: 5   # v5: the import wizard is reachable with an already-parsed payload
owner: core
related:
  - architecture
  - song-mode
  - param-reset-baseline
  - paste-import
  - dialog
  - ../decisions/adr-014-dont-make-me-think
source:
  - src/state/preset.ts
  - src/state/preset-file.ts             # v4: pure file build/parse/merge
  - src/state/serialize.ts               # roundParams (export precision)
  - src/state/preset-session.ts
  - src/audio/engine.ts                  # main.ts seeds on boot
  - src/ui/app.ts                        # preset-select dropdown + the manager button
  - src/ui/components/preset-manager-modal.ts   # v4: save / export / import
```

Save/recall of a **sound** (the scalar param snapshot only) — distinct from a
[song](song-mode.md), which also captures patterns and chains.

## Background / Why

A preset is just a `ParamBus.snapshot()` (a `Record<string, number>`), so saving
and loading are trivial bus operations and any new param is captured automatically.
Factory presets are seeded into `localStorage` on first boot so the dropdown is
never empty. Presets deliberately **do not** include pattern/song state — that is
what songs are for.

Until v4 a preset could never leave the browser: sounds lived in `localStorage`
and died with it. A cleared profile, a second machine or a second browser meant
starting over, and there was no way to hand a patch to anyone else. v4 adds the
two files that fix it, and keeps the vintage naming they come from — a **preset**
is one sound, a **bank** is a collection of them (Roland JX/Juno: PATCH + BANK;
Yamaha DX7: VOICE + 32-VOICE BANK). "Patch" is deliberately *not* used for the
collection, which would invert forty years of usage.

The header's single Save button becomes one **manager** modal rather than
sprouting four sibling buttons in an already-crowded header
([responsive-header](responsive-header.md)) — one obvious door to everything you
can do with a sound ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 1).

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

### v4 — files

- **REQ-7** — **Two file shapes**, both plain JSON carrying a `format` tag and a
  `version`, both rounded at the boundary like `save()` (REQ-6):
  a **preset** file `<name>.preset.websynth.json` holds one sound, and a **bank**
  file `<name>.bank.websynth.json` holds many, keyed by preset name.
- **REQ-8** — **"Modified or new" is computed, not tracked.** `Presets.modified()`
  returns every stored preset whose rounded snapshot differs from its factory
  definition, plus every preset whose name is not a factory name. No dirty flag is
  persisted — the comparison is derivable at any time, so it can never go stale or
  need migrating. Export-bank offers this set by default and "all" as the
  alternative.
- **REQ-9** — **One door.** The header Save button (testid `preset-save`,
  unchanged) opens the **preset manager** modal offering exactly four actions:
  *Save current sound*, *Export preset*, *Export bank*, *Import*. Export-preset
  exports the **live** sound (what you currently hear) under the session's name —
  the same thing Save would store — so the two actions can never disagree.
- **REQ-10** — **Import is a two-step wizard, never a blind merge.** Choosing a
  file moves the modal to a **review** step listing every incoming preset with a
  status: `new`, `identical` (byte-equal to what is stored — nothing to do), or
  `conflict` (same name, different sound). A conflict **policy** applies to the
  whole import — `rename` (default: keep both, appending the first free ` 2`,
  ` 3`, …), `overwrite`, or `skip` — and the confirm button states the exact
  count it will write. Nothing is written until confirm.
- **REQ-11** — **A malformed or wrong-typed file is refused with a reason**, not
  silently ignored: a non-JSON file, a JSON file with the wrong `format` tag, or a
  bank whose `presets` map is absent/empty each report what was wrong. Symmetrically,
  dropping a **preset or bank** file on the *song* Import button
  ([song-mode](song-mode.md)) is detected and answered with a pointer to
  Preset ▸ Import rather than a generic "invalid song" — the two file families
  share the `.websynth.json` tail, so users will mix them up
  ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 1). The **paste**
  door ([paste-import](paste-import.md)) has no wrong door to point at: both
  families arrive through one textarea, so a pasted preset/bank is *routed* into
  this wizard (opening straight on its review step via
  `PresetManagerOptions.initialImport`) instead of being refused.
- **REQ-12** — **Importing never changes the live sound.** Presets land in
  `localStorage` and the dropdown; the currently loaded patch is untouched, so an
  import cannot destroy unsaved work. Loading one afterwards is a normal REQ-4
  selection.

## Technical design

### Contract / public interface

```yaml
Presets:  # src/state/preset.ts
  factory(): FactoryBank
  list(): string[]                    # factory ∪ stored, sorted
  ensureFactoryPresets(): void        # seed missing factory presets
  save(name, snap) / load(name)       # localStorage websynth.preset.*
  capture(bus) / apply(bus, snap)
  modified(): string[]                # v4, REQ-8 — differs-from-factory ∪ user-made
  entries(names): Record<name, Snapshot>   # v4 — snapshots for a name list

preset-file.ts:  # v4 — PURE: no localStorage, no DOM, no ParamBus
  buildPresetFile(name, snap): PresetFile
  buildBankFile(name, entries): PresetBankFile
  parsePresetPayload(text): PresetParse       # tagged union, see below
  presetFilename(name) / bankFilename(name)   # sanitized, like Song.download
  planImport(incoming, existing, policy): ImportPlan   # REQ-10, pure
  sameSnapshot(a, b): boolean                 # rounded-value equality (REQ-8)

openPresetManagerModal(opts)  # src/ui/components/preset-manager-modal.ts
  # opts: { bus, session, onPresetsChanged(): void, initialImport?: PresetParse }
  # initialImport opens on the review step (or on home showing the parse errors) —
  # the paste door's entry point (paste-import.md REQ-7)
```

`preset-file.ts` holds **no** browser state on purpose: the whole import
decision (`planImport`) is a pure function of *incoming × existing × policy*, so
the wizard's counts are unit-testable without a DOM or a `Storage` mock, and the
modal is left with nothing but rendering.

### Data shapes

```yaml
PresetFile:
  format: "websynth-preset"
  version: 1
  name: string
  params: { <paramId>: number }        # rounded to 4 sig-figs

PresetBankFile:
  format: "websynth-preset-bank"
  version: 1
  name: string
  presets: { <presetName>: { <paramId>: number } }

PresetParse:                            # discriminated on ok/kind
  ok: true,  kind: "preset" | "bank",  name: string,  presets: {name: Snapshot}
  ok: false, errors: string[]

ImportPolicy: rename | overwrite | skip
ImportPlan:
  writes: [ { source: string, target: string, status } ]   # what confirm applies
  counts: { new: n, identical: n, conflict: n, writes: n }
# status: new | identical | conflict
```

A parsed **preset** file collapses to a one-entry `presets` map, so the review
step and the writer handle one shape (REQ-10) rather than branching per kind.

### Layer touchpoints & ordering

```yaml
app.ts:        preset-save button -> openPresetManagerModal({ bus, session,
                 onPresetsChanged: () => dropdown.setOptions(Presets.list()) })
modal save:    promptDialog (dialog.md) -> Presets.save -> bus.setBaselines(snap)
                 -> session.setActive(name)      # identical to the pre-v4 path
modal export:  buildPresetFile / buildBankFile -> Blob -> <a download>
modal import:  <input type=file> -> parsePresetPayload -> planImport -> review
                 -> confirm: Presets.save per write, then onPresetsChanged()
song-panel:    showImportErrors gains the preset/bank sniff (REQ-11)
```

Ordering that matters: `bus.setBaselines(snap)` runs on **save**, not on import —
an import never touches the live patch (REQ-12), so the double-tap reset target
must not move.

### Persistence

```yaml
localStorage:
  websynth.preset.<name> : a Snapshot (JSON), values rounded to 4 sig-figs on save()
  websynth.preset.index  : user preset name index
files (v4):
  <name>.preset.websynth.json : PresetFile
  <name>.bank.websynth.json   : PresetBankFile
NOT in a preset: patterns / banks / chains (those belong to a SongFile)
NOT persisted:   the "modified" set (REQ-8 — derived on demand, never stored)
```

## Scenarios (BDD)

```gherkin
Scenario: Saving then loading a preset round-trips the sound
  Given the user tweaks several knobs and saves "MyLead"
  When they load another preset then reload "MyLead"
  Then bus values match the saved snapshot
# pinned by: tests/state/preset.test.ts, e2e/presets.spec.ts

Scenario: Save names the preset via the custom prompt dialog
  Given the preset manager is open
  When the user picks Save, types a name in dialog-input, and confirms
  Then the preset persists under that name (no native prompt is used)
# pinned by: e2e/presets.spec.ts

Scenario: Factory presets seed once (edge)
  Given a fresh localStorage
  When the app boots
  Then the 16 factory presets exist; a second boot does not overwrite edited copies
# pinned by: tests/state/preset.test.ts

Scenario: A bank exports only what the user actually made (REQ-8)
  Given an untouched factory install plus one saved preset "MyLead"
  And the factory preset "bass" has been edited and re-saved
  When the user exports a bank with the default scope
  Then the file holds exactly "MyLead" and "bass"
# pinned by: tests/state/preset-file.test.ts, tests/state/preset.test.ts

Scenario: Importing a bank renames conflicts instead of overwriting (REQ-10)
  Given "lead" is stored with a different sound than the incoming "lead"
  When the user imports a bank with the default rename policy
  Then the incoming one lands as "lead 2" and the stored "lead" is unchanged
# pinned by: tests/state/preset-file.test.ts, e2e/presets.spec.ts

Scenario: An identical preset is a no-op, not a duplicate (edge)
  Given the incoming preset is byte-equal to the stored one of the same name
  When the import is planned
  Then it is reported "identical" and writes nothing under any policy
# pinned by: tests/state/preset-file.test.ts

Scenario: Overwrite and skip policies (edge)
  Given one new and one conflicting preset in the file
  When the policy is overwrite
  Then both are written, the conflicting one replacing the stored sound
  When the policy is skip
  Then only the new one is written
# pinned by: tests/state/preset-file.test.ts

Scenario: A wrong-typed file is refused with a reason (REQ-11)
  Given a SongFile chosen in the preset importer
  When it is parsed
  Then the review step is not reached and the error names the expected format
# pinned by: tests/state/preset-file.test.ts

Scenario: A pasted bank opens the wizard on its review step (REQ-11)
  Given a websynth-preset-bank payload pasted into the Song panel's Paste box
  When the confirm button is pressed
  Then the preset manager opens directly on the review list, not the file home
# pinned by: e2e/paste-import.spec.ts

Scenario: A preset file dropped on the song importer points at the right door (REQ-11)
  Given a .preset.websynth.json chosen via the Song panel's Import button
  Then the dialog says it is a preset file and to use Preset ▸ Import
# pinned by: tests/state/preset-file.test.ts, e2e/presets.spec.ts

Scenario: Importing leaves the live sound alone (REQ-12)
  Given the user has unsaved knob edits
  When a bank is imported
  Then no bus value changes and the session's dirty marker is unaffected
# pinned by: e2e/presets.spec.ts
```

## Tests & verification

- Unit: `tests/state/preset-file.test.ts` (build/parse/`planImport`/filenames —
  pure, no Storage mock), `tests/state/preset.test.ts` (`modified`, `entries`,
  seeding), `tests/state/preset-session.test.ts` — `npm test`
- E2E: `e2e/presets.spec.ts` (manager save, export download, import wizard
  round-trip, the song-importer pointer) — `npm run e2e`
- Typecheck: `npm run typecheck`

## Open questions / future

- New params join presets automatically via `snapshot()`; their **no-op defaults**
  keep old presets sounding the same (see [add-a-parameter](../recipes/add-a-parameter.md)).
- **Deleting** a stored preset has no UI yet (`SlotStore.remove` is ready). The
  natural shape: delete a user preset outright, and let deleting an *edited
  factory* preset fall back to the factory sound, since `load()` already does
  exactly that when the slot is absent.
- Bank files carry no `version` migration path beyond the tag; if the `Snapshot`
  shape ever stops being flat `Record<string, number>` this needs
  [ADR-007](../decisions/adr-007-songfile-additive-versioning.md)-style additive
  rules of its own.
