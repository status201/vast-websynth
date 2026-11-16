# Song mode (cross-cutting integration)

```yaml
id: song-mode
status: implemented
version: 32
owner: core
related:
  - architecture
  - song-file          # the on-disk format: version ladder, validation, canonical form
  - compressor
  - presets
  - sequencer
  - motion-sequencer
  - param-reset-baseline
  - xy-pad
  - sampler
  - project-export
  - dialog
  - session-autosave
  - toast
  - machine-status
  - paste-import
  - untrusted-input      # REQ-an-imported-file-is-validated-first: a song is an untrusted document; the limits live there
  - transport-position   # REQ-a-load-lands-on-bar-one: the seek contract a load reuses
  - transport-window     # REQ-a-load-lands-on-bar-one: the readout/scrubber a stale position contradicts
  - transport-loop       # REQ-a-load-lands-on-bar-one: a loop range names bars of the OUTGOING song
  - runtime-performance   # REQ-a-song-captures-the-whole-session: boot pays only for what the user asks for
  - pwa-install           # offline behaviour of the fetched-on-click demos
source:
  - src/state/song.ts                         # capture/apply/persist + demos + parse
  - src/state/demos-index.json                # generated filename -> song name (REQ-drop-in-demos-are-fetched-on-click)
  - scripts/clean-demos.ts                    # canonicalizer + index generator + drift gate
  - src/state/patterns.ts                     # banks + restore (migration)
  - src/audio/transport/arrangement.ts        # 4 chain lanes
  - src/audio/transport/performance.ts        # live DJ FX
  - src/audio/transport/lane-mix.ts           # audibleLanes (pure mute/solo rule)
  - src/audio/transport/sampler-machine.ts    # sampler lane playback
  - src/ui/panels/song-panel.ts               # the Song tab
  - src/ui/panels/song-session.ts             # the loaded song: apply, slot provenance, the undo net
  - src/ui/panels/song-io.ts                  # import / export / share link, and their failure dialogs
  - src/ui/panels/demo-loader.ts              # the one door every demo comes through
```

The big integration feature. It exercises almost every layer — scalar params (via
`ParamBus.snapshot`), non-scalar grid state (`PatternStore`), the arrangement
chains, live performance FX, the lane mixer, and persistence. The file it reads
and writes — the version ladder, validation and canonical form — is
[song-file](song-file.md)'s.

## Background / Why

Song mode turns the synth from a live instrument into an arranger: 4..16 banks each of
sequencer / drum / sampler / motion patterns, ordered into per-lane **chains**,
played back bar-by-bar, with live DJ FX and a per-lane mixer on top. A whole song
(params + all banks + all four chains) is captured into one portable JSON file and
into `localStorage` slots. Because song files are saved by users and shipped as
demos, the load path **must stay backward compatible** as the format grows.

## Requirements

The file format's REQs (the version ladder, validation, serialization, audio
never embedded) are [song-file](song-file.md)'s.

- **REQ-a-song-captures-the-whole-session** — A song captures the full bus
  snapshot + all seq/drum/sampler/motion banks + all four chain lanes into one
  `SongFile`.
- **REQ-apply-resets-to-defaults-first** — `apply()` is authoritative: it
  **resets params to defaults first** (a stale param omitted by an older file
  reverts rather than lingering), the four chains and the XY axes fall back to
  their defaults, and the **motion** sections (banks / assigns / tracks) a file
  omits are **blanked**, never inherited from the previous song: each absent
  section is coalesced against `emptyPatternSnapshot()`, the same blank New Song
  restores from. **Sampler** banks/names are the deliberate
  exception: they inherit across a load, because the sampler's decoded buffers
  live in `SamplerMachine` (out of reach of `apply`) and blanking the metadata
  alone would orphan them — a full sampler clear (metadata **and** buffers) is
  New Song's job. `resetDefaults()`+`restore()` also replaces every knob **reset
  baseline** with the song's values (see
  [param-reset-baseline](param-reset-baseline.md)); Save-song marks it too.
- **REQ-stale-sampler-audio-is-evicted** — **Stale sampler audio is evicted.** A
  slot's decoded buffer belongs to the *name* beside it, so when an incoming
  file **supplies** `sampleNames` and a slot's name changes, that slot's buffer
  is nulled through the optional narrow `sampler` handle (`{ setBuffer }`),
  before `patterns.restore`, so the store's meta emit repaints the slot (with its
  `.needs-reload` hint) instead of song A's audio playing under song B's label. A
  file that **omits** `sampleNames` renames nothing and evicts nothing. Callers that
  hold a sampler pass it (`song-panel.applySong`, the app.ts demo fallback, the
  boot restore); unit tests without an audio graph omit it.
