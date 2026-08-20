# Onboarding (guided tour & info badges)

```yaml
id: onboarding
status: implemented
version: 25  # v25: the help door never fails silently — the About body is warmed
             #      on idle so it opens offline, and a rejected import says so
             #      with a retry instead of doing nothing (REQ-24)
             # v24: a meter topic + badge on the header picker (REQ-23)
             # v23: a badge hides when its anchor leaves the viewport in EITHER
             #      direction — the below-the-fold half was missing (REQ-5b)
             # v22: the facade's five signatures are unchanged, but its body now
             #      loads on the first startTour()/badge toggle
             #      (runtime-performance.md REQ-1)
             # v21: a `mod` badge on the Song row's MOD launcher (REQ-21)
             # v20: `key` and `seq.chord` badges for the scale/chord tools (REQ-22)
             # v19: an `lfo2.rate` sweet-spot badge, and the LFO panel's page
             #      shell joins the reflow observer list (REQ-5a, lfo.md REQ-15)
             # v18: while the badges show, the ⓘ button's glyph inverts to the
             #      badge's own colours, and the `presets` badge moves off its
             #      neighbour onto the preset selector (REQ-8/REQ-12)
             # v17: the diagram's caps are labelled from the active keyboard
             #      layout, switchable from a gear beside the section title
             #      (REQ-17c, keyboard-layout.md)
             # v16: the About key list renders keycaps, and the two note rows
             #      become a keyboard diagram derived from the real bindings
             #      (REQ-17c)
             # v15: the Info/Help split collapsed — ⓘ toggles the badges and
             #      nothing else, ? opens About, the Help chooser modal is gone,
             #      and About absorbs the tour button + a folded key list
             #      (REQ-8/9/10/17/19/20)
             # v14: the two audio topics rewritten for the Record window + export
             #      modal, and Shift+R added to the key list (REQ-16b/REQ-17)
             # v13: instant badge toggle — Shift/Ctrl+click or long-press the Help
             #      button, plus the `?` key; no modal round-trip (REQ-19)
             # v12: a `song.fx` badge on the Live FX launcher — the last unbadged
             #      section on the Song tab (REQ-18)
             # v11: playhead-ruler + Song-transport badges; symbol glyphs in the
             #      About modal's key list (REQ-16/REQ-17)
             # v10: TourCtx.applyDemo is async (demos are fetched on click)
             # v9: a `seq.render` badge on the Sequencer's "Import into sampler" Render button
             # v8: per-lane Motion help badges (motion.xy / motion.tracks)
             # v7: grid-gesture copy, a `presets` topic, and a "Paint a pattern" tour step
owner: core
related:
  - architecture
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
  - lazy-load-failure     # REQ-24 — the report every deferred surface shares
source:
  - src/ui/onboarding/tour.ts
  - src/ui/onboarding/info-badges.ts
  - src/ui/onboarding/help-content.ts
  - src/ui/onboarding/help-widgets.ts
  - src/ui/onboarding/index.ts            # the synchronous facade (contract below)
  - src/ui/onboarding/onboarding-impl.ts  # the lazily-imported body it fronts
  - src/ui/components/info-badges-button.ts
  - src/ui/components/header-icons.ts   # the ⓘ glyph's part hooks (REQ-8b)
  - src/ui/styles/tour.module.css       # .toggleActive + the badge/glyph colours
  - src/ui/components/about-button.ts   # the tour-replay route (REQ-20)
  - src/main.ts                         # REQ-24 — the idle warm that prevents it
```

First-run guidance: an interactive spotlight tour and persistent **info badges**
that annotate controls.

## Background / Why

New users face a dense control surface, so the tour walks them through it one
control at a time with a dimmed spotlight and a callout. The spotlight is
`pointer-events: none`, so the **real control underneath stays clickable** — that's
what lets steps like "press a key" or "press Play" be genuinely interactive rather
than a slideshow. The tour takes its runtime hooks via an injected `TourCtx` so it
never reads DEV-only globals.

**Why the header has exactly two doors (v15).** The badges draw themselves as
**ⓘ** circles, so the header's ⓘ button has to be the thing that switches them
on — anything else makes the user hunt for it. Up to v14 that button opened the
About modal instead; the badges hid behind the **?** button's chooser modal, and
three extra gestures (modifier-click, long-press, `?`) had been bolted onto that
button to skip the modal. Each of those was a workaround for the same wrong
split. v15 deletes the split rather than papering over it again: **ⓘ toggles the
badges, ? opens About**, and the chooser modal — along with everything that
existed to route around it — is gone.
[ADR-014](../decisions/adr-014-dont-make-me-think.md) law 1: an icon means one
thing.

## Requirements

- **REQ-1** — The tour highlights one target at a time; only the callout (and its
  Back/Skip/Next) is clickable — the spotlighted control remains live.

- **REQ-2** — Interactive steps (play a note, press Play, load a demo) work against
  the real app via injected hooks, not globals.

- **REQ-3** — The info badges show per-control help content from
  `help-content.ts`. The badge *vocabulary* is "info" (the ⓘ glyph the user
  clicks): `InfoBadges`, `Onboarding.toggleInfoBadges`, `UiBridge.toggleInfoBadges`,
  testids `info-badge-layer` / `info-badge-<topic>`, badge `aria-label`
  `Info: <title>`. The *content* vocabulary stays "help" — `help-content.ts`,
  `HelpTopic`, `HELP_TOPICS`, `TopicId` and the `data-help="<topic>"` anchors —
  because an info badge opens a help topic, and the anchors are spread across
  every panel file. The boundary is deliberate, not drift.

