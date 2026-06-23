# Song mode (cross-cutting integration)

```yaml
id: song-mode
status: implemented
version: 1
owner: core
related:
  - architecture
  - compressor
source:
  - src/state/song.ts                         # capture/apply/persist + demos
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
sequencer / drum / sampler patterns, ordered into per-lane **chains**, played back
bar-by-bar, with live DJ FX and a per-lane mixer on top. A whole song
(params + all banks + all three chains) is captured into one portable JSON file and
into `localStorage` slots. Because song files are saved by users and shipped as
demos, the load path **must stay backward compatible** as the format grows.

## Requirements

- **REQ-1** — A song captures the full bus snapshot + all seq/drum/sampler banks +
  all three chain lanes into one `SongFile`.
- **REQ-2** — `SongFile` is a **versioned union** (`version: 1 | 2`); v2 adds
  optional sampler fields. v1 files (incl. built-in demos) must still load.
- **REQ-3** — `apply()` is authoritative: it **resets params to defaults first**,
  then restores, so a stale param omitted by an older file reverts rather than
  lingering.
- **REQ-4** — Legacy step cells (plain `{on, velocity}`) must load and **sound
  unchanged** (gain defaults filled in).
- **REQ-5** — Decoded audio is **never embedded**; only sampler filenames persist
  and the user reloads files after import.
- **REQ-6** — Mute/solo audibility follows one shared pure rule (solo wins over
  mute), used by both the engine and the UI.
- **REQ-7** — Play banks must be settled **before** the machines read them on a
  given tick (construction ordering).

## Technical design

### Contract / public interface

```yaml
Song:   # src/state/song.ts (a plain object of functions, not a class)
  capture(bus, patterns, arr, name): SongFile
  apply(file, bus, patterns, arr): void
  toJSON(file) / fromJSON(text): SongFile | null
  download(file) / readFile(File): Promise<SongFile | null>
  list(): string[]                       # demo names ∪ stored slot names, sorted
  saveSlot(name, file) / loadSlot(name) / deleteSlot(name)

Arrangement:  # setSeqChain / setDrumChain / setSamplerChain(steps, enabled)
Performance:  # setFill / setStutter / setDrop / setTapeStop  (live DJ FX)
lane-mix:     # audibleLanes(mute, solo): LaneFlags   (pure)
```

### Data shapes (the persistence schema)

Nested beyond ~3 levels, so as flat YAML:

```yaml
SongFile:
  format: 'websynth-song'            # required discriminator
  version: 1 | 2
  name: string
  params: Record<string, number>     # = ParamBus.snapshot()
  seqBanks:  SeqStep[][]             # 4 banks × 16 steps
  drumBanks: DrumCell[][][]          # 4 banks × 8 tracks × 16 steps
  seqChain:  ChainData
  drumChain: ChainData
  # ---- v2 additions (optional, so v1 files still parse) ----
  samplerBanks?: SamplerStep[][][]   # 4 banks × 8 slots × 16 steps
  samplerChain?: ChainData
  sampleNames?: (string | null)[]    # filenames ONLY — audio is not embedded

ChainData:
  enabled: boolean
  steps: number[]                    # ordered bank indices, one advance per bar
```

`SeqStep` / `DrumCell` / `SamplerStep` are defined in
[`architecture.md`](../architecture.md) (StepSettings + `on` [+ `note`]).

### Versioning & backward-compat (the load-bearing detail)

```yaml
capture: always writes version: 2
fromJSON: version-agnostic — only checks format === 'websynth-song'
          AND presence of params + seqBanks + drumBanks  -> v1 and v2 both parse
apply (migration point):
  1. bus.resetDefaults()                 # omitted params revert to default
  2. bus.restore(file.params)
  3. patterns.restore({ seqBanks, drumBanks, samplerBanks, sampleNames })
  4. arr.setSeqChain(file.seqChain?.steps ?? [0], file.seqChain?.enabled ?? false)
     arr.setDrumChain(... ?? [0], ... ?? false)
     arr.setSamplerChain(... ?? [0], ... ?? false)   # v1 files lack these -> defaults
patterns.restore: Object.assign(dst, TRIGGER_CELL_DEFAULTS, cell)
  # spreads defaults UNDER incoming cells, so legacy {on, velocity} cells
  # gain gate:1 / prob:1 / ratchet:1 / tie:false and sound unchanged
```

### Persistence

```yaml
file:        download() -> "<name>.websynth.json"; readFile() parses via fromJSON
localStorage:
  websynth.song.<name>  : one slot (JSON)
  websynth.song.index   : JSON array of slot names
loadSlot:    falls back to a DEMO_SONGS[name] if no stored slot
NOT persisted: decoded AudioBuffers — only sampleNames (user reloads files;
               the UI shows a .needs-reload hint)
demos:       DEMO_SONGS = drop-in src/state/demos/*.json (import.meta.glob, eager,
             build-time) spread BEFORE two hand-authored built-ins
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
lane mix: audibleLanes(mute, solo) — solo wins; shared by Engine.applyLaneMix()
          (cuts bus gain / StepSequencer.setMuted) and the panel's dim visual
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
  Then params, all banks, and all three chains match the saved song
# pinned by: tests/state/song.test.ts, e2e/song.spec.ts

Scenario: A v1 file loads with empty sampler state (backward compat)
  Given a SongFile with version 1 and no sampler fields
  When apply() runs
  Then it parses, sampler banks/chain default, and seq/drum play unchanged
# pinned by: tests/state/song.test.ts

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
```

## Tests & verification

- Unit (pure): `tests/state/song.test.ts` (round-trip, slot CRUD, v1/v2 apply,
  demo applies), `tests/state/patterns.test.ts`,
  `tests/audio/transport/arrangement.test.ts`,
  `tests/audio/transport/lane-mix.test.ts`,
  `tests/audio/transport/sampler-machine.test.ts`,
  `tests/audio/transport/performance.test.ts`.
- E2E: `e2e/song.spec.ts` (save→new→load + WAV export RIFF/WAVE header),
  `e2e/song-fx.spec.ts` (live DJ FX), `e2e/song-mixer.spec.ts` (mute/solo/volume).
- `npm test` / `npm run e2e` / `npm run typecheck`.

## Open questions / future

- A future `version: 3` should keep new fields **optional** and extend the
  `apply()` defaults-fallback pattern, so older files keep loading.
