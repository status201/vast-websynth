# Motion sequencer (XY Pad automation machine)

```yaml
id: motion-sequencer
status: implemented
version: 6   # v6: A/B lanes visually distinct (wider grid gap, no fill animation) + playhead;
             #     per-lane help badges (motion.xy / motion.tracks); solid divider above the XY lane
             # v5: per-lane Slide/Step (motion.t<i>.slide) + per-lane header rows
             # v4: two extra single-param tracks per bank (A/B) + the scalar curve core
             # v3: cross-bank carry (the bar-line ramp targets the next play bank), dashed carry in the graph
             # v2: motion.mute (Song-card Mute), mode-aware graph (step = staircase), help badge
owner: core
related:
  - xy-pad
  - arrangement
  - step-grid-editing
  - song-mode
  - banks
  - song-authoring-dialect
source:
  - src/audio/transport/motion-curve.ts     # pure anchor/interpolation math
  - src/audio/transport/motion-machine.ts   # transport-driven param writer
  - src/audio/transport/arrangement.ts      # 4th chain lane
  - src/state/patterns.ts                   # motion banks + per-bank assigns
  - src/utils/taper.ts                      # norm<->value mapping (extracted from ui)
  - src/state/xy-effective.ts               # observable effective-assignment resolver
  - src/ui/panels/motion-panel.ts
  - src/ui/components/motion-step-pad.ts
  - src/ui/components/motion-graph.ts       # pure graph-polyline geometry (v2)
  - src/ui/panels/song-panel.ts             # Motion card: chain + Mute (v2)
  - src/ui/onboarding/help-content.ts       # `motion` help topic (v2)
  - src/state/song.ts                       # SongFile v4 fields
  - src/state/song-author.ts                # dialect `motion` key
```

## Background / Why

(v4) The XY lane is bound to the XY Pad's two params, which means automating
anything costs you the pad — the one surface you want free for live playing. Two
extra **single-param tracks** per bank fix that: each picks its own parameter and
holds its own anchors, so a bank can drive up to four parameters — or drive just
these two and keep the pad free to grab (only the XY lane costs you the pad).
They are the Korg Electribe / MPC "motion lane" idea:
a strip of levels under the pattern, one parameter each.

Songs vary notes and hits over time (banks + chains) but every *parameter* is static —
no filter sweeps, no delay throws, no per-bar sound scenes. Motion is a 4th machine
(16 steps × 4 banks, like the others) whose steps hold optional **XY coordinates**;
during playback it drives the two params assigned to the XY Pad through those
coordinates. "Motion sequencing" is the established hardware term (Korg Electribe).
The tab sits between Sampler and Song.

## Requirements

