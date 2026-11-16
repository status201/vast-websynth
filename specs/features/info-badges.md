# Info badges (per-control help, and the ⓘ button that shows it)

```yaml
id: info-badges
status: implemented
version: 1
owner: core
related:
  - onboarding            # the help copy, the tour and About; the lazy body these load with
  - input-control         # the `?` key
  - equalizer             # REQ-the-equalizer-carries-seven-badges — the section its seven badges annotate
  - sampler
  - motion-panel
  - song-mode
  - midi-clock-sync
  - webrtc-sync
  - presets
  - mod-matrix
  - scale-quantization
  - chord-tools
  - meter
  - render-to-sampler
source:
  - src/ui/onboarding/info-badges.ts
  - src/ui/components/info-badges-button.ts
  - src/ui/components/header-icons.ts   # the ⓘ glyph's part hooks (REQ-the-glyph-inverts-while-badges-show)
  - src/ui/panels/sampler-panel.ts      # the REQ-the-sampler-strip-carries-five-badges badge cells
  - src/ui/panels/eq-panel.ts           # the REQ-the-equalizer-carries-seven-badges knob-row cells
  - src/ui/onboarding/help-content.ts   # the copy each badge opens
```

## Background / Why

A dense control surface needs help *at* the control, not in a manual. Turning the
badges on pins a small **ⓘ** to each documented control; tapping one opens that
control's help topic ([onboarding](onboarding.md) owns the copy and the lazy body
both load with). This spec owns the header button that toggles them, the rules for
where a badge may show, and which controls carry one.

## Requirements

- **REQ-info-badges-show-per-control-help** — The info badges show per-control
  help content from `help-content.ts`. The badge *vocabulary* is "info" (the ⓘ
  glyph the user clicks): `InfoBadges`, `Onboarding.toggleInfoBadges`,
  `UiBridge.toggleInfoBadges`, testids `info-badge-layer` /
  `info-badge-<topic>`, badge `aria-label` `Info: <title>`. The *content*
  vocabulary stays "help" — `help-content.ts`, `HelpTopic`, `HELP_TOPICS`,
  `TopicId` and the `data-help="<topic>"` anchors — because an info badge opens
  a help topic, and the anchors are spread across every panel file. The boundary
  is deliberate, not drift.

- **REQ-the-info-button-is-a-toggle** (v4, rewritten v15) — **The header's ⓘ
  button (`info-badges`) is a pure toggle.** One click shows the badges, one
  click hides them, in every state; it opens no modal and has no second outcome.
  It carries the orange `toggleActive` state (`tour.module.css`, shared with the
  Fullscreen button) **and** `aria-pressed`, so the on/off state is legible to
  sighted and assistive users alike. A click has one outcome in either state
  ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2); active styling
  does not license a second one.

- **REQ-the-glyph-inverts-while-badges-show** — **While the badges show,
  the glyph inverts into a badge.** `toggleActive` alone is *generic* active
  chrome — the Fullscreen button wears the same border and glow — so it says
  "this button is on", not "this button is the badges' switch". The active ⓘ
  therefore also takes the badge's own colour pair: the ring fills with
  `--accent` and the stem + tittle are drawn in `--bg-deep`, exactly `.badge`'s
  `background`/`color`. A user hunting for the way to turn the badges off finds
  a button wearing one.
  - **Idle is unchanged** — an outline ring in `currentColor`. The ⓘ and ? are a
    matched pair at rest ([responsive-header](responsive-header.md) REQ-utility-buttons-are-icon-only), and
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

