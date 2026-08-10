# Stable test identifiers (the E2E selector contract)

```yaml
id: testids
status: implemented
version: 7  # v7: createPanelTabs' ptab-/ppage- namespace (panel-tabs.md REQ-3) and
            #     the LFO panel's per-page ids (lfo.md REQ-12, REQ-15)
            # v6: chain-transpose-<up|down>-seq (arrangement.md REQ-8)
            # v5: ids interpolated from DATA (song-demo-<name>) must be enumerated
            #     by a test, never spelled — see REQ-8
            # v4: chooseDialog's dialog-choice-<id> (dialog.md REQ-8); dialog-cancel
            #     was always emitted but never catalogued
            # v3: the About modal's keyboard-layout picker (keyboard-layout.md)
            # v2: the header's ⓘ/? swap — info-badges replaces help-button, the
            #     Help chooser's two ids retire, and the badge ids become
            #     info-badge-* (onboarding.md v15)
owner: core
related:
  - architecture
  - step-grid-editing
  - transport-position
  - debug-panel
  - onboarding
source:
  - src/ui/components/knob.ts         # knob-<paramId>
  - src/ui/components/switch.ts       # switch-<paramId>
  - src/ui/components/segmented.ts    # seg-<paramId>[-<idx>]
  - src/ui/components/strip.ts        # strip-<paramId>
  - src/ui/components/tabs.ts         # tab-<id> / panel-<id>
  - src/ui/components/panel-tabs.ts   # ptab-<prefix>-<page> / ppage-<prefix>-<page>
  - src/ui/components/bank-bar.ts     # testidPrefix namespacing
  - src/ui/components/clear-menu.ts   # clear-<lane>-…
  - src/ui/components/button.ts       # opts.testId passthrough
  - src/ui/panels/
```

`data-testid` is a **contract**, not a test-writing detail: E2E specs, the guided
tour's spotlight targets and a dozen feature specs all name these ids, so renaming
one breaks callers outside the test that reads it.

## Background / Why

All component styling goes through CSS Modules, which **hash every class name** at
build time, so a class is never a stable selector. Text is not reliable either —
Playwright matches case-insensitively and this UI has real collisions: the header's
`Play` button vs the Arpeggiator's `play` control, the `Sampler` tab vs the Song
panel's `sampler` lane card. That leaves `data-testid` as the only stable handle,
which makes the id set a public surface worth specifying.

Ids are therefore minted **at the factory**, keyed off the thing they identify
(usually a `ParamBus` id), rather than hand-written per call site. A control built
through the shared factories gets a correct, predictable testid for free.

## Requirements

- **REQ-1** — Param-bound controls mint from the **param id**, inside the factory:
  `knob-<paramId>`, `switch-<paramId>`, `seg-<paramId>` (+ `seg-<paramId>-<idx>`
  per button), `strip-<paramId>`. Renaming a param renames its testid; no call site
  restates it. `Switch` accepts an explicit override for its non-param uses.
- **REQ-2** — Structural containers mint from their own id — `tab-<id>` /
  `panel-<id>` (`tabs.ts`) — and reusable multi-instance components namespace
  through a **prefix option** so one component can appear many times without
  colliding: `BankBar`'s `testidPrefix` (`bank-<lane>-…`), `clearMenu`'s `lane`
  (`clear-<lane>-…`), `buildLiveFxControls`' `testIdPrefix` (`perf` on the Song
  tab, `livefx` in the floating window), `buildTransportControls`' `testIdPrefix`
  (`transport` in the Song panel row, `transportw` in the floating window),
  `createPanelTabs`' `prefix` (`ptab-<prefix>-<page>`).
  - **`ptab-`/`ppage-` is deliberately distinct from `tab-`/`panel-`.** Two
    different components page two different things: `TabContainer` owns the
    machine row, and its `tab-<id>` ids are anchored by e2e specs, the guided
    tour's spotlight targets, `info-badges.ts` and `UiBridge.showTab`.
    `createPanelTabs` pages the body of one faceplate panel
    ([panel-tabs](panel-tabs.md) REQ-3). Reusing `tab-<id>` for both would let a
    panel page shadow a machine tab.
- **REQ-3** — Non-param buttons take an explicit `testId` (`createButton` →
  `opts.testId`); per-instance panel ids encode their coordinates
  (`drum-step-<track>-<step>`, `sampler-step-<slot>-<step>`).
- **REQ-4** — **Select by testid, not by label.** Capitalised button text collides
  with lowercase siblings under Playwright's case-insensitive matching.