- **REQ-1** — A Motion step is an optional anchor `{ on, x, y }`, x/y **normalized
  0..1** in taper space (the XY Pad surface's space). Dead step = `{on:false}`.
  4 banks (A–D) × 16 steps, stored in `PatternStore` beside the other machines.
- **REQ-2** — Set steps are **anchors**. In **Slide** mode the driven value ramps
  linearly between consecutive anchors, *across* unset gaps. In **Step** mode the
  value jumps at each anchor's tick and holds. Mode is **per lane** (v5):
  `motion.slide` governs the **XY lane only**, and each extra track has its own
  `motion.t<i>.slide` — so a bank can sweep one param while stepping another.
  All are `0=step, 1=slide, default 1` and persist in songs/presets like any
  param. Splitting a formerly global param is safe here because the tracks it
  would have governed (v4) are unreleased and no demo uses them; a song that
  never set `motion.slide` is unaffected either way, since the defaults match.
- **REQ-2b** — (v3) **Cross-bank carry.** The segment spanning the bar line does not
  wrap within the bank: the ramp *out* of the last anchor targets the **next play
  bank's first anchor** and the ramp *into* the first anchor continues from the
  **previous play bank's last anchor**, so a chained curve is continuous bar to bar
  (step mode carries the previous bank's last anchor as its pre-first-anchor hold).
  The span is unchanged (`n - lastIdx + firstIdx`, measured across the bar line), so
  when both neighbours resolve to the *same* bank — a repeating chain slot, a
  single-slot chain, or a disabled lane (which follows the edit bank) — the curve is
  identical to the pre-v3 self-wrap. A neighbour that **rests**, holds **no anchors**,
  or drives a **different param** on either axis (its effective assignment differs,
  REQ-4) is unusable: the value then **holds flat** to/from the bar line rather than
  ramping toward a meaningless target. Rationale: a bank's last anchor is the value
  the author expects to hand to the next bar — the self-wrap silently undid it inside
  the final step (e.g. a delay throw built at the end of bank D collapsed at the
  seam, and bank A's low ending sprang back up and froze there through anchorless
  banks).
- **REQ-3** — A bank with **zero anchors writes nothing** (params stay put). This is
  the "no automation" state: to localize a one-step peak the user anchors the
  neighbouring steps at the base value.
- **REQ-4** — The driven params are the XY Pad's assignment (`XyPadStore`), resolved
  **per play bank, per axis**: a bank may carry an optional override
  `MotionAssign = { x?: string; y?: string } | null`; each unset axis falls back to
  `xyStore.get()` (which itself defaults to `XY_DEFAULT_ASSIGN`). Norm→value mapping
  is taper-correct via `fromNorm(def, n)` (`src/utils/taper.ts`).
- **REQ-5** — Writes go through `bus.set` (generic path; knobs and the XY-pad dot
  track automatically). **Baseline discipline**: the machine records a param's value
  the first time it writes it in a play session (`Map<paramId, baseline>`) and
  restores *all* recorded baselines on transport stop and on `motion.on → 0`. It
  never subscribes to the params it writes (no feedback loop).
- **REQ-6** — Motion has the 4th `Arrangement` chain lane (`motionPlayBank`,
  `motionResting`, `setMotionChain`); it respects rests (no writes) and a disabled
  lane follows the edit bank. (v3) The lane also resolves its **neighbour bars** —
  `motion{Prev,Next}PlayBank` + `motion{Prev,Next}Resting`, the same `resolveLane`
  at `motionPos ± 1` (wrapped) — which REQ-2b's carry needs; motion is the only lane
  that exposes them. It is **not** an audio lane: excluded from
  `LaneId`/`LaneMixer`/`audibleLanes`; its Song-panel card carries the chain
  controls plus a **Mute** switch (v2, REQ-12) but no solo/volume (nothing to
  mix). The card dims (the same `silenced` visual as the audio lanes) while
  muted.
- **REQ-7** — Both modes evaluate on **one rAF frame loop** (active only while
  playing ∧ enabled, throttled to the perf-tier fps) against the **audio clock's
  now** — clock ticks arrive with `when` scheduled ahead, so tick-time writes would
  run early relative to the heard step. Slide moves every frame; step mode's curve
  only changes value at anchor boundaries and `bus.set` early-returns unchanged
  values, so its idle frames cost nothing. The pure curve math is
  `motion-curve.ts` (`valueAt(bank, barPos, mode)`), fully unit-testable.
  The same discipline applies to **arrangement state**: the rest gate, the play
  bank and (v3) the neighbour banks flip on the *scheduled* bar-boundary tick, up to
  `scheduleAheadS` before
  it is heard — the machine latches them per tick and evaluates against the tick
  whose **audible** window contains now, so rests and bank switches land on the
  heard bar boundary (reading them live truncated the final `scheduleAheadS` of
  every bar before a rest, freezing the previous anchor's value through the
  rest — the "value never comes back down" bug).
- **REQ-8** — UI: each step is a **mini XY pad** square — drag sets `(x,y)` in one
  gesture, double-click/double-tap clears; the dot sits at the literal coordinate.
  An SVG polyline overlay traces the **selected axis** across the 16 squares
  (view toggle Y/X, default Y — a local view state, not a param; dots never move).
  The line is **mode-aware** (v2): in Slide mode it is the anchor-to-anchor
  polyline; in Step mode it is a full-width **staircase** (jump-and-hold at each
  anchor, including the last→first wrap hold before the first anchor — a single
  anchor draws a flat line), mirroring `valueAt`'s semantics. (v3) It also draws the
  **carry**: up to two dashed edge segments joining the first/last anchor to the bar
  edges at the values REQ-2b will actually play, so the bar-line behaviour is visible
  while authoring instead of implied (pre-v3 the slide line simply stopped at the
  outer anchors and the wrap was invisible). The graph resolves its neighbours from
  the motion chain lane around the edit bank (lane disabled or bank absent from the
  chain ⇒ the bank itself — the self-loop that plays), so both edges stay flat when
  nothing carries. The geometry is the
  pure `motionGraphPoints(bank, view, mode, neighbours?)`
  (`ui/components/motion-graph.ts`), whose edge values come from `valueAt` itself so
  the picture cannot drift from playback;
  the panel redraws on its lane's `slide` param, chain and assignment changes.
  (v5) The panel is **one header per lane**, each naming what that lane drives
  and how it interpolates, with its 16 cells full width beneath — so all three
  lanes share one 16-column grid and step *n* reads vertically across them:
    - the **machine header** carries only machine-level controls — `motion.on`
      switch, BankBar (`bank-motion-*`), undo, `Clear ▾`;
    - the **XY lane header** sits *above* the pads with the XY Pad launcher
      (`motion-xypad`), the Y/X view toggle, the XY lane's Slide/Step segmented,
      the axis dropdowns showing the edit bank's *effective* assignment, the
      inherit/reset button and the "graph: `<param>`" hint — the toggle beside
      the readout it drives, rather than three rows apart;
    - a single **dashed divider** separates the XY lane from the tracks below (A
      and B are the same kind of lane, so nothing divides them from each other),
      and (v6) a **solid** divider (the Drum tab's below-grid rule) separates the
      **machine header** from the XY lane header above it.
  (v6) The A/B track cells use a **wider grid gap** than the XY lane's pads, so
  the tracks read as a visually distinct, more spaced-out lane; the full-width
  grid keeps step 0 / step 15 aligned across all three lanes (only interior cells
  drift a few px from the decorative overlay line, which is `pointer-events:none`).
  Help-mode badges ([onboarding](onboarding.md) REQ-3/REQ-14) explain the panel at
  three grains: the machine-level `motion` topic (anchored to `tab-motion`) covers
  the Y/X graph projection and the whole machine; short per-lane topics `motion.xy`
  (the XY lane header) and `motion.tracks` (one shared badge on the A track's row,
  covering both A and B) give the quick version.
- **REQ-9** — SongFile **v4** adds optional `motionBanks` (4×16 `MotionStep`),
  `motionAssigns` (4 × `MotionAssign|null`) and `motionChain` (`ChainData`) —
  additive per ADR-007; old files load with empty motion state. Export is
  default-sparse (dead step → `{on:false}`, x/y rounded to 4 sig-figs, ADR-011).
  The authoring dialect gains a `motion` key (anchor lists per bank, optionally
  `{assign, steps}`) + `motionChain`; both public schemas and the authoring guide
  document it; `motion.on` auto-enables when anchors are present.
- **REQ-10** — Restore/`apply` spreads defaults under incoming cells so sparse and
  legacy files sound identical (mirrors the other machines).
- **REQ-11** — The XY Pad window's **axes** (on-surface labels, dot, drag/wheel
  targets) follow the *effective* assignment — `createEffectiveXy`
  (`state/xy-effective.ts`) resolves the motion **play bank's** override per
  axis while the machine is active (`motion.on` set and not muted, v2), falling
  back to the base `XyPadStore` — and re-resolves as the chain crosses banks, on
  override edits, on base reassignment, and on `motion.on`/`motion.mute` toggles.
  The pad's gear dropdowns keep showing/editing the **base** assignment (the
  store stays its single writer).
- **REQ-12** — (v2) **Mute**: an ordinary param `motion.mute` (default 0, persists
  with songs like the audio lanes' `<lane>.mute`), toggled from the Song-tab
  Motion card (`switch-motion.mute`). The machine is effective-active only while
  `motion.on ≥ 0.5 && motion.mute < 0.5` (`MotionMachine.setMuted`, the
  `StepSequencer.setMuted` precedent): muting stops the write loop and
  **restores every recorded baseline** (REQ-5), so the driven params — and the
  XY Pad's dot, assignments and values — return to their pre-play state;
  unmuting mid-play resumes on the next frame. Motion stays outside
  `audibleLanes` (it makes no sound); the card's dim visual is driven directly
  off `motion.mute`.

### v4 — extra tracks

- **REQ-13** — **Two extra tracks per bank**, A and B, each a
  `MotionTrack = { param?: string; steps: MotionTrackStep[16] }` where
  `MotionTrackStep = { on, v }` and `v` is **0..1 normalized taper space** exactly
  like the XY lane's `x`/`y`. The parameter is chosen **per bank, per track** —
  the same scope as REQ-4's `MotionAssign` override, so one song can drive eight
  different params across a four-bank chain. A track with **no `param`** writes
  nothing: that is the no-op default ([ADR-006](../decisions/adr-006-no-op-param-defaults.md)),
  and unlike REQ-4's axes there is no global fallback to inherit from (there is no
  pad behind these tracks). `copyMotionBank` copies the tracks *and* their param
  choices, so building one bank and copying it does not mean re-picking params.
- **REQ-14** — **Tracks share the XY lane's curve semantics exactly**: slide/step
  from `motion.slide`, set steps are anchors, a track with **zero anchors writes
  nothing** (REQ-3), and the bar-line **cross-bank carry** of REQ-2b applies with
  the same usability gate — a neighbour bar that rests, whose same-index track has
  no anchors, or whose same-index track drives a **different param**, is unusable,
  so the value holds flat to/from the bar line. This is guaranteed rather than
  re-implemented: the interpolation core is extracted as the scalar `scalarAt`,
  and XY's `valueAt` becomes two calls of it, so the two cannot drift.
- **REQ-15** — **Baselines are unchanged** (REQ-5): the machine's baseline map is
  keyed by param id, so track writes join it with no new mechanism. Stop,
  `motion.on → 0` and `motion.mute → 1` restore every recorded baseline including
  the tracks'.
- **REQ-16** — **UI**: two lanes below the XY lane, each a **header row** (label,
  param dropdown, and its own Slide/Step segmented — `seg-motion.t<i>.slide`)
  above 16 full-width **level pads** — drag up/down to set the value (the pad
  fills from the bottom), double-click/double-tap to clear, matching the XY pads'
  gesture family ([step-grid-editing](step-grid-editing.md) REQ-9). (v6) Clearing
  returns the cell to the **default step** (its level reset too), so a cleared
  cell reads like an untouched one instead of keeping its old parked height. The fill
  **snaps** to its value (no CSS height animation), and the lanes show the moving
  **playhead** while playing — the same `PlayheadHighlighter` glow the XY lane and
  the other machines carry (all three motion lanes are wired into one highlighter,
  so the playing column lights across them together). Each lane
  draws the same mode-aware polyline the XY lane does — **using its own mode** —
  so slide interpolation and the bar-line carry stay visible while authoring. A
  lane with no param chosen renders dimmed with its pads inert; the row itself
  never goes inert, or its param picker would be unreachable and the lane could
  never be assigned ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2).
  The parameter is the switch, so there is no separate on/off to keep in sync.
  A level pad drops the XY pad's **vertical** centre line: `onSet` discards `x`,
  so a cell's horizontal position means nothing, and drawing that axis would
  make a one-dimensional cell read as a mini XY pad. The horizontal line stays —
  on a level cell it is a 50% mark.
  Clearing: Motion has no selection cursor, so its `Clear ▾` lists **every lane
  holding steps** rather than "the selected row" — see
  [step-grid-editing](step-grid-editing.md) REQ-6. `Clear bank` empties all
  three lanes; the axis override and the tracks' param choices survive every
  clear, being configuration rather than step data.