- **REQ-4** — Placement of callouts adapts (`auto`/top/bottom/left/right) to stay
  on-screen.

- **REQ-5** — The Song panel's file/audio buttons each carry their own badge —
  `song.load`, `song.save`, `song.import`, `song.export`, `song.new`,
  `song.exportAudio`, `song.record` — and their copy disambiguates the
  easy-to-confuse pairs (Save vs Export; Export the `.json` project vs Export
  Song the WAV/MP3 audio). These pin to the buttons' existing testids, so they
  reposition/hide on tab switch via the same reflow path as other in-panel
  badges (e.g. `seq.prob`).

- **REQ-5a** (v19) — **Every container that shows and hides a badge's anchor must
  be in the reflow observer's selector list.** `position()` hides a badge whose
  anchor measures zero, and `enable()` re-runs it from a `ResizeObserver` over
  the containers that toggle — which is why `[data-testid="panel-seq"]` is
  observed. A [panel-tabs](panel-tabs.md) page shell is the same kind of
  `display:none ↔ flex` container, so the LFO panel's first page
  (`ppage-lfo-1`) joins the list; without it the `lfo.rate` badge does not come
  back when the user returns from LFO 2's page. The second page needs no entry:
  its own anchor (`knob-lfo2.rate`) lives inside it, and revealing it is what
  triggers the observer on page 1 collapsing.

- **REQ-5b** (v23) — **A badge is shown only where it can be reached: hidden when
  its anchor leaves the viewport in *either* direction.** The badges are
  `position: fixed`, so they do not scroll with the page — `position()` re-pins
  every one of them on each scroll frame, and a badge whose computed spot is
  outside the viewport is not a badge the user can click. Three rules, one idea:
    - **zero-size anchor** (a collapsed panel, a hidden tab) → hide (REQ-5a);
    - **above** — the badge's top crosses into the sticky header's band
      (`top < header.bottom`) → hide, or it paints over the header. Anchors
      *inside* the header are exempt: they never scroll away, so measuring them
      against their own container would hide them permanently (REQ-12);
    - **below** (v23) — the badge's bottom crosses the viewport's
      (`top + BADGE_SIZE > innerHeight`) → hide.
  Only the last one is new. Without it the rule was half a rule: scrolling a
  control up under the header dropped its badge, scrolling it down past the fold
  left the badge pinned off-screen — present in the layer, styled `display: ''`,
  reachable by nothing. The thresholds are deliberate mirrors: **any** overlap
  with the band hides, so a half-clipped badge — as unreachable as a fully hidden
  one, and uglier — never survives at either edge. No horizontal rule joins them:
  the faceplate is laid out to fit its width at every breakpoint
  ([responsive-header](responsive-header.md) REQ-1), so nothing scrolls sideways
  to fall off.

- **REQ-6** (v2) — The Song panel's Sync section carries two help topics:
  `sync` (what Master/Slave mean + the USB-MIDI connection steps — Android
  USB-MIDI peripheral mode / loopMIDI on Windows) anchored to
  `sync-mode-master`, and `sync.wifi` (WiFi pairing steps: same network + client
  isolation off → Create on one device, Join on the other, swap codes via QR or
  copy-paste) anchored to `sync-wifi-link`. See
  [midi-clock-sync.md](midi-clock-sync.md) / [webrtc-sync.md](webrtc-sync.md).

- **REQ-7** (v3) — A `motion` help topic anchors to the Motion machine's tab
  (`tab-motion`, like the other machine tabs). Its copy explains the mini-pad
  anchors and, above all, the **Y/X graph view**: the overlay line projects one
  axis at a time (the toggle picks which assigned param it traces; the dots
  never move) and its shape follows Step/Slide mode. See
  [motion-sequencer.md](motion-sequencer.md) REQ-8.

