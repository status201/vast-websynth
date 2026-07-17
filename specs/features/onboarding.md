# Onboarding (guided tour & help mode)

```yaml
id: onboarding
status: implemented
version: 4   # v4: active Help button toggles badges off directly (one-click exit)
owner: core
related:
  - architecture
  - input-control
  - midi-clock-sync
  - webrtc-sync
  - motion-sequencer
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

Scenario: Sync section carries USB + WiFi help badges (v2)
  Given help mode is on and the Song tab is open
  Then a `sync` badge anchors to the Master mode button and a `sync.wifi` badge
    anchors to the WiFi link button, each opening its connection-steps modal
# pinned by: tests/ui/help-content.test.ts (topic presence)
```

## Tests & verification

- `tests/ui/tour-place.test.ts` (placement math), `e2e/onboarding.spec.ts`
  (interactive flow).
- `npm test` / `npm run e2e`.

## Open questions / future

- New tour steps should keep using injected `TourCtx` hooks (never DEV globals) so
  they work in production builds.
