# Recipe — add a demo song

```yaml
id: add-a-demo-song
status: implemented
version: 2   # v2: demos are fetched on click; `npm run clean:demos` is now required
owner: core
related:
  - song-mode
  - runtime-performance
source:
  - src/state/demos/                     # drop your *.json here
  - src/state/demos-index.json           # generated filename -> song name
  - scripts/clean-demos.ts               # canonicalizer + index generator
  - src/state/song.ts                    # ?url glob registration
```

How to add a built-in demo song. This is a **pure data drop-in** — no code changes,
and `src/state/demos/` is allowlisted in the SDD guard, so a new demo needs no spec.
It does need **one command** run (step 2), which is the only thing that makes this
more than "copy a file in".

## Background / Why

Demos are auto-registered at build time: any `*.json` SongFile in
`src/state/demos/` is picked up by
`import.meta.glob('./demos/*.json', { eager: true, query: '?url', import: 'default' })`
and listed **before** the hand-authored built-ins so drop-ins lead the demo button
row. No registry edit.

The glob keeps only the **URL** — the song itself is `fetch`ed when the user clicks
its button, not bundled ([song-mode](../features/song-mode.md) REQ-12). Importing
the demos eagerly instead put ~835 kB of JSON in every visitor's boot payload to
load at most one of them. The consequence for *this* recipe is that nothing reads
your file at build time, so the button label cannot come from the `name` inside it —
it comes from the generated `src/state/demos-index.json`. That is what step 2 writes.

## Steps

### 1. Author a `SongFile` and save it to `src/state/demos/<slug>.json`

Minimum shape (a v1 file is fine — `apply()` resets params to defaults first, so a
partial `params` map is OK; omitted params revert):

```yaml
format: 'websynth-song'
version: 1
name: 'My Demo'              # MUST be unique — it is the registry key AND the label
params: { ... }             # a ParamBus snapshot (or partial)
seqBanks:  [ [ ...16 SeqStep ] × 4 ]
drumBanks: [ [ [ ...16 DrumCell ] × 8 tracks ] × 4 ]
seqChain:  { enabled: true, steps: [0,1,2,3] }
drumChain: { enabled: true, steps: [0,0,0,1] }
# optional v2: samplerBanks / samplerChain / sampleNames
```

### 2. Run `npm run clean:demos` — **required**

One command does two jobs:

- **Regenerates `src/state/demos-index.json`**, adding `"<your-file>.json": "My
  Demo"`. Skip it and your demo still loads, but its button is labelled from the
  *filename* (the fallback) — `hacienda_neworder` instead of "Haçienda". Commit the
  regenerated index alongside your JSON.
- **Canonicalizes the file**: numbers rounded to 4 sig-figs, default step-cells
  collapsed to `{ "on": false }` (see
  [ADR-011](../decisions/adr-011-export-precision-and-default-sparse-serialization.md)),
  pretty-printed (2-space indent, LF, trailing newline) so git diffs stay readable.
  The app's Export Song download is already in exactly this form, so a fresh export
  drops in with zero churn. A full-precision file still loads fine; the gate just
  keeps the repo tidy.

It runs automatically before `npm run build`, and CI's `npm run check:demos` is the
same script in non-mutating mode — it fails on a drifted file **or a stale index**,
so a forgotten run is caught rather than shipped.

### 3. That's it

It appears in the demo row and the song-load list on next build. To verify the
shape parses: `Song.parse` requires `format === 'websynth-song'` plus
`params` + `seqBanks` + `drumBanks`.

## Gotchas

- **Run `npm run clean:demos` and commit `demos-index.json`.** It is the one manual
  step, and the only symptom of forgetting is a wrong-looking button label — easy to
  miss locally, which is why `check:demos` fails the build.
- `name` is the key — a duplicate name overwrites another demo.
- Demos lead the row in **filename** order (drop-ins are sorted, then the built-ins).
- The song is fetched on click, so it is **not** in the offline cache until it has
  been clicked once (same as the zip demos — see
  [pwa-install](../features/pwa-install.md)).
- Riffs aim to be *recognisable*, not note-perfect transcriptions.
- A `.json` demo cannot embed sampler audio — only `sampleNames` persist, so it
  shows the needs-reload hint (see [sampler](../features/sampler.md)). A demo that
  **needs its samples** ships as a `*.websynth.zip` project drop-in instead (also
  auto-registered from `src/state/demos/`, fetched on click via the same `?url`
  treatment — see [project-export](../features/project-export.md) REQ-7).

## Scenarios (BDD)

```gherkin
Scenario: A dropped-in demo loads and applies
  Given src/state/demos/my-demo.json is a valid SongFile
  When the app builds and the user clicks "My Demo"
  Then it is fetched, validated, and Song.apply restores its params, banks and chains
# pinned by: tests/state/song-validate.test.ts, tests/state/song.test.ts, e2e/song.spec.ts

Scenario: A demo added without regenerating the index fails CI
  Given a new demo whose filename is absent from demos-index.json
  When `npm run check:demos` runs
  Then it fails, naming demos-index.json
# pinned by: scripts/clean-demos.ts
```

## Tests & verification

- `npm run clean:demos` writes the index + canonical form; `npm run check:demos` is
  the CI gate for both.
- `tests/state/song-validate.test.ts` validates **every** drop-in, via the test-only
  eager glob in `tests/state/demo-files.ts` — the app itself never parses one until
  it is clicked, so this is where a malformed demo is caught. `npm test`.