- **REQ-mute-and-solo-share-one-rule** — Mute/solo audibility follows one shared
  pure rule (solo wins over mute), used by both the engine and the UI.
- **REQ-play-banks-settle-before-the-machines-read** — Play banks must be
  settled **before** the machines read them on a given tick (construction
  ordering).
- **REQ-the-demo-row-overflows-into-a-menu** (v6) — The demo row shows at most
  `DEMO_ROW_LIMIT` (**10**, what fits a desktop row) buttons inline, in
  `demoNames()` order; the rest hide behind an **"All Demos"** toggle
  (`song-demo-more`, "Less" while open), absent when there are ≤ 10.
  `SongPanel.loadDemo(name)` works for hidden demos too. A load, like every song
  load, fires `UiBridge.cuePlay` ([play-button-blink](play-button-blink.md)).
  *Which* demos overflow is data, so a test asserts the rule, never that a named
  demo is hidden ([write-a-test](../recipes/write-a-test.md)).
- **REQ-song-lane-titles-navigate** (v8) — Each lane
  card's title is a button
  (testid `song-lane-title-<seq|drum|sampler|motion>`) that opens that machine's
  tab, and the tab bar carries a per-machine status LED. Both are governed by
  [machine-status](machine-status.md); note the lane prefix `drum` maps to the tab
  id `drums`. The card's existing silenced-dimming (REQ-mute-and-solo-share-one-rule) is unchanged — it still
  keys off audibility only, never off `<machine>.on`.
- **REQ-drop-in-demos-are-fetched-on-click** (v11) — There are **three** demo sources and `SongPanel.loadDemo(name)`
  dispatches across all of them:
  - `DEMO_SONGS` — the one hand-authored built-in, **Mordor**. Bundled,
    **synchronous**, because callers depend on that: `Song.loadSlot` falls back
    to it, and `ai-prompt.ts` renders `DEMO_SONGS['Mordor']` as its worked
    example.
  - `JSON_DEMOS` — the `src/state/demos/*.json` drop-ins, as `{name, url}`.
    **Fetched on click** and parsed through the same `Song.parse` the Import
    button uses, so a corrupt drop-in reports what is actually wrong with it.
  - `ZIP_DEMOS` — the project bundles ([project-export](project-export.md)
    REQ-zip-demos-auto-register).

  The drop-ins are `?url` imports, never bundled
  ([runtime-performance](runtime-performance.md) REQ-boot-cost-matches-the-request:
  a user loads at most one). Names are therefore not readable at build time, and
  filenames will not do (`hacienda_neworder.json` is "Haçienda"), so
  `src/state/demos-index.json` (`filename → name`) is generated by
  `scripts/clean-demos.ts` and checked by `npm run check:demos` in CI.
  - **Order:** `demoNames()` is the one list (the demo row, the tour fallback, the
    empty-play random pick): all three sources sorted by **display name** with
    `localeCompare(…, { sensitivity: 'base', numeric: true })`, whatever the source.
    `Song.list()` uses the same comparator.
  - **Resolution:** a demo name is data, but callers name one (the tour's
    `DEMO_FOR_TOUR`). `resolveDemoName(name)` returns the name when a source owns
    it, otherwise **the first name in `demoNames()`** (`undefined` only for an empty
    library), so a renamed file degrades to a real song, not silence. `loadDemo`
    resolves *before* REQ-one-name-two-songs-ask's question. The one caller that
    must **not** fall back is the Load button's fallthrough for a slot
    `loadSlot` could not return (`isDemoName` guards it; it is reachable only when
    another tab deletes the slot mid-click).
  - A demo not yet clicked is cached only by an offline copy ([play-offline](play-offline.md)
    REQ-the-build-writes-the-file-list); a failed load after a deploy offers Reload
    ([version-skew](version-skew.md) REQ-a-stale-failure-offers-reload).
  - **Coverage:** `tests/state/demo-files.ts` globs the drop-ins, so each is
    validated; `e2e/helpers.ts` reads `demos-index.json` (Playwright has no Vite).
- **REQ-sync-and-audio-pair-up** (v13) — The panel's last two rows are **Sync**
  then **Audio** (export is the terminal action, so it reads last). Above
  **1280 px** they **share one row**, `justify-content: space-between`. Mechanism:
  an `.ioPair` wrapper that is `display: contents` at ≤ 1280 px (each `.io` keeps
  its own dashed rule, and DOM order is the stacked order) and becomes the flex row
  above it. The Audio row's `Format:` segmented is the global default seeding the
  export modal and the [Record window](record-window.md)
  ([audio-export](audio-export.md)); `song-export-audio` is the layout probe.
