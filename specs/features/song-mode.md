# Song mode (cross-cutting integration)

```yaml
id: song-mode
status: implemented
version: 22  # v22: REQ-12 — one hand-authored built-in, not two: the "Zombie
             #      Nation" demo is gone and "I Feel Love" is now "Mordor"
             # v21: step cells carry the optional `micro` notch count — additive,
             #      default 0, dropped when default, so no SongFile version bump
             #      (step-settings.md REQ-6)
             # v20: REQ-12 — demoNames() is one alphabetical list by display name,
             #      so the project zips stop being pinned to the end of the shelf
             # v19: REQ-2/REQ-16 — SongFile v7 adds the optional per-slot
             #      `seqTranspose`, so one bank can carry a progression
             # v18: REQ-12 — loadDemo resolves an unknown name to the first demo
             #      instead of returning silently, so renaming or deleting a demo
             #      cannot leave a caller (the tour) staring at nothing
             # v17: REQ-15 — a demo whose name a saved slot shadows asks which of
             #      the two songs was meant (demo clicks no longer write slots —
             #      session-autosave REQ-14d)
             # v16: REQ-8 bounds magnitude, not just shape — note 0..127, chain
             #      length, param-key count, reserved keys (untrusted-input, ADR-015)
             # v15: the Audio row's two buttons open surfaces instead of writing
             #      files; its Format is now the global default (REQ-13 note)
             # v14: every load — and New — returns the playhead to bar 1 (REQ-14)
             # v13: Sync then Audio, sharing one row above 1280px (REQ-13)
             # v12: DEMO_ROW_LIMIT 6 -> 10 (REQ-10) — 6 hid two thirds of 17 demos
             # v11: drop-in demos fetched on click, not bundled (REQ-12)
             # v10: apply() evicts stale sampler audio (REQ-3b)
owner: core
related:
  - architecture
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
  - untrusted-input      # REQ-8: a song is an untrusted document; the limits live there
  - transport-position   # REQ-14: the seek contract a load reuses
  - transport-window     # REQ-14: the readout/scrubber a stale position contradicts
  - runtime-performance   # REQ-1: boot pays only for what the user asks for
  - pwa-install           # offline behaviour of the fetched-on-click demos
source:
  - src/state/song.ts                         # capture/apply/persist + demos + parse
  - src/state/demos-index.json                # generated filename -> song name (REQ-12)
  - scripts/clean-demos.ts                    # canonicalizer + index generator + drift gate
  - src/state/serialize.ts                    # compactSongForExport (round + default-sparse)
  - src/state/song-validate.ts                # validateSongFile (import validation)
  - public/schema/websynth-song.schema.json   # machine-readable JSON Schema (shipped)
  - src/state/patterns.ts                     # banks + restore (migration)
  - src/audio/transport/arrangement.ts        # 3 chain lanes
  - src/audio/transport/performance.ts        # live DJ FX
  - src/audio/transport/lane-mix.ts           # audibleLanes (pure mute/solo rule)
  - src/audio/transport/sampler-machine.ts    # sampler lane playback
  - src/ui/panels/song-panel.ts               # the Song tab
```

The big integration feature. It exercises almost every layer — scalar params (via
`ParamBus.snapshot`), non-scalar grid state (`PatternStore`), the arrangement
chains, live performance FX, the lane mixer, and persistence — and it carries the
repo's most important **versioning + backward-compatibility** contract. It is the
best stress test of the spec format.

## Background / Why

Song mode turns the synth from a live instrument into an arranger: 4 banks each of
sequencer / drum / sampler / motion patterns, ordered into per-lane **chains**,
played back bar-by-bar, with live DJ FX and a per-lane mixer on top. A whole song
(params + all banks + all four chains) is captured into one portable JSON file and
into `localStorage` slots. Because song files are saved by users and shipped as
demos, the load path **must stay backward compatible** as the format grows.

## Requirements

- **REQ-1** — A song captures the full bus snapshot + all seq/drum/sampler/motion
  banks + all four chain lanes into one `SongFile`.
