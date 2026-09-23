# Stable test identifiers (the E2E selector contract)

```yaml
id: testids
status: implemented
version: 23 # v23: the seq track row's mute and pan are named in the catalogue as
            #      param-minted ids, so knob-seq.t<t>.pan is findable from here
            # v22: motion's single-param lanes go from two to four, so four id
            #      families widen to <0..3> and the lane fold caret joins them
            #      (motion-sequencer.md REQ-extra-single-param-tracks-per-bank/REQ-an-empty-motion-lane-starts-folded).
            #      seq-track-fold-<t> is unchanged in name and meaning although
            #      its implementation moved into the shared lane-fold component
            # v21: debug-scope — the Debug panel's scope-liveness row (scope.md
            #      REQ-the-panel-says-whether-it-is-drawing)
            # v20: the song transport's Loop button (transport-loop.md REQ-a-loop-button-on-both-surfaces)
            #      and the global `loop` / `loop-anchor` cell classes (REQ-12);
            #      the Song row now carries `transport-toggle` too
            # v19: the About card's Play offline section (play-offline.md REQ-the-about-card-hosts-play-offline)
            #      and its toast (REQ-data-derived-ids-are-enumerated)
            # v18: the EQUALIZER section (equalizer.md REQ-eq-tab-ids-are-namespaced). Its tabs are
            #      eq-NAMESPACED — tab-eq-seq, not tab-seq — because the
            #      pattern row already owns the bare machine ids and a
            #      TabContainer mints tab-<id>/panel-<id> from whatever it
            #      is given. Shadowing them would make every machine-tab
            #      selector ambiguous.
            # v17: scope-zones-toggle — the Spectrum-only problem-band overlay
            #      (scope.md REQ-a-zones-toggle)
            # v16: the preset import wizard's error strip, its copy button and
            #      the review step's warnings (presets.md REQ-the-preset-wizard-reports-every-problem)
            # v15: dialog-copy — an alert's optional "copy the full text"
            #      button (dialog.md REQ-an-alert-may-offer-copyable-text)
            # v14: the Edit Sample modal's three fold headers —
            #      <chop|stretch|scratch>-section/-head/-toggle/-body
            #      (sample-recorder.md REQ-every-section-below-the-waveform-folds)
            # v13: the Fit / Shift rows and the slot-row FIT button
            #      (time-stretch.md)
            # v12: lazy-load-failed-toast, the deferred-surface load report
            #      (onboarding.md REQ-the-help-door-never-fails-silently)
            # v11: the per-step edit row's micro slider exposes its PARTS
            #      (-micro-track/-dec/-inc/-value), step-settings.md REQ-a-step-carries-a-micro-offset
            # v10: meter-picker + machine-<lane>-len/-rate/-meter-hint
            # v9: tempolock-/tempodiv-<paramId> and dropdown-<prefix>.dest
            #     (tempo-lock.md, lfo.md v9)
            # v8: scope-resize-handle (scope.md REQ-a-scope-resize-handle)
            # v7: createPanelTabs' ptab-/ppage- namespace (panel-tabs.md REQ-panel-tab-testids-are-prefixed) and
            #     the LFO panel's per-page ids (lfo.md REQ-destinations-are-no-longer-exclusive, REQ-the-two-lfos-share-one-panel)
            # v6: chain-transpose-<up|down>-seq (arrangement.md REQ-a-seq-slot-carries-a-transpose)
            # v5: ids interpolated from DATA (song-demo-<name>) must be enumerated
            #     by a test, never spelled — see REQ-data-derived-ids-are-enumerated
            # v4: chooseDialog's dialog-choice-<id> (dialog.md REQ-choose-dialog-offers-several-options); dialog-cancel
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

- **REQ-param-controls-mint-from-the-param-id** — Param-bound controls mint from
  the **param id**, inside the factory: `knob-<paramId>`, `switch-<paramId>`,
  `seg-<paramId>` (+ `seg-<paramId>-<idx>` per button), `strip-<paramId>`.
  Renaming a param renames its testid; no call site restates it. `Switch`
  accepts an explicit override for its non-param uses.
  - (v9) A `Knob` on a lockable param mints two more from the **same** param id:
    `tempolock-<paramId>` (the note glyph) and `tempodiv-<paramId>` (the division
    chip) — [tempo-lock](tempo-lock.md) REQ-the-lock-is-a-note-glyph/REQ-locked-the-division-replaces-the-dial. Keyed off the *rate/time*
    param the lock governs, not off the `.sync` param it writes, so the three ids
    on one knob share one stem and a selector reads as one control.
    `tempodiv-` wraps a whole `Dropdown`, so its own text includes the closed
    menu — assert against the toggle's label span, not the chip.
- **REQ-containers-mint-from-their-own-id** — Structural containers mint from
  their own id — `tab-<id>` / `panel-<id>` (`tabs.ts`) — and reusable
  multi-instance components namespace through a **prefix option** so one
  component can appear many times without colliding: `BankBar`'s `testidPrefix`
  (`bank-<lane>-…`), `createClearMenu`'s `lane` (`clear-<lane>-…`),
  `buildLiveFxControls`' `testIdPrefix` (`perf` on the Song tab, `livefx` in the
  floating window), `buildTransportControls`' `testIdPrefix` (`transport` in the
  Song panel row, `transportw` in the floating window), `createPanelTabs`'
  `prefix` (`ptab-<prefix>-<page>`).
  - **`ptab-`/`ppage-` is deliberately distinct from `tab-`/`panel-`.** Two
    different components page two different things: `TabContainer` owns the
    machine row, and its `tab-<id>` ids are anchored by e2e specs, the guided
    tour's spotlight targets, `info-badges.ts` and `UiBridge.showTab`.
    `createPanelTabs` pages the body of one faceplate panel
    ([panel-tabs](panel-tabs.md) REQ-panel-tab-testids-are-prefixed). Reusing `tab-<id>` for both would let a
    panel page shadow a machine tab.
- **REQ-non-param-buttons-take-an-explicit-testid** — Non-param buttons take an
  explicit `testId` (`createButton` → `opts.testId`); per-instance panel ids
  encode their coordinates (`drum-step-<track>-<step>`,
  `sampler-step-<slot>-<step>`).
- **REQ-select-by-testid-not-by-label** — **Select by testid, not by label.**
  Capitalised button text collides with lowercase siblings under Playwright's
  case-insensitive matching.
- **REQ-transport-play-is-prefix-toggle** — The transport row's play button is
  `<prefix>-toggle`, **never** `-play`: `transport-play` is the *header* button,
  and a default-prefixed instance minting a second one would break every spec
  that drives the transport by that id.
- **REQ-a-catalogue-id-is-not-renamed-alone** — An id in the catalogue below is
  not renamed without updating the specs that name it (cross-referenced inline).
- **REQ-state-assertions-use-the-dev-bridge** — Engine/state assertions go
  through the DEV-only `window.__synth` bridge, never through the DOM (see
  [architecture](../architecture.md) → Global conventions).
- **REQ-data-derived-ids-are-enumerated** (ids interpolated from data) — Most
  ids are minted from a fixed vocabulary, so the catalogue below is the whole
  set and REQ-a-catalogue-id-is-not-renamed-alone protects it. A few interpolate
  **runtime data** instead: `song-demo-<name>` takes the demo's own song name
  (via `demos-index.json`). That set changes whenever the data does — with no
  spec change, since `src/state/demos/` is a drop-in directory — so a test must
  **enumerate** those ids rather than spell one:
  `[data-testid^="song-demo-"]:not([data-testid="song-demo-more"])`, wrapped by
  the helpers in `e2e/helpers.ts`. Spelling one couples the suite to data it
  does not own; `tests/no-shipped-demo-names.test.ts` fails any test that does,
  and [write-a-test](../recipes/write-a-test.md) has the full rule. Two
  consequences worth knowing: the enumeration must exclude `song-demo-more`,
  which shares the prefix but is a toggle, not a demo — and a demo literally
  named `more` would mint a colliding id. Nothing prevents that today; it has
  not happened, and the fix (slugging the name) would break every existing
  selector.

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
  BankBar({ testidPrefix: L })   -> bank-<L>-<i> · bank-<L>-follow · bank-<L>-copy ·
                                    bank-<L>-add · bank-<L>-remove   # the grow/shrink arms
  createClearMenu({ lane: L })   -> clear-<L> · clear-<L>-bank · clear-<L>-row-<i>
  buildLiveFxControls({ testIdPrefix: P = 'perf' })
                                 -> <P>-fill · <P>-stutter · <P>-stutter-size-<n> ·
                                    <P>-drop · <P>-tapestop
  buildTransportControls({ testIdPrefix: P = 'transport' })
                                 -> <P>-toggle · <P>-tostart · <P>-readout ·
                                    <P>-loop · <P>-scrub · <P>-scrub-<bar>
  createPanelTabs({ prefix: P })  -> ptab-<P>-<page> · ppage-<P>-<page>
```