- **REQ-17** — **SongFile v5** adds optional `motionTracks` (4 banks × 2 tracks),
  additive per [ADR-007](../decisions/adr-007-songfile-additive-versioning.md):
  v1–v4 files load with both tracks empty and unassigned, writing nothing. Export
  is default-sparse (a dead step is `{on:false}`, `v` rounded to 4 sig-figs) and a
  track that is entirely empty *and* unassigned is omitted. The authoring dialect
  gains a matching key; both public schemas and the authoring guide document it.

## Technical design

### Contract / public interface

- `MotionMachine` (`src/audio/transport/motion-machine.ts`):
  `setEnabled(on)`, `setMuted(m)` (v2 — effective-active = enabled ∧ ¬muted; either
  deactivation restores baselines), `setSlide(on)` (the XY lane) and
  `setTrackSlide(track, on)` (v5 — one mode per extra track), `onStep(cb)` (playhead),
  `stop()` restore hook via `clock.onStop`. Constructed by `Engine.init()` after
  the sampler (Arrangement first, as for all machines); exposed on `StudioApi` as
  `motion`.
- `motion-curve.ts` (pure): `anchorIndices(bank)`,
  `valueAt(bank, barPos, mode, neighbours?) → {x,y} | null` — all
  interpolation/carry math, no AudioContext. (v4) The engine underneath is the
  scalar `scalarAt(bank, barPos, mode, get, neighbours?) → number | null`,
  generic over any `{ on }` cell plus a value accessor; `valueAt` is two calls of
  it (`s => s.x`, `s => s.y`) and `valueAt1D(steps, …)` — the extra tracks' entry
  point — is one (`s => s.v`). One implementation of anchors, slide, step and the
  bar-line carry, so XY and the tracks cannot diverge (REQ-14).
  `MotionNeighbours = { prev?, next?: readonly MotionStep[] | null }` are the banks
  of the adjacent *bars* (REQ-2b); omitted ⇒ this bank (the pre-v3 self-wrap),
  `null`/anchorless ⇒ hold flat at the bar line. The module stays free of
  assignment/`XyPadStore` knowledge — deciding whether a neighbour is *usable* is the
  caller's job.
