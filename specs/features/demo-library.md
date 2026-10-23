# Demo library (what a demo is, and what the shelf says about it)

```yaml
id: demo-library
status: implemented
version: 5   # v5: the ⓘ-mode door knows the loaded demo too, so both doors open the library in the
             #     same state (REQ-info-mode-badges-the-demo-row-once)
             # v4: a blurb folds to its first line with a More/Less toggle; the loaded demo's entry opens
             #     unfolded and its button reads "Loaded" (REQ-a-blurb-folds-to-its-first-line,
             #     REQ-the-loaded-demo-carries-an-info-button) — the unfolded list was too long to scan
             # v3: the demo library window, the loaded demo's ⓘ and one ⓘ-mode badge on the row
             #     (REQ-the-library-reads-without-loading, REQ-the-loaded-demo-carries-an-info-button,
             #     REQ-info-mode-badges-the-demo-row-once) — the blurbs were hover-only, so no touch device saw them
             # v2: every machine is exercised by at least one demo (REQ-every-machine-has-a-demo)
owner: core
related:
  - architecture
  - song-mode              # owns the plumbing: the three sources, fetch-on-click, the row
  - arrangement
  - arpeggiator            # REQ-demo-index-shape-is-stable — an armed control is not a broken one
  - effects                # REQ-a-bypassed-effect-in-a-song-may-be-deliberate — the same, for a staged effect
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
  - src/ui/panels/song-panel.ts     # the demo row + the loaded demo's ⓘ
  - src/ui/components/demo-library.ts  # the library window (lazy)
  - src/ui/onboarding/info-badges.ts   # the one ⓘ-mode badge on the row
```

## Background / Why

The library is the instrument's shop window — every song in `src/state/demos/`
plus the built-in, and for most visitors the only music they will ever hear
it make. Until now **nothing described them**.
`demos-index.json` carried exactly one field per demo, `filename → name`, minted
purely so the buttons could be labelled after demos became fetch-on-click
([song-mode](song-mode.md) REQ-drop-in-demos-are-fetched-on-click). The row therefore reads
`1979 · 1983 · 1985-1 · 1985-2 · Night Rider · … · Fat · Right` — a row of
unlabelled doors, `DEMO_ROW_LIMIT` (10) of them visible and the rest behind an
"All Demos" fold, with no tempo, no length, no genre and no hint of what any of
them demonstrates.

Worse, some demos have things **staged rather than sounding**: `arp.on` armed for
a player to hold keys over ([arpeggiator](arpeggiator.md) REQ-saved-arp-on-is-armed-not-broken), an effect
dialled in but bypassed for the XY pad ([effects](effects.md) REQ-a-bypassed-effect-in-a-song-may-be-deliberate), a motion
bank sitting behind `motion.on: 0`. That is deliberate design, and it is
currently *invisible* — the one thing a listener would most want told.

Every fact worth showing is already computable from the files, by the one pass
that already parses all of them. This spec makes the index carry them, and says
what a demo owes the shelf.

## Requirements

- **REQ-demo-facts-are-generated** — **Facts are generated, never
  hand-maintained.** `scripts/clean-demos.ts` already parses every demo to
  canonicalize it (ADR-011); it now also derives each demo's **tempo, length,
  machines used and what is armed** and writes them to `demos-index.json`.
  Nothing about a demo's *content* is typed by hand, so the index cannot drift
  from the songs — `npm run check:demos` fails on any difference, exactly as it
  already does for the names.

- **REQ-demo-prose-lives-apart** — **Prose is hand-written and lives apart.** A
  one-line "what to listen for" blurb per demo lives in
  `src/state/demo-notes.json`, keyed by filename, and is **merged into** the
  generated index. It is separate precisely so regeneration cannot clobber it,
  and **optional**: a demo with no entry still gets its facts. This preserves
  the property [add-a-demo-song](../recipes/add-a-demo-song.md) promises —
  dropping a `.json` into `src/state/demos/` and running one command is still
  the whole procedure.

  `demo-notes.json` is **allowlisted in the SDD guard** alongside
  `src/state/demos/` itself: it is prose about songs, carries no behaviour, and
  writing a line for a demo must not require a spec change. (It was not, at
  first — the guard blocked the very first blurb, which is how the omission was
  found.)