- **REQ-a-load-lands-on-bar-one** (v14) — **Every path
  that replaces the song returns the playhead to the top**: the demo buttons,
  Load, Import / Paste / share link / PWA file-launch, the Undo toast's restore,
  and **New**. A song carries no playhead — the cue is transient by design
  ([transport-position](transport-position.md) → *Persistence*), so without a
  reset the incoming song inherits the outgoing position and cue (a bar that may
  not exist, [transport-window](transport-window.md)
  REQ-the-position-readout-is-bar-dot-step). Load-bearing details:
    - It goes through **`StudioApi.seekTo(0)`**, never `clock.seek`
      ([transport-position](transport-position.md) REQ-one-seek-entry-point), so the
      three refusals (REQ-seeking-is-refused-in-three-states) hold and every
      relative consumer re-bases (REQ-every-relative-consumer-reacts-to-a-seek). A
      refused seek is a silent no-op: the song still loads.
    - It runs **after** `Song.apply`, not before. `set*Chain` zeroes each lane
      position but leaves `expectFirstBar` untouched, so a seek that follows also
      re-arms it — the incoming chain plays slot 0 for a *whole* bar instead of
      advancing at the next bar line.
    - It lives on the **one apply funnel** (`song-panel.applySong`, which every
      load surface already routes through for `session.setActive`) plus New,
      which deliberately does not route through it (it restores the blank
      snapshot directly). Not in `Song.apply`: that is `state/`-layer and holds
      no clock, and pushing one in would move the refusal guard out of `Engine`.
    - **It also clears the loop**, `engine.loop.clear()`, *before* the seek: a
      [loop](transport-loop.md) range is bars of the outgoing song, and the driver
      would otherwise cue a stopped transport back into it
      (REQ-turning-loop-on-moves-the-cue).
- **REQ-one-name-two-songs-ask** (v17) — A demo's name is not reserved, so a song
  saved as `1979` puts two songs under one label (the demo button and the slot
  list). `SongPanel.loadDemo(name)` checks `Song.hasSlot(name)`, a **stored** slot
  shadowing the demo, and asks which to load (`chooseDialog`, [dialog](dialog.md)
  REQ-choose-dialog-offers-several-options): *Load the demo* / *Load mine*, with a
  visible Cancel (ADR-014: no silent guess). Load-bearing details:
    - The gate sits on **`loadDemo`, the one door** all three demo sources and
      every caller share (buttons, the Load button's fallback, the guided tour,
      the empty-play hint) — so no surface can reintroduce the silent guess. The
      Load button never double-asks: `Song.loadSlot` already returned the stored
      slot, so it only reaches `loadDemo` for names with no slot.
    - **Dismissal loads nothing** (`chooseDialog` → `null`), the case a boolean
      `confirmDialog` cannot express without making Escape mean one of the songs.
    - It is a **disambiguation, not a guard** — the "loads stay confirm-free"
      rule below is intact. A demo whose name nothing shadows loads on one click,
      exactly as before, and the [Undo toast](session-autosave.md) REQ-every-destructive-apply-stashes-first still
      covers the session either way.
- **REQ-applying-a-song-is-click-free** (v23) — `apply()` writes every param
  twice (`resetDefaults()` + `restore()`) in one turn. Plain `AudioParam` writes
  collapse onto one `currentTime`, but **a subscription whose side effect is a
  graph edit runs twice, unfaded**, and a stopped transport is not silent (Stop
  stops only the sampler; drum tails and FX tails ring on). So **every structural
  edit reachable from a param write must be click-free on its own**; muting the
  master across the apply is not allowed, since it would dip a demo loaded
  mid-play. The current ones:

  | Edit | Made click-free by |
  | --- | --- |
  | `BypassWrapper.reconnect()` replays a frozen delay/convolver | [effects](effects.md) REQ-a-bypassed-effect-drains-before-disconnect — drain before disconnecting |
  | `DrumMachine.setTrackModel` disconnects a ringing voice | [drum-machine](drum-machine.md) REQ-swapping-a-model-never-severs-a-voice — ramp, then rewire |
  | `Reverb.setSize` swaps a live convolver's IR | [effects](effects.md) REQ-a-reverb-size-change-ducks — duck across the swap |
  | The FET compressor's first processed block steps | [compressor](compressor.md) REQ-a-silent-input-stays-silent — prime the DC blocker |

  A new one is a defect in *its* spec, not here.