- **REQ-2** — `SongFile` is a **versioned union** (`version: 1 | … | 7`);
  v2 adds optional sampler fields, v3 adds the optional [XY Pad](xy-pad.md) axis
  assignment (`xy`), v4 adds the optional
  [motion sequencer](motion-sequencer.md) fields
  (`motionBanks`/`motionAssigns`/`motionChain`), v5 the optional `motionTracks`
  (motion's two extra single-param tracks) and v6 the optional `seqTracks`
  ([sequencer](sequencer.md) tracks 2–4), and v7 the optional `seqTranspose`
  (REQ-16). Older files (incl. built-in demos) must
  still load. The version `capture()` writes is the exported **`SONG_VERSION`**
  constant, not a literal — the published schema and `llms.txt` are pinned to it
  by `tests/state/authoring-docs.test.ts`, which is what stops the shipped docs
  silently falling a version behind (they did, twice, before v9 of this spec).
- **REQ-3** — `apply()` is authoritative: it **resets params to defaults first**
  (a stale param omitted by an older file reverts rather than lingering), the four
  chains and the XY axes fall back to their defaults, and — the fix this REQ pins —
  the **motion** sections (banks / assigns / tracks) a file omits are **blanked**,
  never inherited from the previously-loaded song. Loading a no-motion song after a
  motion song used to leave the old anchors/tracks automating; `apply` now coalesces
  each absent motion section against the shared blank (`emptyPatternSnapshot()`, the
  same complete-blank source New Song restores from, so an authoritative clear can't
  drift between the two paths). **Sampler** banks/names are the deliberate exception:
  they inherit across a load, because the sampler's decoded buffers live in
  `SamplerMachine` (out of reach of `apply`) and blanking the metadata alone would
  orphan them — a full sampler clear (metadata **and** buffers) is New Song's job.
  `resetDefaults()`+`restore()` also replaces every knob **reset baseline** with the
  song's values (see [param-reset-baseline](param-reset-baseline.md)); Save-song
  marks it too.
- **REQ-3b** — **Stale sampler audio is evicted.** A slot's decoded buffer
  belongs to the *name* beside it, so when an incoming file **supplies**
  `sampleNames` and a slot's name changes, that slot's buffer is nulled — via
  the optional narrow `sampler` handle (`{ setBuffer }`) `apply` now takes,
  before `patterns.restore` runs so the store's own meta emit repaints the slot
  correctly. Without it, loading song B left song A's audio playing under B's
  labels: a slot could read "kick.wav" with no `.needs-reload` hint while
  sounding like something else entirely. The REQ-3 inherit exception is
  untouched: a file that **omits** `sampleNames` (a v1 file) changes no name, so
  nothing is evicted. Callers that hold a sampler pass it (`song-panel.applySong`,
  the app.ts demo fallback, the boot restore); omitting it keeps the old
  inherit-everything behaviour, which is what unit tests without an audio graph
  want.
- **REQ-4** — Legacy step cells (plain `{on, velocity}`) must load and **sound
  unchanged** (gain defaults filled in).
- **REQ-5** — Decoded audio is **never embedded in the `.json`**; only sampler
  filenames persist and the user reloads files after import. The
  [project zip](project-export.md) embeds clips *alongside* an unchanged
  `song.json` — the song format itself stays audio-free.
- **REQ-6** — Mute/solo audibility follows one shared pure rule (solo wins over
  mute), used by both the engine and the UI.
- **REQ-7** — Play banks must be settled **before** the machines read them on a
  given tick (construction ordering).
- **REQ-8** — An imported file is **validated** before it is applied. Validation is
  hand-rolled (no runtime dependency, per ADR-003) and **mirrors the additive loader
  contract**: strict on types / structure / ranges / dimensions, but lenient on the
  optional per-step fields (so legacy v1 files still pass). A rejection surfaces
  **field-level, path-prefixed** messages, not one generic error. A
  machine-readable JSON Schema (draft 2020-12) ships at
  `/schema/websynth-song.schema.json` as the published contract for external tools.
  Leniency is about **shape, never magnitude** ([untrusted-input](untrusted-input.md),
  ADR-015): `SeqStep.note` is an integer `0..127` (matching the dialect, which
  already enforced it), `chainData.steps` is `1..MAX_CHAIN_STEPS`, `params`
  carries at most `MAX_PARAM_KEYS` keys, and a `__proto__` / `constructor` /
  `prototype` key is refused outright. A song is an untrusted document — an
  unbounded `note` reached `midiToHz` as `Infinity` and wedged the transport
  through a throwing `AudioParam` write.
- **REQ-9** — Serialization is **optimized at the boundary** (`toJSON`), never in
  live state: numbers round to 4 significant figures and cells are written
  **default-sparse**, producing the *canonical compact* form. The output must still
  `apply()` to identical-sounding state (rounding is inaudible; sparse cells re-expand
  via `restore`). See [ADR-011](../decisions/adr-011-export-precision-and-default-sparse-serialization.md).
- **REQ-10** (demo row overflow, v6; limit raised in v12) — The Song panel's demo
  row shows at most `DEMO_ROW_LIMIT` (**10**) demo buttons inline; any further
  demos (JSON drop-ins, built-ins and zip demos alike, in their usual order) hide
  behind an **"All Demos"** toggle button (testid `song-demo-more`) that
  expands/collapses them in place (label flips to "Less" while open). With
  ≤ `DEMO_ROW_LIMIT` demos the toggle is absent. `SongPanel.loadDemo(name)` (used
  by the guided tour) keeps working for hidden demos — visibility only affects
  the buttons. Loading a demo — like every song load/import — also fires
  `UiBridge.cuePlay` (see [play-button-blink](play-button-blink.md)).
  The limit was 6, which hid most of a growing library behind a click. The row is
  a wrapping flex (`.io`), so the only cost of a higher limit is horizontal
  space, and 10 is what fits a desktop row before wrapping.

  **Which** demos fall into the overflow is a function of the library's size and
  filename order — i.e. of data. A test may therefore assert the *rule* (at most
  10 inline, the rest behind the toggle, both directions) but never that a named
  demo is hidden; see [write-a-test](../recipes/write-a-test.md).
- **REQ-11** (lane titles navigate, v8) — Each lane card's title is a button
  (testid `song-lane-title-<seq|drum|sampler|motion>`) that opens that machine's
  tab, and the tab bar carries a per-machine status LED. Both are governed by
  [machine-status](machine-status.md); note the lane prefix `drum` maps to the tab
  id `drums`. The card's existing silenced-dimming (REQ-6) is unchanged — it still
  keys off audibility only, never off `<machine>.on`.
- **REQ-12** (drop-in demos are fetched on click, v11) — There are **three** demo
  sources and `SongPanel.loadDemo(name)` dispatches across all of them:
  - `DEMO_SONGS` — the one hand-authored built-in, **Mordor**. Bundled,
    **synchronous**, because callers depend on that: `Song.loadSlot` falls back
    to it, and `ai-prompt.ts` renders `DEMO_SONGS['Mordor']` as its worked
    example.
  - `JSON_DEMOS` — the `src/state/demos/*.json` drop-ins, as `{name, url}`.
    **Fetched on click** and parsed through the same `Song.parse` the Import
    button uses, so a corrupt drop-in reports what is actually wrong with it.
  - `ZIP_DEMOS` — the project bundles, unchanged (REQ-7 in
    [project-export](project-export.md)).

  Eagerly importing the drop-ins put **835 kB of JSON — a 227 kB JS chunk — into
  the boot payload of every visitor**, parsed as object literals and held
  resident for the lifetime of the page, so that the user could load *at most
  one*. That is [runtime-performance](runtime-performance.md) REQ-1 in its purest
  form, and the `?url` treatment `ZIP_DEMOS` always had is the fix.

  The cost of `?url` is that a song's own `name` is no longer readable at build
  time, and filenames will not do — `hacienda_neworder.json` is "Haçienda". So
  `src/state/demos-index.json` (`filename → name`) is generated by
  `scripts/clean-demos.ts`, the pass that already parses every demo, and checked
  by `npm run check:demos` in CI: a renamed demo cannot ship with a stale label.
  `demoNames()` is the single source of button order, shared by the demo row, the
  tour fallback and the empty-play random pick.

  **Button order is one alphabetical list (v20).** It used to be the three
  sources concatenated in source order, each sorted by *filename*. That leaked
  two implementation facts into the shelf: the project zips always sat last —
  `1973`, the library's most feature-complete demo, was pushed past
  `DEMO_ROW_LIMIT` into the "All Demos" fold purely for being a `.zip` — and the
  filename key mis-filed anything whose label differs from its file, so
  "Haçienda" sorted under `h` and "Apex Twin" landed after "Tosti". Which of the
  three sources a demo comes from is a loading detail the listener has no way to
  see and no reason to care about. So the merged list is sorted by **display
  name** with `localeCompare(…, { sensitivity: 'base', numeric: true })` —
  `numeric` so `1973 · 1979 · 1983 · 1985-1 · 1985-2` read as numbers rather than
  lexically, `sensitivity: 'base'` so accents file under their base letter.
  `Song.list()` (the slot picker) uses the same comparator, so the two lists
  cannot disagree about where a name sits.

  **Name resolution (v18).** A demo name is *data* — `src/state/demos/**` is a
  drop-in directory anyone may add to, rename in or delete from without touching
  code. But callers name one: the guided tour applies `DEMO_FOR_TOUR` by string
  constant. `loadDemo` used to try the three sources and **return silently** when
  none owned the name, so renaming that one file turned the tour's headline step
  into a no-op followed by a "the transport is now playing" step over silence.
  So `resolveDemoName(name)` (in `song.ts`, beside the sources it consults)
  returns the name when a source owns it and otherwise **the first name in
  `demoNames()`** — a missing demo degrades to a real song rather than to nothing.
  It returns `undefined` only for an empty library. `loadDemo` resolves *before*
  asking the REQ-15 shadow question, so the dialog can never name a song other
  than the one about to load.

  The one caller that must **not** fall back is the Load button's fallthrough for
  a slot-picker entry `loadSlot` could not return (`isDemoName` guards it). Every
  entry there is a stored slot or a drop-in, so the branch is reachable only when
  a slot is deleted in another tab mid-click — and loading an unrelated song is a
  worse answer to that race than doing nothing. The demo buttons, the tour and the
  empty-play random pick all take the fallback.

  Offline (see [pwa-install](pwa-install.md)): a demo not yet clicked is not in
  the cache, exactly as for the zip demos — one clicked once is, since the
  service worker is cache-first for hashed `/assets/*`.

  Validation coverage moved rather than vanished: nothing in the app parses a
  drop-in until a user clicks it, so `tests/state/demo-files.ts` eagerly globs
  them for the **test** bundle and every one is still asserted against
  `validateSongFile`.

  E2E reaches the same library a third way. Playwright runs in plain Node with no
  Vite, so `song.ts`'s globs are not evaluable there: `e2e/helpers.ts` reads
  `demos-index.json` and `readdirSync`s `src/state/demos/` instead, mirroring the
  registration rules, and derives the built-ins as (rendered buttons − drop-ins −
  zips). A stale index therefore fails E2E loudly, naming `npm run clean:demos`.
- **REQ-13** (Sync and Audio pair up, v13) — The panel's last two rows are
  **Sync** then **Audio**, in that order: Audio export is the tab's terminal
  action (render the finished thing), so it reads last, while Sync is setup that
  belongs with the transport rows above it.
  Above **1280 px** — the boundary the rest of the panel already uses — the two
  **share one row**, `justify-content: space-between`, Sync pinned to the left
  edge and Audio to the right. Both are short rows, so two of them were spending
  a whole row of height on air.
  Mechanism: one `.ioPair` wrapper that is `display: contents` at ≤ 1280 px, so
  each `.io` is a `.panel` flex item with its own dashed rule exactly as before
  and the DOM order *is* the stacked order. Above the breakpoint the wrapper
  becomes the flex row and takes over the single dashed rule from its two halves.
  `display: contents` has precedent in this module (`.demoOverflow.demoOpen`).
  (v15) The Audio row's **contents** changed with
  [audio-export](audio-export.md) v7 — its `Format:` segmented is now the *global
  default* seeding the export modal and the [Record window](record-window.md),
  and its two buttons open those surfaces rather than writing files — but its
  shape, position and pairing behaviour are untouched, and `song-export-audio`
  remains the probe this REQ's layout scenario measures.
- **REQ-14** (a load lands on bar 1, v14) — **Every path that replaces the song
  returns the playhead to the top**: the demo buttons, Load, Import / Paste /
  share link / PWA file-launch, the Undo toast's restore, and **New**. A song
  carries no playhead — the cue is transient by design
  ([transport-position](transport-position.md) → *Persistence*) — so with no
  reset the incoming song silently inherits the outgoing one's position *and*
  cue. Both halves were visibly wrong: New'ing a 37-bar song down to a blank one
  left the readout reading `5.01` beside a single scrubber cell (a bar that no
  longer exists — [transport-window](transport-window.md) REQ-6), and a demo
  clicked mid-play started from wherever the previous arrangement happened to
  have reached.
  Three details are load-bearing:
    - It goes through **`StudioApi.seekTo(0)`**, never `clock.seek` — the one
      entry point ([transport-position](transport-position.md) REQ-8), so the
      three refusals (slaved / exporting / rendering, REQ-6 there) still hold and
      all four relative-position consumers re-base (REQ-4 there). A refused seek
      stays a silent no-op: the song still loads.
    - It runs **after** `Song.apply`, not before. `set*Chain` zeroes each lane
      position but leaves `expectFirstBar` untouched, so a seek that follows also
      re-arms it — the incoming chain plays slot 0 for a *whole* bar instead of
      advancing at the next bar line.
    - It lives on the **one apply funnel** (`song-panel.applySong`, which every
      load surface already routes through for `session.setActive`) plus New,
      which deliberately does not route through it (it restores the blank
      snapshot directly). Not in `Song.apply`: that is `state/`-layer and holds
      no clock, and pushing one in would move the refusal guard out of `Engine`.
- **REQ-15** (one name, two songs — ask, v17) — A demo's name is not reserved:
  saving your own song as `1979` leaves the **demo button** and the **slot list**
  offering two different songs under one label, and each door silently picked its
  own (`loadSlot` prefers the stored slot, a demo button always fetched the demo).
  Nothing was destroyed — [session-autosave](session-autosave.md) REQ-14d stops
  demo clicks writing slots at all — but the user could not say which `1979` they
  meant, and the two controls disagreeing under one name is the kind of guess
  [ADR-014](../decisions/adr-014-dont-make-me-think.md) forbids.
  `SongPanel.loadDemo(name)` therefore checks `Song.hasSlot(name)` — a **stored**
  slot shadowing this demo — and, when one exists, asks which to load
  (`chooseDialog`, [dialog](dialog.md) REQ-8): *Load the demo* / *Load mine*, with
  a visible Cancel. Load-bearing details:
    - The gate sits on **`loadDemo`, the one door** all three demo sources and
      every caller share (buttons, the Load button's fallback, the guided tour,
      the empty-play hint) — so no surface can reintroduce the silent guess. The
      Load button never double-asks: `Song.loadSlot` already returned the stored
      slot, so it only reaches `loadDemo` for names with no slot.
    - **Dismissal loads nothing** (`chooseDialog` → `null`). This is the case
      `confirmDialog` could not express, and it is why REQ-8 exists: with a
      boolean, Escape would have had to *mean* one of the two songs.
    - It is a **disambiguation, not a guard** — the "loads stay confirm-free"
      rule below is intact. A demo whose name nothing shadows loads on one click,
      exactly as before, and the [Undo toast](session-autosave.md) REQ-7 still
      covers the session either way.
- **REQ-16** (SongFile v7 — per-slot transpose, v19) — v7 adds one optional
  top-level field, `seqTranspose: number[]`, the semitone offset of each
  `seqChain` slot ([arrangement](arrangement.md) REQ-8).

  It is a **sibling of `seqChain`, not a field inside it**, and that is the whole
  design: `ChainData` keeps its exact `{enabled, steps}` shape, so `cloneChain`,
  `checkChain`, `expandChain` and every existing reader are untouched, and a v1–v6
  file round-trips through `compactSongForExport` **byte-identically** — which
  `npm run check:demos` enforces across every shipped demo in `src/state/demos/`
  (16 `.json` + 2 `.websynth.zip` at the time of writing).

  Serialization follows the `seqTracks` precedent (REQ-2): the field is **omitted
  entirely when every offset is 0**, so a song that does not transpose serializes
  exactly as it did before v7 and `SONG_VERSION`'s floor logic
  ([song-authoring-dialect](song-authoring-dialect.md) REQ-12) keeps emitting 6 or
  lower for it. `apply()` defaults it to all-zeros, per REQ-3's
  reset-then-restore contract, so a pre-v7 file plays exactly as written.

## Technical design

### Contract / public interface

```yaml
Song:   # src/state/song.ts (a plain object of functions, not a class)
  SONG_VERSION: 7                                   # the version capture() writes (exported, not a literal)
  capture(bus, patterns, arr, name, xy?): SongFile   # writes SONG_VERSION; xy included only when passed
  apply(file, bus, patterns, arr, xyStore?, sampler?): void  # xyStore?.set(file.xy ?? XY_DEFAULT_ASSIGN);
                                                    # `sampler` is the SamplerSlots the stale-audio eviction
                                                    # in REQ-3b needs — omit it and no eviction happens
  toJSON(file, pretty?): string                    # canonical compact: round 4 sig-figs + default-sparse cells
  fromJSON(text): SongFile | null                  # delegates to parse() — full field-level validation, then file|null
  parse(text): SongValidation                      # rich: { ok, file } | { ok:false, errors }
  download(file) / readFile(File): Promise<SongFile | null>
  parseFile(File): Promise<SongValidation>         # rich variant for the import UI
  list(): string[]                       # JSON demo names ∪ stored slot names, sorted
                                         #   (zip demos excluded — not song files)
  saveSlot(name, file) / loadSlot(name) / deleteSlot(name)
  hasSlot(name): boolean                 # a STORED slot (demos excluded) — REQ-15's shadow test
  slotDiffers(file): boolean             # stored slot under file.name holds something ELSE
  planSlotSave(file, from): {name, conflict}   # from = the slot this session came from
  planImportSave(file): {name, conflict}       # = planSlotSave(file, null) — an import has none
                                         #   (session-autosave REQ-14/14b/14c)

song-validate:  # src/state/song-validate.ts (pure, dependency-free)
  validateSongFile(value: unknown): SongValidation
  type SongValidation = { ok: true; file: SongFile; warnings?: string[] }
                      | { ok: false; errors: string[] }   # warnings ride the ok:true branch —
                                                          # see untrusted-input.md REQ-12

Arrangement:  # setSeqChain(steps, enabled, transpose?) / setDrumChain / setSamplerChain / setMotionChain
Performance:  # setFill / setStutter / setDrop / setTapeStop  (live DJ FX)
lane-mix:     # audibleLanes(mute, solo): LaneFlags   (pure)
```

### Data shapes (the persistence schema)

Nested beyond ~3 levels, so as flat YAML:

```yaml
SongFile:
  format: 'websynth-song'            # required discriminator
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7
  name: string
  params: Record<string, number>     # = ParamBus.snapshot()
  seqBanks:  SeqStep[][]             # 4 banks × 16 steps — since v6 this is TRACK 1 only
  drumBanks: DrumCell[][][]          # 4 banks × 8 tracks × 16 steps
  seqChain:  ChainData
  drumChain: ChainData
  # ---- v2 additions (optional, so v1 files still parse) ----
  samplerBanks?: SamplerStep[][][]   # 4 banks × 8 slots × 16 steps
  samplerChain?: ChainData
  sampleNames?: (string | null)[]    # filenames ONLY — audio is not embedded
  # ---- v3 addition (optional, so v1/v2 files still parse) ----
  xy?: { x: string; y: string }      # XY Pad axis assignment (ParamBus ids) — see xy-pad.md
  # ---- v4 additions (optional, so v1-v3 files still parse) ----
  motionBanks?: MotionStep[][]       # 4 banks × 16 steps of {on, x, y} anchors — see motion-sequencer.md
  motionAssigns?: (MotionAssign | null)[]  # per-bank axis override; null = inherit xy
  motionChain?: ChainData
  # ---- v5 addition (optional, so v1-v4 files still parse) ----
  motionTracks?: (MotionTrack | null)[][]  # 4 banks × 2 extra single-param tracks — see motion-sequencer.md
  # ---- v6 addition (optional, so v1-v5 files still parse) ----
  seqTracks?: (SeqStep[] | null)[][]  # [bank][track], indexed by the REAL track number:
                                      # index 0 is ALWAYS null (track 1 stays in seqBanks) and an
                                      # empty track is null. Omitted entirely when no extra track
                                      # holds a step, so a one-track song stays byte-identical to
                                      # its pre-v6 form — see sequencer.md REQ-13.
  # ---- v7 addition (optional, so v1-v6 files still parse) ----
  seqTranspose?: number[]             # per-seq-chain-slot semitone offset, parallel to seqChain.steps.
                                      # A sidecar array rather than a field on ChainData, so ChainData
                                      # keeps its shape and every v1-v6 file round-trips byte-identically.
                                      # Omitted when every offset is 0 — see arrangement.md REQ-16.

ChainData:
  enabled: boolean
  steps: number[]                    # ordered bank indices, one advance per bar
```

`SeqStep` / `DrumCell` / `SamplerStep` are defined in
[`architecture.md`](../architecture.md) (StepSettings + `on` [+ `note`]).

### Versioning & backward-compat (the load-bearing detail)

```yaml
capture: always writes SONG_VERSION (7)
fromJSON: delegates to parse() -> expandAuthorSong + validateSongFile, so it is
          the FULL field-level check (dims, ranges, KNOWN_SONG_VERSIONS = 1..7),
          not a presence test. Every v1..v7 file still parses because each
          addition is optional — see "Import validation" below.
apply (migration point):
  1. bus.resetDefaults()                 # omitted params revert to default
  2. bus.restore(file.params)
  2b. sampler?.setBuffer(i, null) for every slot this file RENAMES   # REQ-3b.
     # Before patterns.restore, so the store's sample-meta emit repaints each
     # slot against settled buffers. A file omitting sampleNames renames nothing.
  3. patterns.restore({ seqBanks, drumBanks, samplerBanks, sampleNames,
        motionBanks/motionAssigns/motionTracks ?? emptyPatternSnapshot().<section> })
     # absent MOTION section -> blanked, never inherited; sampler banks/names inherit
     # (buffers live in SamplerMachine; full sampler clear is New Song's job)
     # seqBanks is rebuilt to [bank][track][step] first: track 1 from seqBanks,
     # 2-4 from seqTracks when present (absent pre-v6 -> a one-track song)
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

### Import validation (the field-level contract)

`fromJSON` no longer trusts a 4-key presence check — it parses then runs
`validateSongFile` (`src/state/song-validate.ts`), a pure, dependency-free
validator. The validator's job is to reject corruption **without** rejecting any
file the loader would accept, so it tracks the *additive* loader contract above,
not the strict current shape:

```yaml
strict (reject + name the path):
  root:        object; format === 'websynth-song'; version ∈ KNOWN_SONG_VERSIONS (= 1..SONG_VERSION); name: string
  params:      object of string -> finite number   # keys NOT restricted (forward-compat)
  xy?:         { x: non-empty string, y: non-empty string }   # v3; param-id existence NOT checked
  seqBanks:    SeqStep[4][16]                       # exact dims
  seqTracks?:  (SeqStep[16]|null)[4][4]             # if present; index 0 of each bank MUST be null
  drumBanks:   DrumCell[4][8][16]
  samplerBanks?: SamplerStep[4][8][16]              # if present
  motionTracks?: (MotionTrack|null)[4][2]           # if present
  sampleNames?:  (string|null)[8]                   # if present
  chainData:   { enabled: boolean, steps: int[1..MAX_CHAIN_STEPS], each 0..3 or REST }
  cell fields when present, by type/range:
    velocity/gate/prob: number 0..1 ; ratchet: int 1..4 ; tie: boolean
    SeqStep.note: int 0..127                        # MIDI range (untrusted-input REQ-4)
  seqTranspose?: number[]                           # v7; each int, |offset| <= MAX_CHAIN_TRANSPOSE
  refused at the three validators that build objects from payload keys —
    validateSeqStep, validateTriggerCell, checkParams — via checkKeys():
    __proto__ / constructor / prototype             # untrusted-input REQ-5 scopes this exactly
lenient (additive — do NOT require):
  per-step velocity/gate/prob/ratchet/tie/micro  # pre-v3 cells omit them; restore defaults them
  required-per-cell: SeqStep -> {on, note}; TriggerCell -> {on}
surface:
  fromJSON(text): SongFile | null              # back-compat: returns null on any failure
  parse(text) / parseFile(File): SongValidation # { ok:false, errors:[ "drumBanks[1][3][7].ratchet must be an integer 1..4", ... ] }
  song-panel Import: shows the first N errors via alertDialog (see dialog.md);
                     applySong wrapped in try/catch
```

Four surfaces feed bytes into that one path (`SongPanel.importBytes`): the
**Import** file picker, the installed PWA's `launchQueue`
([pwa-install](pwa-install.md) REQ-5), share links
([song-share-link](song-share-link.md) REQ-3), and — for JSON that arrives as
text rather than a file, which is how AI agents answer — the **Paste** button
([paste-import](paste-import.md)). None of them re-implements validation or
apply; they only produce bytes.

The published JSON Schema (`public/schema/websynth-song.schema.json`, draft
2020-12) encodes the same rules and **ships to `dist/schema/`** via Vite's
`public/` copy (like `worklets/`), fetchable at `/schema/websynth-song.schema.json`.
It is documentation/tooling only — the runtime validator is the hand-rolled TS
above (no schema interpreter at runtime, per ADR-003). Both are kept honest by the
demo-conformance tests (every demo must pass `validateSongFile`).

### Serialization / on-disk compaction (the canonical form)

`Song.toJSON` runs one pure helper, `compactSongForExport` (`src/state/serialize.ts`),
so every persisted artifact is the *canonical compact* form. Live `ParamBus` /
`PatternStore` state is untouched — optimization happens **only** here
([ADR-011](../decisions/adr-011-export-precision-and-default-sparse-serialization.md)).

```yaml
round:   every number -> Number(n.toPrecision(4))   # 4 sig-figs; inaudible, keeps tiny exp values
sparse cells (drop fields equal to the cell's restore default):
  trigger (drum/sampler): keep `on`; drop velocity/gate/prob/ratchet/tie/micro when default
                          -> a dead cell is just { "on": false }
  seq:     keep on/note/velocity/gate ALWAYS; drop prob/ratchet/tie/micro when default
           # asymmetry: restore spreads SEQ_EXTRA_DEFAULTS (prob/ratchet/tie/micro) only,
           # and apply() does not reset the store first, so velocity/gate must be present
params:  ALL params kept (rounded) — not default-omitted (forward-compat: a future
         default change must not silently move old songs)
whitespace: download() -> pretty (2-space indent + trailing \n) — byte-identical to
            clean:demos output, so an export dropped into src/state/demos/ diffs
            cleanly with no later churn; saveSlot()/project-zip/share-link/AI-prompt
            example -> compact (no indent)
round-trip: fromJSON(toJSON(x)) === compactSongForExport(x)   # canonical inverse, NOT raw x
            full fidelity is restored by apply()/restore re-expanding defaults
reuse:   compare-to-default happens AFTER rounding (0.8500001 -> 0.85 -> dropped);
         defaults come from TRIGGER_CELL_DEFAULTS / SEQ_EXTRA_DEFAULTS (patterns.ts)
```

### Persistence

```yaml
file:        download() -> "<name>.websynth.json"; readFile() parses via fromJSON
localStorage:
  websynth.song.<name>  : one slot (JSON)
  websynth.song.index   : JSON array of slot names
loadSlot:    falls back to a DEMO_SONGS[name] (a BUILT-IN) if no stored slot;
             sync + JSON-only, so a drop-in demo is listed but not returned —
             the Song panel Load button falls back to loadDemo for those (REQ-12)
NOT persisted: decoded AudioBuffers — only sampleNames (user reloads files;
               the UI shows a .needs-reload hint)
demos:       three sources, merged and sorted by display name by demoNames() —
             REQ-12 (the source a demo comes from does not affect its position):
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
          Save also guards the SLOT it lands on (session-autosave REQ-14c):
          confirm when a different song already holds that name, silent when it
          is the slot this session came from (sessionSlot).
load-undo safety net (see session-autosave.md): every destructive apply —
          demo buttons, Load, Import/share-link/launchQueue, and New (after its
          confirm) — stashes the outgoing session (SongFile + sampler
          AudioBuffer refs) and shows an Undo toast (song-undo-toast, toast.md).
          Loads themselves stay confirm-free by design; New keeps its danger
          confirm because it also nulls the sampler buffers. REQ-15's demo
          question is not an exception: it disambiguates WHICH song loads, and
          only when a stored slot shadows the demo's name.
demo persistence: loadDemo NEVER writes a slot (session-autosave REQ-14d) —
          applyProjectBundle(res, { persist }) is true only for real imports, so
          a zip demo now syncs the dropdown the way applyDemo always has.
playhead reset (REQ-14): applySong ends `Song.apply(...)` -> `engine.seekTo(0)`
          (AFTER apply, so the chain re-seat re-arms expectFirstBar); New does
          the same after its own restore + chain resets. Both via StudioApi,
          so transport-position.md REQ-6's refusals are inherited, not re-stated.
```

## Visual aids

```
SongFile (JSON / localStorage slot)
   │ apply()                                   capture() │
   ▼                                                     │
ParamBus.restore ── PatternStore.restore ── Arrangement.set*Chain
   (params)            (seq/drum/sampler banks)   (3 chain lanes)
                                                     │ per bar
                                                     ▼
                              play banks ─► Sequencer / DrumMachine / SamplerMachine
                                                     │ (mute/solo via audibleLanes)
                                                     ▼  + Performance live DJ FX
                                                  audio out
```

## Scenarios (BDD)

```gherkin
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

Scenario: Destructive applies offer a toast Undo (session-autosave.md REQ-7)
  Given an in-progress session
  When the user clicks a demo button, Load, Import, or confirms New
  Then the new state applies without any extra prompt (New's confirm excepted)
  And a toast (song-undo-toast) offers Undo, which restores the prior session
    including the sampler's decoded buffers
# pinned by: e2e/session.spec.ts

Scenario: Loading a song returns the playhead to bar 1 (REQ-14, regression)
  Given the playhead has been moved to bar 5 of an 8-bar chain
  When the user clicks a demo button (or Load, or Import)
  Then the transport readout reads 1.01 and clock.cue is 0
  And the chain's first bar plays slot 0 in full — the next bar line advances it
    by exactly one
# pinned by: e2e/song.spec.ts

Scenario: New Song returns the playhead to bar 1 (REQ-14, regression)
  Given the playhead has been moved to bar 5 and the chains are several bars long
  When the user confirms New
  Then the readout reads 1.01 — not the bar count remembered from the cleared song,
    which the one-cell scrubber beside it no longer has
# pinned by: e2e/song.spec.ts

Scenario: A load while seeking is refused still loads (REQ-14, edge)
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

Scenario: Export is the canonical compact form (round + default-sparse)
  Given a song with high-precision params and default-valued step cells
  When toJSON serializes it
  Then numbers are rounded to 4 significant figures, a dead drum cell is { "on": false },
    and a default seq step keeps on/note/velocity/gate but omits prob/ratchet/tie/micro
  And fromJSON(toJSON(file)) deep-equals compactSongForExport(file)
  And applying it reproduces the original-sounding state (defaults re-expanded)
  And download() writes it pretty-printed (2-space + trailing newline), matching
    `npm run clean:demos` byte-for-byte so demo drop-ins produce readable git diffs
# pinned by: tests/state/serialize.test.ts, tests/state/song.test.ts,
#            e2e/export-project.spec.ts (download formatting)

Scenario: Loading a song repaints the UI without marking it edited
  Given a per-param subscriber on transport.bpm and a global onChange listener
  When apply() loads a song whose bpm differs from the current value
  Then the per-param subscriber receives the new bpm (audio + UI repaint via the
    same `subscribe` channel — there is no explicit "repaint" call)
  And onChange never fires, so the load is not seen as an edit (session stays clean)
# pinned by: tests/state/song.test.ts
# see: architecture.md → "Event flow / propagation"

Scenario: A v1 file loads with empty sampler state (backward compat)
  Given a SongFile with version 1 and no sampler fields
  When apply() runs
  Then it parses, sampler banks/chain default, and seq/drum play unchanged
# pinned by: tests/state/song.test.ts

Scenario: A v2 file loads with default XY axes (backward compat)
  Given a SongFile without an xy field and an XyPadStore
  When apply(file, …, xyStore) runs
  Then the store holds the default axes { x: filter.cutoff, y: filter.resonance }
# pinned by: tests/state/song.test.ts
# see: xy-pad.md → REQ-6

Scenario: Loading a no-motion song clears the previous song's motion (REQ-3, regression)
  Given a store already holding a song with motion banks, tracks and assigns
  When apply() loads a song whose file omits the motion sections (e.g. a v1 file)
  Then every motion section (banks, tracks, assigns) is blank/default — the prior
    song's motion is not inherited, and nothing is still automated
  And sampler banks/names still inherit (the deliberate exception, REQ-3)
  And no sampler buffer is evicted — an omitted section changes no name (REQ-3b)
# pinned by: tests/state/song.test.ts

Scenario: Loading a song evicts audio the new song does not name (REQ-3b, regression)
  Given slot 0 holds a loaded "beep.wav" buffer
  When apply() loads a song whose sampleNames give slot 0 a different name (or none)
  Then slot 0's buffer is nulled, so the label can never claim audio it isn't playing
  And a slot whose name is unchanged keeps its buffer (reloading the same song
    does not force the user to re-pick the file)
# pinned by: tests/state/song.test.ts, e2e/song.spec.ts

Scenario: Legacy {on, velocity} cells sound unchanged (edge)
  Given a drum cell with only { on, velocity }
  When patterns.restore loads it
  Then it gains gate:1, prob:1, ratchet:1, tie:false
# pinned by: tests/state/patterns.test.ts

Scenario: Solo overrides mute (lane mixer)
  Given the drum lane is muted and the seq lane is soloed
  Then only the seq lane is audible
# pinned by: tests/audio/transport/lane-mix.test.ts, e2e/song-mixer.spec.ts

Scenario: Stale param reverts on load (failure guard)
  Given param P was edited live but the loaded song omits P
  When apply() runs
  Then P returns to its registered default (resetDefaults precedes restore)
# pinned by: tests/state/song.test.ts

Scenario: A valid legacy v1 file passes validation (backward compat)
  Given a version-1 SongFile whose drum cells are plain { on, velocity }
  When validateSongFile runs
  Then it returns { ok: true } (missing per-step fields are tolerated)
# pinned by: tests/state/song-validate.test.ts

Scenario: An out-of-range field is rejected with its path (validation)
  Given a SongFile with a drum cell ratchet of 5
  When validateSongFile runs
  Then it returns { ok: false } and an error naming "drumBanks[…].ratchet"
# pinned by: tests/state/song-validate.test.ts

Scenario: A non-number param is rejected (validation)
  Given a SongFile whose params has a value that is a string or NaN
  When validateSongFile runs
  Then it returns { ok: false } naming the offending param key
# pinned by: tests/state/song-validate.test.ts

Scenario: Every shipped demo conforms to the validator (schema↔reality)
  Given each built-in and each src/state/demos/*.json drop-in
  When validateSongFile runs on it
  Then it returns { ok: true }
# pinned by: tests/state/song-validate.test.ts

Scenario: A drop-in demo keeps its own name as its button label (REQ-12)
  Given the drop-ins are referenced by url, not imported
  Then JSON_DEMOS lists them under the names inside the files, not their filenames
  And the demo row renders exactly that library, each drop-in labelled from the index
# pinned by: tests/state/song.test.ts, e2e/song.spec.ts

Scenario: The shelf reads alphabetically, whatever a demo is made of (v20, REQ-12)
  Given the three demo sources
  Then demoNames() is sorted by display name, not grouped by source
  And every project-zip demo sits where its name puts it, not at the end
  And Song.list() orders the slot picker with the same comparator
# pinned by: tests/state/song.test.ts, e2e/demo-library.spec.ts

Scenario: A stale demo index fails CI (REQ-12, drift gate)
  Given a demo whose song name no longer matches src/state/demos-index.json
  When `npm run check:demos` runs
  Then it fails, naming demos-index.json
# pinned by: scripts/clean-demos.ts (CLEAN_DEMOS_CHECK=1)

Scenario: Clicking a drop-in demo fetches and applies it (REQ-12)
  Given a drop-in demo button
  When it is clicked
  Then the song is fetched, validated by Song.parse, applied, and the slot dropdown syncs
  And a fetch or validation failure surfaces in the demo-failed dialog
# pinned by: e2e/song.spec.ts

Scenario: A demo name no source owns falls back to the first demo (v18, REQ-12)
  Given a name no demo source owns — the tour's demo was renamed or deleted
  When loadDemo runs with it
  Then resolveDemoName returns demoNames()[0] and that song loads, not nothing
  And the REQ-15 question, if any, is asked about the resolved name
  But the Load button's slot fallthrough stays strict (isDemoName), so a slot
      deleted in another tab loads nothing rather than an unrelated song
# pinned by: tests/state/song.test.ts

Scenario: A demo whose name you have saved asks which one (v17, REQ-15)
  Given a stored slot whose name a demo button also carries
  When they click that demo button
  Then a choice dialog offers "Load the demo" and "Load mine", naming the song
  And choosing "Load mine" applies the stored slot, not the demo
  And choosing "Load the demo" applies the demo, leaving the slot untouched
  And dismissing it (Escape, backdrop, or Cancel) loads neither
# pinned by: e2e/song.spec.ts

Scenario: An unshadowed demo still loads on one click (v17, REQ-15, boundary)
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

Scenario: With no overflow there is no toggle (REQ-10, boundary)
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
- E2E: `e2e/song.spec.ts` (save→new→load + WAV export RIFF/WAVE header),
  `e2e/song-fx.spec.ts` (live DJ FX), `e2e/song-mixer.spec.ts` (mute/solo/volume).
- `npm test` / `npm run e2e` / `npm run typecheck`.

## Open questions / future

- Every version so far has held the additive contract: `version: 3` shipped the
  optional `xy` field (see [xy-pad](xy-pad.md)), `4` the motion fields, `5`
  `motionTracks` (both [motion-sequencer](motion-sequencer.md)), `6` `seqTracks`
  ([sequencer](sequencer.md)) and `7` `seqTranspose`
  ([arrangement](arrangement.md)). A future `version: 8` must keep new fields
  **optional** and extend the `apply()` defaults-fallback pattern the same way,
  so older files keep loading.
- Bumping the version is **three** edits, not one: `SONG_VERSION`, the
  `SongFile['version']` union, and the published `websynth-song.schema.json` —
  plus `llms.txt`, which advertises the
  canonical version to crawling agents. The validator's accepted set is *not* a
  fourth edit: `KNOWN_SONG_VERSIONS` is derived as `1..SONG_VERSION`
  (`src/state/song-version.ts`), deliberately so it cannot be forgotten. See
  [evolve-the-song-format](../recipes/evolve-the-song-format.md); the drift pins
  in `tests/state/authoring-docs.test.ts` fail loudly if the published pair is
  forgotten (v5 and v6 both shipped without them before this was pinned).