- **REQ-zip-demos-are-indexed-too** — **The zip demos are indexed too.** `1973`
  and `Run Away 2` are the only demos that use the sampler (a `.json` cannot
  embed audio), and they were absent from the index entirely — their labels came
  from mangling the filename (`Run_Away_2` → "Run Away 2"). The generator reads
  their `song.json` through `parseProjectZip` and indexes them like any other,
  so the two most feature-complete demos in the library stop being the two least
  described.

- **REQ-uses-is-heard-armed-is-playable** — **`uses` is what you will hear;
  `armed` is what you can play.** The two are separate lists because they answer
  different questions, and conflating them is what made an armed arp look like a
  bug:
  - `uses` — a machine with steps that will sound on playback: `seq`, `drums`,
    `sampler`, `motion`.
  - `armed` — set up and waiting for a hand: `arp` (the arpeggiator follows the
    keyboard, never the sequencer, so it is **always** armed and never "used")
    and `motion` (banks present but `motion.on: 0`).

  **A staged *effect* is deliberately not reported, and this is the record of
  why.** [effects](effects.md) REQ-a-bypassed-effect-in-a-song-may-be-deliberate says a bypassed or `mix: 0` effect may be
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
  (Exact counts are deliberately not quoted here: `demoMetaOf` derives them from
  each song file at runtime, so any number written down rots the next time a demo
  lands. Read them from the shipped corpus.)
  Under-reporting is the right failure: a missing hint costs a discovery, a hint
  that cries wolf costs the listener's attention on every other demo too.

- **REQ-demo-length-is-the-longest-lane** — **Length is the longest enabled
  chain lane**, matching `Arrangement.songBars` — the same number the playhead
  ruler shows as `Bar 3/16`. A demo with no enabled lane reports `0` and the UI
  omits it rather than claiming "0 bars".

- **REQ-demo-row-says-what-it-knows** — **The row says what it knows.** Every
  demo button carries a `title` built from its metadata — `124 BPM · 16 bars ·
  seq + drums + motion · hold a key: arp armed — <blurb>` (the armed phrasing is
  `ARMED_LABEL`'s, which spells out the gesture rather than just naming the
  machine) — so hovering (or a screen reader) answers "what is this?" without a
  click. The visible label stays the song's name: the row is already tight on
  mobile, and the fix for a row of unlabelled buttons is not a row of wider
  ones.

- **REQ-demo-index-shape-is-stable** — **The index stays a build artifact with a
  stable shape.** Keys are sorted filenames (so the emitted JSON is
  byte-stable), values are `DemoMeta`. `song.ts` reads `name` from it exactly as
  before; the extra fields are additive, and a demo missing from the index still
  falls back to its filename ([song-mode](song-mode.md) REQ-drop-in-demos-are-fetched-on-click) rather than
  breaking the row.

- **REQ-the-library-reads-without-loading** (v3) — **Everything the shelf knows
  can be read without loading anything.** REQ-demo-row-says-what-it-knows put it in
  a `title`, which only a hover reveals: a touch device never shows one, and
  tapping a demo button *loads* the demo, so a phone could only learn about a demo
  by replacing the session with it. The tooltip was also outgrown on desktop —
  several blurbs run past a hundred words, and a native tooltip is unstyled, slow
  to appear and can vanish mid-read. So a **demo library** window lists every demo
  in `demoNames()` order — the row's own order — each entry carrying the name, the
  facts line (`demoFacts`), the blurb when there is one, and a **Load** button.
  Opening, scrolling or closing the window loads and plays nothing. Load closes
  the window and goes through the Song panel's `loadDemo`, the door every other
  caller uses, so the same-name question ([song-mode](song-mode.md)
  REQ-one-name-two-songs-ask), the Undo stash and the Play cue all still apply.
  The blurb is set as **text**, never HTML: it is data from a drop-in file.
  The window is a lazy chunk ([runtime-performance](runtime-performance.md)
  REQ-boot-cost-matches-the-request) — nobody pays for it until they open it. The
  buttons keep their `title` and `aria-label`: hover still answers on a desktop.