- `PatternStore`: `motionEditBank`, `motion`, `motionBank(i)`, `setMotionEditBank`,
  `setMotionStep(step, cell)`, `copyMotionBank(from,to)`, `motionAssign(i)`,
  `setMotionAssign(i, a|null)`, `onMotionChange`, `onMotionBankChange`.
  (v4) `motionTracks(bank) → MotionTrack[2]`, `motionTrack(track)` (edit bank),
  `setMotionTrackStep(track, step, patch)`, `setMotionTrackParam(track, id|null)`,
  `clearMotionTrack(track)`, `onMotionTrackChange(fn)`. Track mutations emit the
  `motion-track` / `motion-track-param` undo kinds; `clearMotionBank` and
  `copyMotionBank` keep carrying the whole bank (tracks included) in their single
  `motion-copy` entry (step-grid-editing.md REQ-7).
- `Arrangement`: `motionPlayBank`, `motionResting`, `setMotionChain(steps, enabled)`,
  `motionChainPos`, `motion{Prev,Next}PlayBank`, `motion{Prev,Next}Resting` (v3).
- `src/utils/taper.ts`: `toNorm(def, v)`, `fromNorm(def, n)` — moved out of the
  UI layer so the audio layer can map taper-correctly without importing UI code.
- `src/state/xy-effective.ts`: `motionAxesFor(patterns, bank, base) → XyAssign`
  (v3) — the one-line per-axis override/fallback rule (REQ-4), shared by
  `createEffectiveXy`, `MotionMachine`'s neighbour gate and the panel's graph.