- **REQ-the-info-button-gesture-inventory** (v13, re-authored v15) — **Gesture
  inventory for the ⓘ button.** A plain click toggles the badges, so no second
  gesture may have the same outcome.

  | Gesture (on `info-badges`) | Outcome                          | Precedent                          |
  | -------------------------- | -------------------------------- | ---------------------------------- |
  | click (either state)       | **toggle badges**                | one gesture, one outcome           |
  | Shift / Ctrl / ⌘ + click   | — (plain click already toggles)  | —                                  |
  | long-press                 | — (plain click already toggles)  | —                                  |
  | right-click                | — (`contextmenu` is globally suppressed) | —                          |
  | double-click               | — (reads as two toggles)         | —                                  |
  | `?` (global key)           | **toggle badges**                | `?` = help, near-universal         |

  Load-bearing details:
  - A `—` row is a decision, not an oversight
    (`../recipes/design-an-interaction.md` step 1).
  - No gesture's outcome depends on state
    ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2).
  - `?` reaches the app because `e.key` for Shift+`/` is `?`, so the `/`
    pitch-bend branch never sees it, and the `ctrl/meta/alt` bail-out in
    `installShortcuts` does not test `shiftKey`. It routes through
    `UiBridge.toggleInfoBadges` rather than importing onboarding into
    `shortcuts.ts` (the `toggleTransport`/`undoActiveMachine` precedent), and it
    is suppressed inside editable fields like every other key
    ([input-control](input-control.md) REQ-shortcuts-are-suppressed-in-a-field).
  - Discoverability (`../recipes/design-an-interaction.md` step 4): the button's
    glyph **is** the badge glyph — literally so while the badges show, where it
    takes the badge's colours too (REQ-the-glyph-inverts-while-badges-show) — its tooltip names the key (REQ-help-copy-tells-the-truth),
    the About key list carries the `?` row (REQ-about-key-symbols-are-drawn), and the tour's closing step
    spotlights it (REQ-the-tour-showcases-the-song-tab).

- **REQ-a-container-must-tell-badges-when-it-hides** — **Every container
  that shows and hides a badge's anchor must be in the reflow observer's
  selector list.** `position()` hides a badge whose anchor measures zero, and
  `enable()` re-runs it from a `ResizeObserver` over the containers that toggle
  — which is why `[data-testid="panel-seq"]` is observed. A
  [panel-tabs](panel-tabs.md) page shell is the same kind of `display:none ↔
  flex` container, so the LFO panel's first page (`ppage-lfo-1`) joins the list;
  without it the `lfo.rate` badge does not come back when the user returns from
  LFO 2's page. The second page needs no entry: its own anchor
  (`knob-lfo2.rate`) lives inside it, and revealing it is what triggers the
  observer on page 1 collapsing.
  - The Equalizer's **`eq-section`** and all three of its page shells
    (`panel-eq-seq`, `panel-eq-drums`, `panel-eq-sampler`) join the list too.
    The three pages are the same height — each takes it from `--scope-h`
    ([equalizer](equalizer.md) REQ-the-eq-page-mirrors-the-scope-row) — so a lane switch resizes neither the
    body nor any other observed container; only the two shells trading places
    change size. **Unfolding does not resize the body either**: an expanded
    section is absorbed by the keyboard row's slack (equalizer REQ-the-eq-is-a-third-bottom-row), so the
    page can stay exactly as tall. Without these entries the lane badges never
    appear when the section is opened, and after a switch the previous lane's
    stay pinned over a hidden page. All three shells are observed rather than
    one, because a switch between two lanes need not involve the third. The e2e
    was checked against the list with these entries removed: it fails at the
    unfold, before it reaches the switch.

- **REQ-a-badge-shows-only-where-reachable** — **A badge is shown only
  where it can be reached: hidden when its anchor leaves the viewport in
  *either* direction.** The badges are `position: fixed`, so they do not scroll
  with the page — `position()` re-pins every one of them on each scroll frame,
  and a badge whose computed spot is outside the viewport is not a badge the
  user can click. Three rules, one idea:
    - **zero-size anchor** (a collapsed panel, a hidden tab) → hide (REQ-a-container-must-tell-badges-when-it-hides);
    - **above** — the badge's top crosses into the sticky header's band
      (`top < header.bottom`) → hide, or it paints over the header. Anchors
      *inside* the header are exempt: they never scroll away, so measuring them
      against their own container would hide them permanently (REQ-a-presets-topic-anchors-to-the-picker);
    - **below** — the badge's bottom crosses the viewport's
      (`top + BADGE_SIZE > viewportHeight()`, the window's height in local px:
      [ui-scale](ui-scale.md) REQ-coordinates-are-converted-at-the-read) → hide.
  Both directions, or a badge scrolled past the fold stays pinned off-screen,
  reachable by nothing. The thresholds are deliberate mirrors: **any** overlap
  with the band hides, so a half-clipped badge — as unreachable as a fully hidden
  one, and uglier — never survives at either edge. No horizontal rule joins them:
  the faceplate is laid out to fit its width at every breakpoint
  ([responsive-header](responsive-header.md) REQ-below-720-the-preset-cluster-hides), so nothing scrolls sideways
  to fall off.