- **REQ-a-rejected-import-is-copyable-in-full** (v24) — The **Import failed**
  alert renders the **first 8** messages and `…and N more` (the validator collects
  up to `MAX_ERRORS`, 50), and the messages exist nowhere else. So the alert
  carries a **Copy errors** button ([dialog](dialog.md) REQ-an-alert-may-offer-copyable-text) whose
  payload is built from the **error array**, not the rendered paragraph
  ([failure-report](failure-report.md) REQ-report-carries-every-message) — every message, plus the app
  version, a timestamp and the file name, so the paste stands on its own in a bug
  report. Two supporting rules:
  - The truncation line **names the button** (`…and N more — use Copy errors for
    the full list`). A copy affordance nobody notices does not solve the problem
    the truncation creates.
  - When `errors.length` reached `MAX_ERRORS` the report says so, rather than
    presenting a capped list as a complete one.

  The same affordance covers the *other* import failures — apply-threw,
  undecodable clips, a demo that would not load, a shared link that would not
  resolve — since each is equally unrecoverable once dismissed.

  A demo-load parse failure goes to `showDemoFailure(name, errors)` with the whole
  array, like `showImportErrors`. Deliberate: never reduce an error list to its
  first element before the dialog (`throw new Error(errors[0])`), or the copy
  button has nothing left to copy.

- **REQ-a-saved-song-can-be-deleted** (v28) — **A saved song can be
  deleted.** A **Delete** button
  (`song-delete`) sits after Save and acts on the slot the picker shows. It is
  enabled only when that entry **is a stored slot** (`Song.hasSlot`) — a demo is
  not yours to delete — and its `title` says why when it is not. It asks first
  (`confirmDialog`, danger) and then removes the slot; **the session is not
  touched** (nothing you hear or see in the grids changes). If the session came
  from that slot, it no longer does: the Save guard
  ([session-autosave](session-autosave.md) REQ-every-slot-write-is-guarded)
  treats the next Save of that name as a new slot, not a silent overwrite of
  something that is gone. A stored slot that shadowed a demo of the same name
  reveals the demo again.

## Technical design

### Contract / public interface

```yaml
Song:   # src/state/song.ts (a plain object of functions, not a class)
  SONG_VERSION: 9                                   # the version capture() writes (exported, not a literal)
  capture(bus, patterns, arr, name, xy?): SongFile   # writes SONG_VERSION; xy included only when passed
  apply(file, bus, patterns, arr, xyStore?, sampler?): void  # xyStore?.set(file.xy ?? XY_DEFAULT_ASSIGN);
                                                    # `sampler` is the SamplerSlots the stale-audio eviction
                                                    # in REQ-stale-sampler-audio-is-evicted needs — omit it and no eviction happens
  toJSON(file, pretty?): string                    # canonical compact: round 4 sig-figs + default-sparse cells
  fromJSON(text): SongFile | null                  # delegates to parse() — full field-level validation, then file|null
  parse(text): SongValidation                      # rich: { ok, file } | { ok:false, errors }
  download(file): void                             # files arrive as bytes: SongPanel.importFile sizes, then parses
  list(): string[]                       # JSON demo names ∪ stored slot names, sorted
                                         #   (zip demos excluded — not song files)
  saveSlot(name, file) / loadSlot(name) / deleteSlot(name)
  hasSlot(name): boolean                 # a STORED slot (demos excluded) — REQ-one-name-two-songs-ask's shadow test
  slotDiffers(file): boolean             # stored slot under file.name holds something ELSE
  planSlotSave(file, from): {name, conflict}   # from = the slot this session came from
  planImportSave(file): {name, conflict}       # = planSlotSave(file, null) — an import has none
                                         #   (session-autosave
                                         #    REQ-the-undo-net-covers-the-session/REQ-an-identical-slot-is-not-a-conflict,
                                         #    session-autosave REQ-every-slot-write-is-guarded)

song-validate:  # src/state/song-validate.ts (pure, dependency-free)
  validateSongFile(value: unknown): SongValidation
  type SongValidation = { ok: true; file: SongFile; warnings?: string[] }
                      | { ok: false; errors: string[] }   # warnings ride the ok:true branch —
                                                          # see untrusted-input.md REQ-an-unresolvable-target-warns

Arrangement:  # setSeqChain(steps, enabled, transpose?) / setDrumChain / setSamplerChain / setMotionChain
Performance:  # setFill / setStutter / setDrop / setTapeStop  (live DJ FX)
lane-mix:     # audibleLanes(mute, solo): LaneFlags   (pure)
```

### Versioning & backward-compat (the load-bearing detail)