### Catalogue

Grouped by surface; `<…>` is interpolated at build time.

```yaml
shell (app.ts):
  app-header · pattern-row · fx · keyboard · panic · header-menu
  transport-play                     # the HEADER play button (see REQ-transport-play-is-prefix-toggle)
  preset-select · preset-save        # preset-save opens the manager
  scope-toggle · scope-channels-toggle · scope-canvas    # features/scope.md
  scope-resize-handle                # features/scope.md REQ-a-scope-resize-handle — drags the panel taller
  scope-zones-toggle                 # features/scope.md REQ-a-zones-toggle — hidden unless Spectrum
  eq-section                         # features/equalizer.md — the whole folded section
  tab-eq-<seq|drums|sampler>         # equalizer.md REQ-eq-tab-ids-are-namespaced — NOT tab-<lane>: those
  panel-eq-<seq|drums|sampler>       #   belong to the pattern row (REQ-a-catalogue-id-is-not-renamed-alone)
  eq-graph-<lane> · eq-canvas-<lane> # the wrapper carries data-eq-curve (REQ-14);
                                     #   the curve itself is canvas strokes, so the
                                     #   eight bands mint no ids of their own
  eq-preset-<lane> · eq-reset-<lane> # equalizer.md REQ-eq-presets-are-a-table-of-bus-writes
  # Its switches and knobs mint from param ids like every other control
  # (REQ-param-controls-mint-from-the-param-id): switch-fx.eq.on, knob-fx.drum.eq.hp, and so on.
  info-badges · about-button · fullscreen   # ⓘ toggles badges, ? opens About;
                                            # ids follow function, not glyph order
                                            # (features/responsive-header.md REQ-every-icon-button-has-a-title)

synth faceplate panels:
  # The seven panel() panels carry no id of their own — their controls mint from
  # param ids (REQ-param-controls-mint-from-the-param-id). Only the LFO panel's pages and hints are named:
  ptab-lfo-<1|2> · ppage-lfo-<1|2>   # features/panel-tabs.md REQ-panel-tab-testids-are-prefixed
  pulse-hint-<lfo|lfo2>              # features/oscillators.md REQ-pwm-rate-is-clamped — per page, so
                                     #   the two hints don't collide by text (REQ-select-by-testid-not-by-label)
  # dest-taken-<lfo|lfo2> REMOVED in lfo.md v8 — REQ-12 is superseded by the matrix

step grids, rulers & overlays:
  seq-step-<i>                       # sequencer track 1
  seq-step-<t>-<i>                   # sequencer tracks 2-4  (features/sequencer.md)
  seq-track-<t> · seq-track-fold-<t> · seq-step-input   # fold: features/lane-fold.md
  # the row's mute and pan mint from their param ids (REQ-param-controls-mint-from-the-param-id):
  #   switch-seq.t<t>.mute · knob-seq.t<t>.pan          # pan: features/sequencer.md
  seq-chord · seq-snap · seq-snap-toast      # features/chord-tools.md — the degree
                                             #   writer and SNAP. `seq-chord` is a
                                             #   Dropdown, which mints no per-row ids.
  drum-step-<track>-<step> · drum-track-<track>
  drum-kit · drum-model · drum-randomize · drum-reset      # features/drum-kits.md
  sampler-step-<slot>-<step>
  motion-step-<s>                    # the mini XY pads
  ruler-<lane> · ruler-<lane>-<0..15> · ruler-<lane>-bar   # lane = seq|drum|sampler|motion
  ruler-<lane>-bar-<prev|next>                             # the ‹ › bar steppers
  # A tick past the lane's played length is `hidden`, not removed (meter.md
  # REQ-cells-beyond-the-length-are-hidden) — so all 16 ids always resolve, and `:visible` is what counts them.
  # `ruler-<lane>-bar` shares the `ruler-<lane>-` prefix and is NOT a tick: count
  # ticks inside `ruler-<lane>`, or assert the last live index directly.
  rest-overlay-<lane>                # features/arrangement-rest.md
  # the lit ruler tick carries the GLOBAL `playing` class, so e2e can find it
  # despite CSS-Module hashing — see features/transport-position.md

per-step edit row (StepSettingsEditor):                    # features/step-settings.md
  <seq|drum|sampler>-vel · -gate · -prob · -ratchet · -ratchet-<n> · -tie
  <seq|drum|sampler>-micro · -micro-track · -micro-dec · -micro-inc · -micro-value
  # micro is the one slider whose PARTS are addressable: it grew −/+ buttons, so a
  # positional selector into the row breaks (features/step-settings.md REQ-a-step-carries-a-micro-offset)

banks, clear menus & undo:                          # features/banks.md, step-grid-editing.md
  bank-<lane>-<i> · bank-<lane>-follow · bank-<lane>-copy
  bank-<lane>-add · bank-<lane>-remove              # <i> runs 0..7 now (banks.md)
                                                    # -add is ABSENT at the ceiling
  clear-<lane> · clear-<lane>-bank · clear-<lane>-row-<i> · clear-toast-<lane>
  undo-<lane>                                       # features/pattern-undo.md
  machine-<lane>-chain · machine-<lane>-mute · machine-<lane>-solo
                                                    # features/machine-status.md
  machine-<lane>-grid · machine-<lane>-len · machine-<lane>-rate
  machine-<lane>-meter-hint                         # features/meter.md (v10)
  # `-grid` is the cluster root: its `title` carries the in-meter reading, and
  # `-meter-hint` is EMPTY + hidden while the lane matches the bar.

key tab:                     # features/scale-quantization.md, features/chord-tools.md
  # scale.root / scale.type / chord.voicing are ParamDropdowns, which mint no id of
  # their own (REQ-param-controls-mint-from-the-param-id covers factory-minted ids; Dropdown takes one per call site):
  key-root · key-scale · key-chord · key-hint
  key-map · key-map-<0..23> · key-legend   # the two-octave map; the per-key id is
                                           #   the SEMITONE, so 0..11 is octave 1

mod matrix window:                                  # features/mod-matrix.md
  mod-window · mod-row-<0..7> · mod-hint
  mod-src-<2..7> · mod-dst-<0..7>    # rows 0-1 are the LFOs: fixed source, so no
                                     #   src picker, and their dst/amt bind to
                                     #   lfo.dest / lfo.amount (REQ-containers-mint-from-their-own-id)
  perf-mod                           # the launcher, beside perf-xypad

motion tab:                                         # features/motion-sequencer.md
  motion-view · motion-view-<x|y> · motion-graph · motion-xypad
  motion-assign-<x|y> · motion-assign-reset
  motion-trk-<0..3>-param · motion-trk-<0..3>-step-<s> · motion-trk-<0..3>-graph
  motion-trk-<0..3>-fold                         # the lane fold caret (v17, features/lane-fold.md)
  seg-motion.t<0..3>.slide
  motion-readout-xy · motion-readout-trk-<0..3>  # per-lane value readout (v11)
  motion-value-bubble                            # the drag bubble; absent when idle

sampler slots:                                      # features/sampler.md
  sampler-load-<slot> · sampler-name-<slot> · sampler-edit-<slot> ·
  sampler-file-<slot> · sampler-record ·
  sampler-fit-<slot>                                # the row's FIT button
    # (sampler.md REQ-a-slot-row-carries-a-fit-button / time-stretch.md REQ-the-slot-fit-button-is-a-quick-fit). Hidden with sampler-edit-<slot>
    # while the slot holds no buffer, so assert on visibility, not presence.
  sampler-slot-reset                                # the selected-slot strip's
    # Reset (sampler.md REQ-each-slot-has-a-channel). The strip's own controls mint no ids of their own:
    # they are Knob/Switch, so they are knob-sampler.t<slot>.<param> and
    # switch-sampler.t<slot>.rev — and the <slot> moves with the grid cursor.
  seq-import-slot · seq-import-render               # features/render-to-sampler.md

xy pad:                                             # features/xy-pad.md
  xypad-surface · xypad-dot · xypad-hint · xypad-gear ·
  xypad-axis-<x|y> · xypad-assign-<x|y> · xypad-window

song panel — lanes, chains & live FX:
  song-lane-<seq|drum|sampler>       # + switch-<lane>.mute / .solo / knob-<lane>.master
  song-lane-motion                   # chain + switch-motion.mute only — no solo/volume
  song-lane-title-<lane>             # opens that machine's tab (features/machine-status.md)
  song-chain-<lane> · chain-chip-<lane>-<idx> · chain-add-<lane>-<i> ·   # <i> 0..7,
                                                    # only as many as that machine has
  chain-add-rest-<lane> · chain-clear-<lane>        # features/arrangement.md
  chain-move-<left|right>-<lane> · chain-remove-<lane>   # the precise reorder path
                                                    #   REQ-11 keeps beside the drag
  # a chip being dragged / a chip about to receive a drop are read off the chip's
  # own attributes, not extra testids (REQ-11):
  #   data-dragging="true" · data-drag-over="before|after"
  chain-transpose-<up|down>-seq                     # SEQ ONLY — the other lanes are
                                                    #   unpitched, so the control is
                                                    #   absent, not disabled (REQ-data-derived-ids-are-enumerated)
  perf-fill · perf-stutter · perf-stutter-size-<n> · perf-drop · perf-tapestop
  perf-xypad                         # the Song-panel XY launcher; livefx-xypad and
                                     #   motion-xypad open the SAME window (REQ-non-param-buttons-take-an-explicit-testid there)
  livefx-open · livefx-window · livefx-xypad + the same five under the `livefx`
    prefix                                          # features/live-fx-window.md
  sync-mode-<off|master|slave> · sync-status · sync-wifi-link   # features/midi-clock-sync.md
  sync-pair-<create|join|generate|scan|next|back|apply|close|qr|status|error|insecure|debug>
  sync-pair-<offer|answer> · sync-pair-<offer|answer>-copy   # the blob textareas +
                                                    #   their copy buttons
                                                    # features/webrtc-sync.md

song panel — files:
  song-save · song-load · song-new · song-slot-select
  song-export · song-import · song-import-file · song-undo-toast
  song-demo-<name> · song-demo-more    # <name> is DATA — see REQ-data-derived-ids-are-enumerated, never spell one
  song-paste + paste-modal · paste-input · paste-status · paste-confirm ·
    paste-cancel · paste-read-clipboard             # features/paste-import.md
  export-modal · export-kind-<json|project> · export-project-note ·
    export-fmt-<wav|mp3> · export-confirm · export-cancel
  song-share-link                                   # Copy Link (features/song-share-link.md)

transport row & window:                             # features/transport-window.md
  transport-open · transport-window
  transport-toggle · transport-tostart · transport-readout · transport-loop ·
    transport-scrub · transport-scrub-<bar>
  transportw-toggle · transportw-tostart · transportw-readout · transportw-loop ·
    transportw-scrub · transportw-scrub-<bar>
  # scrub cells carry GLOBAL state classes: `playing` (current bar), `loop` (in
  # the effective loop range), `loop-anchor` (a pending first pick) —
  # features/transport-loop.md REQ-what-the-loop-scrubber-shows

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
  chop-section · chop-head · chop-toggle · chop-body ·
    chop-row · chop-count · chop-equal · chop-detect · chop-spread ·
    chop-toast                                        # features/sample-chop.md
    # The editor modal's three sections all mint the same four ids —
    # <base>-section (the wrapper), -head (the clickable title row), -toggle
    # (the caret button) and -body (what folds). One shape, so a fold test can
    # be written once and parameterised. # features/sample-recorder.md REQ-every-section-below-the-waveform-folds
    # The boundaries themselves are canvas strokes, not elements, so they mint no
    # ids — a chop is asserted through the slots it fills, not through its markers.
  stretch-section · stretch-head · stretch-toggle · stretch-body ·
    fit-row · fit-target · fit-mode · fit-apply · fit-hint ·
    shift-row · shift-amount · shift-apply ·
    fit-toast · fit-load-failed-toast                 # features/time-stretch.md
    # `fit-toast` is raised by the SLOT-ROW button (sampler-fit-<slot>), not by the
    # modal: inside the modal the one-level undo already covers the edit.
  scratch-section · scratch-head · scratch-toggle · scratch-body · scratch-graph ·
    scratch-canvas · scratch-legend · scratch-row · scratch-hint ·
    scratch-length · scratch-preset · scratch-random · scratch-preview ·
    scratch-apply                                     # features/scratch.md
    # The curve's points, its cut bands and its cue are canvas strokes, not
    # elements — the same rule the chop boundaries above follow. A scratch is
    # asserted through the buffer it produces (its exact frame count), never
    # through a handle per breakpoint, which would mint an id per user gesture.

presets:                                            # features/presets.md
  preset-manager · preset-mgr-save · preset-mgr-export-preset ·
    preset-mgr-export-bank · preset-mgr-bank-scope-<modified|all> ·
    preset-mgr-import · preset-mgr-file · preset-mgr-close · preset-toast
  preset-import-review · preset-import-row-<name> ·
    preset-import-policy-<rename|overwrite|skip> · preset-import-confirm ·
    preset-import-back
  preset-import-errors · preset-import-copy ·
    preset-import-warnings                          # presets.md REQ-the-preset-wizard-reports-every-problem (v16)
                                                    # rows inside carry no ids of
                                                    # their own — query the container

shared UI:
  dialog-detail · dialog-input · dialog-confirm ·
    dialog-cancel · dialog-choice-<id> · dialog-copy # features/dialog.md (copy: v15)
  dropdown-filter                                   # features/dropdown.md
  tempolock-<paramId> · tempodiv-<paramId>          # features/tempo-lock.md
  dropdown-lfo.dest · dropdown-lfo2.dest            # features/lfo.md (v9)
  meter-picker                                      # features/meter.md (v10)
  toast · toast-host · toast-action · toast-dismiss # `toast` is showToast's DEFAULT
                                                    #   root id (features/toast.md REQ-toast-testids)
  value-bubble                                      # the drag readout's default id;
                                                    #   motion-value-bubble overrides it
  fxgroup-<prefix> · fx-patch-decoration            # features/fx-group.md
  grmeter-<fxPrefix>                                # grmeter-fx.drum.comp,
                                                    #   grmeter-fx.master.comp
                                                    # features/compressor.md
  clips-restored-toast                              # boot-time sampler restore
                                                    # features/sample-persistence.md
  audio-suspended-toast                             # "tap to resume" when every
                                                    #   automatic resume failed
                                                    # features/audio-lifecycle.md REQ-a-stuck-context-is-visible
  lazy-load-failed-toast                            # a deferred surface's import()
                                                    #   rejected (onboarding.md REQ-the-help-door-never-fails-silently)
  empty-play-modal · empty-play-demo · empty-play-dismiss · empty-play-close
                                                    # features/empty-play-hint.md
  perf-settings · perf-status · perf-mode · perf-mode-<tier> · perf-reload ·
    perf-reload-hint                                # features/performance-mode.md
  play-offline · play-offline-button · play-offline-status · play-offline-progress
                                                    # About card, above factory-reset
                                                    # features/play-offline.md
  play-offline-toast                                # a download that ended behind a
                                                    #   closed About (play-offline REQ-offline-feedback-while-about-is-closed),
                                                    #   or the re-download after a
                                                    #   factory reset (REQ-12)
  factory-reset                                     # features/factory-reset.md

onboarding:                                         # features/onboarding.md
  tour-overlay · tour-callout · tour-next · tour-done · tour-back · tour-skip
  start-tour                                        # in the About modal (REQ-20)
  shortcuts-layout-gear · shortcuts-layout-select   # features/keyboard-layout.md
  info-badge-layer · info-badge-<topic>   # incl. info-badge-meter (features/meter.md)
  sweet-<paramId>-<label>                           # features/tempo-sync-help.md

about → debug panel:                                # features/debug-panel.md
  debug-section · debug-actions
  rows:    debug-ctx-state · -latency · -transport · -perf-tier · -sampler-clips ·
           -session · -storage · -sw · -midi · -wake · -scope · -ios-unlock ·
           -ios-loop · -media-session · -background
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

Scenario: One component serves many surfaces without id collisions (REQ-containers-mint-from-their-own-id)
  Given each machine builds a BankBar with its own testidPrefix
  When a spec selects [data-testid="bank-drum-2"]
  Then it finds the drum machine's bank C button, not the sequencer's
# pinned by: e2e/banks.spec.ts

Scenario: The transport window's play button does not shadow the header's (REQ-transport-play-is-prefix-toggle)
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

- A new interactive component should mint its id in the factory (REQ-param-controls-mint-from-the-param-id/REQ-containers-mint-from-their-own-id)
  rather than take one per call site, and add a row to the catalogue above.