- `src/ui/components/motion-graph.ts` (pure, v2):
  `motionGraphPoints(bank, view, mode, neighbours?)
  → { line: [x,y][]; dots: [x,y][]; carry: [x,y][][] }` in the
  graph SVG's 0–100 viewBox space (dots at anchor centres; step mode's line is
  the wrap-aware staircase; `carry` holds the 0–2 dashed bar-edge segments, v3).
  No DOM — unit-testable like `motion-curve.ts`.

### Data shapes

```yaml
MotionStep:
  on: boolean
  x: number   # 0..1 normalized (taper space)
  y: number   # 0..1
MotionAssign:        # per-bank override, each axis optional
  x: string | absent # ParamBus id
  y: string | absent
MotionTrackStep:     # v4 — one extra track's step
  on: boolean
  v: number          # 0..1 normalized (taper space)
MotionTrack:         # v4 — per bank, per track
  param: string | absent   # ParamBus id; absent = the track writes nothing
  steps: MotionTrackStep[16]
Params (v5):         # mode is per lane, not global
  motion.slide:       { discrete, labels: [step, slide], default: 1 }   # XY lane
  motion.t<i>.slide:  { discrete, labels: [step, slide], default: 1 }   # each track
SongFile v5 (additive):
  motionTracks: (MotionTrack | null)[4][2] | absent
Author dialect (v4):
  motionTracks: [ [TrackSpec, TrackSpec], ... up to 4 banks ]
  # TrackSpec = { param, steps: [ {step, v}, ... ] } | null
SongFile v4 (additive):
  motionBanks: MotionStep[4][16] | absent
  motionAssigns: (MotionAssign | null)[4] | absent
  motionChain: ChainData | absent
Author dialect:
  motion: [ MotionBank, ... up to 4 ]
  # MotionBank = [ {step, x, y}, ... ]  |  { assign?: {x?, y?}, steps: [ {step,x,y}, ... ] }
  motionChain: Chain
```