- **REQ-the-loaded-demo-carries-an-info-button** (v3) — **The demo you just loaded
  says so, and offers its notes.** Right after a load is when "what am I hearing?"
  gets asked, and the row never said which demo was loaded. After a demo applies —
  from its button, the Load button, the tour, the empty-play hint or the library —
  an ⓘ button sits directly after that demo's button and opens the library
  scrolled to its entry, which is marked as the loaded one (`aria-current`). The
  library opens in that same state from the ⓘ-mode badge too
  (REQ-info-mode-badges-the-demo-row-once, v5). That
  entry opens with its blurb **unfolded** (REQ-a-blurb-folds-to-its-first-line) —
  its notes are what the ⓘ was pressed for — and its button reads **Loaded** and
  is disabled: the demo is already what is playing, and re-loading it from here
  would silently throw away any edit made since (the row's own button still
  re-loads it, deliberately, behind the Undo toast) (v4). Any
  other song apply — a stored slot, an import, a paste, a share link — and **New**
  take it away; **Undo** restores whatever the stash's session showed. It is
  session state, not persisted: after a reload no ⓘ shows. It belongs to the row,
  not to the ⓘ-mode layer, so the badges' "no added chrome while off" rule
  ([onboarding](onboarding.md) REQ-info-badges-show-per-control-help) is untouched.

  *Gestures* (ADR-014): it is a plain `<button>` — click or tap opens the library,
  Enter/Space do the same when focused. No long-press: iOS claims long-press for
  its own callout, and nothing would tell a player it was there.

- **REQ-info-mode-badges-the-demo-row-once** (v3) — **ⓘ mode badges the demo row
  once, not per demo.** One badge, `song.demos`, tucked into the corner of the `Demos:` label (placed after it, it would cover the first demo button),
  opens the library. A badge per demo was considered and rejected: there are
  around thirty demos and most sit behind the "All Demos" fold, where an anchor
  measures 0×0 and its badge hides; the row wraps tightly, so corner badges would
  cover the neighbouring names; and thirty content badges would bury the control
  badges ⓘ mode exists for. The library is reached from the ⓘ-mode badge through
  `HelpContext.loadDemo`, which the badges are handed from `TourCtx.applyDemo` — the
  same late-bound loader the tour already uses.

  **Both doors open the same library** (v5). The badge's library marks, unfolds
  and scrolls to the loaded demo exactly as the row's ⓘ does: a library that
  forgot what was playing depending on which door you came through would contradict
  itself. It is read through `HelpContext.loadedDemo`, taken from
  `TourCtx.loadedDemo` — late-bound to `SongPanel.loadedDemo` like `applyDemo` —
  **when the badge is clicked**, never when the badges switch on: a demo loaded
  while the badges are showing must still be the one the next click marks.

- **REQ-a-blurb-folds-to-its-first-line** (v4) — **The list scans first and reads
  on demand.** Unfolded, the library was a wall of text: some blurbs run past a
  hundred words, so a handful of demos filled the window and the rest were a long
  scroll away. Each blurb therefore shows **its first line only** (CSS line clamp,
  ending in an ellipsis), with a **More** toggle under it that unfolds the whole
  text and then reads **Less** (`aria-expanded` follows it). Each entry folds on its
  own. A blurb that fits on one line gets **no** toggle: once the window has laid
  out, a toggle whose blurb would not grow is removed, because a control that
  changes nothing teaches the player to ignore the rest — and that blurb is
  **unclamped** with it: it fits one line at *this* width, and a narrower window
  later (a phone turned upright) must wrap it in full rather than hide its end
  behind an ellipsis that no toggle can undo. A demo with no blurb has
  nothing to fold. The facts line is never folded — it is the scanning line.

  *Gestures* (ADR-014): the toggle is a plain `<button>` — click or tap, or
  Enter/Space when focused, flips that one entry. Nothing else in the entry folds
  it, so a tap on the text while reading never collapses it.

