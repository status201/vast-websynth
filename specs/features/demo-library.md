# Demo library (what a demo is, and what the shelf says about it)

```yaml
id: demo-library
status: implemented
version: 1
owner: core
related:
  - architecture
  - song-mode              # owns the plumbing: the three sources, fetch-on-click, the row
  - arrangement
  - arpeggiator            # REQ-7 — an armed control is not a broken one
  - effects                # REQ-8 — the same, for a staged effect
  - project-export         # the zip demos
  - onboarding             # the tour picks one demo by name
  - runtime-performance    # why demos are not bundled
  - ../decisions/adr-011-export-precision-and-default-sparse-serialization
  - ../recipes/add-a-demo-song
source:
  - src/state/demo-meta.ts          # the pure fact-extractor
  - src/state/demo-notes.json       # hand-written blurbs (optional, per demo)
  - src/state/demos-index.json      # GENERATED — facts + merged blurbs
  - scripts/clean-demos.ts          # the generator + the check:demos gate
  - src/state/song.ts               # JSON_DEMOS / ZIP_DEMOS / demoNames
  - src/ui/panels/song-panel.ts     # the demo row
```

## Background / Why

The library is the instrument's shop window — every song in `src/state/demos/`
plus the two built-ins, and for most visitors the only music they will ever hear
it make. Until now **nothing described them**.
`demos-index.json` carried exactly one field per demo, `filename → name`, minted
purely so the buttons could be labelled after demos became fetch-on-click
([song-mode](song-mode.md) REQ-12). The row therefore reads
`1979 · 1983 · 1985-1 · 1985-2 · Night Rider · … · Fat · Right` — a row of
unlabelled doors, `DEMO_ROW_LIMIT` (10) of them visible and the rest behind an
"All Demos" fold, with no tempo, no length, no genre and no hint of what any of
them demonstrates.

Worse, some demos have things **staged rather than sounding**: `arp.on` armed for
a player to hold keys over ([arpeggiator](arpeggiator.md) REQ-7), an effect
dialled in but bypassed for the XY pad ([effects](effects.md) REQ-8), a motion
bank sitting behind `motion.on: 0`. That is deliberate design, and it is
currently *invisible* — the one thing a listener would most want told.

Every fact worth showing is already computable from the files, by the one pass
that already parses all of them. This spec makes the index carry them, and says
what a demo owes the shelf.

## Requirements

- **REQ-1** — **Facts are generated, never hand-maintained.** `scripts/clean-demos.ts`
  already parses every demo to canonicalize it (ADR-011); it now also derives each
  demo's **tempo, length, machines used and what is armed** and writes them to
  `demos-index.json`. Nothing about a demo's *content* is typed by hand, so the
  index cannot drift from the songs — `npm run check:demos` fails on any
  difference, exactly as it already does for the names.

- **REQ-2** — **Prose is hand-written and lives apart.** A one-line "what to listen
  for" blurb per demo lives in `src/state/demo-notes.json`, keyed by filename, and
  is **merged into** the generated index. It is separate precisely so regeneration
  cannot clobber it, and **optional**: a demo with no entry still gets its facts.
  This preserves the property [add-a-demo-song](../recipes/add-a-demo-song.md)
  promises — dropping a `.json` into `src/state/demos/` and running one command is
  still the whole procedure.

  `demo-notes.json` is **allowlisted in the SDD guard** alongside
  `src/state/demos/` itself: it is prose about songs, carries no behaviour, and
  writing a line for a demo must not require a spec change. (It was not, at
  first — the guard blocked the very first blurb, which is how the omission was
  found.)

- **REQ-3** — **The zip demos are indexed too.** `1973` and `Run Away 2` are the only
  demos that use the sampler (a `.json` cannot embed audio), and they were absent
  from the index entirely — their labels came from mangling the filename
  (`Run_Away_2` → "Run Away 2"). The generator reads their `song.json` through
  `parseProjectZip` and indexes them like any other, so the two most
  feature-complete demos in the library stop being the two least described.