### Layer touchpoints & ordering

- `main.ts` creates `XyPadStore` and now passes it into `Engine.init()` (previously
  UI-only) so `MotionMachine` can resolve assignments; the same instance still flows
  to the UI (song-panel capture/apply is unchanged).
- Engine construction order unchanged: Arrangement → Performance → machines; Motion
  is created after the sampler. Engine subscribes `motion.on` → `setEnabled`,
  `motion.mute` → `setMuted` (v2), `motion.slide` → `setSlide`.
- The Song panel's Motion card reuses `buildChainLane` with a `{ mixer: 'mute' }`
  opt (v2) — the mixer strip renders only the `motion.mute` Switch (the audio
  lanes use the default `'full'`: mute + solo + volume).

### Persistence

- Song: the v4 fields above; save slots/share links/project zips pass them through
  (opaque). Presets are untouched (motion state is pattern data, not params —
  except `motion.on`/`motion.slide`, which are ordinary params).
- Deliberately NOT persisted: the Y/X view toggle (local UI state), the baseline
  map (runtime-only).

## Scenarios (BDD)

```gherkin
Scenario: A one-bar cutoff sweep (slide)
  Given the XY Pad assigns x=filter.resonance, y=filter.cutoff
  And motion bank A has anchors step0 y=0, step8 y=1, step15 y=0 and slide mode
  When the transport plays bar after bar
  Then filter.cutoff ramps min→max→min continuously each bar
# pinned by: tests/audio/transport/motion-curve.test.ts, tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: An extra track drives a third parameter while the pad stays free (v4)
  Given motion track A on bank A is assigned to fx.delay.mix with anchors
  When the transport plays that bank
  Then fx.delay.mix follows the track's curve
  And the XY Pad's own two params are driven only by the XY anchors
  And stopping restores every driven param, tracks included
# pinned by: tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: Two lanes interpolate differently in the same bar (v5)
  Given track A is assigned with anchors and set to STEP
  And track B is assigned with anchors and set to SLIDE
  When the bar plays
  Then A jumps and holds while B ramps, in the same bar
  And the XY lane follows its own motion.slide, independent of both
# pinned by: tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: Every lane's controls sit above its own cells (v5)
  Given the Motion tab is open
  Then the XY Pad launcher, view toggle, Slide/Step, axis dropdowns and the
    "graph:" hint are all in one row ABOVE the 16 XY pads
  And each track's label, param picker and Slide/Step sit above its own cells
  And a single dashed divider separates the XY lane from the tracks
  And a solid divider separates the machine header from the XY lane (v6)
# pinned by: e2e/motion.spec.ts

Scenario: The A/B tracks show the playhead while playing (v6)
  Given the Motion tab is open and the transport is running
  When the playhead advances
  Then the playing column lights on the A and B track cells, not only the XY pads
# pinned by: e2e/motion.spec.ts

Scenario: The XY lane and the tracks each carry a short help badge (v6)
  Given help mode is on and the Motion tab is open
  Then a `motion.xy` badge anchors to the XY lane header and a `motion.tracks`
    badge anchors to the A track's row, each a short explainer distinct from the
    essay-length `motion` badge on the tab
# pinned by: tests/ui/help-content.test.ts (topic presence)

Scenario: An unassigned extra track writes nothing (v4)
  Given motion track B has anchors but no parameter chosen
  When the transport plays
  Then nothing is written — the parameter is the track's on/off
  And its cells render inert while the param picker stays usable
# pinned by: tests/audio/transport/motion-machine.test.ts, tests/state/patterns.test.ts

Scenario: Extra tracks follow the XY lane's curve rules exactly (v4)
  Given a track and the XY lane's y axis carry the same anchors
  When both are sampled across the bar in slide and step mode
  Then their values are equal at every point, since one scalar core serves both
# pinned by: tests/audio/transport/motion-curve.test.ts

Scenario: Copying a bank carries the tracks and their parameters (v4)
  Given bank A has track B assigned with anchors
  When bank A is copied to bank C
  Then C's track B has the same parameter and anchors, deep-copied
# pinned by: tests/state/patterns.test.ts

Scenario: New Song clears the extra tracks (v4, regression)
  Given a song assigned motion track A to fx.delay.mix
  When the user starts a New Song
  Then the track is blank AND unassigned, so nothing is still being automated
# pinned by: tests/state/patterns.test.ts, e2e/motion.spec.ts

Scenario: Step mode jumps and holds
  Given anchors at steps 0 and 8 and step mode
  When the bar plays
  Then the param jumps at step 0, holds, jumps at step 8, holds
# pinned by: tests/audio/transport/motion-curve.test.ts

Scenario: Step mode graphs as a square line (v2)
  Given anchors at steps 2 and 10 and step mode
  When the graph is drawn
  Then the line is a full-width staircase: the last anchor's value holds from the
    bar start to step 2 (wrap), jumps there, holds to step 10, jumps, holds to the end
  And in slide mode the same anchors draw the plain anchor-to-anchor polyline
# pinned by: tests/ui/motion-graph.test.ts

Scenario: Muting from the Song tab restores baselines and the pad's base axes (v2)
  Given motion is on and driving params away from their baselines
  When motion.mute is set from the Song panel's Motion card
  Then the write loop stops, every driven param returns to its baseline
  And the XY Pad's axes fall back to the base assignment while muted
  And unmuting mid-play resumes automation
# pinned by: tests/audio/transport/motion-machine.test.ts, tests/state/xy-effective.test.ts, e2e/motion.spec.ts

Scenario: The final anchor before a rest bar still writes under look-ahead (regression)
  Given step mode with a high anchor at step 12 and a low anchor at step 15
  And the chain plays that bank into a REST bar
  When the rest bar's first tick arrives scheduleAheadS ahead of its audible time
  And frames evaluate between that tick and the audible bar boundary
  Then the machine still writes the step-15 value (the rest gate waits for the
    audible boundary instead of freezing the step-12 value through the rest)
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: The curve carries into the next bank instead of wrapping (v3, regression)
  Given slide mode and a chain D → A
  And bank D ends high (anchor at step 15) while bank A opens at that same value
  When the bar line between them is crossed
  Then D's final step holds its high value instead of ramping back to D's step-0 value
  And bank A opens on its own step-0 anchor, so the move is continuous
# pinned by: tests/audio/transport/motion-curve.test.ts, tests/audio/transport/motion-machine.test.ts

Scenario: An unusable neighbour holds the last anchor (v3)
  Given slide mode and a chain A → B where B has no anchors (or rests, or drives
    a different param than A)
  When bank A's last anchor is passed
  Then the value holds that anchor to the bar line
  And bank B — writing nothing — leaves it there, instead of freezing the value the
    old self-wrap sprang back up to
# pinned by: tests/audio/transport/motion-curve.test.ts, tests/audio/transport/motion-machine.test.ts

Scenario: A repeating bank is unchanged by the carry (v3, back-compat)
  Given a single-bank chain (or a disabled lane) with anchors at steps 4 and 12
  When the bar plays
  Then the curve is exactly the pre-v3 last→first wrap across the bar line
# pinned by: tests/audio/transport/motion-curve.test.ts

Scenario: The graph draws the bar-line carry (v3)
  Given the chain plays D → A and bank D is on screen
  When the graph is drawn
  Then dashed segments join the bar edges to D's outer anchors at the values that
    will play, and they are flat when the neighbour cannot be carried to
# pinned by: tests/ui/motion-graph.test.ts

Scenario: Bank switches apply at the audible bar boundary, not at schedule time
  Given the chain moves from bank A to bank B with different anchor values
  When the new bar's first tick arrives ahead of its audible time
  Then frames before the audible boundary still evaluate bank A
  And frames from the boundary on evaluate bank B
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: Empty bank writes nothing
  Given the play bank has no anchors
  When the transport runs
  Then the assigned params never change
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: Baselines restore on stop
  Given motion drove filter.cutoff away from its saved value
  When the transport stops
  Then filter.cutoff returns to its pre-play value
# pinned by: tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: Per-bank assignment override with fallback
  Given bank B overrides x=fx.delay.time and leaves y unset
  When the chain reaches bank B
  Then motion writes fx.delay.time for x and the XY Pad's y param for y
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: The XY Pad reflects the bank being driven
  Given motion is on and the play bank overrides x to fx.delay.time
  When the effective assignment resolves
  Then the pad's x axis (label/dot/drag) is fx.delay.time while y stays the base param
  And turning motion off returns both axes to the base assignment
# pinned by: tests/state/xy-effective.test.ts, e2e/motion.spec.ts

Scenario: Extra tracks round-trip through a song (v4)
  Given a track assigned with anchors
  When the song is saved, a New Song started, and the song reloaded
  Then the track's parameter and anchors come back
# pinned by: tests/state/patterns.test.ts, e2e/motion.spec.ts

Scenario: Old songs load unchanged
  Given a v1/v2/v3 SongFile without motion fields
  When it is applied
  Then motion banks are empty, the chain is disabled and nothing is written
# pinned by: tests/state/song-validate.test.ts, tests/state/song.test.ts

Scenario: Dialect motion bank expands
  Given an author song with motion anchors and a per-bank assign
  When expandAuthorSong runs
  Then a canonical v4 file with motionBanks/motionAssigns and motion.on=1 results
# pinned by: tests/state/song-author.test.ts
```