- **REQ-every-machine-has-a-demo** (v2) — **Every machine is heard in at least
  one demo.** The library is how a new user meets the instrument, and a machine
  no demo uses is one they may never find. `demos-index.json` already records
  each demo's `uses`, so the check is cheap and stays true without naming a
  demo: the union of `uses` across the index must contain `seq`, `drums`,
  `sampler` and `motion`. Removing the last demo that exercises one fails the
  suite — the prompt to replace it, not to delete the check. Zip demos count:
  today they are the only ones that use the sampler.

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
  blurb?: string;            // merged from demo-notes.json (REQ-demo-prose-lives-apart)
}
export function demoMetaOf(file: SongFile): Omit<DemoMeta, 'blurb'>;
/** The facts alone — `124 BPM · 16 bars · seq + drums` — the library's facts line (v3). */
export function demoFacts(meta: DemoMeta): string;
/** The one-line summary the demo button's title shows (REQ-demo-row-says-what-it-knows):
 *  `demoFacts(meta) — blurb`. */
export function demoSummary(meta: DemoMeta): string;

// src/ui/components/demo-library.ts — lazy (REQ-the-library-reads-without-loading)
export interface DemoLibraryOptions {
  loadDemo: (name: string) => Promise<void>;
  /** Called before `loadDemo` when Load is pressed. */
  close: () => void;
  /** The loaded demo: its entry is marked, unfolded and scrolled into view, and its
   *  button reads "Loaded" (disabled). */
  focus?: string | null;
}
export function renderDemoLibrary(opts: DemoLibraryOptions): HTMLElement;
/** `renderDemoLibrary` in its own Modal (title "Demo library", a Close button). */
export function openDemoLibrary(opts: Omit<DemoLibraryOptions, 'close'>): void;

// src/ui/onboarding/help-content.ts (REQ-info-mode-badges-the-demo-row-once)
export interface HelpContext {
  bus: ParamBus;
  close: () => void;
  loadDemo: (name: string) => Promise<void>;   // v3 — the song.demos topic's Load
  loadedDemo: string | null;                    // v5 — read at click time; the library's focus
}

