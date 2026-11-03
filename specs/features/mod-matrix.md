# Mod matrix

```yaml
id: mod-matrix
status: implemented
version: 9
owner: core
related:
  - architecture
  - lfo
  - envelopes
  - filter-models
  - voicing
  - runtime-performance
  - floating-window
  - cross-modulation             # the `fm` destination
source:
  - src/audio/mod-matrix.ts        # route table, fan-out, source/dest wiring
  - src/audio/engine.ts            # builds the matrix in the voice loop; subscribes mod.*
  - src/audio/voice.ts             # exposes the per-voice sources
  - src/audio/sample-hold.ts       # the random source and its smoother
  - src/state/params.ts            # mod.* params + the two append-only label arrays
  - src/ui/components/mod-matrix-window.ts
  - src/state/mod-routing.ts       # the vocabulary + the per-voice rule + depth table
  - src/state/mod-depth.ts         # reach + position maths for the knob bands, pure
  - src/ui/components/knob.ts      # the range band, the live tick, its direction colour
  - src/ui/components/fx-group.ts  # rowDivider, shared with the Song row
```

Many sources into many destinations, with a depth per route. It sums in the audio
graph, so a route costs one `GainNode` and no main-thread work.

## Background / Why

Each LFO used to hold exactly one destination. The audio graph is already a
statically wired matrix: `LFO` keeps all six of its taps wired for the session, and
`setDest` only cross-fades their gains. So this feature raises the gain count and
lets the player address them.
[ADR-017](../decisions/adr-017-modulation-in-graph.md) records the boundary:
**modulation is a graph concern, automation is a bus concern.**

## Requirements

- **REQ-one-gain-per-route-rewired-while-silent** — A route is **one `GainNode` per
  voice** whose gain is its depth. Changing its source or destination **ramps that
  gain to zero, rewires while silent, then ramps back**, so nothing is connected or
  disconnected while audible. **A depth written during a re-patch waits for the
  rewire.** `setAmount` stores it and ramps nothing while a rewire is pending. A
  load writes src, dst and amt back to back, and ramping early would drive the old
  destination at the new one's scale. The cost is at most 54 nodes (6 rows × 8
  voices + one bus-wide gain per row; 30 + 6 on the `weak` tier's 5 voices). A
  node per (row × source × destination × voice) would be over 300. The only graph
  edit happens on a gesture, where a 20 ms mute is inaudible. Nothing rewires per
  frame, tick or note.
- **REQ-eight-rows-two-grandfathered** — Rows 0–1 are LFO 1 and LFO 2 and keep
  their **existing params** (`lfo.dest`/`lfo.amount`, `lfo2.dest`/`lfo2.amount`).
  Rows 2–7 are `mod.<n>.src` / `.dst` / `.amt` for `n = 0..5`. Grandfathering is
  the whole back-compat story: no migration code.
- **REQ-routes-are-inert-by-default** — Every new param defaults to `0` (`src` =
  `off`, `dst` = `none`, `amt` = 0), so older files load unchanged (ADR-006). They
  are plain params in the `params` bag: no `SONG_VERSION` bump, and no
  `serialize.ts`, schema or `llms.txt` change.
- **REQ-label-arrays-are-append-only** — `MOD_SOURCE_LABELS` and `MOD_DEST_LABELS`
  are append-only. The stored value is the index.
- **REQ-destinations-are-summing-params** — The destination list is curated: a
  destination must be something modulation can *sum into*. `pulse` is absent,
  because it is a main-thread `setPeriodicWave` write with no node. It stays
  arbitrated on rows 0–1 ([lfo](lfo.md) REQ-pulse-is-arbitrated). Anything else
  belongs to the [motion sequencer](motion-sequencer.md) or the [XY Pad](xy-pad.md)
  (ADR-017), and the window says so.
- **REQ-resonance-becomes-reachable** — `filter.resonance`, an a-rate worklet
  `AudioParam` nothing else addresses, is a destination.
- **REQ-per-voice-sources-cannot-drive-bus-destinations** — Sources are **global**
  (LFO 1/2, mod wheel, random) or **per-voice** (filter env, amp env, velocity,
  key). Eight voices' envelopes into one `StereoPannerNode` is mush. So a bus-wide
  destination under a per-voice source is **greyed with the reason shown, never
  removed** (`Dropdown.setDisabledOptions`), and the audio layer holds that route at
  zero. `pan` (the one `synthPan`) is the only bus-wide destination. The
  sequencer's per-track panners are written per note and are not matrix
  destinations ([sequencer](sequencer.md) REQ-a-seq-track-carries-a-pan).
