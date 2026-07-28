# Onboarding (guided tour & help mode)

```yaml
id: onboarding
status: implemented
version: 14  # v14: the two audio topics rewritten for the Record window + export
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
  - midi-clock-sync
  - webrtc-sync
  - motion-sequencer
  - step-grid-editing
  - sequencer
  - render-to-sampler
  - presets
  - audio-export
  - record-window
source:
  - src/ui/onboarding/tour.ts
  - src/ui/onboarding/help-mode.ts
  - src/ui/onboarding/help-content.ts
  - src/ui/onboarding/index.ts
  - src/ui/components/help.ts
```

First-run guidance: an interactive spotlight tour and a persistent help mode that
annotates controls.

## Background / Why

New users face a dense control surface, so the tour walks them through it one
control at a time with a dimmed spotlight and a callout. The spotlight is
`pointer-events: none`, so the **real control underneath stays clickable** — that's
what lets steps like "press a key" or "press Play" be genuinely interactive rather
than a slideshow. The tour takes its runtime hooks via an injected `TourCtx` so it
never reads DEV-only globals.

## Requirements

- **REQ-1** — The tour highlights one target at a time; only the callout (and its
  Back/Skip/Next) is clickable — the spotlighted control remains live.
- **REQ-2** — Interactive steps (play a note, press Play, load a demo) work against
  the real app via injected hooks, not globals.
- **REQ-3** — Help mode shows per-control help badges/content from
  `help-content.ts`.
- **REQ-5** — The Song panel's file/audio buttons each carry their own badge —
  `song.load`, `song.save`, `song.import`, `song.export`, `song.new`,
  `song.exportAudio`, `song.record` — and their copy disambiguates the
  easy-to-confuse pairs (Save vs Export; Export the `.json` project vs Export
  Song the WAV/MP3 audio). These pin to the buttons' existing testids, so they
  reposition/hide on tab switch via the same reflow path as other in-panel
  badges (e.g. `seq.prob`).
- **REQ-4** — Placement of callouts adapts (`auto`/top/bottom/left/right) to stay
  on-screen.
- **REQ-7** (v3) — A `motion` help topic anchors to the Motion machine's tab
  (`tab-motion`, like the other machine tabs). Its copy explains the mini-pad
  anchors and, above all, the **Y/X graph view**: the overlay line projects one
  axis at a time (the toggle picks which assigned param it traces; the dots
  never move) and its shape follows Step/Slide mode. See
  [motion-sequencer.md](motion-sequencer.md) REQ-8.
- **REQ-8** (v4) — While help mode is active (the header Help button shows its
  orange active state), clicking the Help button toggles the badges **off**
  directly — no modal round-trip. While inactive, the click opens the Help
  chooser modal as before. The active styling is what licenses the shortcut:
  an orange toggle reads as "click to switch off".
- **REQ-9** (v5) — Help copy tells the truth about what a control does:
  - The `modWheel` topic explains the wheel's actual routing — it **adds to the
    LFO Amount** (engine clamps the sum to 1), so it deepens whatever the LFO
    destination is aimed at: wobble (cutoff), vibrato (pitch), tremolo (amp) or
    PWM movement (pulse) — and that it does nothing while the LFO destination
    is off.
  - The Help button's tooltip while help mode is **inactive** names the door it
    opens *and* the shortcut past it — "Help & Demo Tour — Shift+click or hold
    for badges" (v13, REQ-19); it is not a shortcuts list. The active-state
    tooltip stays "Turn off help badges" (REQ-8).
- **REQ-10** (v6) — The tour showcases the Song tab before its closing step: one
  step spotlights the arrangement **chain lanes** (`song-lane-seq` — banks chained
  one per bar, plus the per-lane mute/solo/level mixer) and the next the **live DJ
  FX** (`perf-stutter` — Fill/Stutter/Drop/Tape Stop + the DJ filter). Both use
  `precondition: clickTestId('tab-song')` — on *both* steps, not just the first, so
  **Back** from the closing step (or a stray tab click) re-opens the Song tab. The
  closing step targets the header `help-button` and switches no tab, so the tour
  **ends with the Song tab open and active** — the user is left ready to play rather
  than parked on the Sequencer. The demo loaded earlier in the tour populates the
  chains, so the lane spotlight lands on real content.
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
- **REQ-12** (v7) — **A `presets` topic anchors to `preset-save`.** The header's
  single Presets button ([presets](presets.md) REQ-9) opens save / export-preset /
  export-bank / import-with-review, none of which was explained anywhere. Its copy
  must separate a **preset** (one sound) from a **song** (the whole arrangement) —
  the confusion the badge exists to kill — and must describe the import review
  step as non-destructive until confirmed.
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
- **REQ-18** — **The Live FX row carries a badge on its launcher**, `song.fx`
  anchored to `livefx-open` ([live-fx-window.md](live-fx-window.md) REQ-7). It is
  written as `transport.song`'s **sibling** — the two rows sit against each other
  on the Song tab, both led by a launcher that doubles as its section title, so
  their copy follows the same order: what the row is, each control, what the
  floating window adds, where it is reduced. It stays out of the two topics that
  overlap its row: the master compressor (`fx.master.comp`) and the XY Pad's
  axis assignment (`motion.xy`). Before it, Live FX was the only unbadged
  section on the Song tab.