```yaml
capture: always writes SONG_VERSION (9)
fromJSON: delegates to parse() -> expandAuthorSong + validateSongFile, so it is
          the FULL field-level check (dims, ranges, KNOWN_SONG_VERSIONS = 1..9),
          not a presence test. Every v1..v9 file still parses because each
          addition is optional — see song-file.md "Import validation".
apply (migration point):
  1. bus.resetDefaults()                 # omitted params revert to default
  2. bus.restore(file.params)
  2b. sampler?.setBuffer(i, null) for every slot this file RENAMES   # REQ-stale-sampler-audio-is-evicted.
     # Before patterns.restore, so the store's sample-meta emit repaints each
     # slot against settled buffers. A file omitting sampleNames renames nothing.
  3. patterns.restore({ seqBanks, drumBanks, samplerBanks, sampleNames,
        motionBanks/motionAssigns/motionTracks ?? emptyPatternSnapshot().<section> },
        { seq, drum, sampler, motion })   # v8 per-machine bank counts, computed ONCE here as
                                          # max(arrayLength, highestChainRef+1, MIN_BANK_COUNT)
     # absent MOTION section -> blanked, never inherited; sampler banks/names inherit
     # (buffers live in SamplerMachine; full sampler clear is New Song's job)
     # seqBanks is rebuilt to [bank][track][step] first: track 1 from seqBanks,
     # 2-4 from seqTracks when present (absent pre-v6 -> a one-track song)
  # ORDER IS LOAD-BEARING since v8: the chain setters clamp each step against the
  # machine's count, so they must run AFTER restore has resized the arrays. Reversed,
  # a big song's chain outlives its banks (banks.md REQ-an-omitted-bank-restores-blank).
  4. arr.setSeqChain(file.seqChain?.steps ?? [0], file.seqChain?.enabled ?? false,
                     file.seqTranspose ?? [])         # v7; older files -> no transpose
     arr.setDrumChain(... ?? [0], ... ?? false)
     arr.setSamplerChain(... ?? [0], ... ?? false)   # v1 files lack these -> defaults
     arr.setMotionChain(... ?? [0], ... ?? false)    # v4; older files -> defaults
  5. xyStore?.set(file.xy ?? XY_DEFAULT_ASSIGN)       # v3; older files -> default axes
patterns.restore: Object.assign(dst, TRIGGER_CELL_DEFAULTS, cell)
  # spreads defaults UNDER incoming cells, so legacy {on, velocity} cells
  # gain gate:1 / prob:1 / ratchet:1 / tie:false and sound unchanged
```

### Persistence

```yaml
file:        download() -> "<name>.websynth.json"; import: SongPanel.importFile (sized, then parse)
localStorage:
  websynth.song.<name>  : one slot (JSON)
  websynth.song.index   : JSON array of slot names
loadSlot:    falls back to a DEMO_SONGS[name] (a BUILT-IN) if no stored slot;
             sync + JSON-only, so a drop-in demo is listed but not returned —
             the Song panel Load button falls back to loadDemo for those (REQ-drop-in-demos-are-fetched-on-click)
NOT persisted: decoded AudioBuffers — only sampleNames (user reloads files;
               the UI shows a .needs-reload hint)
demos:       three sources, merged and sorted by display name by demoNames() —
             REQ-drop-in-demos-are-fetched-on-click (the source a demo comes from does not affect its position):
               JSON_DEMOS  = src/state/demos/*.json via import.meta.glob '?url',
                             fetched on click; names from src/state/demos-index.json
               DEMO_SONGS  = the one hand-authored built-in (bundled, sync)
               ZIP_DEMOS   = src/state/demos/*.websynth.zip via '?url', fetched on click
             stored canonical + pretty-printed; re-canonicalize via `npm run clean:demos`
             (auto-run by `npm run build` via prebuild) — which also regenerates
             demos-index.json; CI runs `npm run check:demos`, the same script's
             non-mutating drift check (CLEAN_DEMOS_CHECK=1), covering both
```

### Layer touchpoints & ordering (the tick constraint)