- **REQ-each-oscillator-carries-its-own-badge** — OSC 1 and OSC 2 each
  carry a panel badge, `oscillators` and `osc2`, anchored by `data-help` on
  their panels. One topic once explained both. Sync, FM and ring
  ([oscillator-sync](oscillator-sync.md), [cross-modulation](cross-modulation.md))
  grew it past what one modal reads comfortably, and each panel now has controls
  the other lacks. The split follows the panels:
  - `oscillators` (OSC 1) explains the shared controls (wave, OCT, TUNE, LEVEL,
    WIDTH) once, then OSC 1's own FM and RING.
  - `osc2` covers what is OSC 2's alone: SYNC and its knob, and how OSC 1 shapes
    OSC 2. It points back to OSC 1 for the shared controls instead of repeating
    them.

- **REQ-song-file-buttons-carry-badges** — The Song panel's file/audio buttons
  each carry their own badge — `song.load`, `song.save`, `song.import`,
  `song.export`, `song.new`, `song.exportAudio`, `song.record` — and their copy
  disambiguates the easy-to-confuse pairs (Save vs Export; Export the `.json`
  project vs Export Song the WAV/MP3 audio). These pin to the buttons' existing
  testids, so they reposition/hide on tab switch via the same reflow path as
  other in-panel badges (e.g. `seq.prob`).
  The demo row beside them carries **one** badge, `song.demos`, on the
  `Demos:` label (`data-help="song.demos"`); its topic body *is* the demo library,
  which is why `HelpContext` also carries `loadDemo` and `loadedDemo` ([demo-library](demo-library.md)
  REQ-info-mode-badges-the-demo-row-once).

- **REQ-the-song-audio-buttons-keep-their-badges** — **The Song tab's two
  audio buttons keep their badges, and both topics are rewritten**, because
  neither button does what it used to: `song.record` now opens the [Record
  window](record-window.md) and `song.exportAudio` opens the export options
  modal ([audio-export](audio-export.md) REQ-export-opens-an-options-modal). The
  old copy said "Press **Record** … press **Stop** to finish and download",
  which is now wrong twice over — a take is stopped, then explicitly saved or
  discarded. The record topic must cover the four phases, that **pause pauses
  the recorder and not the transport**, the discard-on-close confirm, and
  `Shift`+`R`; the export topic must cover runs and what the tail bar is for.
  The anchors (`song-record`, `song-export-audio`) are unchanged.

- **REQ-the-sync-section-has-two-topics** — The Song panel's Sync section
  carries two help topics: `sync` (what Master/Slave mean + the USB-MIDI
  connection steps — Android USB-MIDI peripheral mode / loopMIDI on Windows)
  anchored to `sync-mode-master`, and `sync.wifi` (WiFi pairing steps: same
  network + client isolation off → Create on one device, Join on the other, swap
  codes via QR or copy-paste) anchored to `sync-wifi-link`. See
  [midi-clock-sync.md](midi-clock-sync.md) / [webrtc-sync.md](webrtc-sync.md).

- **REQ-a-motion-topic-anchors-to-the-tab** — A `motion` help topic anchors
  to the Motion machine's tab (`tab-motion`, like the other machine tabs). Its
  copy explains the mini-pad anchors and, above all, the **Y/X graph view**: the
  overlay line projects one axis at a time (the toggle picks which assigned
  param it traces; the dots never move) and its shape follows Step/Slide mode.
  See [motion-panel](motion-panel.md)
  REQ-each-motion-step-is-a-mini-xy-pad.