- **REQ-depth-is-in-the-destinations-unit** — A route's amount is scaled by the
  destination, from one table, `MOD_DEST_SCALE` (`src/state/mod-routing.ts`):
  pitch ±2400 ¢, cutoff ±48 st, shape ±1, amp ±0.5, pan ±1, sync ±48 st, FM ±8
  index units, resonance ±4.2, drive ±4. These are deliberately deeper than the
  LFO taps' own scale (`LFO_DEST_SCALE`, [lfo](lfo.md)
  REQ-duplicated-destinations-sum-and-stay-bounded). The matrix is the wide router,
  and the LFO knob is the fine one. Cutoff modulators emit **semitones**, never Hz
  (ADR-005), enforced in this one table.
- **REQ-route-depth-is-bipolar** — Amount is `-1..1`, so a route can be inverted.
  `0` is the no-op.
- **REQ-two-rows-may-share-a-destination** — Two rows may hold the same
  destination, and they sum ([lfo](lfo.md)
  REQ-destinations-are-no-longer-exclusive). The validators always accepted that,
  so no existing sound changes.
- **REQ-an-unselected-source-costs-nothing** — The `random` sample-&-hold schedules
  one value per 16th on its `ConstantSourceNode`, at the tick's own time. That
  write is **gated on whether any live row reads `random`**. The test is the same
  liveness predicate that decides a route's gain (`src` set, `dst` set, not
  per-voice into bus-wide), read from the rows at tick time, so no cache needs
  invalidating ([runtime-performance](runtime-performance.md)
  REQ-boot-cost-matches-the-request).
- **REQ-random-steps-are-smoothed** — The sample-&-hold's steps reach the matrix
  through the same control smoother as the LFO taps ([lfo](lfo.md)
  REQ-amplitude-destinations-are-smoothed), so a new value arrives as a ~3 ms
  slew rather than a step. Raw, every 16th was a full-bandwidth step in
  whatever the route drives: `random` into amp measured 95x the 3rd-difference
  floor of a held sine, once per 16th. `SampleHold` owns the source and its
  smoother, and the matrix reads its smoothed `out`.
- **REQ-a-modulated-knob-shows-its-reach** — A faceplate knob that any route
  targets draws a **range band**: an inner arc over `value ± Σ|depth|`, computed
  from the route params alone. There is no audio-thread readback and nothing per
  frame. Details that keep it honest:
  - both ends run through the param's **own taper**;
  - it rides an **inner radius**, so a bipolar route reads as two-sided;
  - an LFO row contributes at `LFO_DEST_SCALE`, and LFO 1's band widens with the
    **mod wheel**, which adds into its depth ([lfo](lfo.md)
    REQ-mod-wheel-sums-into-lfo-one).

  Six destinations have a knob: cutoff, resonance, shape, drive, `sync`
  (`osc2.syncPitch`) and `fm` (`osc1.fm`). `pitch`, `amp` and `pan` have no single
  control. Knobs self-wire (ADR-008) and subscribe only when something can
  modulate them.
- **REQ-a-known-source-shows-its-position** (v2) — A source whose current value the
  main thread already holds also draws a **position tick**. Only the **mod wheel**
  qualifies (a `ParamBus` param). The tick sits at `value + wheel × depth` and is
  drawn even at wheel zero. The other sources live on the audio thread, most of
  them per voice, so they get the band only. Without the tick, a `mod wheel →
  resonance` route changed the sound while nothing on screen moved. The wheel's
  contribution to LFO 1's depth widens the band and is **not** also counted in the
  tick.
- **REQ-the-bands-direction-has-a-colour** (v3) — The band and its tick are
  coloured by which way the routes push: **green up, yellow down**. Only the band
  is coloured; a knob's own value arc is never coloured by sign, since its pointer
  and readout already say that. Routes that **disagree in sign** leave it neutral
  (`modSignFor` is unanimous, not a sum).

## Technical design

### Contract / public interface

```yaml
src/audio/mod-matrix.ts:               # imports MOD_ROWS from mod-routing
  ModMatrix:
    constructor(ctx, sources: ModSources)
    connectVoice(v: Voice): void       # fan-out, the connectLfoToVoice idiom
    setSource(row, src): void
    setDest(row, dst): void
    setAmount(row, amt): void

src/state/mod-routing.ts:              # pure, UI-and-audio-shared
  MOD_ROWS: 6                          # the free rows; LFO 1/2 are rows 0-1
  MOD_SOURCE_LABELS: string[]          # APPEND-ONLY; index 0 === 'off'
  MOD_DEST_LABELS: string[]            # APPEND-ONLY; index 0 === 'none'
  MOD_DEST_SCALE: number[]             # the depth table, per destination
  blockedDests(src): number[]          # bus-wide dests under a per-voice source
```