```yaml
construction (src/audio/engine.ts):
  new Arrangement(...)        # BEFORE the machines
  new StepSequencer(...); new DrumMachine(...); new SamplerMachine(...)
why: Arrangement's clock.onTick runs first, so seq/drum/samplerPlayBank are
     settled before the machines read them on the SAME tick
     (e.g. sampler-machine reads patterns.samplerBank(arrangement.samplerPlayBank))
edit-vs-play bank: a DISABLED lane's play bank tracks that machine's EDIT bank
lane mix: audibleLanes(mute, solo) — solo wins; shared by LaneMixer
          (cuts bus gain / StepSequencer.setMuted) and the panel's dim visual
ui dialogs (song-panel): Save/New/Import + the per-lane Clear route through the
          shared confirm/prompt/alert helpers (see dialog.md), NOT native
          prompt/confirm/alert. The per-lane Clear (testid chain-clear-<lane>)
          gains a "You sure?" confirm, skipped when the chain is already just [0].
          Save also guards the SLOT it lands on (session-autosave REQ-every-slot-write-is-guarded):
          confirm when a different song already holds that name, silent when it
          is the slot this session came from (sessionSlot).
load-undo safety net (see session-autosave.md): every destructive apply —
          demo buttons, Load, Import/share-link/launchQueue, and New (after its
          confirm) — stashes the outgoing session (SongFile + sampler
          AudioBuffer refs) and shows an Undo toast (song-undo-toast, toast.md).
          Loads themselves stay confirm-free by design; New keeps its danger
          confirm because it also nulls the sampler buffers. REQ-one-name-two-songs-ask's demo
          question is not an exception: it disambiguates WHICH song loads, and
          only when a stored slot shadows the demo's name.
demo persistence: loadDemo NEVER writes a slot (session-autosave REQ-a-demo-click-never-writes-a-slot) —
          applyProjectBundle(res, { persist }) is true only for real imports, so
          a zip demo now syncs the dropdown the way applyDemo always has.
playhead reset (REQ-a-load-lands-on-bar-one): applySong ends `Song.apply(...)` -> `engine.seekTo(0)`
          (AFTER apply, so the chain re-seat re-arms expectFirstBar); New does
          the same after its own restore + chain resets. Both via StudioApi,
          so transport-position.md REQ-seeking-is-refused-in-three-states's refusals are inherited, not re-stated.
```

## Visual aids

```
SongFile (JSON / localStorage slot)
   │ apply()                                   capture() │
   ▼                                                     │
ParamBus.restore ── PatternStore.restore ── Arrangement.set*Chain
   (params)            (all four machines)       (4 chain lanes)
                                                     │ per bar
                                                     ▼
                              play banks ─► Sequencer / Drums / Sampler / Motion
                                                     │ (mute/solo via audibleLanes)
                                                     ▼  + Performance live DJ FX
                                                  audio out
```

## Scenarios (BDD)