- **REQ-5** — The transport row's play button is `<prefix>-toggle`, **never**
  `-play`: `transport-play` is the *header* button, and a default-prefixed instance
  minting a second one would break every spec that drives the transport by that id.
- **REQ-6** — An id in the catalogue below is not renamed without updating the
  specs that name it (cross-referenced inline).
- **REQ-7** — Engine/state assertions go through the DEV-only `window.__synth`
  bridge, never through the DOM (see [architecture](../architecture.md) → Global
  conventions).
- **REQ-8 (ids interpolated from data)** — Most ids are minted from a fixed
  vocabulary, so the catalogue below is the whole set and REQ-6 protects it. A few
  interpolate **runtime data** instead: `song-demo-<name>` takes the demo's own
  song name (via `demos-index.json`). That set changes whenever the data does —
  with no spec change, since `src/state/demos/` is a drop-in directory — so a test
  must **enumerate** those ids rather than spell one:
  `[data-testid^="song-demo-"]:not([data-testid="song-demo-more"])`, wrapped by
  the helpers in `e2e/helpers.ts`. Spelling one couples the suite to data it does
  not own; `tests/no-shipped-demo-names.test.ts` fails any test that does, and
  [write-a-test](../recipes/write-a-test.md) has the full rule.
  Two consequences worth knowing: the enumeration must exclude `song-demo-more`,
  which shares the prefix but is a toggle, not a demo — and a demo literally named
  `more` would mint a colliding id. Nothing prevents that today; it has not
  happened, and the fix (slugging the name) would break every existing selector.

## Technical design

### Contract / public interface

```yaml
auto-minting factories (src/ui/components/):
  Knob({ paramId })              -> knob-<paramId>
  Switch(paramId, testId?)       -> switch-<paramId>          # testId overrides
  Segmented(paramId)             -> seg-<paramId> · seg-<paramId>-<idx>
  Strip({ paramId })             -> strip-<paramId>
  TabContainer(tabs)             -> tab-<id> · panel-<id>
  createButton({ testId })       -> the given id (opt-in)
prefix-namespaced components:
  BankBar({ testidPrefix: L })   -> bank-<L>-<i> · bank-<L>-follow · bank-<L>-copy
  createClearMenu({ lane: L })   -> clear-<L> · clear-<L>-bank · clear-<L>-row-<i>
  buildLiveFxControls({ testIdPrefix: P = 'perf' })
                                 -> <P>-fill · <P>-stutter · <P>-stutter-size-<n> ·
                                    <P>-drop · <P>-tapestop
  buildTransportControls({ testIdPrefix: P = 'transport' })
                                 -> <P>-toggle · <P>-tostart · <P>-readout ·
                                    <P>-scrub · <P>-scrub-<bar>
  createPanelTabs({ prefix: P })  -> ptab-<P>-<page> · ppage-<P>-<page>
```

### Catalogue

Grouped by surface; `<…>` is interpolated at build time.