- **REQ-4** — **`uses` is what you will hear; `armed` is what you can play.** The two
  are separate lists because they answer different questions, and conflating them
  is what made an armed arp look like a bug:
  - `uses` — a machine with steps that will sound on playback: `seq`, `drums`,
    `sampler`, `motion`.
  - `armed` — set up and waiting for a hand: `arp` (the arpeggiator follows the
    keyboard, never the sequencer, so it is **always** armed and never "used")
    and `motion` (banks present but `motion.on: 0`).

  **A staged *effect* is deliberately not reported, and this is the record of
  why.** [effects](effects.md) REQ-8 says a bypassed or `mix: 0` effect may be
  dialled in and waiting, so it was specced as a third `armed` value and then
  measured against the shipped corpus. The measurement below is **point-in-time**
  (taken against the 15-demo corpus of the day) and is kept as the record of *why*
  the value was dropped — not as a live count:

  | candidate test | fired on |
  | --- | --- |
  | any bypassed effect with a non-default parameter | **13 of 15** demos |
  | on, but `mix` pinned to 0 (enabled and deliberately closed) | **0 of 15** |

  The loose test is technically correct — `1979` really does carry a dialled-in
  wah and phaser, switched off — but a hint that appears on almost every button
  conveys nothing and adds noise to every tooltip; the strict test finds nothing
  at all. Neither is a signal, so neither ships. `arp` and `motion` are precise
  and rare — a handful of demos each — which is what makes them worth showing.
  (Exact counts are deliberately not quoted here: `demoMeta` derives them from
  each song file at runtime, so any number written down rots the next time a demo
  lands. Read them from the shipped corpus.)
  Under-reporting is the right failure: a missing hint costs a discovery, a hint
  that cries wolf costs the listener's attention on every other demo too.

- **REQ-5** — **Length is the longest enabled chain lane**, matching
  `Arrangement.songBars` — the same number the playhead ruler shows as
  `Bar 3/16`. A demo with no enabled lane reports `0` and the UI omits it rather
  than claiming "0 bars".

- **REQ-6** — **The row says what it knows.** Every demo button carries a `title`
  built from its metadata — `124 BPM · 16 bars · seq + drums + motion · hold a
  key: arp armed — <blurb>` (the armed phrasing is `ARMED_LABEL`'s, which spells
  out the gesture rather than just naming the machine) — so hovering (or a screen
  reader) answers "what is this?" without a click. The visible label stays the
  song's name: the row is already tight on mobile, and the fix for a row of
  unlabelled buttons is not a row of wider ones.

- **REQ-7** — **The index stays a build artifact with a stable shape.** Keys are
  sorted filenames (so the emitted JSON is byte-stable), values are `DemoMeta`.
  `song.ts` reads `name` from it exactly as before; the extra fields are additive,
  and a demo missing from the index still falls back to its filename
  ([song-mode](song-mode.md) REQ-12) rather than breaking the row.

## Technical design

### Contract / public interface

```ts
// src/state/demo-meta.ts — pure, no I/O, testable without the filesystem
export interface DemoMeta {
  name: string;              // the song's own `name` — the button label
  bpm: number;               // params['transport.bpm'], rounded
  bars: number;              // longest enabled chain lane; 0 = no arrangement
  uses: DemoMachine[];       // 'seq' | 'drums' | 'sampler' | 'motion'
  armed?: DemoArmed[];       // 'arp' | 'motion' — omitted when empty
  blurb?: string;            // merged from demo-notes.json (REQ-2)
}
export function demoMetaOf(file: SongFile): Omit<DemoMeta, 'blurb'>;
/** The one-line summary the demo button's title shows (REQ-6). */
export function demoSummary(meta: DemoMeta): string;
```

### Data shapes

```yaml
demos-index.json:            # GENERATED — keys are sorted filenames
  "<file>.json":
    name: string
    bpm: number
    bars: number
    uses: [seq, drums, sampler, motion]     # subset, in that order
    armed: [arp, motion]                    # subset; key omitted when empty
    blurb: string                           # key omitted when demo-notes has none

demo-notes.json:             # HAND-WRITTEN — filename -> one line, all optional
  "<file>.json": "Acid bassline over a 909; hold a key, the arp is armed."
```

### Layer touchpoints & ordering

```yaml
clean:demos  -> reads src/state/demos/*.json   (canonicalize, ADR-011)
             -> reads src/state/demos/*.zip    (parseProjectZip, REQ-3)
             -> demoMetaOf(file) per demo      (pure, src/state/demo-meta.ts)
             -> merges src/state/demo-notes.json blurbs   (REQ-2)
             -> writes src/state/demos-index.json
check:demos  -> the same pass, writes nothing, fails on any difference
song.ts      -> imports demos-index.json; DemoRef gains `meta`
song-panel   -> mkDemoBtn sets button.title = demoSummary(meta)   (REQ-6)
```