- **REQ-17** (v11) — **Symbols in the About modal's key list are legible.** The
  key column is Courier New at 11px, which has no glyph for `← → ↑ ↓`: the
  browser substitutes per character at its own much smaller size, and the arrow
  rows rendered as unreadable dashes. A run of such symbols is wrapped in
  `Modal.glyphClass` and drawn in the UI sans at 15px on the monospace baseline.
  The list is also the canonical on-screen shortcut reference, so it must name
  every global key — including `Home` / `Shift`+arrows
  ([transport-position.md](transport-position.md) REQ-11), `Delete` and
  `Ctrl/Cmd+Z`, which were missing, (v13) `?` plus `Shift`+click on Help
  (REQ-19), and (v14) `Shift`+`R` for the
  [Record window](record-window.md) (REQ-9 there). It already carries non-key gestures (`Shift`+drag for fine knob
  control), so a mouse row is in keeping.
- **REQ-19** (v13) — **Switching the badges on is one gesture, not a modal round
  trip.** Switching them *off* has been one click since REQ-8; turning them on
  cost Help → modal → "Toggle help badges" → close, and there was no keyboard
  route at all. So the Help button carries a second gesture that **toggles the
  badges and never opens a modal**, and a global key does the same:

  | Gesture (on `help-button`) | Outcome                          | Precedent                          |
  | -------------------------- | -------------------------------- | ---------------------------------- |
  | click, badges off          | open the Help chooser modal      | REQ-8 (unchanged)                  |
  | click, badges on           | badges off                       | REQ-8 (unchanged)                  |
  | Shift / Ctrl / ⌘ + click   | **toggle badges, no modal**      | modifier-click = skip the dialog   |
  | long-press (350 ms)        | **toggle badges, no modal**      | step grids (`grid-gestures.ts`)    |
  | right-click                | — (`contextmenu` is globally suppressed) | —                          |
  | double-click               | — (reads as two toggles)         | —                                  |
  | `?` (global key)           | **toggle badges**                | `?` = help, near-universal         |

  Load-bearing details:
  - The new gesture's outcome is **toggle** in both states — one gesture, one
    outcome ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2). It is
    not "reveal": a second Shift+click hides the badges again, matching what a
    plain click does while they show.
  - **Long-press must swallow the trailing `click`**, or the badges would toggle
    and the chooser modal would open behind them. The hold cancels on pointer
    travel past ~6 px slop and on `pointerup`/`pointercancel`; the pointerdown is
    **not** `preventDefault`ed, since that would break the plain-click path.
  - `?` reaches the app because `e.key` for Shift+`/` is `?`, so the `/`
    pitch-bend branch never sees it, and the `ctrl/meta/alt` bail-out in
    `installShortcuts` does not test `shiftKey`. It routes through
    `UiBridge.toggleHelpBadges` rather than importing onboarding into
    `shortcuts.ts` (the `toggleTransport`/`undoActiveMachine` precedent), and it
    is suppressed inside editable fields like every other key
    ([input-control](input-control.md) REQ-5).
  - Discoverability (`../recipes/design-an-interaction.md` step 4): the inactive
    tooltip names the gesture (REQ-9), and **both** routes are listed in the
    About modal's key list (REQ-17) — the canonical on-screen reference.
- **REQ-6** (v2) — The Song panel's Sync section carries two help topics:
  `sync` (what Master/Slave mean + the USB-MIDI connection steps — Android
  USB-MIDI peripheral mode / loopMIDI on Windows) anchored to
  `sync-mode-master`, and `sync.wifi` (WiFi pairing steps: same network + client
  isolation off → Create on one device, Join on the other, swap codes via QR or
  copy-paste) anchored to `sync-wifi-link`. See
  [midi-clock-sync.md](midi-clock-sync.md) / [webrtc-sync.md](webrtc-sync.md).

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
    resumeAudio(): Promise   # idempotent AudioContext resume (before note step)
    expandFx()               # open the collapsible FX section
help-mode.ts / help-content.ts: per-control help badges + copy
```

### Layer touchpoints

```yaml
boot: onboarding/index.ts wires the tour + help mode with a TourCtx from main.ts
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

Scenario: Song file buttons each explain themselves
  Given help mode is on and the Song tab is open
  When the user clicks the Save badge, then the Export badge
  Then each opens its own modal whose copy distinguishes the two
# pinned by: e2e/onboarding.spec.ts

Scenario: Active Help button switches badges off in one click (v4)
  Given help mode is active and the Help button shows its active state
  When the user clicks the Help button
  Then the badges disable immediately and no Help modal opens