```yaml
shell (app.ts):
  app-header · pattern-row · fx · keyboard · panic · header-menu
  transport-play                     # the HEADER play button (see REQ-5)
  preset-select · preset-save        # preset-save opens the manager
  scope-toggle · scope-channels-toggle · scope-canvas    # features/scope.md
  info-badges · about-button · fullscreen   # ⓘ toggles badges, ? opens About;
                                            # ids follow function, not glyph order
                                            # (features/responsive-header.md REQ-6)

synth faceplate panels:
  # The eight panel() panels carry no id of their own — their controls mint from
  # param ids (REQ-1). Only the LFO panel's pages and hints are named:
  ptab-lfo-<1|2> · ppage-lfo-<1|2>   # features/panel-tabs.md REQ-3
  pulse-hint-<lfo|lfo2>              # features/oscillators.md REQ-9 — per page, so
                                     #   the two hints don't collide by text (REQ-4)
  dest-taken-<lfo|lfo2>              # features/lfo.md REQ-12 — names the holder

step grids, rulers & overlays:
  seq-step-<i>                       # sequencer track 1
  seq-step-<t>-<i>                   # sequencer tracks 2-4  (features/sequencer.md)
  seq-track-<t> · seq-track-fold-<t> · seq-step-input
  seq-chord · seq-snap · seq-snap-toast      # features/chord-tools.md — the degree
                                             #   writer and SNAP. `seq-chord` is a
                                             #   Dropdown, which mints no per-row ids.
  drum-step-<track>-<step> · drum-track-<track>
  drum-kit · drum-model · drum-randomize · drum-reset      # features/drum-kits.md
  sampler-step-<slot>-<step>
  motion-step-<s>                    # the mini XY pads
  ruler-<lane> · ruler-<lane>-<0..15> · ruler-<lane>-bar   # lane = seq|drum|sampler|motion
  rest-overlay-<lane>                # features/arrangement-rest.md
  # the lit ruler tick carries the GLOBAL `playing` class, so e2e can find it
  # despite CSS-Module hashing — see features/transport-position.md

per-step edit row (StepSettingsEditor):                    # features/step-settings.md
  <seq|drum|sampler>-vel · -gate · -prob · -ratchet · -ratchet-<n> · -tie

banks, clear menus & undo:                          # features/banks.md, step-grid-editing.md
  bank-<lane>-<i> · bank-<lane>-follow · bank-<lane>-copy
  clear-<lane> · clear-<lane>-bank · clear-<lane>-row-<i> · clear-toast-<lane>
  undo-<lane>                                       # features/pattern-undo.md
  machine-<lane>-chain                              # features/machine-status.md

key tab:                     # features/scale-quantization.md, features/chord-tools.md
  # scale.root / scale.type / chord.voicing are ParamDropdowns, which mint no id of
  # their own (REQ-1 covers factory-minted ids; Dropdown takes one per call site):
  key-root · key-scale · key-chord · key-hint
  key-map · key-map-<0..23> · key-legend   # the two-octave map; the per-key id is
                                           #   the SEMITONE, so 0..11 is octave 1

motion tab:                                         # features/motion-sequencer.md
  motion-view · motion-view-<x|y> · motion-graph · motion-xypad
  motion-assign-<x|y> · motion-assign-reset
  motion-trk-<0|1>-param · motion-trk-<0|1>-step-<s> · motion-trk-<0|1>-graph
  seg-motion.t<0|1>.slide
  motion-readout-xy · motion-readout-trk-<0|1>   # per-lane value readout (v11)
  motion-value-bubble                            # the drag bubble; absent when idle

sampler slots:                                      # features/sampler.md
  sampler-load-<slot> · sampler-name-<slot> · sampler-edit-<slot> ·
  sampler-file-<slot> · sampler-record
  seq-import-slot · seq-import-render               # features/render-to-sampler.md

xy pad:                                             # features/xy-pad.md
  xypad-surface · xypad-dot · xypad-hint · xypad-gear ·
  xypad-axis-<x|y> · xypad-assign-<x|y> · xypad-window

song panel — lanes, chains & live FX:
  song-lane-<seq|drum|sampler>       # + switch-<lane>.mute / .solo / knob-<lane>.master
  song-lane-motion                   # chain + switch-motion.mute only — no solo/volume
  song-lane-title-<lane>             # opens that machine's tab (features/machine-status.md)
  song-chain-<lane> · chain-chip-<lane>-<idx> · chain-add-<lane>-<i> ·
  chain-add-rest-<lane> · chain-clear-<lane>        # features/arrangement.md
  chain-transpose-<up|down>-seq                     # SEQ ONLY — the other lanes are
                                                    #   unpitched, so the control is
                                                    #   absent, not disabled (REQ-8)
  perf-fill · perf-stutter · perf-stutter-size-<n> · perf-drop · perf-tapestop
  livefx-open · livefx-window + the same five under the `livefx` prefix
                                                    # features/live-fx-window.md
  sync-mode-<off|master|slave> · sync-status · sync-wifi-link   # features/midi-clock-sync.md
  sync-pair-<generate|scan|next|back|apply|close|qr|status|error|insecure|debug>
                                                    # features/webrtc-sync.md

song panel — files:
  song-save · song-load · song-new · song-slot-select
  song-export · song-import · song-import-file · song-undo-toast
  song-demo-<name> · song-demo-more    # <name> is DATA — see REQ-8, never spell one
  song-paste + paste-modal · paste-input · paste-status · paste-confirm ·
    paste-cancel · paste-read-clipboard             # features/paste-import.md
  export-modal · export-kind-<json|project> · export-project-note ·
    export-fmt-<wav|mp3> · export-confirm · export-cancel
  song-share-link                                   # Copy Link (features/song-share-link.md)

transport row & window:                             # features/transport-window.md
  transport-open · transport-window
  transport-tostart · transport-readout · transport-scrub · transport-scrub-<bar>
  transportw-toggle · transportw-tostart · transportw-readout · transportw-scrub ·
    transportw-scrub-<bar>

audio capture:
  song-export-audio · song-export-fmt-<wav|mp3> · song-record
  export-audio-modal · export-audio-fmt-<wav|mp3> · export-audio-runs ·
    export-audio-tail · export-audio-length · export-audio-status ·
    export-audio-progress · export-audio-confirm · export-audio-cancel ·
    export-audio-abort                              # features/audio-export.md
  record-window · record-toggle · record-stop · record-save · record-discard ·
    record-status · record-timer · record-fmt-<wav|mp3>   # features/record-window.md
  mic-record-toggle · mic-play · mic-load · mic-undo · mic-reset · mic-close ·
    mic-save-<wav|mp3> · mic-slot-select · mic-fx-<name>  # features/sample-recorder.md

presets:                                            # features/presets.md
  preset-manager · preset-mgr-save · preset-mgr-export-preset ·
    preset-mgr-export-bank · preset-mgr-bank-scope-<modified|all> ·
    preset-mgr-import · preset-mgr-file · preset-mgr-close · preset-toast
  preset-import-review · preset-import-row-<name> ·
    preset-import-policy-<rename|overwrite|skip> · preset-import-confirm ·
    preset-import-back

shared UI:
  dialog-detail · dialog-input · dialog-confirm ·
    dialog-cancel · dialog-choice-<id>              # features/dialog.md
  dropdown-filter                                   # features/dropdown.md
  toast-host · toast-action · toast-dismiss         # features/toast.md
  fxgroup-<prefix> · fx-patch-decoration            # features/fx-group.md
  empty-play-modal · empty-play-demo · empty-play-dismiss · empty-play-close
                                                    # features/empty-play-hint.md
  perf-settings · perf-status · perf-mode · perf-mode-<tier> · perf-reload ·
    perf-reload-hint                                # features/performance-mode.md
  factory-reset                                     # features/factory-reset.md

onboarding:                                         # features/onboarding.md
  tour-overlay · tour-callout · tour-next · tour-done · tour-back · tour-skip
  start-tour                                        # in the About modal (REQ-20)
  shortcuts-layout-gear · shortcuts-layout-select   # features/keyboard-layout.md
  info-badge-layer · info-badge-<topic>
  sweet-<paramId>-<label>                           # features/tempo-sync-help.md

about → debug panel:                                # features/debug-panel.md
  debug-section · debug-actions
  rows:    debug-ctx-state · -latency · -transport · -perf-tier · -sampler-clips ·
           -session · -storage · -sw · -midi · -wake · -ios-unlock · -ios-loop ·
           -media-session · -background
  actions: debug-ctx-toggle · debug-panic · debug-test-tone · debug-copy
  inline:  debug-clips-clear · debug-session-clear · debug-sw-unregister
```