- **REQ-the-motion-tab-carries-two-lane-badges** — **The Motion tab carries
  two short per-lane badges** beside the essay-length `motion` topic
  (REQ-a-motion-topic-anchors-to-the-tab): `motion.xy` anchored to the **XY lane
  header** (`data-help="motion.xy"`) and `motion.tracks` anchored to the **A
  lane's row** (`data-help="motion.tracks"`, one shared badge covering every
  single-param lane, since their number varies). Each is a 2–3 sentence quick explainer — the XY-pad automation and the
  single-param tracks respectively — for users who don't want the full Motion
  write-up. See [motion-panel](motion-panel.md)
  REQ-each-motion-step-is-a-mini-xy-pad.

- **REQ-a-presets-topic-anchors-to-the-picker** (v7, re-anchored v18) — **A
  `presets` topic anchors to `preset-select`.** It covers the whole preset
  cluster: the selector, and the single Presets button beside it
  ([presets](presets.md) REQ-one-door-for-saving) which opens save /
  export-preset / export-bank / import-with-review, none of which was explained
  anywhere. Its copy must separate a **preset** (one sound) from a **song** (the
  whole arrangement) — the confusion the badge exists to kill — and must
  describe the import review step as non-destructive until confirmed.
  - Deliberate: not on `preset-save`, one button from the ⓘ toggle, where the
    loudest mark in the header would pull the eye off the control
    REQ-the-glyph-inverts-while-badges-show makes findable. The selector is where
    the copy begins ("The dropdown flips through 16 factory sounds…").
  - Everything else is unchanged: default `'corner'` placement, the `inHeader`
    exemption from the scrolled-under-the-header rule, and hiding on a zero-size
    anchor when the cluster collapses behind the hamburger below 720px
    ([responsive-header](responsive-header.md) REQ-below-720-the-preset-cluster-hides).

