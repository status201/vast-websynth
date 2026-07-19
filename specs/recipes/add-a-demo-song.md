# Recipe — add a demo song

```yaml
id: add-a-demo-song
status: implemented
version: 1
owner: core
related:
  - song-mode
source:
  - src/state/demos/                     # drop your *.json here
  - src/state/song.ts                    # import.meta.glob auto-registration
```

How to add a built-in demo song. This is a **pure data drop-in** — no code changes,
and `src/state/demos/` is allowlisted in the SDD guard, so a new demo needs no spec.

## Background / Why

Demos are auto-registered at build time: any `*.json` SongFile in
`src/state/demos/` is picked up by `import.meta.glob('./demos/*.json', { eager: true,
import: 'default' })`, keyed by the file's `name`, and spread **before** the
hand-authored built-ins so drop-ins lead the demo button row. No `fetch`, no
registry edit.

## Steps

### 1. Author a `SongFile` and save it to `src/state/demos/<slug>.json`

Minimum shape (a v1 file is fine — `apply()` resets params to defaults first, so a
partial `params` map is OK; omitted params revert):

```yaml
format: 'websynth-song'
version: 1
name: 'My Demo'              # MUST be unique — it is the registry key
params: { ... }             # a ParamBus snapshot (or partial)
seqBanks:  [ [ ...16 SeqStep ] × 4 ]
drumBanks: [ [ [ ...16 DrumCell ] × 8 tracks ] × 4 ]
seqChain:  { enabled: true, steps: [0,1,2,3] }
drumChain: { enabled: true, steps: [0,0,0,1] }
# optional v2: samplerBanks / samplerChain / sampleNames
```

### 2. Canonicalize it (recommended)

Demos ship in **canonical compact** form (numbers rounded to 4 sig-figs, default
step-cells collapsed to `{ "on": false }`; see
[ADR-011](../decisions/adr-011-export-precision-and-default-sparse-serialization.md))
and **pretty-printed** (2-space indent, LF, trailing newline) so git diffs stay
readable. The app's Export Song download is already in exactly this form — a fresh
export drops into `src/state/demos/` with zero churn. For hand-authored or legacy
files, `npm run clean:demos` rewrites every `src/state/demos/*.json` through the
same `compactSongForExport` helper (it also runs automatically before
`npm run build`), and CI's `npm run check:demos` fails on any demo that drifts
from canonical form. A full-precision file still loads fine; the gate just keeps
the repo tidy.

### 3. That's it

It appears in the demo row and the song-load list on next build. To verify the
shape parses: `Song.fromJSON` requires `format === 'websynth-song'` plus
`params` + `seqBanks` + `drumBanks`.

## Gotchas

- `name` is the key — a duplicate name overwrites another demo.
- Demos lead the row in **filename** order (drop-ins are sorted, then spread before
  built-ins).
- Riffs aim to be *recognisable*, not note-perfect transcriptions.
- A `.json` demo cannot embed sampler audio — only `sampleNames` persist, so it
  shows the needs-reload hint (see [sampler](../features/sampler.md)). A demo that
  **needs its samples** ships as a `*.websynth.zip` project drop-in instead (also
  auto-registered from `src/state/demos/`, fetched on click via a `?url` glob —
  see [project-export](../features/project-export.md) REQ-7).

## Scenarios (BDD)

```gherkin
Scenario: A dropped-in demo loads and applies
  Given src/state/demos/my-demo.json is a valid SongFile
  When the app builds and the user loads "My Demo"
  Then Song.apply restores its params, banks, and chains
# pinned by: tests/state/song.test.ts (applies each DEMO_SONGS entry)
```

## Tests & verification

- `tests/state/song.test.ts` exercises every `DEMO_SONGS` entry; confirm your JSON
  parses and applies. `npm test`.