```gherkin
Scenario: A saved song is deleted after a confirm (v28, REQ-a-saved-song-can-be-deleted)
  Given a saved song "Jam" selected in the slot picker
  When Delete is pressed and confirmed
  Then "Jam" is no longer stored and leaves the picker
  And the session (params, patterns, chains) is unchanged
  When a built-in demo is selected
  Then Delete is disabled and its title says demos cannot be deleted
# pinned by: e2e/song.spec.ts

Scenario: Round-trip a song through a slot
  Given an edited song
  When the user saves it to a slot, starts a new song, then loads the slot
  Then params, all banks, and all four chains match the saved song
# pinned by: tests/state/song.test.ts, e2e/song.spec.ts

Scenario: Save/New use the custom dialog, not a native prompt/confirm
  Given the Song tab
  When the user clicks Save, types a name in dialog-input and clicks dialog-confirm
  Then the song is saved under that name
  And clicking New then dialog-confirm clears all banks and chains
# pinned by: e2e/song.spec.ts

Scenario: Destructive applies offer a toast Undo (session-autosave.md REQ-every-destructive-apply-stashes-first)
  Given an in-progress session
  When the user clicks a demo button, Load, Import, or confirms New
  Then the new state applies without any extra prompt (New's confirm excepted)
  And a toast (song-undo-toast) offers Undo, which restores the prior session
    including the sampler's decoded buffers
# pinned by: e2e/session.spec.ts

Scenario: Loading a song returns the playhead to bar 1 (REQ-a-load-lands-on-bar-one, regression)
  Given the playhead has been moved to bar 5 of an 8-bar chain
  When the user clicks a demo button (or Load, or Import)
  Then the transport readout reads 1.01 and clock.cue is 0
  And the chain's first bar plays slot 0 in full — the next bar line advances it
    by exactly one
# pinned by: e2e/song.spec.ts

Scenario: New Song returns the playhead to bar 1 (REQ-a-load-lands-on-bar-one, regression)
  Given the playhead has been moved to bar 5 and the chains are several bars long
  When the user confirms New
  Then the readout reads 1.01 — not the bar count remembered from the cleared song,
    which the one-cell scrubber beside it no longer has
# pinned by: e2e/song.spec.ts

Scenario: Loading a song clears the transport loop (v26, REQ-a-load-lands-on-bar-one)
  Given Loop is on with a range picked
  When a demo is loaded
  Then Loop is off, no range is remembered, and the readout reads 1.01
# pinned by: e2e/transport-loop.spec.ts

Scenario: A load while seeking is refused still loads (REQ-a-load-lands-on-bar-one, edge)
  Given the song recorder is capturing (seekTo returns false)
  When a song is applied
  Then the song applies normally and the refused seek is a silent no-op
# pinned by: tests/ui/transport-controls.test.ts (the refusal contract)

Scenario: Clearing a lane chain asks for confirmation first
  Given a lane chain with several steps
  When the user clicks that lane's Clear button
  Then a confirm dialog appears; confirming resets the chain to a single step and
    cancelling leaves it unchanged
# pinned by: e2e/song.spec.ts

Scenario: A load's structural edits are each click-free (REQ-applying-a-song-is-click-free, v23)
  Given a song is playing and stopped, leaving a drum tail and an FX tail ringing
  When a demo is loaded, so every param is written twice in one turn
  Then no graph edit the writes trigger is heard: no severed tail, no burst of the
    previous song out of a delay line that was frozen while bypassed
   And the master is NOT muted across the apply — a demo loaded mid-play must not dip
# pinned by: tests/audio/effects/bypass.test.ts,
#            tests/audio/drums/drum-machine-model.test.ts,
#            tests/audio/compressor-worklet.test.ts
# by ear: specs/recipes/verify-audio-by-ear.md — the only real verification (ADR-010)

Scenario: Loading a song repaints the UI without marking it edited
  Given a per-param subscriber on transport.bpm and a global onChange listener
  When apply() loads a song whose bpm differs from the current value
  Then the per-param subscriber receives the new bpm (audio + UI repaint via the
    same `subscribe` channel — there is no explicit "repaint" call)
  And onChange never fires, so the load is not seen as an edit (session stays clean)
# pinned by: tests/state/song.test.ts
# see: architecture.md → "Event flow / propagation"

Scenario: Loading a no-motion song clears the previous song's motion (REQ-apply-resets-to-defaults-first, regression)
  Given a store already holding a song with motion banks, tracks and assigns
  When apply() loads a song whose file omits the motion sections (e.g. a v1 file)
  Then every motion section (banks, tracks, assigns) is blank/default — the prior
    song's motion is not inherited, and nothing is still automated
  And sampler banks/names still inherit (the deliberate exception, REQ-apply-resets-to-defaults-first)
  And no sampler buffer is evicted — an omitted section changes no name (REQ-stale-sampler-audio-is-evicted)
# pinned by: tests/state/song.test.ts

Scenario: Loading a song evicts audio the new song does not name (REQ-stale-sampler-audio-is-evicted, regression)
  Given slot 0 holds a loaded "beep.wav" buffer
  When apply() loads a song whose sampleNames give slot 0 a different name (or none)
  Then slot 0's buffer is nulled, so the label can never claim audio it isn't playing
  And a slot whose name is unchanged keeps its buffer (reloading the same song
    does not force the user to re-pick the file)
# pinned by: tests/state/song.test.ts, e2e/song.spec.ts

Scenario: Solo overrides mute (lane mixer)
  Given the drum lane is muted and the seq lane is soloed
  Then only the seq lane is audible
# pinned by: tests/audio/transport/lane-mix.test.ts, e2e/song-mixer.spec.ts

Scenario: Stale param reverts on load (failure guard)
  Given param P was edited live but the loaded song omits P
  When apply() runs
  Then P returns to its registered default (resetDefaults precedes restore)
# pinned by: tests/state/song.test.ts

Scenario: A rejected import copies every error, not the eight shown (v24, REQ-a-rejected-import-is-copyable-in-full)
  Given an import whose validation produced more errors than the dialog renders
  When the user clicks Copy errors on the Import failed dialog
  Then the clipboard holds messages the dialog never displayed
  And the truncation line told the user that button existed
# pinned by: e2e/song-link.spec.ts, tests/ui/failure-report.test.ts

Scenario: A demo that fails to parse reports every error (v25, REQ-a-rejected-import-is-copyable-in-full)
  Given a demo file whose validation produced several messages
  When the demo is clicked and the load fails
  Then the dialog's copy report holds all of them, not only the first
# not pinned: reaching it needs a failing fetch inside a fully built song panel,
# which has no unit harness. The reduction it removes is pinned one level down by
# tests/ui/failure-report.test.ts ("carries every message").

Scenario: A drop-in demo keeps its own name as its button label (REQ-drop-in-demos-are-fetched-on-click)
  Given the drop-ins are referenced by url, not imported
  Then JSON_DEMOS lists them under the names inside the files, not their filenames
  And the demo row renders exactly that library, each drop-in labelled from the index
# pinned by: tests/state/song.test.ts, e2e/song.spec.ts

Scenario: The shelf reads alphabetically, whatever a demo is made of (v20, REQ-drop-in-demos-are-fetched-on-click)
  Given the three demo sources
  Then demoNames() is sorted by display name, not grouped by source
  And every project-zip demo sits where its name puts it, not at the end
  And Song.list() orders the slot picker with the same comparator
# pinned by: tests/state/song.test.ts, e2e/demo-library.spec.ts

Scenario: A stale demo index fails CI (REQ-drop-in-demos-are-fetched-on-click, drift gate)
  Given a demo whose song name no longer matches src/state/demos-index.json
  When `npm run check:demos` runs
  Then it fails, naming demos-index.json
# pinned by: scripts/clean-demos.ts (CLEAN_DEMOS_CHECK=1)

Scenario: Clicking a drop-in demo fetches and applies it (REQ-drop-in-demos-are-fetched-on-click)
  Given a drop-in demo button
  When it is clicked
  Then the song is fetched, validated by Song.parse, applied, and the slot dropdown syncs
  And a fetch or validation failure surfaces in the demo-failed dialog
# pinned by: e2e/song.spec.ts

Scenario: A demo name no source owns falls back to the first demo (v18, REQ-drop-in-demos-are-fetched-on-click)
  Given a name no demo source owns — the tour's demo was renamed or deleted
  When loadDemo runs with it
  Then resolveDemoName returns demoNames()[0] and that song loads, not nothing
  And the REQ-one-name-two-songs-ask question, if any, is asked about the resolved name
  But the Load button's slot fallthrough stays strict (isDemoName), so a slot
      deleted in another tab loads nothing rather than an unrelated song
# pinned by: tests/state/song.test.ts

Scenario: A demo whose name you have saved asks which one (v17, REQ-one-name-two-songs-ask)
  Given a stored slot whose name a demo button also carries
  When they click that demo button
  Then a choice dialog offers "Load the demo" and "Load mine", naming the song
  And choosing "Load mine" applies the stored slot, not the demo
  And choosing "Load the demo" applies the demo, leaving the slot untouched
  And dismissing it (Escape, backdrop, or Cancel) loads neither
# pinned by: e2e/song.spec.ts

Scenario: An unshadowed demo still loads on one click (v17, REQ-one-name-two-songs-ask, boundary)
  Given no stored slot shares the demo's name
  When the demo button is clicked
  Then it loads immediately with no dialog — hasSlot(), not list(), decides,
       so a name that is only a demo never asks
# pinned by: e2e/song.spec.ts (every other demo test in the file is this case)

Scenario: Sync leads Audio, and they share a row on a wide screen (UI, v13)
  Given the Song tab is open at 1440px wide
  Then the Sync row and the Audio row sit on one line, Sync left and Audio right
  When the viewport narrows to 1024px
  Then they stack, Sync above Audio, each with its own dashed rule
# pinned by: e2e/song.spec.ts

Scenario: Demo row overflow hides behind an All Demos toggle (UI, v6/v12)
  Given more than DEMO_ROW_LIMIT (10) demos are registered
  When the Song panel renders
  Then only the first 10 demo buttons are visible plus an "All Demos" toggle
   And clicking the toggle reveals the remaining demo buttons (and flips to "Less")
   And clicking it again re-collapses them, so it is a toggle either way
   And a hidden demo button, once revealed, loads its demo like any other
# pinned by: e2e/song.spec.ts

Scenario: With no overflow there is no toggle (REQ-the-demo-row-overflows-into-a-menu, boundary)
  Given DEMO_ROW_LIMIT or fewer demos are registered
  Then every demo button is visible and no "All Demos" toggle is rendered
# pinned by: e2e/song.spec.ts
```

