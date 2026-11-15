# Onboarding (guided tour, help copy & About)

```yaml
id: onboarding
status: implemented
version: 31
owner: core
related:
  - architecture
  - info-badges          # the ⓘ badges and the header button that toggles them
  - input-control
  - keyboard-layout
  - midi-clock-sync
  - webrtc-sync
  - motion-sequencer
  - step-grid-editing
  - sequencer
  - scale-quantization
  - chord-tools
  - mod-matrix
  - render-to-sampler
  - presets
  - audio-export
  - record-window
  - lazy-load-failure     # REQ-the-help-door-never-fails-silently — the report every deferred surface shares
source:
  - src/ui/onboarding/tour.ts
  - src/ui/onboarding/help-content.ts
  - src/ui/onboarding/help-widgets.ts
  - src/ui/onboarding/index.ts            # the synchronous facade (contract below)
  - src/ui/onboarding/onboarding-impl.ts  # the lazily-imported body it fronts
  - src/ui/styles/tour.module.css       # .toggleActive + the badge/glyph colours
  - src/ui/components/about-button.ts   # the tour-replay route (REQ-about-is-the-single-door-for-help)
  - src/main.ts                         # REQ-the-help-door-never-fails-silently — the idle warm that prevents it
```

First-run guidance: an interactive spotlight tour, the help copy, and the About
door. The per-control **info badges** that show that copy are
[info-badges](info-badges.md)'s.

## Background / Why

New users face a dense control surface, so the tour walks them through it one
control at a time with a dimmed spotlight and a callout. The spotlight is
`pointer-events: none`, so the **real control underneath stays clickable** — that's
what lets steps like "press a key" or "press Play" be genuinely interactive rather
than a slideshow. The tour takes its runtime hooks via an injected `TourCtx` so it
never reads DEV-only globals.

**The header has exactly two doors**: ⓘ toggles the badges, because they draw
themselves as ⓘ circles ([info-badges](info-badges.md)), and **?** opens About
(REQ-about-is-the-single-door-for-help) —
[ADR-014](../decisions/adr-014-dont-make-me-think.md) law 1: an icon means one
thing.

## Requirements

- **REQ-the-tour-highlights-one-target** — The tour highlights one target at a
  time; only the callout (and its Back/Skip/Next) is clickable — the spotlighted
  control remains live.

- **REQ-interactive-tour-steps-work-for-real** — Interactive steps (play a note,
  press Play, load a demo) work against the real app via injected hooks, not
  globals.

- **REQ-callout-placement-adapts** — Placement of callouts adapts
  (`auto`/top/bottom/left/right) to stay on-screen.

- **REQ-help-copy-tells-the-truth** (v5) — Help copy tells the truth about what
  a control does:
  - The `modWheel` topic explains the wheel's actual routing — it **adds to the
    LFO Amount** (engine clamps the sum to 1), so it deepens whatever the LFO
    destination is aimed at: wobble (cutoff), vibrato (pitch), tremolo (amp) or
    PWM movement (pulse) — and that it does nothing while the LFO destination
    is off.
  - The two header buttons' tooltips name **what they do**, not what they are:
    the ⓘ button reads "Show info badges (?)" while inactive and "Hide
    info badges (?)" while active — the parenthetical is the keyboard route, the
    discoverability leg `recipes/design-an-interaction.md` step 4 asks for. The
    ? button reads "Help & About": it names both things behind it (the guided
    tour and the shortcut list, plus version and credits) rather than only the
    modal's title. A tooltip never names a gesture that does not exist.