The generator is **async** now (zip inflate is streaming). It is a vitest entry
precisely because vitest is the only Vite-aware TS runner here — that has not
changed, and it is what lets it import `parseProjectZip` and `demo-meta.ts`
directly rather than reimplementing either.

### Persistence

Nothing new persists at runtime. `demos-index.json` and `demo-notes.json` are
**source files**, committed and diffable; the first is generated and gated, the
second is written by hand and never rewritten by a tool.

## Scenarios (BDD)

```gherkin
Scenario: The index carries a demo's tempo, length and machines
  Given a demo with transport.bpm 124, a 16-bar seq chain and drum steps
  When clean:demos runs
  Then its index entry reads bpm 124, bars 16 and uses [seq, drums]
# pinned by: tests/state/demo-meta.test.ts

Scenario: An armed arp is reported as armed, not as used (REQ-4)
  Given a demo with arp.on 1 and no arp notes of its own
  Then `armed` contains 'arp' and `uses` does not
  # the arp follows the keyboard, never the sequencer (arpeggiator.md REQ-7)
# pinned by: tests/state/demo-meta.test.ts

Scenario: A motion bank behind motion.on 0 is armed, not missing (REQ-4)
  Given a demo carrying motion anchors with motion.on 0
  Then `armed` contains 'motion' and `uses` does not
# pinned by: tests/state/demo-meta.test.ts

Scenario: A bypassed effect is never reported as armed (REQ-4)
  Given a demo whose wah is dialled in but switched off
  Then `armed` reports only arp/motion — the corpus measurement (REQ-4) found an
    FX hint would fire on almost every demo and so mean nothing
# pinned by: tests/state/demo-meta.test.ts

Scenario: A hand-written blurb survives regeneration (REQ-2)
  Given demo-notes.json holds a line for a demo
  When clean:demos regenerates the index
  Then the blurb is present in the index and unchanged
  And a demo with no note still gets its generated facts
# pinned by: tests/state/demo-meta.test.ts

Scenario: The zip demos are indexed like any other (REQ-3)
  When clean:demos runs
  Then both *.websynth.zip demos have index entries with their real names
# pinned by: tests/state/demo-index.test.ts

Scenario: A stale index fails CI (REQ-1, regression)
  Given a demo whose tempo was edited without regenerating the index
  When check:demos runs
  Then it fails naming demos-index.json
# pinned by: scripts/clean-demos.ts (CLEAN_DEMOS_CHECK)

Scenario: A demo button says what it is without being clicked (REQ-6)
  Given the Song tab's demo row
  Then each button's title names its tempo, length and machines
# pinned by: e2e/demo-library.spec.ts
```

## Tests & verification

- Unit: `tests/state/demo-meta.test.ts` (the extractor, against hand-built
  fixtures — never against a named shipped demo), `tests/state/demo-index.test.ts`
  (every shipped demo has a well-formed entry) — `npm test`
- E2E: `e2e/demo-library.spec.ts` — `npm run e2e`
- Drift: `npm run check:demos`
- Typecheck: `npm run typecheck`
- **Editorial, by hand:** the blurbs are prose about *music*. A generated fact is
  checkable; "what to listen for" is a judgement, and the person who knows whether
  a line is true of a song is the one who has heard it.

## Open questions / future

- **The metadata could live in the `SongFile` itself** (an optional `description`,
  additive per ADR-007), so a shared song carries its own description instead of
  only the demos having one. Deliberately not done here: it re-opens the format
  one bump after v7, and the shelf's problem is solvable without it.
- **`DEMO_ROW_LIMIT` (10 visible, the rest folded)** is worth revisiting now that buttons
  carry meaning — but a row that says more per button is the prerequisite, not
  the same change.
- **Coverage is lopsided and the index now makes it measurable**: zero JSON demos
  use the sampler, motion is live in a minority of the corpus, and the tour's demo
  is a v2 file with no XY and no motion. A future check could fail when no demo
  exercises a machine at all — and unlike a number in this spec, it would stay
  true.