## Tests & verification

- Unit: `tests/audio/transport/motion-curve.test.ts`,
  `tests/audio/transport/motion-machine.test.ts`, `tests/audio/transport/arrangement.test.ts`,
  `tests/state/{patterns,song-validate,serialize,song-author,authoring-docs}.test.ts`,
  `tests/ui/motion-step-pad.test.ts`, `tests/ui/motion-graph.test.ts`,
  `tests/ui/help-content.test.ts` (the `motion` / `motion.xy` / `motion.tracks`
  topics) — `npm test`
- E2E: `e2e/motion.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.bus.get('<assigned id>')` while playing.

## Pitfalls (documented behaviour)

- Saving a song/preset **while playing** captures the momentary automated values
  (same as saving mid-knob-drag); stop first for the baseline sound.
- Dragging an automated knob mid-play: motion wins on its next write.
- Assigning `transport.bpm` is allowed (tempo automation); slave-sync gating already
  prevents clock conflicts.
- When the chain leaves a bank whose override drove other params, those params hold
  their last written value until stop (then baselines restore). Since v3 that held
  value is the bank's **last anchor** (the carry holds flat toward an unusable
  neighbour), which is what the author drew — pre-v3 it was the bank's *first*
  anchor, because the self-wrap ran back up inside the final step. To bring a param
  home during anchorless bars, anchor them.

## Open questions / future

- More than two axes / free per-step param choice (would decouple from the XY Pad).