- **REQ-the-tour-showcases-the-song-tab** (v6) — The tour showcases the Song tab
  before its closing step: one step spotlights the arrangement **chain lanes**
  (`song-lane-seq` — banks chained one per bar, plus the per-lane
  mute/solo/level mixer) and the next the **live DJ FX** (`perf-stutter` —
  Fill/Stutter/Drop/Tape Stop + the DJ filter). Both use `precondition:
  clickTestId('tab-song')` — on *both* steps, not just the first, so **Back**
  from the closing step (or a stray tab click) re-opens the Song tab. The
  closing step targets the header `info-badges` button
  and switches no tab, so the tour **ends with the Song tab open
  and active** — the user is left ready to play rather than parked on the
  Sequencer. The demo loaded earlier in the tour populates the chains, so the
  lane spotlight lands on real content. Its copy names **both** header doors — ⓘ
  for the badges it is spotlighting, ? for replaying this tour — because the
  closing step is the last moment the tour can hand over the two things a stuck
  user needs.

- **REQ-help-copy-covers-the-gesture-model** (v7) — **Help copy covers the
  gesture model.** The grid gestures ([step-grid-editing](step-grid-editing.md))
  are invisible by construction — nothing on screen says a step can be dragged,
  held or bulk-cleared — so the `seq`, `drums` and `sampler` topics each carry
  the same authored paragraph naming drag-to-paint (starting lit = erase),
  press-and-hold / right-click to select without toggling, `Delete`, `Clear ▾`
  and tab-scoped `Ctrl+Z`. It is **one shared constant** concatenated into the
  three bodies, not three paraphrases, so the gesture vocabulary cannot drift
  between machines. `motion` states its own variant, because its grid has no
  tap-toggle (drag sets a value, double-click clears) and its `Clear ▾` lists
  lanes rather than a selected row (step-grid-editing
  REQ-clear-menu-clears-in-bulk).

- **REQ-the-tour-teaches-the-grid-gestures** (v7) — **The tour teaches the grid
  gestures.** A "Paint a pattern" step sits between the pattern-tabs step and
  the Song-tab steps. It targets **`panel-drums`** (`precondition:
  clickTestId('tab-drums')`), deliberately *not* `panel-seq`: the preceding step
  already spotlights `panel-seq`, and two consecutive steps sharing a target
  leave the spotlight rect unmoved, which reads as "nothing happened". The drum
  grid also carries the demo song's hits by this point (same rationale as
  REQ-the-tour-showcases-the-song-tab), so the gesture lands on real content.

- **REQ-about-key-symbols-are-drawn** (v11, mechanism replaced v17) — **Symbols
  in the About modal's key list are legible.** A symbol cap (`← → ↑ ↓`) is
  **drawn**: an `svg.ui-icon` from `ui-icons.ts`, on a cap carrying `role="img"`
  and an `aria-label` because it holds no text ([iconography](iconography.md)).
  Deliberate: not a typed character re-faced to another font — no font is bundled,
  so on Android the character falls through to a symbol face at its own weight and
  baseline. One glyph per keycap, never a run inside a string.
  The list is also the canonical on-screen shortcut reference, so it must name
  every global key — including `Home` / `Shift`+arrows
  ([transport-position.md](transport-position.md) REQ-home-and-shift-arrows-seek), `Delete`,
  `Ctrl/Cmd+Z`, `?`, and `Shift`+`R` for the
  [Record window](record-window.md) (REQ-shift-r-toggles-the-record-window there). It already carries non-key gestures (`Shift`+drag for fine knob
  control), so a mouse row is in keeping. The v13 `Shift`+click-on-Help row is
  **gone** in v15 along with the gesture itself.