// src/ui/onboarding/tour.ts + src/ui/panels/song-panel.ts (v5)
interface TourCtx { /* … */ loadedDemo: () => string | null; }    // late-bound in app.ts
interface SongPanel { /* … */ loadedDemo: () => string | null; }
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
             -> reads src/state/demos/*.zip    (parseProjectZip, REQ-zip-demos-are-indexed-too)
             -> demoMetaOf(file) per demo      (pure, src/state/demo-meta.ts)
             -> merges src/state/demo-notes.json blurbs   (REQ-demo-prose-lives-apart)
             -> writes src/state/demos-index.json
check:demos  -> the same pass, writes nothing, fails on any difference
song.ts      -> imports demos-index.json; DemoRef gains `meta`
song-panel   -> mkDemoBtn sets button.title = demoSummary(meta)   (REQ-demo-row-says-what-it-knows)
             -> applySongWithUndo / New clear the loaded demo; applyDemo and a demo zip set it
                right after their apply; restoreStash puts back the stash's
                (REQ-the-loaded-demo-carries-an-info-button)
             -> the ⓘ click -> loadSurface(import('components/demo-library'))
                -> openDemoLibrary({ loadDemo, focus: loadedDemo })
info-badges  -> anchor song.demos = [data-help="song.demos"] (the Demos: label)
             -> HELP_TOPICS['song.demos'].body(ctx) = renderDemoLibrary({ loadDemo: ctx.loadDemo,
                  close: ctx.close, focus: ctx.loadedDemo })   (ctx.loadedDemo read at the click, v5)
                (REQ-info-mode-badges-the-demo-row-once)
```

Testids (catalogued in [testids](testids.md)): `demo-loaded-info` (the ⓘ — deliberately
*not* `song-demo-…`, which the row's enumeration treats as a demo button),
`demo-library` (the list), `demo-library-entry`, `demo-library-load` and
`demo-library-more` (the fold toggle, v4) (one per demo; the entry is found by its text, so no id is minted from data —
REQ-data-derived-ids-are-enumerated), and the badge `info-badge-song.demos`.

The generator is **async** now (zip inflate is streaming). It is a vitest entry
precisely because vitest is the only Vite-aware TS runner here — that has not
changed, and it is what lets it import `parseProjectZip` and `demo-meta.ts`
directly rather than reimplementing either.

### Persistence

Nothing new persists at runtime — the loaded demo's ⓘ is session state and
deliberately does not survive a reload (REQ-the-loaded-demo-carries-an-info-button). `demos-index.json` and `demo-notes.json` are
**source files**, committed and diffable; the first is generated and gated, the
second is written by hand and never rewritten by a tool.

## Scenarios (BDD)

```gherkin
Scenario: Every machine is used by some demo (v2, REQ-every-machine-has-a-demo)
  Given the shipped demos-index.json
  Then the union of every entry's uses contains seq, drums, sampler and motion
# pinned by: tests/state/demo-index.test.ts

Scenario: The index carries a demo's tempo, length and machines
  Given a demo with transport.bpm 124, a 16-bar seq chain and drum steps
  When clean:demos runs
  Then its index entry reads bpm 124, bars 16 and uses [seq, drums]
# pinned by: tests/state/demo-meta.test.ts

Scenario: An armed arp is reported as armed, not as used (REQ-uses-is-heard-armed-is-playable)
  Given a demo with arp.on 1 and no arp notes of its own
  Then `armed` contains 'arp' and `uses` does not
  # the arp follows the keyboard, never the sequencer (arpeggiator.md REQ-saved-arp-on-is-armed-not-broken)
# pinned by: tests/state/demo-meta.test.ts

Scenario: A motion bank behind motion.on 0 is armed, not missing (REQ-uses-is-heard-armed-is-playable)
  Given a demo carrying motion anchors with motion.on 0
  Then `armed` contains 'motion' and `uses` does not
# pinned by: tests/state/demo-meta.test.ts

Scenario: A bypassed effect is never reported as armed (REQ-uses-is-heard-armed-is-playable)
  Given a demo whose wah is dialled in but switched off
  Then `armed` reports only arp/motion — the corpus measurement (REQ-uses-is-heard-armed-is-playable) found an
    FX hint would fire on almost every demo and so mean nothing
# pinned by: tests/state/demo-meta.test.ts

Scenario: A hand-written blurb survives regeneration (REQ-demo-prose-lives-apart)
  Given demo-notes.json holds a line for a demo
  When clean:demos regenerates the index
  Then the blurb is present in the index and unchanged
  And a demo with no note still gets its generated facts
# pinned by: tests/state/demo-meta.test.ts

Scenario: The zip demos are indexed like any other (REQ-zip-demos-are-indexed-too)
  When clean:demos runs
  Then both *.websynth.zip demos have index entries with their real names
# pinned by: tests/state/demo-index.test.ts

Scenario: A stale index fails CI (REQ-demo-facts-are-generated, regression)
  Given a demo whose tempo was edited without regenerating the index
  When check:demos runs
  Then it fails naming demos-index.json
# pinned by: scripts/clean-demos.ts (CLEAN_DEMOS_CHECK)

Scenario: A demo button says what it is without being clicked (REQ-demo-row-says-what-it-knows)
  Given the Song tab's demo row
  Then each button's title names its tempo, length and machines
# pinned by: e2e/demo-library.spec.ts

Scenario: The facts line is the summary without the blurb (v3)
  Given a demo's metadata with a blurb
  Then demoSummary is demoFacts, " — ", then the blurb
  And demoFacts drops an unknown tempo or length rather than printing a zero
# pinned by: tests/state/demo-meta.test.ts

Scenario: The library lists every demo and loads none (REQ-the-library-reads-without-loading)
  Given the demo library is rendered
  Then it has one entry per demo, in demoNames() order, each with its facts line
  And a blurb is set as text, never parsed as HTML
  And no loader has been called
  When Load is pressed on an entry
  Then the window closes first and loadDemo receives that demo's name
# pinned by: tests/ui/demo-library.test.ts

Scenario: The loaded entry is marked (REQ-the-loaded-demo-carries-an-info-button)
  Given the library is rendered with focus on a demo
  Then exactly that entry carries aria-current
  And its blurb is unfolded, and its button reads "Loaded" and is disabled (v4)
  And every other entry's button reads "Load"
# pinned by: tests/ui/demo-library.test.ts

Scenario: A blurb folds to its first line (REQ-a-blurb-folds-to-its-first-line)
  Given the library is rendered without a focus
  Then every blurb is folded, each with a More toggle (aria-expanded false)
  When one toggle is pressed
  Then that blurb unfolds, its toggle reads Less, and every other blurb stays folded
  When it is pressed again the blurb folds back
# pinned by: tests/ui/demo-library.test.ts

Scenario: A blurb that fits one line has no toggle (REQ-a-blurb-folds-to-its-first-line)
  Given the library is laid out and a blurb's full height is its folded height
  Then that entry has no More toggle
  And that blurb is no longer clamped, so a narrower window wraps it in full
# pinned by: tests/ui/demo-library.test.ts (layout stubbed — jsdom lays nothing out)
#            + e2e/demo-library.spec.ts (a real layout: the long blurbs keep theirs)

Scenario: The loaded demo carries an ⓘ that opens its notes (REQ-the-loaded-demo-carries-an-info-button)
  Given the Song tab with no demo loaded
  Then there is no demo-loaded-info button
  When a demo button is clicked
  Then demo-loaded-info sits directly after that demo's button
  When it is clicked
  Then the demo library opens with that demo's entry marked
# pinned by: e2e/demo-library.spec.ts

Scenario: New takes the ⓘ away and Undo brings it back (REQ-the-loaded-demo-carries-an-info-button)
  Given a loaded demo showing its ⓘ
  When another song replaces it (New) the ⓘ is gone
  When the undo toast is pressed after a load over a loaded demo
  Then the ⓘ is back after the first demo's button
# pinned by: e2e/demo-library.spec.ts

Scenario: ⓘ mode reaches the library without loading (REQ-info-mode-badges-the-demo-row-once)
  Given the info badges are on and the Song tab is showing
  Then one badge, info-badge-song.demos, is drawn for the demo row
  When it is clicked the library opens, and nothing has loaded
  When Load is pressed on an entry
  Then that demo loads, the slot picker names it, and its ⓘ appears
# pinned by: e2e/demo-library.spec.ts

Scenario: Both doors open the same library (v5, REQ-info-mode-badges-the-demo-row-once)
  Given the info badges are on and a demo was loaded after they were switched on
  When the song.demos badge is clicked
  Then that demo's entry is marked, unfolded, and its button reads "Loaded"
# pinned by: tests/ui/demo-library.test.ts (the topic passes ctx.loadedDemo as the focus)
#            + e2e/demo-library.spec.ts (through the real wiring)
```

## Tests & verification

- Unit: `tests/state/demo-meta.test.ts` (the extractor, against hand-built
  fixtures — never against a named shipped demo), `tests/state/demo-index.test.ts`
  (every shipped demo has a well-formed entry), `tests/ui/demo-library.test.ts`
  (the library window, jsdom) — `npm test`
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
  is a v2 file with no XY and no motion. The floor is now enforced
  (REQ-every-machine-has-a-demo); the lopsidedness above it is not, on purpose.