## Tests & verification

- Unit (pure): `tests/state/song.test.ts` (round-trip, slot CRUD, v1/v2 apply,
  demo applies), `tests/state/serialize.test.ts` (rounding + default-sparse cells +
  canonical round-trip), `tests/state/song-validate.test.ts` (accepts v1/v2 + every demo,
  rejects malformed input with path-prefixed messages, schema file well-formed),
  `tests/state/patterns.test.ts`,
  `tests/audio/transport/arrangement.test.ts`,
  `tests/audio/transport/lane-mix.test.ts`,
  `tests/audio/transport/sampler-machine.test.ts`,
  `tests/audio/transport/performance.test.ts`.
- E2E: `e2e/song.spec.ts`, `e2e/song-fx.spec.ts`, `e2e/song-mixer.spec.ts` —
  `npm test` / `npm run e2e`.

## Open questions / future

- A future `version: 10` must keep new fields **optional** and extend the
  `apply()` defaults-fallback the same way (ADR-007). The full checklist for a bump
  is [evolve-the-song-format](../recipes/evolve-the-song-format.md);
  `KNOWN_SONG_VERSIONS` is derived as `1..SONG_VERSION` (`src/state/song-version.ts`),
  and `tests/state/authoring-docs.test.ts` fails if the schema or `llms.txt` is left
  behind.