- **REQ-a-settings-topic-anchors-to-the-gauge** — **A `settings` topic
  anchors to the header's Settings button** (`perf-settings`, the gauge), placed
  `'corner-left'`: the button's top-left corner, the side away from the ⓘ
  toggle. Its copy covers all three sections of the dialog — **Theme** (the looks,
  that Auto is the default, what Auto follows and that it falls back to Classic,
  that the choice is per device and never in a song;
  [ui-themes](ui-themes.md)), **UI size** (zooms the whole interface like the
  browser's zoom, 50–150%, applied on release; [ui-scale](ui-scale.md)) and
  **Performance** (what a tier trades, what Auto
  picks, and that buffer and voice changes wait for a reload;
  [performance-mode](performance-mode.md)).
  - Deliberate exception to REQ-a-presets-topic-anchors-to-the-picker's
    reasoning: the presets topic had the selector to move to, but the dialog
    this badge explains is not on screen while the badges show, so the button is
    the only place it can sit. It takes the corner away from ⓘ rather than leave
    the dialog unexplained.

- **REQ-seq-render-has-a-help-badge** — **The Sequencer's Render
  button carries a `seq.render` badge** (anchored to `seq-import-render`). Same
  rationale as REQ-song-file-buttons-carry-badges's per-button Song badges:
  "Import into sampler" is unexplained on screen, and pressing Render goes quiet
  for ~2 bars because it renders the bar **twice** to bake the reverb/delay tail
  into the loop — behaviour that reads as a hang unless the copy says so. The
  badge must also cover the two reasons the button greys out. See
  [render-to-sampler.md](render-to-sampler.md)
  REQ-the-render-button-carries-a-badge.

- **REQ-the-playhead-ruler-carries-a-badge** — **The playhead ruler
  carries a badge on every machine tab**, and the Song panel's transport row
  carries one on its launcher ([transport-position.md](transport-position.md)
  REQ-a-position-ruler-above-every-grid,
  [transport-window.md](transport-window.md)
  REQ-the-transport-launcher-is-the-section-title). The ruler's is **four topic
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

- **REQ-the-live-fx-row-carries-a-badge** — **The Live FX row carries a badge on
  its launcher**, `song.fx` anchored to `livefx-open`
  ([live-fx-window.md](live-fx-window.md) REQ-live-fx-row-carries-a-help-badge).
  It is written as `transport.song`'s **sibling** — the two rows sit against
  each other on the Song tab, both led by a launcher that doubles as its section
  title, so their copy follows the same order: what the row is, each control,
  what the floating window adds, where it is reduced. It stays out of the two
  topics that overlap its row: the master compressor (`fx.master.comp`) and the
  XY Pad's axis assignment (`motion.xy`). Before it, Live FX was the only
  unbadged section on the Song tab.

- **REQ-the-mod-launcher-carries-a-badge** — **The MOD launcher carries a
  badge**, `mod` anchored to `perf-mod` ([mod-matrix](mod-matrix.md)). It sits
  in the Live FX row but is not a Live FX control — it opens the patch's
  **modulation routing**, which is sound design rather than a momentary
  performance gesture. A vertical divider says that visually; the badge is what
  says *what it is*, since "MOD" alone names nothing a newcomer knows.

  Its copy carries the three things the window cannot show on its own: that **amount is
  bipolar** and past zero the route inverts; that a modulated knob on the synth panels
  grows an inner arc, **green for up and yellow for down**, so the effect is visible
  with the window shut; and **why the destination list is short** — ADR-017's boundary,
  pointing at Motion and the XY Pad for everything else. Without that last part a
  curated list reads as a missing feature.

- **REQ-key-and-chord-writer-carry-badges** — **The key and the chord
  writer each carry a badge.** `key` is anchored to `tab-key`, the machine-tab
  convention the arp/seq/drums badges already follow: an active scale silently
  re-pitches *every* note source ([scale-quantization](scale-quantization.md)),
  so "why does my note not sound where I put it?" has to be answerable from the
  tab itself. Its copy leads with the fact the panel cannot show — that the
  filter is **non-destructive**, and `chromatic` means nothing changes — and
  names the map's four colours, which is otherwise the one thing on the tab with
  no on-screen legend beyond three words.

  `seq.chord` is anchored to `seq-chord` on the Sequencer's step row
  ([chord-tools](chord-tools.md)). It earns a per-control badge on two counts that
  the badge policy already recognises: it is the only control in that row that writes
  to **four tracks at once**, and it is the only one whose options are disabled by a
  setting on **another tab** — a dead control with an off-screen cause is exactly the
  case ADR-014 says must explain itself. The copy also decodes the Roman numerals,
  which are the notation a non-musician will not have.

- **REQ-the-meter-has-a-help-topic** — **The meter has a help topic and an
  info badge**, anchored to the header's `meter-picker` beside SWING's. It is
  one topic, not three: the time signature and the per-machine `LEN`/`RATE`
  overrides are one idea ([meter](meter.md)), and pinning a second badge inside
  each machine header would spend the row's one-line budget
  (`responsive-machine-header.md`) on chrome. The copy carries the two things
  the controls cannot say themselves — that a lane off the bar is deliberate,
  and that 5/4 and 7/4 need a coarser rate because a bar of them is longer than
  the grid.

- **REQ-the-sampler-strip-carries-five-badges** — **The Sampler's
  selected-slot strip carries five badges**: `sampler.pitch`, `sampler.window`
  (START, speaking for END and REV), `sampler.env` (DECAY, for ATK),
  `sampler.tone` (TONE, for RES) and `sampler.choke` (CHOKE, for MONO). Between
  them they cover the controls a player cannot guess — pitch that changes a
  hit's *length*, a trim that stays in forward coordinates when reversed, a
  decay whose 0 means "play to the end", and a choke *group*, which is a concept
  with no label ([sampler](sampler.md)
  REQ-each-slot-has-a-channel/REQ-a-hit-plays-a-window-of-the-buffer/REQ-a-slot-can-cut-another-slot).
  PAN and VOL get none: they say what they are.

  **They anchor to `data-help` cells, never to the knobs' own testids**, and that
  is the requirement rather than an implementation note. A `Knob` binds its
  paramId at construction, so the strip *rebuilds every control* when the grid
  cursor moves to another slot; `enable()` resolves each anchor once and keeps
  the `Element`, so a badge pinned to `knob-sampler.t0.pitch` would be holding a
  detached node the moment the user selected slot 3 — measuring 0×0 and hiding
  itself on the next reflow. Nothing throws and nothing logs; the help just
  stops being there. `sampler-panel.ts` therefore builds one persistent cell per
  control and swaps only its contents.

  The failure is invisible until something forces a re-measure, so the e2e that
  pins it **resizes the viewport after the slot change** — asserting visibility
  without that passes with the bug present.

- **REQ-the-equalizer-carries-seven-badges** — **The Equalizer carries
  seven badges over three topics**, covering what a player cannot read off the
  panel: eight band abbreviations, a lamp that is not a switch, presets that switch
  the EQ on, an unpickable `Custom`, a RESET that leaves on/off alone, and a curve
  with no undo ([equalizer](equalizer.md)
  REQ-the-eq-tab-led-only-indicates/REQ-eq-presets-are-a-table-of-bus-writes):

  | Topic | Anchor | Covers |
  | --- | --- | --- |
  | `eq` | `eq-section`, corner | one EQ per lane and which one saves with the *sound*; the lamp's three states and that it is not a control; ON, presets and `Custom`, RESET; first in the lane; a boost is a level change; no undo |
  | `eq.graph.<lane>` | `eq-graph-<lane>` | the gestures; how to read the axis, the 0 dB line and the fill; every band label decoded; the zone stripes |
  | `eq.knobs.<lane>` | `data-help="eq.knobs.<lane>"`, the knob row | HP, LP and Q, including `off` at their ends and that Q skips the two shelves |

  `<lane>` is `seq`, `drums` or `sampler` — the panel's own lane keys, so the
  anchor ids are the testids the panel already mints.

  - **The section badge pins to the section root**, as the FX rack's `fx` badge
    does, not to a page. The bar stays on screen while the section is folded —
    which it is by default — so the one topic that explains what the section
    *is* stays reachable before the user has opened it.
  - **The page badges are one id per lane, sharing one `HelpTopic` object per
    kind** — REQ-the-playhead-ruler-carries-a-badge's ruler rule: only the visible page's anchor has a box, so a
    single shared badge would be reachable on one tab only. Six ids, two objects.
  - **The band list in `eq.graph.*` is generated from `EQ_BANDS`**, with only the
    prose authored (`EQ_BAND_ROLES`, keyed by label). The frequencies and order
    therefore cannot disagree with the filters, which read the same table; a
    band whose label has no role fails `tests/ui/help-content.test.ts`.
  - **The knob-row anchor is a persistent row, not a knob**, for REQ-the-sampler-strip-carries-five-badges's
    reason even though the EQ never rebuilds its knobs today: the topic speaks
    for three controls, and the row is the thing it describes.
  - Placement is the default `'corner'` for all three. Anchors that change
    visibility with a tab switch rely on REQ-a-container-must-tell-badges-when-it-hides's observer list.

## Scenarios (BDD)

```gherkin
Scenario: Each oscillator carries its own badge (REQ-each-oscillator-carries-its-own-badge)
  Given the info badges are on
  Then OSC 1 shows info-badge-oscillators and OSC 2 shows info-badge-osc2
  And the OSC 2 topic explains SYNC, while the OSC 1 topic explains FM and RING
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts

Scenario: A badge below the fold is hidden, not left pinned off-screen (REQ-a-badge-shows-only-where-reachable, regression)
  Given the info badges are on
  When an anchor scrolls down past the bottom of the viewport
  Then its badge is hidden — the same way one scrolling up under the sticky
    header is, rather than staying in the layer where nothing can reach it
  When the anchor scrolls back into view
  Then its badge comes back on the next reflow frame
# pinned by: tests/ui/info-badges.test.ts, e2e/onboarding.spec.ts (both edges,
#            plus a sweep asserting no shown badge sits past the fold)

Scenario: A badge only half past an edge still goes (REQ-a-badge-shows-only-where-reachable, edge)
  Given an anchor whose badge would straddle the viewport's bottom edge
  Then the badge is hidden, because the rule is any overlap — the mirror of the
    sticky-header band above
# pinned by: tests/ui/info-badges.test.ts

Scenario: Header badges survive a scroll (REQ-a-badge-shows-only-where-reachable, edge)
  Given the page is scrolled far down
  Then the transport / voicing / panic badges are still shown — a header anchor
    never scrolls away, and the header sits nowhere near the fold
# pinned by: tests/ui/info-badges.test.ts

Scenario: The Settings button explains its dialog, from the corner away from ⓘ (REQ-a-settings-topic-anchors-to-the-gauge)
  Given the info badges are on
  Then the Settings button carries a badge at its top-left corner, not its top-right
  And its topic covers the theme (the default, Auto, per device) and the performance tier (and the reload)
# pinned by: tests/ui/info-badges.test.ts, tests/ui/help-content.test.ts

Scenario: Song file buttons each explain themselves
  Given the info badges are on and the Song tab is open
  When the user clicks the Save badge, then the Export badge
  Then each opens its own modal whose copy distinguishes the two
# pinned by: e2e/onboarding.spec.ts

Scenario: The ⓘ button toggles the badges in one click, both ways (REQ-the-info-button-is-a-toggle)
  Given the info badges are off
  When the user clicks the ⓘ button
  Then the badges appear, the button gains its orange active state and aria-pressed="true"
  And no modal opens
  When the user clicks it again
  Then the badges disappear and aria-pressed is "false"
# pinned by: tests/ui/info-badges-button.test.ts, e2e/onboarding.spec.ts

Scenario: The active ⓘ button wears the badge it switches off (REQ-the-glyph-inverts-while-badges-show)
  Given the info badges are off
  Then the ⓘ glyph is an outline ring — its disc is unfilled, like the ? beside it
  When the user clicks the ⓘ button
  Then the disc fills with the accent and the i is drawn in --bg-deep,
    the same pair the floating badges use
   And the Fullscreen button's glyph is unaffected by its own toggleActive state
# pinned by: tests/ui/info-badges-button.test.ts (the part hooks),
#            e2e/onboarding.spec.ts (the computed fill, both states)

Scenario: The dropped gestures do nothing special (REQ-the-info-button-gesture-inventory)
  Given the info badges are off
  When the user Shift+clicks the ⓘ button, or presses and holds it for 350 ms
  Then the outcome is exactly a plain click's — one toggle, no modal, no
    swallowed click afterwards
# pinned by: tests/ui/info-badges-button.test.ts

Scenario: The ? key toggles the badges (REQ-the-info-button-gesture-inventory)
  Given no editable field has focus
  When the user presses ?
  Then the badges toggle
  And master.pitchBend stays 0 — the '/' pitch-bend branch never sees it
  And pressing ? inside a textarea does nothing
# pinned by: tests/ui/shortcuts.test.ts

Scenario: The preset selector explains what a preset is (re-anchored v18)
  Given the info badges are on
  When the user clicks the badge on the header preset selector
  Then the modal distinguishes a preset (one sound) from a song, and describes
    exporting a preset/bank and the review step shown before an import is written
   And the badge sits on the selector, not on the Save button beside the ⓘ toggle
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts

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

Scenario: Every machine tab's ruler carries a badge (REQ-the-playhead-ruler-carries-a-badge)
  Given the info badges are on
  When the user opens each machine tab in turn
  Then a `transport.ruler.<lane>` badge anchors to that tab's ruler
   And all four resolve to the same copy — one HelpTopic behind four ids
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts

Scenario: The Song tab's transport row explains the scrubber (REQ-the-playhead-ruler-carries-a-badge)
  Given the info badges are on and the Song tab is open
  When the user clicks the badge on the TRANSPORT launcher
  Then the modal explains bar.step, the one-cell-per-chain-slot scrubber, the
    floating window, and when seeking is refused
# pinned by: tests/ui/help-content.test.ts

Scenario: The Live FX row below it explains the DJ controls (REQ-the-live-fx-row-carries-a-badge)
  Given the info badges are on and the Song tab is open
  When the user clicks the badge on the LIVE FX launcher
  Then the modal names DJ Filter, Fill, Stutter, Drop, Tape Stop and the XY Pad,
    says the buttons are momentary, and says what the floating window adds
   And it leaves the master compressor to its own badge
# pinned by: tests/ui/help-content.test.ts, e2e/onboarding.spec.ts

Scenario: The MOD badge explains bipolar amount and the knob colours (REQ-the-mod-launcher-carries-a-badge)
  Given the info badges are on and the Song tab is open
  When the user clicks the badge on the MOD button
  Then the modal says amount is bipolar and that past zero the route inverts
  And it names the green/yellow arc a modulated knob grows
  And it points at Motion and the XY Pad for what the matrix cannot reach
# pinned by: tests/ui/help-content.test.ts

Scenario: The Key badge says the filter is non-destructive (REQ-key-and-chord-writer-carry-badges)
  Given the info badges are on
  When the user clicks the badge on the Key tab
  Then the modal says stored notes are never rewritten and chromatic changes nothing
  And it names what the map's colours mean
# pinned by: tests/ui/help-content.test.ts

Scenario: The Chord badge decodes the Roman numerals (REQ-key-and-chord-writer-carry-badges)
  Given the info badges are on and the Sequencer tab is open
  When the user clicks the badge on the Chord control
  Then the modal explains the write across four tracks, the single Undo,
    and that a capital numeral is major and a small one minor
# pinned by: tests/ui/help-content.test.ts

Scenario: The Equalizer's section badge is reachable while folded (REQ-the-equalizer-carries-seven-badges)
  Given the info badges are on and the Equalizer section is folded
  When the section is scrolled into view
  Then an `eq` badge sits on the section
  And its modal says the tab lamps only report, and names Custom and Reset
# pinned by: tests/ui/help-content.test.ts, e2e/equalizer.spec.ts

Scenario: Each Equalizer lane shows its own graph and knob badges (REQ-the-equalizer-carries-seven-badges, REQ-a-container-must-tell-badges-when-it-hides)
  Given the info badges are on and the Equalizer is open on the Sequencer lane
  Then the `eq.graph.seq` and `eq.knobs.seq` badges show and the drums ones do not
  When the user clicks the Drum Machine tab, with no scroll or resize
  Then the drums badges show and the seq badges hide
# pinned by: e2e/equalizer.spec.ts

Scenario: The graph badge decodes every band label (REQ-the-equalizer-carries-seven-badges)
  Given the eq.graph topic
  Then every label in EQ_BANDS appears in it, with that band's frequency
  And the three lane ids resolve to one HelpTopic object
# pinned by: tests/ui/help-content.test.ts

Scenario: The Render button says why it takes two bars (v9)
  Given the info badges are on and the Sequencer tab is open
  When the user clicks the badge on the Render button
  Then the modal explains the import into a sampler slot and the second pass
    that lets the reverb tail blend into the loop
# pinned by: tests/ui/help-content.test.ts (topic copy), e2e/onboarding.spec.ts
```

## Tests & verification

- `tests/ui/info-badges-button.test.ts` (the ⓘ button's gesture inventory),
  `tests/ui/shortcuts.test.ts` (the `?` key), `tests/ui/info-badges.test.ts` (the
  three hide rules, in a jsdom viewport with stubbed anchor rects),
  `tests/ui/help-content.test.ts` (every badge has its topic), `e2e/onboarding.spec.ts`.