### Data shapes (registry)

```yaml
mod.<n>.src: { discrete, labels: MOD_SOURCE_LABELS, range: 0..N, default: 0 }   # off
mod.<n>.dst: { discrete, labels: MOD_DEST_LABELS,   range: 0..M, default: 0 }   # none
mod.<n>.amt: { range: -1..1, default: 0 }                                        # bipolar, no-op
# n = 0..5 -> 18 params. Rows 0-1 reuse lfo.dest/lfo.amount and add nothing.
```

```yaml
# Destination table — the unit and depth each route is scaled by
none:      -                                      -
cutoff:    v.filter.cutoffNote    a-rate  per-voice   semitones, x48
resonance: v.filter.resonance     a-rate  per-voice   0..4.2,    x4.2
pitch:     v.pitchTargets()       a-rate  per-voice   cents,     x2400  # the detunes + the sync pair's junction
shape:     v.filter.shape         a-rate  per-voice   0..1,      x1
amp:       v.tremolo.gain         a-rate  per-voice   base 1,    x0.5
drive:     v.filter.drive         k-rate  per-voice   0.5..8,    x4
pan:       Engine.synthPan.pan    a-rate  BUS-WIDE    -1..1,     x1
sync:      v.syncTarget           a-rate  per-voice   semitones, x48    # oscillator-sync.md
fm:        v.fmTarget             a-rate  per-voice   FM index,  x8     # cross-modulation.md
```

### Gesture inventory — a matrix row (ADR-014)

Each row is `[source ▾] → [dest ▾] [amount] [range]`. Rows 0–1 show `LFO 1` /
`LFO 2` as fixed text.

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| pick a source | the row's source; `off` frees the row | motion track param picker |
| pick a destination | cross-fades the route onto it | LFO `DEST` dropdown |
| drag the amount | bipolar depth, in the destination's unit (`+14 st`, `−25 ¢`) | every `Knob` |
| Shift + drag the amount | fine adjust | app-wide knob convention |
| double-click the amount | back to `0`, keeping src and dst | knob double-tap reset |
| hover a disabled destination | its `title` says why | the dropdown disabled idiom |
| drag the title bar | move the window | [floating-window](floating-window.md) REQ-dragged-by-its-title-bar |
| `Escape` | nothing — Escape is panic | [floating-window](floating-window.md) REQ-escape-does-not-close-a-window |
| drag a row onto another | nothing: rows are independent summands | — |
| a delete button per row | none: `source = off` is the same act | ADR-014 law 3 |
| disabling an unassigned row | never: its pickers must stay reachable | [motion-sequencer](motion-sequencer.md) REQ-single-param-lanes-below-the-xy-lane |

An **idle** row (a free row with source `off`, or an LFO row with destination
`off`) fades every cell after the first. The knob takes `opacity`. The destination
picker is dimmed through `Dropdown.setDimmed`, **never** by `opacity` on the
picker: its open menu is a DOM child and would turn translucent
(dropdown.md REQ-a-dropdown-can-be-dimmed).

### Layer touchpoints & ordering

```yaml
construction (engine): ModMatrix is built with ModSources
  { lfo1: lfo.modTap, lfo2: lfo2.modTap, modWheel, random }, BEFORE the voice
  loop, so connectVoice() runs inside it beside connectLfoToVoice. Pitch bend is
  NOT a matrix source: it wires straight to the osc detune params.
engine (subscribeParams):
  mod.<n>.src -> matrix.setSource(n, round(x))
  mod.<n>.dst -> matrix.setDest(n, round(x))
  mod.<n>.amt -> matrix.setAmount(n, x)
per-voice sources: Voice exposes filEnv.out, ampEnv.out, and two ConstantSourceNodes
  (velocity, key) whose offsets are set at noteOn.
ui: src/ui/components/mod-matrix-window.ts, launched from the LFO panel + Live FX row;
  one controller, so every launcher toggles the same window.
```

### Persistence

`mod.*` persist as ordinary params. **Not** persisted: the live modulation value and
the window's open state.

## Scenarios (BDD)