- **REQ-the-key-list-folds-to-six-rows** (v15) — **The key list is folded to its
  first six rows.** Fifteen rows of mostly-advanced keys made the modal long
  enough that the tour button, the version and the Debug section all fell below
  the fold on a phone, so only the note rows, the octave keys, the two bend keys
  and `Space` show by default; the header row expands the rest. Load-bearing
  details:
  - This is a **display default, not a removal** — REQ-about-key-symbols-are-drawn's "names every global
    key" still holds, one click away, so the discoverability claims in
    [transport-position.md](transport-position.md) REQ-every-ruler-tick-carries-a-title and
    [record-window.md](record-window.md) REQ-shift-r-toggles-the-record-window (which cite this list) stay true.
  - The fold is the **same component** as the Debug section's
    (`createCollapseToggle`, whole header row clickable, `▾` from
    `tabs.module.css`) — one fold idiom per modal, not two. Its target is the
    **one** `.keys` grid, which keeps the two columns aligned across the cut;
    the hidden rows are `display: none` cells, not a second grid.
  - Persisted under `websynth.shortcuts.about`, default folded, so someone who
    wants the full reference keeps it. The header's right-hand hint reads
    **"Show all"** when folded and **"Show less"** when open — the verb is the
    point: a bare "all" is a label the reader has to interpret, where "Show all"
    says what the click does. The chevron carries its own `aria-label` ("Show
    all keyboard shortcuts") rather than the component's generic one.
  - The cut point is **`Space`** — the last row a first-time player needs. Rows
    below it are transport-position, performance and editing keys, which is also
    why `?` (row 14) is not the badges' discoverability route: the always-visible
    ⓘ button is (REQ-the-info-button-is-a-toggle). The count moved from five rows to six when pitch bend
    split into one row per key ([input-control](input-control.md) REQ-pitch-bend-is-quote-and-slash); the
    rule is "through `Space`", not a magic number.

- **REQ-keys-are-drawn-as-keys** (v16) — **Keys are drawn as keys, and the note
  rows are drawn as a keyboard.** A combo is an ordered list of **tokens** — a
  keycap or a run of literal text — never one parsed string. Two things follow,
  and both are the requirement rather than decoration:
  - **Only actual keys look like keys.** `Shift + drag` renders one cap
    (`Shift`) beside plain text — "hold this, then use the mouse". Same for
    `F (hold)`.
  - **The two note rows are a two-row keyboard diagram** in the keys' real
    relative positions: sharps on top, offset by half a cap so each sits in the
    gap between its two naturals, with the gaps at **E–F** and **B–C** left
    empty, so the block reads as a piano. Naturals and sharps carry **different
    cap tints**, so the two ranks read apart.
  - **The diagram is derived from `NOTE_ROWS`**
    (`notes(NOTE_ROWS.lower)` / `notes(NOTE_ROWS.upper)` in `about-shortcuts.ts`;
    `LOWER`/`UPPER` themselves stay module-private in `src/ui/shortcuts.ts` —
    [input-control](input-control.md) REQ-two-key-rows-an-octave-apart), never
    restated in the About code, so it cannot drift from the bindings. Naturals are the
    semitones `{0,2,4,5,7,9,11}` of each row's own base; a sharp occupies the gap
    after the natural below it.
  - **The cap labels follow the active keyboard layout.** A cap that
    stands for a physical key carries `data-code` and takes its label from
    [keyboard-layout](keyboard-layout.md); switching layout relabels those caps
    **in place**, because the diagram's structure — which rank, which column,
    where the E–F and B–C gaps fall — is the piano's and never varies. Only the
    note diagram uses `data-code`: the `F`, `R` and `Z` caps are fixed labels
    for bindings that do not move (keyboard-layout REQ-layout-scope-is-note-keys-only).
  - **A gear beside the section title** opens the layout picker (a `Dropdown` in
    a row revealed under the header). It must stop its click from reaching the
    header, which is the fold's `trigger` — otherwise choosing a layout would
    also collapse the list you opened it to read.
  - Empty gaps are **cap-sized invisible spacers**, not margins, and caps have a
    fixed width (only multi-character caps grow), so the half-cap offset is exact
    by construction.
  - The cell class is **`.combo`, not `.key`**, which is the Debug section's
    left column ([debug-panel](debug-panel.md)).

- **REQ-about-is-the-single-door-for-help** (v15) — **About is the single door
  for help.** With the chooser modal gone, the About modal carries a full-width
  **"Take the guided tour"** button (testid `start-tour`) placed **between the
  version/credits block and the Keyboard Shortcuts header** — above the
  shortcuts, because replaying the tour is the one action in the modal and
  everything below it is reference. It is the only tour-replay route in the app;
  the first-visit auto-launch (`websynth.onboarding.done`, `main.ts`) is
  unchanged and still calls the same `Onboarding.startTour`. `createAboutButton`
  therefore takes that hook as an injected dep, the same way the tour takes its
  `TourCtx` (REQ-interactive-tour-steps-work-for-real) — the About modal must
  not reach into the onboarding layer itself.

- **REQ-the-help-door-never-fails-silently** (v25) — **The help door never fails
  silently.** Both surfaces behind it load on demand
  ([runtime-performance](runtime-performance.md)
  REQ-boot-cost-matches-the-request) — the About card via
  `import('./about-modal')`, the tour and badges via the facade's
  `import('./onboarding-impl')` — and a rejected `import()` used to do *nothing
  at all*: no card, no error, a `?` button that reads as broken. The realistic
  trigger is an offline revisit whose chunk was never fetched while online
  (`pwa-install.md` REQ-service-worker-is-registered caches only what the page
  actually requested), and help is precisely what someone reaches for when they
  are stuck.

  Two halves, because either alone is insufficient:

  - **Prevention.** The About body joins `lamejs` and the onboarding body in
    `main.ts`'s idle warm set, so one online visit is enough to make it openable
    offline forever after. This is REQ-the-tour-highlights-one-target's standing rule — *a deferred surface
    the user can reach offline is warmed on idle* — applied to the surface that
    most needs it; the warm swallows its error, because the click still retries.
  - **Report.** When the `import()` rejects anyway (the first visit went offline
    before idle, a flaky network, a purged cache), the trigger raises a
    [toast](toast.md) naming the surface and offering **Retry**, rather than
    returning silently. The About button and both facade commands (`startTour`,
    `toggleInfoBadges`) route their failures through the app-wide
    `showLazyLoadFailure` — wording, retry rule and the rest of the trigger set
    are [lazy-load-failure](lazy-load-failure.md); the help door was simply the
    first place its absence was noticed.

  A failed facade load must also **not poison the memo**. `index.ts` caches its
  import promise so two triggers cannot build two `InfoBadges` (REQ-the-tour-highlights-one-target), but a
  cached *rejection* is permanent: every later attempt reuses it, so the tour
  stays dead even after the network returns. The catch clears `pending` before
  rethrowing, making Retry — and any subsequent click — a real retry.

## Technical design

### Contract / public interface

```yaml
tour.ts:
  Placement = 'auto' | 'top' | 'bottom' | 'left' | 'right'
  TourTarget = string | (() => Element | null)
  TourCtx (injected hooks):
    bus, engine
    toggleTransport()        # via the header button (keeps LED/label synced)
    applyDemo(name): Promise # load a demo song (does not start transport).
                             #   ASYNC: all but the built-in are fetched on
                             #   click (song-mode REQ-drop-in-demos-are-fetched-on-click), so a step that acts on
                             #   the loaded song must await it (see below).
                             #   The tour names DEMO_FOR_TOUR by constant while
                             #   demo files are data; song-mode REQ-drop-in-demos-are-fetched-on-click's
                             #   resolveDemoName means a renamed or deleted demo
                             #   degrades to the first one, never to nothing.
    resumeAudio(): Promise   # idempotent AudioContext resume (before note step)
    expandFx()               # open the collapsible FX section
info-badges.ts / help-content.ts: per-control info badges + copy
Onboarding (index.ts facade):     # fully SYNCHRONOUS — see the note below
  startTour()
  toggleInfoBadges() / isInfoBadgesActive() / onInfoBadgesChange(cb)
  shouldAutoLaunch()
onboarding-impl.ts:               # the lazy body; nothing outside index.ts imports it
  createOnboardingImpl(ctx, onBadgeChange, markDone): { startTour, toggleInfoBadges }
components/info-badges-button.ts:
  createInfoBadgesButton({ toggle, isActive, onChange }): HTMLButtonElement
components/about-button.ts:
  createAboutButton(engine, { startTour }): HTMLButtonElement   # REQ-about-is-the-single-door-for-help
components/lazy-load-toast.ts:
  showLazyLoadFailure(surface: string, retry: () => void): void # REQ-the-help-door-never-fails-silently
```

**The facade is synchronous; its body is not.** `tour.ts`, `info-badges.ts`,
`help-content.ts`, `help-widgets.ts` and `envelope-graph.ts` are ~90 kB reached only from
`onboarding-impl.ts`, which `index.ts` `import()`s on the first `startTour()` or
`toggleInfoBadges()` ([`runtime-performance.md`](runtime-performance.md) REQ-boot-cost-matches-the-request).
No caller changes, and none may be made to await: `shell/header.ts` wires
`toggleInfoBadges`/`isActive`/`onChange` into the ⓘ button and
`UiBridge.toggleInfoBadges` at header-build time — *before* any gesture — so the
facade must already exist and answer then. The two readers keep working because
`shouldAutoLaunch()` needs only `localStorage` and `isInfoBadgesActive()` is
`false` until the body loads, which is exact rather than approximate: the badges
cannot be showing before the code that shows them exists. The load is memoized,
so the ⓘ button and the `?` key racing each other still yield one `InfoBadges`.
Because a returning visitor can reach help **offline**, the chunk is also warmed
on idle from `main.ts` ([`pwa-install.md`](pwa-install.md) REQ-deferred-chunks-are-warmed-on-idle).

### Layer touchpoints

```yaml
boot: onboarding/index.ts wires the tour + info badges with a TourCtx from main.ts
interactivity: spotlight overlay is pointer-events:none so the underlying control
  stays clickable; only the callout intercepts clicks
```

## Scenarios (BDD)

```gherkin
Scenario: The spotlighted control stays interactive
  Given the tour is on the "press a key" step
  When the user clicks the spotlighted key
  Then the note actually sounds and the step advances
# pinned by: e2e/onboarding.spec.ts

Scenario: Callout placement stays on-screen (edge)
  Given a target near the viewport edge
  When the callout renders with placement 'auto'
  Then it flips to a side that keeps it fully visible
# pinned by: tests/ui/tour-place.test.ts

Scenario: The ? button opens About, which is the only tour-replay route (v15, REQ-about-is-the-single-door-for-help)
  Given the app is loaded
  When the user clicks the ? button
  Then the About modal opens with "Take the guided tour" above Keyboard Shortcuts
  When the user clicks it
  Then the modal closes and the guided tour starts
# pinned by: tests/ui/about.test.ts, e2e/onboarding.spec.ts

Scenario: The tour ends on the Song tab, ready to play (v6)
  Given the tour is running
  When the user advances past the chain-lane and live-FX steps and presses Done
  Then the Song tab is the active tab, showing the chains and live FX
# pinned by: e2e/onboarding.spec.ts

Scenario: Every step grid explains its gestures the same way (v7)
  Given the info badges are on
  When the user opens the Sequencer, Drum Machine and Sampler topics in turn
  Then each names drag-to-paint, hold-to-select, Delete and Clear ▾ in identical words
# pinned by: tests/ui/help-content.test.ts

Scenario: The tour's gesture step moves the spotlight to the drum grid (v7)
  Given the tour has passed the "Build your own patterns" step
  When the user presses Next
  Then the Drum tab opens and the callout explains tap / drag / hold / Clear ▾
# pinned by: e2e/onboarding.spec.ts

Scenario: The gear switches layout without folding the list (v17, REQ-keys-are-drawn-as-keys)
  Given the About modal is open with the shortcut list expanded
  When the user clicks the gear beside "Keyboard Shortcuts"
  Then the layout select appears and the list stays expanded
  When they pick AZERTY
  Then the naturals rank relabels to W X C V B N , ; in place
# pinned by: tests/ui/about.test.ts

Scenario: The note rows read as a keyboard (v16, REQ-keys-are-drawn-as-keys)
  Given the About modal is open on the qwerty layout
  Then the lower-octave row is two ranks of caps: 8 naturals below, 5 sharps
    above, each sharp offset into the gap between its two naturals
   And the gaps at E-F and B-C are cap-sized blanks, not missing cells
   And naturals and sharps carry different cap tints
   And every letter comes from NOTE_ROWS, so the diagram cannot disagree with the
    keys it documents
# pinned by: tests/ui/about.test.ts

Scenario: Only real keys are drawn as keys (v16, REQ-keys-are-drawn-as-keys)
  Given the About modal is open and the shortcut list is expanded
  Then the "Shift + drag" row shows exactly one cap, labelled Shift
   And "drag" is plain text, so the row cannot read as a keyboard shortcut
# pinned by: tests/ui/about.test.ts

Scenario: Arrow keys are readable in the About shortcut list (v11, REQ-about-key-symbols-are-drawn)
  Given the About modal is open and the shortcut list is expanded
  Then each arrow is a cap carrying the glyph class rather than left to the
    monospace face, which has no glyph for it
   And the list names Home, Shift+arrows, Delete, Ctrl/Cmd+Z, Shift+R and ?
   And no row mentions Shift+click on Help — that gesture is gone (v15)
   And pitch bend is two rows, ' above /, never a combined one (input-control REQ-pitch-bend-is-quote-and-slash)
# pinned by: tests/ui/about.test.ts

Scenario: The shortcut list is folded through Space by default (v15, REQ-the-key-list-folds-to-six-rows)
  Given the About modal is opened for the first time on this device
  Then six key rows are visible, the last of them Space, and the hint reads "Show all"
   And the rest are present in the same grid but hidden
  When the user clicks the Keyboard Shortcuts header
  Then every row is visible and the hint reads "Show less"
   And the choice is persisted under websynth.shortcuts.about, independently of
    the Debug section's own fold
# pinned by: tests/ui/about.test.ts

Scenario: The ? button says so when the About body cannot load (v25, REQ-the-help-door-never-fails-silently, regression)
  Given the About modal body has not loaded and its import will reject
  When the user clicks the ? button
  Then no card is appended, and a toast names Help & About and offers Retry
  And the toast says "you're offline and this part of the app isn't
    downloaded yet" while navigator.onLine is false, and "the download failed"
    while it is true
# pinned by: tests/ui/lazy-load-failure.test.ts

Scenario: Retry opens About once the import succeeds (v25, REQ-the-help-door-never-fails-silently, regression)
  Given the ? button raised the load-failure toast
  When the import stops rejecting and the user clicks Retry
  Then the About card opens normally
# pinned by: tests/ui/lazy-load-failure.test.ts

Scenario: A failed onboarding load is retryable, not permanent (v25, REQ-the-help-door-never-fails-silently, regression)
  Given the facade's import of onboarding-impl rejects
  When startTour() is called
  Then a toast names the guided tour and offers Retry
    — and names the info badges instead when the ⓘ toggle is what failed
  And the memoized promise has been cleared, so a later call imports again
    and starts the tour rather than replaying the cached rejection
# pinned by: tests/ui/lazy-load-failure.test.ts
```

## Tests & verification

- `tests/ui/tour-place.test.ts` (placement math), `e2e/onboarding.spec.ts`
  (interactive flow).
- `tests/ui/about.test.ts` (the tour button, the folded key list, REQ-the-key-list-folds-to-six-rows/REQ-about-is-the-single-door-for-help).
- REQ-the-help-door-never-fails-silently's two halves are verified apart: the **report** by
  `tests/ui/lazy-load-failure.test.ts` (both lazy modules mocked to throw on
  evaluation, which is what a rejected chunk fetch looks like), the
  **prevention** only by hand — load the built app
  online once, then reload it with DevTools ▸ Network ▸ Offline and open `?`.
  A green suite says nothing about whether the chunk is in the cache.
- `npm test` / `npm run e2e`.

## Open questions / future

- New tour steps should keep using injected `TourCtx` hooks (never DEV globals) so
  they work in production builds.
