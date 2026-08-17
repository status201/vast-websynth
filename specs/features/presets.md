# Presets

```yaml
id: presets
status: implemented
version: 9   # v9: the motion sequencer is not part of a sound (REQ-15)
             # v8: REQ-2b covers the FX tempo locks — a bank that ENGAGES an
             #     effect must pin its .sync (tempo-lock.md REQ-8)
             # v7: the loaded song's sound is a pinned dropdown entry (REQ-13),
             #     and an options rebuild never relabels the selector (REQ-14)
             # v6: REQ-2b spells out WHY only presets leak, and is now pinned
             # v5: the import wizard is reachable with an already-parsed payload
owner: core
related:
  - architecture
  - song-mode
  - dropdown               # REQ-13's pinned entry + its divider
  - demo-library           # the shelf REQ-13 exists to make auditionable
  - param-reset-baseline
  - paste-import
  - preset-authoring
  - dialog
  - ../decisions/adr-014-dont-make-me-think
source:
  - src/state/preset.ts
  - src/state/preset-file.ts             # v4: pure file build/parse/merge
  - src/state/preset-validate.ts         # the file format + its validator (preset-authoring.md)
  - src/state/serialize.ts               # roundParams (export precision)
  - src/state/preset-session.ts          # v7: isPatchParam/patchSnapshot + the song-sound slot
  - src/audio/engine.ts                  # main.ts seeds on boot
  - src/ui/app.ts                        # preset-select dropdown + the manager button
  - src/ui/panels/song-panel.ts          # v7: applySong pins the song's sound
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
- **REQ-2** — The 19 factory presets (`acid`, `b3`, `basic`, `bass`, `bells`,
  `brass`, `ember`, `lead`, `pad`, `pbass`, `piano`, `pluck`, `prism`, `reese`,
  `rhodes`, `solina`, `upright`, `vellum`, `wobble`) are seeded by
  `ensureFactoryPresets()` on boot (only if absent). Sixteen cover the core
  instrument families: basses (`bass`, `upright`, `pbass`, `reese`, `acid`), keys
  (`piano`, `rhodes`, `b3`, `bells`), ensemble/poly (`pad`, `solina`, `brass`),
  leads/plucks (`lead`, `pluck`) and FX basses (`wobble`). The remaining three —
  `ember`, `vellum`, `prism` — are the POLY-model showcases that arrived with
  [filter-models](filter-models.md); each leans on something LADDER cannot do, so
  flipping the model switch on one is the A/B.
- **REQ-2b** — Every factory preset sets the **full sound** (all osc/sub/unison/
  drift/mixer/glide/filter/env/LFO params — *both* LFOs, including their `.sync`
  — plus every synth-FX `.on` flag), so switching between factory presets is
  deterministic: no param from the previous patch leaks through (per the
  [add-a-factory-preset](../recipes/add-a-factory-preset.md) recipe).
  - **Why this is the preset side's job and not the loader's.** `Song.apply`
    calls `bus.resetDefaults()` before `bus.restore(file.params)`, so a song
    cannot leak — anything it omits returns to its default. `Presets.apply` is a
    bare `bus.restore(snap)`, so a preset leaks whatever it omits. Adding a reset
    there would change what a *user-saved sparse* preset means, so the fix is for
    each factory bank to be complete. That makes REQ-2b an invariant a human has
    to remember on every new param — which is exactly why it is now pinned by a
    test rather than by the recipe's prose. Two params had already slipped
    through (`lfo.sync` from [lfo](lfo.md) v6, `lfo2.*` from v7).
  - **(v8) The FX tempo locks are covered too, but only where the effect is
    engaged.** A bank that sets `fx.delay.on: 1` must also set `fx.delay.sync`,
    or the delay inherits whatever division the previously loaded patch was locked
    to ([tempo-lock](tempo-lock.md) REQ-8). Scoped to engaged effects because that
    is the existing convention for every other FX sub-param — a bypassed effect's
    settings are inert, so only the `.on` flags are pinned unconditionally. The
    pinning test follows the same scope, so it cannot drift from the rule.
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

### v7 — the loaded song's sound

- **REQ-13** — **A loaded song's sound is a selectable entry, not just a label.**
  Loading a song or demo sets the selector's *label* to the song name (REQ-5), but
  until v7 that name was never an *option*: the menu listed only `Presets.list()`.
  So auditioning any preset against a demo destroyed the demo's sound, and the
  only way back was to reload the demo — discarding every other edit made since.
  That is the opposite of what a preset selector is for.

  The song's patch is therefore **pinned as the first option**, labelled with the
  song's name and separated from the preset list by a divider
  ([dropdown](dropdown.md) REQ-11). Selecting it re-applies that patch exactly as
  REQ-4 applies a preset, baselines included.
  - **Patch params only.** What is pinned is `patchSnapshot(bus.snapshot())` —
    the ids `isPatchParam` accepts (synth voice + synth FX + master volume),
    already the definition the dirty marker uses. So `transport.bpm`, the drum
    kit, the sampler and the sequencer are *not* restored: comparing sounds
    mid-demo must not silently undo a tempo tweak or a drum edit. Returning to
    the song's **arrangement** is what a song load is for; this is its sound.
  - **Captured after the apply, not from `file.params`.** `Song.apply` runs
    `bus.resetDefaults()` then `bus.restore(file.params)`, so the post-apply
    snapshot is the *effective* patch. Reading `file.params` instead would pin a
    sparse map and re-open exactly the leak REQ-2b closes for factory presets.
  - **Transient and single-slot.** It lives in `PresetSession`, is replaced by the
    next song load, and is never written to `localStorage` — the preset library is
    the user's, and auditioning nineteen demos must not leave nineteen presets in
    it. It survives a reload only because [session-autosave](session-autosave.md)
    restores the song itself, which re-pins it.
  - **A name collision resolves to the song.** If a stored preset shares the
    song's name, the preset is filtered out of the list while the song is loaded:
    one row per label, and the pinned sound wins.

- **REQ-14** (regression) — **Rebuilding the options never relabels the
  selector.** [dropdown](dropdown.md) REQ-2 has `setOptions` fall back to the
  first option when the current value is absent from the new list — and the
  displayed value is *often* absent here, because a song name (REQ-13) or a dirty
  marker (`"Ember *"`) is not a preset name. So `onPresetsChanged` — which fires
  on **import**, an action REQ-12 guarantees changes no sound — silently repainted
  the header from the song's name to `"acid"` while `PresetSession.label` still
  said the song. The label and the audible patch desynchronized with nothing to
  notice it by. Every rebuild therefore re-asserts `setValue(session.display)`
  afterwards, and the session stays the single source of what the selector reads.

- **REQ-15** (v9) — **The motion sequencer is not part of a sound.**
  `NON_PATCH_PREFIXES` listed `transport.`/`arp.`/`seq.`/`drum.`/`sampler.` but
  not `motion.`, so `motion.on`, `motion.mute` and `motion.slide` were captured
  into presets and reapplied on load — auditioning a sound silently switched a
  song's automation off. Motion is a song-level machine like the other three;
  the prefix is added ([meter](meter.md) REQ-13). Consequence to expect: a
  previously saved preset that happens to carry `motion.*` keys keeps them in its
  file, and they are now ignored on load rather than applied.
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
  parsePresetPayload(text): PresetParse       # JSON.parse + validatePresetPayload (no bus)
  # the format tags + file/parse types are defined in preset-validate.ts and
  # re-exported here, so this stays the one door — see preset-authoring.md REQ-1
  presetFilename(name) / bankFilename(name)   # sanitized, like Song.download
  planImport(incoming, existing, policy): ImportPlan   # REQ-10, pure
  sameSnapshot(a, b): boolean                 # rounded-value equality (REQ-8)

preset-session.ts:  # PURE: no localStorage, no DOM
  isPatchParam(id): boolean                   # synth voice + synth FX + master volume
  patchSnapshot(snap): Snapshot               # v7 — the isPatchParam half of a snapshot
  PresetSession:
    label / dirty / display                   # display = label + ' *' once dirty
    setActive(name)                           # a preset became active; songSound untouched
    setActiveSong(name, patch)                # v7, REQ-13 — pin + setActive(name)
    songSound: { name, patch } | null         # v7 — the one transient slot
    markDirty() / subscribe(fn)

openPresetManagerModal(opts)  # src/ui/components/preset-manager-modal.ts
  # opts: { bus, session, onPresetsChanged(): void, initialImport?: PresetParse }
  # initialImport opens on the review step (or on home showing the parse errors) —
  # the paste door's entry point (paste-import.md REQ-7)
```