# pinned by: e2e/onboarding.spec.ts

Scenario: Inactive Help button opens the chooser modal
  Given help mode is off
  When the user clicks the Help button
  Then the Help chooser modal opens (tour / toggle badges)
# pinned by: e2e/onboarding.spec.ts

Scenario: Shift+click switches the badges on without a modal (v13, REQ-19)
  Given help mode is off
  When the user Shift+clicks the Help button
  Then the badges appear and no Help modal opens
  When the user Shift+clicks it again
  Then the badges disappear, still without a modal
# pinned by: tests/ui/help.test.ts, e2e/onboarding.spec.ts

Scenario: A long press toggles the badges and eats its own click (v13, REQ-19)
  Given help mode is off
  When the user presses the Help button and holds for 350 ms, then releases
  Then the badges appear
  And the release's click does NOT open the chooser modal behind them
# pinned by: tests/ui/help.test.ts

Scenario: A press that turns into a drag is not a long press (edge, v13)
  Given the user presses the Help button
  When the pointer travels past the slop threshold before the hold fires
  Then no toggle happens and the click behaves normally
# pinned by: tests/ui/help.test.ts

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
  Given help mode is on
  When the user opens the Sequencer, Drum Machine and Sampler topics in turn
  Then each names drag-to-paint, hold-to-select, Delete and Clear ▾ in identical words
# pinned by: tests/ui/help-content.test.ts

Scenario: The Presets button explains what a preset is (v7)
  Given help mode is on
  When the user clicks the badge on the header Presets button
  Then the modal distinguishes a preset (one sound) from a song, and describes
    exporting a preset/bank and the review step shown before an import is written
# pinned by: tests/ui/help-content.test.ts

Scenario: The tour's gesture step moves the spotlight to the drum grid (v7)
  Given the tour has passed the "Build your own patterns" step
  When the user presses Next
  Then the Drum tab opens and the callout explains tap / drag / hold / Clear ▾
# pinned by: e2e/onboarding.spec.ts

Scenario: Sync section carries USB + WiFi help badges (v2)
  Given help mode is on and the Song tab is open
  Then a `sync` badge anchors to the Master mode button and a `sync.wifi` badge
    anchors to the WiFi link button, each opening its connection-steps modal
# pinned by: tests/ui/help-content.test.ts (topic presence)

Scenario: Motion tab carries per-lane help badges (v8)
  Given help mode is on and the Motion tab is open
  Then a `motion.xy` badge anchors to the XY lane header and a `motion.tracks`
    badge anchors to the A track's row, each a short explainer distinct from the
    machine-level `motion` topic
# pinned by: tests/ui/help-content.test.ts (topic presence)

Scenario: Every machine tab's ruler carries a badge (v11, REQ-16)
  Given help mode is on
  When the user opens each machine tab in turn
  Then a `transport.ruler.<lane>` badge anchors to that tab's ruler
   And all four resolve to the same copy — one HelpTopic behind four ids
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts

Scenario: The Song tab's transport row explains the scrubber (v11, REQ-16)
  Given help mode is on and the Song tab is open
  When the user clicks the badge on the TRANSPORT launcher
  Then the modal explains bar.step, the one-cell-per-chain-slot scrubber, the
    floating window, and when seeking is refused
# pinned by: tests/ui/help-content.test.ts

Scenario: The Live FX row below it explains the DJ controls (v12, REQ-18)
  Given help mode is on and the Song tab is open
  When the user clicks the badge on the LIVE FX launcher
  Then the modal names DJ Filter, Fill, Stutter, Drop, Tape Stop and the XY Pad,
    says the buttons are momentary, and says what the floating window adds
   And it leaves the master compressor to its own badge
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts

Scenario: Arrow keys are readable in the About shortcut list (v11, REQ-17)
  Given the About modal is open
  Then each arrow run is wrapped in the glyph class rather than left to the
    monospace face, which has no glyph for it
   And the list names Home, Shift+arrows, Delete and Ctrl/Cmd+Z
# pinned by: tests/ui/about.test.ts

Scenario: The Render button says why it takes two bars (v9)
  Given help mode is on and the Sequencer tab is open
  When the user clicks the badge on the Render button
  Then the modal explains the import into a sampler slot and the second pass
    that lets the reverb tail blend into the loop
# pinned by: tests/ui/help-content.test.ts (topic copy), e2e/onboarding.spec.ts
```

## Tests & verification

- `tests/ui/tour-place.test.ts` (placement math), `e2e/onboarding.spec.ts`
  (interactive flow).
- `tests/ui/help.test.ts` (the Help button's gesture inventory, REQ-19),
  `tests/ui/shortcuts.test.ts` (the `?` key), `tests/ui/about.test.ts` (the key
  list names both routes).
- `npm test` / `npm run e2e`.

## Open questions / future

- New tour steps should keep using injected `TourCtx` hooks (never DEV globals) so
  they work in production builds.
