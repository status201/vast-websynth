# Onboarding (guided tour & help mode)

```yaml
id: onboarding
status: implemented
version: 8   # v8: per-lane Motion help badges (motion.xy / motion.tracks)
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
  - presets
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
  - The Help button's tooltip while help mode is **inactive** is
    "Help & Demo Tour" (it opens the tour/badges chooser, not a shortcuts
    list); the active-state tooltip stays "Turn off help badges" (REQ-8).
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
    applyDemo(name)          # load a demo song (does not start transport)
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
```

## Tests & verification

- `tests/ui/tour-place.test.ts` (placement math), `e2e/onboarding.spec.ts`
  (interactive flow).
- `npm test` / `npm run e2e`.

## Open questions / future

- New tour steps should keep using injected `TourCtx` hooks (never DEV globals) so
  they work in production builds.