`setActive` deliberately does **not** clear `songSound`: picking a preset is the
act REQ-13 exists to make survivable, so it must not unpin the thing you are
comparing against. Only another `setActiveSong` replaces it.

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
  ok: true,  kind: "preset" | "bank",  name: string,  presets: {name: Snapshot},
             warnings?: string[]        # ride the ok:true branch (preset-authoring REQ-3)
  ok: false, errors: string[]

ImportPolicy: rename | overwrite | skip
ImportPlan:
  rows:   [ { source: string, target: string, status } ]   # EVERY incoming preset,
                                                           # in file order — REQ-10's review list
  writes: [ ... ]                                          # the subset confirm applies
  counts: { new: n, identical: n, conflict: n, writes: n }
# status: new | identical | conflict
```

A parsed **preset** file collapses to a one-entry `presets` map, so the review
step and the writer handle one shape (REQ-10) rather than branching per kind.

### Layer touchpoints & ordering

```yaml
app.ts:        presetOptions()  = songSound ? [song.name, ...list() minus that name]
                                            : Presets.list()          # REQ-13
               refreshPresetOptions() = setOptions(presetOptions(), {dividerAfter})
                                        THEN setValue(session.display) # REQ-14
               session.subscribe(refreshPresetOptions)   # label, dirty and pin in one
               preset-save button -> openPresetManagerModal({ bus, session,
                 onPresetsChanged: refreshPresetOptions })