### Layer touchpoints

```yaml
minting: src/ui/components/*.ts (factories) · src/ui/panels/*.ts (per-instance)
reading: e2e/*.spec.ts (selectors) · src/ui/onboarding/tour.ts (spotlight targets)
state:   window.__synth (DEV-only bridge) — never the DOM
```

## Scenarios (BDD)

```gherkin
Scenario: A param control is selectable by its param id
  Given the app has booted
  When a spec queries [data-testid="knob-filter.cutoff"]
  Then it finds the CUTOFF knob, whatever its hashed CSS class is
# pinned by: e2e/controls.spec.ts

Scenario: Testids disambiguate a case-insensitive label collision
  Given the header has a "Play" button and the Arpeggiator a "play" control
  When a spec selects [data-testid="transport-play"]
  Then it drives the header button only
# pinned by: e2e/smoke.spec.ts, e2e/arp.spec.ts

Scenario: One component serves many surfaces without id collisions (REQ-2)
  Given each machine builds a BankBar with its own testidPrefix
  When a spec selects [data-testid="bank-drum-2"]
  Then it finds the drum machine's bank C button, not the sequencer's
# pinned by: e2e/banks.spec.ts

Scenario: The transport window's play button does not shadow the header's (REQ-5)
  Given the floating transport window is open
  When a spec selects [data-testid="transport-play"]
  Then exactly one element matches — the header button
  And the window's own toggle is [data-testid="transportw-toggle"]
# pinned by: e2e/transport-window.spec.ts
```

## Tests & verification

- Every `e2e/*.spec.ts` consumes this catalogue; `npm run e2e`.
- Conventions for *writing* those specs (mocks, dialogs, downloads, fake media
  devices) live in [`recipes/write-a-test.md`](../recipes/write-a-test.md) and
  `e2e/CLAUDE.md`.

## Open questions / future

- A new interactive component should mint its id in the factory (REQ-1/REQ-2)
  rather than take one per call site, and add a row to the catalogue above.