```gherkin
Scenario: A route with zero depth changes nothing (REQ-routes-are-inert-by-default, back-compat)
  Given every mod.* param is at its default
  Then the rendered audio is identical to before the matrix existed
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: The sample-&-hold is silent while nothing reads it (REQ-an-unselected-source-costs-nothing)
  Given no row selects random as its source
  When the transport runs
  Then no value is scheduled on the random source at all
# pinned by: tests/audio/mod-matrix.test.ts (usesSource)

Scenario: Routing random anywhere starts the sample-&-hold (REQ-an-unselected-source-costs-nothing)
  Given a row routes random to a destination with a non-zero depth
  When the transport runs
  Then one new value is scheduled per 16th, at that tick's own time
# pinned by: tests/audio/mod-matrix.test.ts (usesSource)

Scenario: A sample-&-hold step reaches the matrix smoothed (REQ-random-steps-are-smoothed, regression)
  Given the engine's random source
  When a new value is rolled at a tick
  Then it is written on the ConstantSourceNode at the tick's time
  And the matrix reads it through the critically damped control smoother, never raw
# pinned by: tests/audio/sample-hold.test.ts

Scenario: A route the matrix refuses does not wake the source (REQ-an-unselected-source-costs-nothing, edge)
  Given a row routes a per-voice source to a bus-wide destination
  Then the route is held at zero gain (REQ-per-voice-sources-cannot-drive-bus-destinations)
  And the source counts as unused, because nothing can hear it
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: Two rows on one destination sum (REQ-two-rows-may-share-a-destination)
  Given row 2 and row 3 both target cutoff
  Then both gains feed the same AudioParam and their contributions add
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: Changing a destination rewires only while silent (REQ-one-gain-per-route-rewired-while-silent)
  Given a route is running at depth
  When its destination changes
  Then its gain ramps to zero before anything is disconnected
  And the new destination is connected before the gain ramps back
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: Two changes in quick succession settle on the last one (REQ-one-gain-per-route-rewired-while-silent, edge)
  Given a route's destination is changed twice inside the mute ramp
  Then only the final destination ends up connected, and the gain returns to depth
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: A depth written mid-re-patch waits for the rewire (REQ-one-gain-per-route-rewired-while-silent, regression)
  Given a route running at depth
  When its source changes and its amount is written straight after (a song load)
  Then every chain stays ramped to zero until the rewire
  And the rewire brings it up to the new depth
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: Resonance is reachable (REQ-resonance-becomes-reachable)
  Given a route targets resonance
  Then it connects to the filter worklet's resonance AudioParam
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: A per-voice source cannot drive pan (REQ-per-voice-sources-cannot-drive-bus-destinations)
  Given a route's source is the filter envelope
  Then the audio layer wires nothing, and the route is held at zero gain
  And the window offers pan but disabled, with the reason shown
# pinned by: tests/audio/mod-matrix.test.ts, tests/ui/mod-matrix-window.test.ts,
#            e2e/mod-matrix.spec.ts

Scenario: Every launcher toggles one window, never a second (floating-window REQ-floating-window-reopens)
  Given the matrix window is open
  When its launcher is used again
  Then the window closes, and re-opening yields exactly one window
# pinned by: e2e/mod-matrix.spec.ts

Scenario: The window says where the params it cannot reach live (ADR-017)
  Given the matrix window is open
  Then it names the Motion lanes and the XY Pad
# pinned by: tests/ui/mod-matrix-window.test.ts

Scenario: An idle row's destination picker opens a readable menu (regression)
  Given a row with nothing routed, so it reads as idle
  Then its destination picker's toggle carries the dimmed class and its root does not
  And when the picker is opened, its options render at full opacity, above the rows below
  And assigning the row lifts the dim again
# pinned by: tests/ui/mod-matrix-window.test.ts, tests/ui/dropdown-stacking.test.ts,
#            e2e/mod-matrix.spec.ts

Scenario: Depth is bipolar (REQ-route-depth-is-bipolar)
  Given two routes with equal and opposite amounts on one destination
  Then their contributions cancel
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: The two LFO rows still read their old params (REQ-eight-rows-two-grandfathered, back-compat)
  Given a preset with lfo.dest = cutoff and lfo.amount = 0.5
  When it loads
  Then row 0 shows cutoff at that depth and sounds exactly as it did
# pinned by: tests/audio/mod-matrix.test.ts

Scenario: Label arrays are append-only (REQ-label-arrays-are-append-only, regression)
  Then index 0 of each array is the inert option, and the known prefix never changes
# pinned by: tests/state/mod-params.test.ts

Scenario: A modulated knob grows a range band, and loses it again (REQ-a-modulated-knob-shows-its-reach)
  Given a route points at filter.cutoff
  Then the cutoff knob draws a band over the span the route can reach
  And taking the route to zero depth removes the band rather than hiding it
# pinned by: tests/ui/knob.test.ts

Scenario: A knob nothing can modulate subscribes to nothing (REQ-a-modulated-knob-shows-its-reach)
  Given a param no destination maps to
  Then its knob has no band and no route subscriptions at all
# pinned by: tests/ui/knob.test.ts, tests/state/mod-depth.test.ts

Scenario: The band agrees with what is heard (REQ-a-modulated-knob-shows-its-reach)
  Given an LFO row on cutoff at full depth
  Then the band spans the LFO's own +-24 semitones, not the matrix's +-48
  And raising the mod wheel widens LFO 1's band, because it widens its depth
# pinned by: tests/state/mod-depth.test.ts

Scenario: A mod-wheel route draws a tick that follows the wheel (REQ-a-known-source-shows-its-position)
  Given a route runs from the mod wheel to resonance
  Then the resonance knob shows a tick inside its band
  And moving the wheel moves the tick
# pinned by: tests/ui/knob.test.ts, tests/state/mod-depth.test.ts

Scenario: The tick shows at wheel zero, sitting on the value (REQ-a-known-source-shows-its-position, edge)
  Given a mod-wheel route and the wheel down
  Then the tick is drawn, so the travel about to happen is visible
# pinned by: tests/ui/knob.test.ts, tests/state/mod-depth.test.ts

Scenario: An audio-thread source gets a band but no tick (REQ-a-known-source-shows-its-position)
  Given a route runs from LFO 1 to cutoff
  Then the cutoff knob shows a band and no tick, because its position is not known here
# pinned by: tests/ui/knob.test.ts

Scenario: The wheel widening LFO 1 is drawn once, not twice (REQ-a-known-source-shows-its-position, regression)
  Given LFO 1 is routed to cutoff and the wheel is raised
  Then the band widens, and no tick appears for it
# pinned by: tests/state/mod-depth.test.ts

Scenario: An inverted route is visible with the window shut (REQ-the-bands-direction-has-a-colour)
  Given a route on filter.resonance is negative
  Then the FILTER panel's RESO band and tick read yellow
  And making it positive turns them green
# pinned by: tests/ui/knob.test.ts

Scenario: A knob's own value is never coloured by its sign (REQ-the-bands-direction-has-a-colour)
  Given a bipolar control set well below zero
  Then its own arc and pointer are unchanged, because position already says that
# pinned by: tests/ui/knob.test.ts

Scenario: Routes that disagree in sign stay neutral (REQ-the-bands-direction-has-a-colour, edge)
  Given one route up and one route down on the same destination
  Then the band is coloured neither way, because neither would be true
# pinned by: tests/ui/knob.test.ts, tests/state/mod-depth.test.ts

Scenario: The matrix does not run on the main thread (REQ-one-gain-per-route-rewired-while-silent)
  Given routes are active and the transport is running
  Then no per-frame ParamBus write is made on their behalf
# pinned by: tests/audio/mod-matrix.test.ts
```

## Tests & verification

- Unit: `tests/audio/mod-matrix.test.ts`, `tests/state/mod-params.test.ts`,
  `tests/state/mod-depth.test.ts`, `tests/ui/mod-matrix-window.test.ts`,
  `tests/ui/knob.test.ts` — `npm test`. E2E: `e2e/mod-matrix.spec.ts`.
  `npm run check:params` after a param change.
- **By ear** (ADR-010, [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)),
  A/B against `amt: 0`: `resonance` stable at high depth, and a per-voice envelope →
  cutoff route sounding genuinely polyphonic.

## Open questions / future

- **An envelope follower off the drum bus.** It needs an analyser read or a worklet,
  so it carries a cost. [sidechain-ducking](sidechain-ducking.md) reaches the same
  musical goal from scheduled hits with no follower. Copy that trigger before
  arguing for a detector.
- **Live modulation position on the knobs** would need a port message per frame,
  and it is per-voice, so "which voice?" needs an answer first.
- **XY Pad and motion lanes as matrix sources** are blocked on the automation
  defect ADR-017 records: three uncoordinated restore caches over one `ParamBus`
  slot.
- Six free rows is fixed. A pool would make the params non-scalar, which costs a
  `SONG_VERSION` bump.