dropdown pick: songSound?.name match -> Presets.apply(bus, songSound.patch)  # REQ-13
               else Presets.load(name) -> Presets.apply;  then session.setActive(name)
song-panel:    applySong -> Song.apply(...) -> session.setActiveSong(
                 file.name, patchSnapshot(bus.snapshot()))             # REQ-13
main.ts:       autosave restore -> Song.apply -> session.setActiveSong(...)  # same
modal save:    promptDialog (dialog.md) -> Presets.save -> bus.setBaselines(snap)
                 -> session.setActive(name)      # identical to the pre-v4 path
modal export:  buildPresetFile / buildBankFile -> Blob -> <a download>
modal import:  <input type=file> -> parsePresetPayload -> planImport -> review
                 -> confirm: Presets.save per write, then onPresetsChanged()
song-panel:    showImportErrors gains the preset/bank sniff (REQ-11)
```

Ordering that matters: `bus.setBaselines(snap)` runs on **save**, not on import —
an import never touches the live patch (REQ-12), so the double-tap reset target
must not move. And `setValue` runs **after** `setOptions`, never before: the
rebuild is what strands the label (REQ-14).

`applySong` is the one choke point every song apply already routes through
(`applyDemo`, `loadStoredSlot`, `applyProjectBundle`, the share-link and file
importers), so REQ-13's pin cannot be reintroduced-around by a new load surface.

### Persistence

```yaml
localStorage:
  websynth.preset.<name> : a Snapshot (JSON), values rounded to 4 sig-figs on save()
  websynth.preset.index  : preset name index — factory AND user. ensureFactoryPresets()
                           seeds every factory name on first boot, so list() unions it
                           with Object.keys(FACTORY) rather than trusting either alone
files (v4):
  <name>.preset.websynth.json : PresetFile
  <name>.bank.websynth.json   : PresetBankFile
NOT in a preset: patterns / banks / chains (those belong to a SongFile)
NOT persisted:   the "modified" set (REQ-8 — derived on demand, never stored)
NOT persisted:   PresetSession.songSound (REQ-13 — transient; the autosaved song
                 re-pins it on restore, so it needs no storage of its own)
```

## Scenarios (BDD)

```gherkin
Scenario: Saving then loading a preset round-trips the sound
  Given the user tweaks several knobs and saves "MyLead"
  When they load another preset then reload "MyLead"
  Then bus values match the saved snapshot
# pinned by: tests/state/preset.test.ts, e2e/presets.spec.ts

Scenario: No factory preset can leak an LFO param (regression, v6, REQ-2b)
  Given every factory bank
  Then each one sets all five params of both LFOs, sync included
  So switching from a patch with an armed LFO cannot carry it into the next
# pinned by: tests/state/preset.test.ts

Scenario: No factory preset can leak an FX tempo lock (regression, v8, REQ-2b)
  Given every factory bank that engages the wah, phaser or delay
  Then that bank also sets the effect's .sync
  So switching from a tempo-locked patch cannot carry the division into the next