- **REQ-8** (v4, rewritten v15) — **The header's ⓘ button (`info-badges`) is a
  pure toggle.** One click shows the badges, one click hides them, in every
  state; it opens no modal and has no second outcome. It carries the orange
  `toggleActive` state (`tour.module.css`, shared with the Fullscreen button)
  **and** `aria-pressed`, so the on/off state is legible to sighted and
  assistive users alike. Until v14 the same click had two different outcomes
  depending on state (open a modal / switch the badges off), which is exactly
  what [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2 forbids; the
  active styling was cited as licensing it. v15 removes the ambiguity instead of
  licensing it.

- **REQ-8b** (v18) — **While the badges show, the glyph inverts into a badge.**
  `toggleActive` alone is *generic* active chrome — the Fullscreen button wears
  the same border and glow — so it says "this button is on", not "this button is
  the badges' switch". The active ⓘ therefore also takes the badge's own colour
  pair: the ring fills with `--accent` and the stem + tittle are drawn in
  `--bg-deep`, exactly `.badge`'s `background`/`color`. A user hunting for the
  way to turn the badges off finds a button wearing one.
  - **Idle is unchanged** — an outline ring in `currentColor`. The ⓘ and ? are a
    matched pair at rest ([responsive-header](responsive-header.md) REQ-5), and
    a permanently solid disc would both break that pair and make the header
    louder in the state the user has *not* asked for anything.
  - The disc takes **`currentColor`**, i.e. the `--accent` `toggleActive` sets
    one rule above, so the disc can never drift from the border and glow around
    it.
  - Geometry does **not** change with state: same `r`, same stem, same tittle,
    only the colours swap. The badge is 20px and this ring ~16px; matching the
    badge's literal diameter would leave ⓘ fatter than every sibling icon for
    no gain. The dark stem gets a hair more stroke weight, because dark-on-orange
    reads thinner than light-on-dark — an optical correction, not a second shape.
  - The hooks are **per-part classes on the glyph** (`.disc` / `.stem` / `.dot`
    in `header-icons.ts`) targeted from `tour.module.css`. Only the ⓘ glyph
    carries them, so Fullscreen — which shares `toggleActive` — is untouched.

- **REQ-9** (v5) — Help copy tells the truth about what a control does:
  - The `modWheel` topic explains the wheel's actual routing — it **adds to the
    LFO Amount** (engine clamps the sum to 1), so it deepens whatever the LFO
    destination is aimed at: wobble (cutoff), vibrato (pitch), tremolo (amp) or
    PWM movement (pulse) — and that it does nothing while the LFO destination
    is off.
  - The two header buttons' tooltips name **what they do**, not what they are
    (v15): the ⓘ button reads "Show info badges (?)" while inactive and "Hide
    info badges (?)" while active — the parenthetical is the keyboard route, the
    discoverability leg `recipes/design-an-interaction.md` step 4 asks for. The
    ? button reads "Help & About": it names both things behind it (the guided
    tour and the shortcut list, plus version and credits) rather than only the
    modal's title. The v13 tooltip "Help & Demo Tour — Shift+click or hold for
    badges" named a door and two gestures that no longer exist.

- **REQ-10** (v6) — The tour showcases the Song tab before its closing step: one
  step spotlights the arrangement **chain lanes** (`song-lane-seq` — banks chained
  one per bar, plus the per-lane mute/solo/level mixer) and the next the **live DJ
  FX** (`perf-stutter` — Fill/Stutter/Drop/Tape Stop + the DJ filter). Both use
  `precondition: clickTestId('tab-song')` — on *both* steps, not just the first, so
  **Back** from the closing step (or a stray tab click) re-opens the Song tab. The
  closing step targets the header `info-badges` button (v15; `help-button` before
  that) and switches no tab, so the tour **ends with the Song tab open and
  active** — the user is left ready to play rather than parked on the Sequencer.
  The demo loaded earlier in the tour populates the chains, so the lane spotlight
  lands on real content. Its copy names **both** header doors — ⓘ for the badges
  it is spotlighting, ? for replaying this tour — because the closing step is the
  last moment the tour can hand over the two things a stuck user needs.

- **REQ-11** (v7) — **Help copy covers the gesture model.** The grid gestures
  ([step-grid-editing](step-grid-editing.md)) are invisible by construction —
  nothing on screen says a step can be dragged, held or bulk-cleared — so the
  `seq`, `drums` and `sampler` topics each carry the same authored paragraph
  naming drag-to-paint (starting lit = erase), press-and-hold / right-click to
  select without toggling, `Delete`, `Clear ▾` and tab-scoped `Ctrl+Z`. It is
  **one shared constant** concatenated into the three bodies, not three
  paraphrases, so the gesture vocabulary cannot drift between machines. `motion`
  states its own variant, because its grid has no tap-toggle (drag sets a value,
  double-click clears) and its `Clear ▾` lists lanes rather than a selected row
  (step-grid-editing REQ-6).

- **REQ-12** (v7, re-anchored v18) — **A `presets` topic anchors to
  `preset-select`.** It covers the whole preset cluster: the selector, and the
  single Presets button beside it ([presets](presets.md) REQ-9) which opens
  save / export-preset / export-bank / import-with-review, none of which was
  explained anywhere. Its copy must separate a **preset** (one sound) from a
  **song** (the whole arrangement) — the confusion the badge exists to kill —
  and must describe the import review step as non-destructive until confirmed.
  - Through v17 it pinned to **`preset-save`**, one button away from the ⓘ
    toggle. A badge is the loudest mark in the header, so parked there it pulled
    the eye off the very control REQ-8b exists to make findable — the two were
    competing inside one cluster. The selector is far enough left to stop that,
    and it is where the copy already begins ("The dropdown flips through 16
    factory sounds…"), so the anchor and the first sentence now agree.
  - Everything else is unchanged: default `'corner'` placement, the `inHeader`
    exemption from the scrolled-under-the-header rule, and hiding on a zero-size
    anchor when the cluster collapses behind the hamburger below 720px
    ([responsive-header](responsive-header.md) REQ-1).

- **REQ-13** (v7) — **The tour teaches the grid gestures.** A "Paint a pattern"
  step sits between the pattern-tabs step and the Song-tab steps. It targets
  **`panel-drums`** (`precondition: clickTestId('tab-drums')`), deliberately *not*
  `panel-seq`: the preceding step already spotlights `panel-seq`, and two
  consecutive steps sharing a target leave the spotlight rect unmoved, which reads
  as "nothing happened". The drum grid also carries the demo song's hits by this
  point (same rationale as REQ-10), so the gesture lands on real content.

- **REQ-14** (v8) — **The Motion tab carries two short per-lane badges** beside the
  essay-length `motion` topic (REQ-7): `motion.xy` anchored to the **XY lane header**
  (`data-help="motion.xy"`) and `motion.tracks` anchored to the **A track's row**
  (`data-help="motion.tracks"`, one shared badge covering both A and B). Each is a
  2–3 sentence quick explainer — the XY-pad automation and the single-param tracks
  respectively — for users who don't want the full Motion write-up. See
  [motion-sequencer.md](motion-sequencer.md) REQ-8.

- **REQ-15** (v9) — **The Sequencer's Render button carries a `seq.render` badge**
  (anchored to `seq-import-render`). Same rationale as REQ-5's per-button Song
  badges: "Import into sampler" is unexplained on screen, and pressing Render
  goes quiet for ~2 bars because it renders the bar **twice** to bake the
  reverb/delay tail into the loop — behaviour that reads as a hang unless the
  copy says so. The badge must also cover the two reasons the button greys out.
  See [render-to-sampler.md](render-to-sampler.md) REQ-10.

- **REQ-16** (v11) — **The playhead ruler carries a badge on every machine tab**,
  and the Song panel's transport row carries one on its launcher
  ([transport-position.md](transport-position.md) REQ-9,
  [transport-window.md](transport-window.md) REQ-3). The ruler's is **four topic
  ids** (`transport.ruler.<seq|drum|sampler|motion>`, anchored to
  `ruler-<lane>`) sharing **one** `HelpTopic` object: a hidden tab's anchor
  measures 0×0 so its badge hides, meaning a single shared badge would be
  reachable on exactly one tab — while four paraphrases of identical copy would
  drift. (Precedent: the per-machine `fx.drum.*` / `fx.sampler.*` topics.) The
  ruler copy must cover the thing the grid playhead cannot say — that it shows
  the position while stopped, on a switched-off machine, and across banks — plus
  the `Home` / `Shift`+arrow keys. `transport.song` (anchored to
  `transport-open`) covers the bar readout, the scrubber's one-cell-per-chain-slot
  correspondence, the floating window, and the states where seeking is refused.

- **REQ-16b** (v14) — **The Song tab's two audio buttons keep their badges, and
  both topics are rewritten**, because neither button does what it used to:
  `song.record` now opens the [Record window](record-window.md) and
  `song.exportAudio` opens the export options modal
  ([audio-export](audio-export.md) REQ-9). The old copy said "Press **Record** …
  press **Stop** to finish and download", which is now wrong twice over — a take
  is stopped, then explicitly saved or discarded. The record topic must cover the
  four phases, that **pause pauses the recorder and not the transport**, the
  discard-on-close confirm, and `Shift`+`R`; the export topic must cover runs and
  what the tail bar is for. The anchors (`song-record`, `song-export-audio`) are
  unchanged.

- **REQ-17** (v11) — **Symbols in the About modal's key list are legible.** The
  key column is monospace at 11px, which has no glyph for `← → ↑ ↓`: the
  browser substitutes per character at its own much smaller size, and the arrow
  rows rendered as unreadable dashes. Such a symbol carries `Modal.glyphClass`
  and is drawn in the UI sans instead (v16: on its own keycap, rather than as a
  run inside a text string — same reason, same class).
  The list is also the canonical on-screen shortcut reference, so it must name
  every global key — including `Home` / `Shift`+arrows
  ([transport-position.md](transport-position.md) REQ-11), `Delete` and
  `Ctrl/Cmd+Z`, which were missing, (v13) `?`, and (v14) `Shift`+`R` for the
  [Record window](record-window.md) (REQ-9 there). It already carries non-key gestures (`Shift`+drag for fine knob
  control), so a mouse row is in keeping. The v13 `Shift`+click-on-Help row is
  **gone** in v15 along with the gesture itself.

- **REQ-17b** (v15) — **The key list is folded to its first six rows.** Fifteen
  rows of mostly-advanced keys made the modal long enough that the tour button,
  the version and the Debug section all fell below the fold on a phone, so only
  the note rows, the octave keys, the two bend keys and `Space` show by default;
  the header row expands the rest. Load-bearing details:
  - This is a **display default, not a removal** — REQ-17's "names every global
    key" still holds, one click away, so the discoverability claims in
    [transport-position.md](transport-position.md) REQ-13 and
    [record-window.md](record-window.md) REQ-9 (which cite this list) stay true.
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
    ⓘ button is (REQ-8). The count moved from five rows to six when pitch bend
    split into one row per key ([input-control](input-control.md) REQ-12); the
    rule is "through `Space`", not a magic number.

- **REQ-17c** (v16) — **Keys are drawn as keys, and the note rows are drawn as a
  keyboard.** A combo is an ordered list of **tokens** — a keycap or a run of
  literal text — never one parsed string. Two things follow, and both are the
  requirement rather than decoration:
  - **Only actual keys look like keys.** `Shift + drag` renders one cap
    (`Shift`) beside plain text, so the row says "hold this, then use the mouse"
    without spending a word on it. Same for `F (hold)`. A list where every token
    looked alike made "drag" read as keyboard input.
  - **The two note rows are a two-row keyboard diagram** in the keys' real
    relative positions: sharps on top, offset by half a cap so each sits in the
    gap between its two naturals, with the gaps at **E–F** and **B–C** left
    empty. That break is what makes the block legible as a piano at a glance,
    which a flat `Z S X D C V G B H N J M ,` never was. Naturals and sharps also
    carry **different cap tints** — the offset alone reads as an arbitrary grid
    until the two ranks are told apart.
  - **The diagram is derived from `NOTE_ROWS`**
    (`notes(NOTE_ROWS.lower)` / `notes(NOTE_ROWS.upper)` in `about-shortcuts.ts`;
    `LOWER`/`UPPER` themselves stay module-private in `src/ui/shortcuts.ts` —
    [input-control](input-control.md) REQ-3), not restated in the About code. A
    diagram that disagrees with the actual bindings is worse than none, and this
    is the one place in the app that would silently drift. Naturals are the
    semitones `{0,2,4,5,7,9,11}` of each row's own base; a sharp occupies the gap
    after the natural below it.
  - **(v17) The cap labels follow the active keyboard layout.** A cap that
    stands for a physical key carries `data-code` and takes its label from
    [keyboard-layout](keyboard-layout.md); switching layout relabels those caps
    **in place**, because the diagram's structure — which rank, which column,
    where the E–F and B–C gaps fall — is the piano's and never varies. Only the
    note diagram uses `data-code`: the `F`, `R` and `Z` caps are fixed labels
    for bindings that do not move (keyboard-layout REQ-5).
  - **A gear beside the section title** opens the layout picker (a `Dropdown` in
    a row revealed under the header). It must stop its click from reaching the
    header, which is the fold's `trigger` — otherwise choosing a layout would
    also collapse the list you opened it to read.
  - Empty gaps are **cap-sized invisible spacers**, not margins, so the two rows
    stay aligned without positioning maths, and caps have a fixed width so the
    half-cap offset is exact. Multi-character caps (`Shift`, `Ctrl/Cmd`) grow
    past that width; only note caps are single characters, so the diagram's
    columns line up by construction.
  - The cell class is **`.combo`, not `.key`** — `.key` is also the Debug
    section's left-column class ([debug-panel](debug-panel.md)), where the
    monospace label treatment is still correct.

- **REQ-18** — **The Live FX row carries a badge on its launcher**, `song.fx`
  anchored to `livefx-open` ([live-fx-window.md](live-fx-window.md) REQ-7). It is
  written as `transport.song`'s **sibling** — the two rows sit against each other
  on the Song tab, both led by a launcher that doubles as its section title, so
  their copy follows the same order: what the row is, each control, what the
  floating window adds, where it is reduced. It stays out of the two topics that
  overlap its row: the master compressor (`fx.master.comp`) and the XY Pad's
  axis assignment (`motion.xy`). Before it, Live FX was the only unbadged
  section on the Song tab.

- **REQ-19** (v13, re-authored v15) — **Gesture inventory for the ⓘ button.**
  Switching the badges on used to cost Help → modal → "Toggle help badges" →
  close, so v13 bolted a modifier-click and a long-press onto the Help button to
  skip the modal. v15 removes the modal, which removes the thing those gestures
  routed around: a plain click already toggles, so a second gesture for the same
  outcome is exactly the redundancy this revamp exists to delete.

  | Gesture (on `info-badges`) | Outcome                          | Precedent                          |
  | -------------------------- | -------------------------------- | ---------------------------------- |
  | click (either state)       | **toggle badges**                | one gesture, one outcome           |
  | Shift / Ctrl / ⌘ + click   | — (plain click already toggles)  | dropped in v15                     |
  | long-press (350 ms)        | — (plain click already toggles)  | dropped in v15                     |
  | right-click                | — (`contextmenu` is globally suppressed) | —                          |
  | double-click               | — (reads as two toggles)         | —                                  |
  | `?` (global key)           | **toggle badges**                | `?` = help, near-universal         |

  Load-bearing details:
  - A `—` row is a decision, not an oversight
    (`../recipes/design-an-interaction.md` step 1). The three dropped gestures
    are listed so the next reader knows they were considered and why they went.
  - No two rows produce different outcomes for the same gesture depending on
    state ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2) — the
    v13 table's first two rows did.
  - Dropping the long-press also drops its machinery: the 350 ms timer, the ~6 px
    travel slop, and the flag that had to **swallow the trailing `click`** so the
    chooser modal could not open behind the badges the hold had just switched on.
    That last one existed only because a click had a second outcome.
  - `?` reaches the app because `e.key` for Shift+`/` is `?`, so the `/`
    pitch-bend branch never sees it, and the `ctrl/meta/alt` bail-out in
    `installShortcuts` does not test `shiftKey`. It routes through
    `UiBridge.toggleInfoBadges` rather than importing onboarding into
    `shortcuts.ts` (the `toggleTransport`/`undoActiveMachine` precedent), and it
    is suppressed inside editable fields like every other key
    ([input-control](input-control.md) REQ-5).
  - Discoverability (`../recipes/design-an-interaction.md` step 4): the button's
    glyph **is** the badge glyph — literally so while the badges show, where it
    takes the badge's colours too (REQ-8b) — its tooltip names the key (REQ-9),
    the About key list carries the `?` row (REQ-17), and the tour's closing step
    spotlights it (REQ-10).

- **REQ-20** (v15) — **About is the single door for help.** With the chooser
  modal gone, the About modal carries a full-width **"Take the guided tour"**
  button (testid `start-tour`) placed **between the version/credits block and
  the Keyboard Shortcuts header** — above the shortcuts, because replaying the
  tour is the one action in the modal and everything below it is reference. It
  is the only tour-replay route in the app; the first-visit auto-launch
  (`websynth.onboarding.done`, `main.ts`) is unchanged and still calls the same
  `Onboarding.startTour`. `createAboutButton` therefore takes that hook as an
  injected dep, the same way the tour takes its `TourCtx` (REQ-2) — the About
  modal must not reach into the onboarding layer itself.

- **REQ-21** (v21) — **The MOD launcher carries a badge**, `mod` anchored to
  `perf-mod` ([mod-matrix](mod-matrix.md)). It sits in the Live FX row but is not a
  Live FX control — it opens the patch's **modulation routing**, which is sound design
  rather than a momentary performance gesture. A vertical divider says that visually;
  the badge is what says *what it is*, since "MOD" alone names nothing a newcomer knows.

  Its copy carries the three things the window cannot show on its own: that **amount is
  bipolar** and past zero the route inverts; that a modulated knob on the synth panels
  grows an inner arc, **green for up and yellow for down**, so the effect is visible
  with the window shut; and **why the destination list is short** — ADR-017's boundary,
  pointing at Motion and the XY Pad for everything else. Without that last part a
  curated list reads as a missing feature.

- **REQ-22** (v20) — **The key and the chord writer each carry a badge.** `key` is
  anchored to `tab-key`, the machine-tab convention the arp/seq/drums badges already
  follow: an active scale silently re-pitches *every* note source
  ([scale-quantization](scale-quantization.md)), so "why does my note not sound where
  I put it?" has to be answerable from the tab itself. Its copy leads with the fact
  the panel cannot show — that the filter is **non-destructive**, and `chromatic`
  means nothing changes — and names the map's four colours, which is otherwise the
  one thing on the tab with no on-screen legend beyond three words.

  `seq.chord` is anchored to `seq-chord` on the Sequencer's step row
  ([chord-tools](chord-tools.md)). It earns a per-control badge on two counts that
  the badge policy already recognises: it is the only control in that row that writes
  to **four tracks at once**, and it is the only one whose options are disabled by a
  setting on **another tab** — a dead control with an off-screen cause is exactly the
  case ADR-014 says must explain itself. The copy also decodes the Roman numerals,
  which are the notation a non-musician will not have.

- **REQ-23** (v24) — **The meter has a help topic and an info badge**, anchored
  to the header's `meter-picker` beside SWING's. It is one topic, not three: the
  time signature and the per-machine `LEN`/`RATE` overrides are one idea
  ([meter](meter.md)), and pinning a second badge inside each machine header
  would spend the row's one-line budget (`responsive-machine-header.md`) on
  chrome. The copy carries the two things the controls cannot say themselves —
  that a lane off the bar is deliberate, and that 5/4 and 7/4 need a coarser
  rate because a bar of them is longer than the grid.

- **REQ-24** (v25) — **The help door never fails silently.** Both surfaces
  behind it load on demand ([runtime-performance](runtime-performance.md)
  REQ-1) — the About card via `import('./about-modal')`, the tour and badges via
  the facade's `import('./onboarding-impl')` — and a rejected `import()` used to
  do *nothing at all*: no card, no error, a `?` button that reads as broken. The
  realistic trigger is an offline revisit whose chunk was never fetched while
  online (`pwa-install.md` REQ-6 caches only what the page actually requested),
  and help is precisely what someone reaches for when they are stuck.

  Two halves, because either alone is insufficient:

  - **Prevention.** The About body joins `lamejs` and the onboarding body in
    `main.ts`'s idle warm set, so one online visit is enough to make it openable
    offline forever after. This is REQ-1's standing rule — *a deferred surface
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
  import promise so two triggers cannot build two `InfoBadges` (REQ-1), but a
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
                             #   ASYNC: all but the two built-ins are fetched on
                             #   click (song-mode REQ-12), so a step that acts on
                             #   the loaded song must await it (see below).
                             #   The tour names DEMO_FOR_TOUR by constant while
                             #   demo files are data; song-mode REQ-12's
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
  createAboutButton(engine, { startTour }): HTMLButtonElement   # REQ-20
components/lazy-load-toast.ts:
  showLazyLoadFailure(surface: string, retry: () => void): void # REQ-24
```

**The facade is synchronous; its body is not.** `tour.ts`, `info-badges.ts`,
`help-content.ts` and `help-widgets.ts` are ~93 kB reached only from
`onboarding-impl.ts`, which `index.ts` `import()`s on the first `startTour()` or
`toggleInfoBadges()` ([`runtime-performance.md`](runtime-performance.md) REQ-1).
No caller changes, and none may be made to await: `app.ts` wires
`toggleInfoBadges`/`isActive`/`onChange` into the ⓘ button and
`UiBridge.toggleInfoBadges` at header-build time — *before* any gesture — so the
facade must already exist and answer then. The two readers keep working because
`shouldAutoLaunch()` needs only `localStorage` and `isInfoBadgesActive()` is
`false` until the body loads, which is exact rather than approximate: the badges
cannot be showing before the code that shows them exists. The load is memoized,
so the ⓘ button and the `?` key racing each other still yield one `InfoBadges`.
Because a returning visitor can reach help **offline**, the chunk is also warmed
on idle from `main.ts` ([`pwa-install.md`](pwa-install.md) REQ-6).

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

Scenario: A badge below the fold is hidden, not left pinned off-screen (v23, REQ-5b, regression)
  Given the info badges are on
  When an anchor scrolls down past the bottom of the viewport
  Then its badge is hidden — the same way one scrolling up under the sticky
    header is, rather than staying in the layer where nothing can reach it
  When the anchor scrolls back into view
  Then its badge comes back on the next reflow frame
# pinned by: tests/ui/info-badges.test.ts, e2e/onboarding.spec.ts (both edges,
#            plus a sweep asserting no shown badge sits past the fold)

Scenario: A badge only half past an edge still goes (v23, REQ-5b, edge)
  Given an anchor whose badge would straddle the viewport's bottom edge
  Then the badge is hidden, because the rule is any overlap — the mirror of the
    sticky-header band above
# pinned by: tests/ui/info-badges.test.ts

Scenario: Header badges survive a scroll (v23, REQ-5b, edge)
  Given the page is scrolled far down
  Then the transport / voicing / panic badges are still shown — a header anchor
    never scrolls away, and the header sits nowhere near the fold
# pinned by: tests/ui/info-badges.test.ts

Scenario: Song file buttons each explain themselves
  Given the info badges are on and the Song tab is open
  When the user clicks the Save badge, then the Export badge
  Then each opens its own modal whose copy distinguishes the two
# pinned by: e2e/onboarding.spec.ts

Scenario: The ⓘ button toggles the badges in one click, both ways (v15, REQ-8)
  Given the info badges are off
  When the user clicks the ⓘ button
  Then the badges appear, the button gains its orange active state and aria-pressed="true"
  And no modal opens
  When the user clicks it again
  Then the badges disappear and aria-pressed is "false"
# pinned by: tests/ui/info-badges-button.test.ts, e2e/onboarding.spec.ts

Scenario: The active ⓘ button wears the badge it switches off (v18, REQ-8b)
  Given the info badges are off
  Then the ⓘ glyph is an outline ring — its disc is unfilled, like the ? beside it
  When the user clicks the ⓘ button
  Then the disc fills with the accent and the i is drawn in --bg-deep,
    the same pair the floating badges use
   And the Fullscreen button's glyph is unaffected by its own toggleActive state
# pinned by: tests/ui/info-badges-button.test.ts (the part hooks),
#            e2e/onboarding.spec.ts (the computed fill, both states)

Scenario: The dropped gestures do nothing special (v15, REQ-19)
  Given the info badges are off
  When the user Shift+clicks the ⓘ button, or presses and holds it for 350 ms
  Then the outcome is exactly a plain click's — one toggle, no modal, no
    swallowed click afterwards
# pinned by: tests/ui/info-badges-button.test.ts

Scenario: The ? button opens About, which is the only tour-replay route (v15, REQ-20)
  Given the app is loaded
  When the user clicks the ? button
  Then the About modal opens with "Take the guided tour" above Keyboard Shortcuts
  When the user clicks it
  Then the modal closes and the guided tour starts
# pinned by: tests/ui/about.test.ts, e2e/onboarding.spec.ts

Scenario: The ? key toggles the badges (v13, REQ-19)
  Given no editable field has focus
  When the user presses ?
  Then the badges toggle
  And master.pitchBend stays 0 — the '/' pitch-bend branch never sees it
  And pressing ? inside a textarea does nothing
# pinned by: tests/ui/shortcuts.test.ts

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

Scenario: The preset selector explains what a preset is (v7, re-anchored v18)
  Given the info badges are on
  When the user clicks the badge on the header preset selector
  Then the modal distinguishes a preset (one sound) from a song, and describes
    exporting a preset/bank and the review step shown before an import is written
   And the badge sits on the selector, not on the Save button beside the ⓘ toggle
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts

Scenario: The tour's gesture step moves the spotlight to the drum grid (v7)
  Given the tour has passed the "Build your own patterns" step
  When the user presses Next
  Then the Drum tab opens and the callout explains tap / drag / hold / Clear ▾
# pinned by: e2e/onboarding.spec.ts

Scenario: Sync section carries USB + WiFi info badges (v2)
  Given the info badges are on and the Song tab is open
  Then a `sync` badge anchors to the Master mode button and a `sync.wifi` badge
    anchors to the WiFi link button, each opening its connection-steps modal
# pinned by: tests/ui/help-content.test.ts (topic presence)

Scenario: Motion tab carries per-lane info badges (v8)
  Given the info badges are on and the Motion tab is open
  Then a `motion.xy` badge anchors to the XY lane header and a `motion.tracks`
    badge anchors to the A track's row, each a short explainer distinct from the
    machine-level `motion` topic
# pinned by: tests/ui/help-content.test.ts (topic presence)

Scenario: Every machine tab's ruler carries a badge (v11, REQ-16)
  Given the info badges are on
  When the user opens each machine tab in turn
  Then a `transport.ruler.<lane>` badge anchors to that tab's ruler
   And all four resolve to the same copy — one HelpTopic behind four ids
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts

Scenario: The Song tab's transport row explains the scrubber (v11, REQ-16)
  Given the info badges are on and the Song tab is open
  When the user clicks the badge on the TRANSPORT launcher
  Then the modal explains bar.step, the one-cell-per-chain-slot scrubber, the
    floating window, and when seeking is refused
# pinned by: tests/ui/help-content.test.ts

Scenario: The Live FX row below it explains the DJ controls (v12, REQ-18)
  Given the info badges are on and the Song tab is open
  When the user clicks the badge on the LIVE FX launcher
  Then the modal names DJ Filter, Fill, Stutter, Drop, Tape Stop and the XY Pad,
    says the buttons are momentary, and says what the floating window adds
   And it leaves the master compressor to its own badge
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts

Scenario: The gear switches layout without folding the list (v17, REQ-17c)
  Given the About modal is open with the shortcut list expanded
  When the user clicks the gear beside "Keyboard Shortcuts"
  Then the layout select appears and the list stays expanded
  When they pick AZERTY
  Then the naturals rank relabels to W X C V B N , ; in place
# pinned by: tests/ui/about.test.ts

Scenario: The note rows read as a keyboard (v16, REQ-17c)
  Given the About modal is open on the qwerty layout
  Then the lower-octave row is two ranks of caps: 8 naturals below, 5 sharps
    above, each sharp offset into the gap between its two naturals
   And the gaps at E-F and B-C are cap-sized blanks, not missing cells
   And naturals and sharps carry different cap tints
   And every letter comes from NOTE_ROWS, so the diagram cannot disagree with the
    keys it documents
# pinned by: tests/ui/about.test.ts

Scenario: Only real keys are drawn as keys (v16, REQ-17c)
  Given the About modal is open and the shortcut list is expanded
  Then the "Shift + drag" row shows exactly one cap, labelled Shift
   And "drag" is plain text, so the row cannot read as a keyboard shortcut
# pinned by: tests/ui/about.test.ts

Scenario: Arrow keys are readable in the About shortcut list (v11, REQ-17)
  Given the About modal is open and the shortcut list is expanded
  Then each arrow is a cap carrying the glyph class rather than left to the
    monospace face, which has no glyph for it
   And the list names Home, Shift+arrows, Delete, Ctrl/Cmd+Z, Shift+R and ?
   And no row mentions Shift+click on Help — that gesture is gone (v15)
   And pitch bend is two rows, ' above /, never a combined one (input-control REQ-12)
# pinned by: tests/ui/about.test.ts

Scenario: The shortcut list is folded through Space by default (v15, REQ-17b)
  Given the About modal is opened for the first time on this device
  Then six key rows are visible, the last of them Space, and the hint reads "Show all"
   And the rest are present in the same grid but hidden
  When the user clicks the Keyboard Shortcuts header
  Then every row is visible and the hint reads "Show less"
   And the choice is persisted under websynth.shortcuts.about, independently of
    the Debug section's own fold
# pinned by: tests/ui/about.test.ts

Scenario: The MOD badge explains bipolar amount and the knob colours (v21, REQ-21)
  Given the info badges are on and the Song tab is open
  When the user clicks the badge on the MOD button
  Then the modal says amount is bipolar and that past zero the route inverts
  And it names the green/yellow arc a modulated knob grows
  And it points at Motion and the XY Pad for what the matrix cannot reach
# pinned by: tests/ui/help-content.test.ts

Scenario: The Key badge says the filter is non-destructive (v20, REQ-22)
  Given the info badges are on
  When the user clicks the badge on the Key tab
  Then the modal says stored notes are never rewritten and chromatic changes nothing
  And it names what the map's colours mean
# pinned by: tests/ui/help-content.test.ts

Scenario: The Chord badge decodes the Roman numerals (v20, REQ-22)
  Given the info badges are on and the Sequencer tab is open
  When the user clicks the badge on the Chord control
  Then the modal explains the write across four tracks, the single Undo,
    and that a capital numeral is major and a small one minor
# pinned by: tests/ui/help-content.test.ts

Scenario: The Render button says why it takes two bars (v9)
  Given the info badges are on and the Sequencer tab is open
  When the user clicks the badge on the Render button
  Then the modal explains the import into a sampler slot and the second pass
    that lets the reverb tail blend into the loop
# pinned by: tests/ui/help-content.test.ts (topic copy), e2e/onboarding.spec.ts

Scenario: The ? button says so when the About body cannot load (v25, REQ-24, regression)
  Given the About modal body has not loaded and its import will reject
  When the user clicks the ? button
  Then no card is appended, and a toast names Help & About and offers Retry
  And the toast says "you're offline and this part of the app isn't
    downloaded yet" while navigator.onLine is false, and "the download failed"
    while it is true
# pinned by: tests/ui/lazy-load-failure.test.ts

Scenario: Retry opens About once the import succeeds (v25, REQ-24, regression)
  Given the ? button raised the load-failure toast
  When the import stops rejecting and the user clicks Retry
  Then the About card opens normally
# pinned by: tests/ui/lazy-load-failure.test.ts

Scenario: A failed onboarding load is retryable, not permanent (v25, REQ-24, regression)
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
- `tests/ui/info-badges-button.test.ts` (the ⓘ button's gesture inventory,
  REQ-8/REQ-19), `tests/ui/shortcuts.test.ts` (the `?` key),
  `tests/ui/about.test.ts` (the tour button, the folded key list, REQ-17b/REQ-20).
- `tests/ui/info-badges.test.ts` (REQ-5b: the three hide rules, in a jsdom
  viewport with stubbed anchor rects).
- REQ-24's two halves are verified apart: the **report** by
  `tests/ui/lazy-load-failure.test.ts` (both lazy modules mocked to throw on
  evaluation, which is what a rejected chunk fetch looks like), the
  **prevention** only by hand — load the built app
  online once, then reload it with DevTools ▸ Network ▸ Offline and open `?`.
  A green suite says nothing about whether the chunk is in the cache.
- `npm test` / `npm run e2e`.

## Open questions / future

- New tour steps should keep using injected `TourCtx` hooks (never DEV globals) so
  they work in production builds.