# pinned by: tests/state/preset.test.ts

Scenario: Save names the preset via the custom prompt dialog
  Given the preset manager is open
  When the user picks Save, types a name in dialog-input, and confirms
  Then the preset persists under that name (no native prompt is used)
# pinned by: e2e/presets.spec.ts

Scenario: Factory presets seed once (edge)
  Given a fresh localStorage
  When the app boots
  Then the 19 factory presets exist; a second boot does not overwrite edited copies
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

Scenario: A demo's sound stays reachable while presets are auditioned (REQ-13)
  Given a demo has been loaded
  Then its name is the first option in the preset selector
  When the user selects a factory preset and then selects the demo's name again
  Then the synth patch is the demo's again and the dirty marker is gone
# pinned by: e2e/presets.spec.ts, tests/state/preset-session.test.ts

Scenario: Returning to the song's sound leaves the song alone (REQ-13)
  Given a demo has been loaded and the user has since changed transport.bpm
  When they select a preset and then the demo's pinned sound
  Then filter.cutoff is the demo's value again
  And transport.bpm still holds the user's change
# pinned by: tests/state/preset-session.test.ts

Scenario: The pinned sound is the effective patch, not the file's sparse map (REQ-13)
  Given a song whose params omit an id the previous song had set
  When the song is applied
  Then the pinned patch carries that id at its registered default
  So re-selecting it cannot leak the previous song's value
# The mechanism is the CALL SITE: every caller pins
# `patchSnapshot(bus.snapshot())` — the settled bus, read after `Song.apply` has
# run `resetDefaults()` — never `file.params`. app.ts, song-panel.ts and main.ts
# all do this, and `apply`'s resetDefaults is what makes the omitted id revert.
# pinned by: tests/state/preset-session.test.ts (patchSnapshot's filter only —
#   see Open questions: no test exercises the apply-then-pin path end to end)

Scenario: Loading another song replaces the pinned sound (REQ-13, edge)
  Given one demo is loaded and pinned
  When a second demo is loaded
  Then only the second demo's name is pinned — the list never grows a history
# pinned by: tests/state/preset-session.test.ts

Scenario: An import does not relabel the selector (REQ-14, regression)
  Given a demo is loaded, so the selector reads its name
  When a preset bank is imported and the options are rebuilt
  Then the selector still reads the demo's name, not the first preset
# pinned by: e2e/presets.spec.ts, tests/ui/dropdown.test.ts
```

## Tests & verification

- Unit: `tests/state/preset-file.test.ts` (build/parse/`planImport`/filenames —
  pure, no Storage mock), `tests/state/preset.test.ts` (`modified`, `entries`,
  seeding), `tests/state/preset-session.test.ts` (`patchSnapshot`, the REQ-13
  pin/replace rules), `tests/ui/dropdown.test.ts` (REQ-14's re-assert) — `npm test`
- E2E: `e2e/presets.spec.ts` (manager save, export download, import wizard
  round-trip, the song-importer pointer) — `npm run e2e`
- Typecheck: `npm run typecheck`

## Open questions / future

- **No test covers apply-then-pin end to end.** `patchSnapshot`'s filter is unit
  tested and `PresetSession`'s bookkeeping is unit tested, but nothing applies a
  song and then asserts the pinned snapshot — the one place REQ-13's "effective
  patch, not the sparse map" actually lives is the three call sites. An e2e that
  loads a demo, loads a second demo whose `params` omits an id the first set, and
  re-selects the first would close it.

- New params join presets automatically via `snapshot()`; their **no-op defaults**
  keep old presets sounding the same (see [add-a-parameter](../recipes/add-a-parameter.md)).
- **Promoting the pinned song sound** to a stored preset (REQ-13) has no button.
  It needs none — Save already stores the live patch, and while the pinned sound
  is selected the live patch *is* it. A dedicated "keep this" action would be a
  second door to the same result ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 1).
- **Deleting** a stored preset has no UI yet (`SlotStore.remove` is ready). The
  natural shape: delete a user preset outright, and let deleting an *edited
  factory* preset fall back to the factory sound, since `load()` already does
  exactly that when the slot is absent.
- Bank files carry no `version` migration path beyond the tag; if the `Snapshot`
  shape ever stops being flat `Record<string, number>` this needs
  [ADR-007](../decisions/adr-007-songfile-additive-versioning.md)-style additive
  rules of its own.
