# Motion sequencer (XY Pad automation machine)

```yaml
id: motion-sequencer
status: implemented
version: 20
owner: core
related:
  - xy-pad
  - arrangement
  - runtime-performance
  - transport             # the clock's worker-timer guarantee
  - transport-position    # the seek reaction
  - session-autosave      # what "automation is not an edit" stopped starving
  - step-grid-editing
  - song-mode
  - banks
  - meter
  - song-authoring-dialect
  - dropdown
  - motion-panel          # the Motion tab: step pads, lanes, fold, graph
source:
  - src/audio/transport/motion-curve.ts     # pure anchor/interpolation math
  - src/audio/transport/motion-machine.ts   # transport-driven param writer
  - src/audio/transport/tick-timer.ts
  - src/audio/transport/arrangement.ts      # 4th chain lane
  - src/state/patterns.ts                   # motion banks + per-bank assigns + tracks
  - src/utils/taper.ts                      # norm<->value mapping
  - src/state/xy-effective.ts               # observable effective-assignment resolver
  - src/state/params.ts                     # snapshot overlay: a capture stores the baselines
  - src/ui/panels/motion-panel.ts
  - src/state/serialize.ts
  - src/ui/panels/song-panel.ts
  - src/ui/onboarding/help-content.ts
  - src/state/song.ts
  - src/state/song-author.ts                # dialect `motion` key
```

## Background / Why

Banks and chains vary notes over time, but every *parameter* was static: no filter
sweeps, no delay throws, no per-bar scenes. Motion is a 4th machine (16 steps × 4..16
banks, like the others). It has one **XY lane**, whose steps hold `(x, y)` anchors
driving the two params assigned to the XY Pad, plus **four single-param lanes** (A–D),
each picking its own parameter: the Electribe/MPC "motion lane". Only the XY lane
costs you the pad, so a bank can automate four params and keep the pad free for live
playing. The tab sits between Sampler and Song.

## Requirements

### The curve

- **REQ-a-motion-step-is-an-optional-anchor** — A step is an optional anchor `{ on, x,
  y }`, x/y **normalized 0..1** in taper space (the XY Pad's space). A dead step is
  `{on:false}`. 4..16 banks (A–P, [banks](banks.md) REQ-a-machine-owns-its-bank-count)
  × 16 steps, in `PatternStore`.
- **REQ-set-steps-are-anchors** — In **Slide** the value ramps linearly between
  consecutive anchors, across unset gaps. In **Step** it jumps at each anchor and
  holds. Mode is **per lane**: `motion.slide` governs the XY lane and each track has
  `motion.t<i>.slide` (all `0=step, 1=slide, default 1`).
- **REQ-cross-bank-carry** — The bar-line segment does not wrap within the bank. The
  ramp *out* of the last anchor targets the **next play bank's first anchor**, and the
  ramp *into* the first anchor continues from the **previous play bank's last
  anchor**. Step mode carries the previous last anchor as its pre-first hold. The
  span is `n - lastIdx + firstIdx`, so when both neighbours are the same bank
  (repeating slot, single-slot chain, disabled lane) the curve is the self-wrap. A
  neighbour that **rests**, holds **no anchors**, or drives a **different param** on
  either axis is unusable, and the value **holds flat** to/from the bar line. A
  bank's last anchor is what the author hands to the next bar.
- **REQ-a-bank-with-no-anchors-writes-nothing** — Zero anchors write nothing: the "no
  automation" state. To localize a peak, anchor the neighbours at the base value.
- **REQ-motion-drives-the-xy-assignment** — The XY lane drives the XY Pad's assignment
  (`XyPadStore`), resolved **per play bank, per axis**: a bank's optional
  `MotionAssign = { x?: string; y?: string } | null`, each unset axis falling back to
  `xyStore.get()` (default `XY_DEFAULT_ASSIGN`). Norm → value is taper-correct via
  `fromNorm(def, n)`.
- **REQ-extra-single-param-tracks-per-bank** — `MOTION_TRACK_COUNT` (4, A–D) tracks per
  bank, each `MotionTrack = { param?: string; steps: MotionTrackStep[16] }` with
  `MotionTrackStep = { on, v }` (0..1 taper space). The param is chosen **per bank,
  per track**. A track with **no `param`** writes nothing (ADR-006), and there is no
  fallback. `copyMotionBank` copies tracks and their params. The count lives **once**,
  in `src/state/patterns.ts`; `MOTION_TRACK_LABELS` derives from it, as do the slide
  params, subscriptions, loops, rows, clear menu and undo (ADR-022's rule, one level
  in).
- **REQ-tracks-share-the-lanes-curve-semantics** — Tracks follow the XY lane's rules
  (anchors, zero-anchor no-op, the carry and its usability gate, per-track mode). The
  core is the scalar `scalarAt`. XY's `valueAt` is two calls of it and `valueAt1D` is
  one, so they cannot drift.
- **REQ-the-automation-lane-follows-the-meter** — `motion.len` / `motion.rate` size
  the XY lane **and** every track together ([meter](meter.md)
  REQ-each-machine-has-a-loop-length/REQ-each-machine-has-a-step-rate). `scalarAt`
  takes `cells` (defaulting to the whole bank), and anchors beyond it are invisible.
  So a shortened slide ends at the lane's seam. The machine reads the **raw** step:
  automation never follows a stutter remap ([meter](meter.md)
  REQ-stutter-composes-with-length-and-rate).
- **REQ-a-bank-parks-at-its-last-anchor** — On the frame the governing tick's play
  bank changes (or rests), the machine evaluates the **outgoing** bank once more at its
  seam (`barPos → 1⁻`, no carry, i.e. its last in-lane anchor). It writes that for
  every param the incoming bar does **not** drive itself. A lane that does not tile
  the bar ends its bar mid-loop, so without this a bank would hold an arbitrary
  mid-sweep value. The park records baselines, runs under `withoutChangeSignal`, and is
  armed only by a *played* handover: `onStart`, `onSeek` and every restore clear it.

### Writes and baselines

- **REQ-motion-writes-go-through-bus-set** — Writes go through `bus.set`, so knobs and
  the XY dot track them. The machine records a param's baseline the first time it
  writes it in a play session (`Map<paramId, baseline>`) and restores *all* of them on
  stop and on `motion.on → 0`. It never subscribes to what it writes.
- **REQ-motion-baselines-are-unchanged** — The map is keyed by param id, so track
  writes join it. Stop, `motion.on → 0` and `motion.mute → 1` restore every baseline.
- **REQ-a-load-or-an-edit-rebaselines** (v19) — A bulk apply (`ParamBus.restore` /
  `resetDefaults`, reported by `ParamBus.onBulkApply(ids)`) re-baselines each id it
  applied. A **user edit** (the global `onChange`) re-baselines that id. So a song
  loaded mid-play, or a knob turned, is what Stop returns to; motion still wins on
  its next frame. The machine's own writes run under `withoutChangeSignal`, and it
  only *records* from these signals, so there is no loop.
- **REQ-a-capture-mid-play-stores-the-baselines** — Automation is not the authored
  sound, so a capture must not store it. The machine registers its baseline map with
  `ParamBus.addSnapshotOverlay` once, and `ParamBus.snapshot()` reports each param in
  it at its **baseline** instead of its live value. So a song save, slot, export,
  share link, project zip, preset save or [session autosave](session-autosave.md)
  taken mid-play stores exactly what Stop would return to. A knob turned mid-play is
  captured, because it re-baselines (REQ-a-load-or-an-edit-rebaselines). `get()`,
  the knobs and the audio keep the live value. The map is empty while stopped, so a
  capture then is unchanged.
- **REQ-motion-automation-is-not-an-edit** — Every machine write (axes, tracks,
  restores) runs inside `ParamBus.withoutChangeSignal`. Per-param listeners still
  fire. Only the global `onChange` ("the user changed the sound") is withheld, so the
  [session autosave](session-autosave.md) debounce and the preset-dirty marker are not
  re-armed at frame rate. The suppression belongs to the writer. The bracketed body is
  pre-bound for the 60 fps path ([runtime-performance](runtime-performance.md)
  REQ-automation-is-not-an-edit/REQ-no-allocation-in-a-hot-loop). The XY Pad's
  spring-back *is* a gesture and stays on the normal path.
- **REQ-motion-mute-is-an-ordinary-param** — `motion.mute` (default 0, persisted like
  `<lane>.mute`) is toggled from the Song-tab Motion card (`switch-motion.mute`). The
  machine is active only while `motion.on ≥ 0.5 && motion.mute < 0.5`
  (`MotionMachine.setMuted`). Muting stops writes and restores every baseline;
  unmuting mid-play resumes next frame. Motion stays outside `audibleLanes`.
- **REQ-an-unresolved-motion-target-is-reported** — `write(id, norm)` returns early on
  an unknown id, so it never throws into the clock. A misspelled
  `motionTracks[].param` / `motionAssigns[].x` is reported instead:
  [untrusted-input](untrusted-input.md) REQ-an-unresolvable-target-warns owns
  `unresolvedTargets(file)`, a **warning** (ADR-007), counted in the import toast.

### Arrangement and the frame loop

- **REQ-motion-has-the-fourth-chain-lane** — The 4th `Arrangement` lane
  (`motionPlayBank`, `motionResting`, `setMotionChain`) respects rests, and a disabled
  lane follows the edit bank. It also resolves the **neighbour bars**
  (`motion{Prev,Next}PlayBank`, `motion{Prev,Next}Resting`, `resolveLane` at
  `motionPos ± 1`) for the carry. It is **not** an audio lane: excluded from
  `LaneId`/`LaneMixer`/`audibleLanes`. Its Song card has chain controls and a **Mute**
  switch, no solo/volume, and dims while muted.
- **REQ-both-motion-modes-share-one-frame-loop** — One frame loop (playing ∧ active,
  throttled to the perf-tier fps) evaluates against the **audio clock's now**. Ticks
  arrive up to `scheduleAheadS` early, so tick-time writes would run ahead of the
  heard step. Step mode costs nothing between anchors (`bus.set` skips unchanged
  values). Arrangement state (rest gate, play bank, neighbours) is latched per tick
  and evaluated from the tick whose **audible** window contains now. So rests and
  bank switches land on the heard bar boundary.
- **REQ-the-governing-cell-is-the-latest-heard** — The latch is a small preallocated
  ring of every cell (each cell of a finer rate), sized for the widest look-ahead at
  the fastest tempo. The loop scans back from the newest to the first cell at or
  before `now`. Above ~150 BPM several ticks sit inside the look-ahead, and taking
  "the previous one" would apply a tick nobody has heard. Before anything is heard it
  evaluates the oldest queued cell.
- **REQ-the-motion-playhead-follows-the-swung-grid** — The position is
  `idx + (now - when) / span`, where `span` runs from this cell's onset to the next
  cell's on the same swung grid ([meter](meter.md)
  REQ-swing-is-computed-on-the-lanes-grid). So the playhead reaches `idx + 1` exactly
  when the next cell sounds, and a slide stays a line under swing. Straight time is
  unchanged.
- **REQ-the-motion-frame-loop-allocates-nothing** — No allocation per frame
  ([runtime-performance](runtime-performance.md) REQ-no-allocation-in-a-hot-loop):
  - `createAnchorCache()` memoizes `anchorIndices` by bank. It is **handed in**, never
    module state, because banks mutate in place. The machine clears it on
    `onMotionChange` / `onMotionBankChange` / `onMotionTrackChange` / `onBulkRestore`;
  - the carry gate asks `motionAxesMatch` instead of building `motionAxesFor` pairs;
  - the `Neighbours` pair is a reused scratch object;
  - the carry resolves to a bank and an anchor count, not a fresh record;
  - the tick latch is a fixed ring of reused records.

  The cache is optional, so the panel, graph and tests call the pure functions bare.
- **REQ-the-motion-frame-loop-is-visibility-independent** — rAF is suspended in a
  hidden document, so the loop has **two drivers for one body**: rAF while visible and
  the worker-backed `TickTimer` while hidden, at the **same** fps
  ([runtime-performance](runtime-performance.md)
  REQ-visibility-gating-is-for-pixels-not-sound; [transport](transport.md)
  REQ-the-wakeup-timer-is-off-the-main-thread). One `visibilitychange` listener swaps
  *only* the driver. Hiding MUST NOT deactivate the machine or restore baselines, which
  would be an audible jump per tab switch. Position is recomputed from `(tick.idx,
  tick.when, now)` every evaluation, so nothing needs repair on return. The hidden
  driver bypasses the rAF throttle. The Worker spawns on the timer's first `start()`.
- **REQ-a-seek-clears-the-tick-latch** — `clock.onSeek` empties the latch, as
  `onStart` does, so the loop never glides from the old position's anchor
  ([transport-position](transport-position.md) REQ-motion-baselines-survive-a-seek). It
  **must not** call `restoreBaselines()`: that would snap every param and then
  re-capture baselines from automated values, losing the user's sound on stop.
  Copying `onStop`'s reset here is a data-losing bug.

### Song format

- **REQ-song-file-v4-adds-motion-banks** — SongFile **v4** adds optional `motionBanks`
  (4..16 × 16 `MotionStep`), `motionAssigns` (`MotionAssign|null` per bank) and
  `motionChain` (`ChainData`), additive per ADR-007. Old files load with empty motion.
  Export is default-sparse (`{on:false}`, 4 sig-figs, ADR-011). The dialect's `motion`
  key (anchor lists per bank, optionally `{assign, steps}`) + `motionChain` is
  documented in both schemas and the authoring guide, and `motion.on` auto-enables
  when anchors are present.
- **REQ-restore-spreads-defaults-under-cells** — Restore spreads defaults under
  incoming cells, so sparse and legacy files sound identical.
- **REQ-song-file-v5-adds-motion-tracks** — SongFile **v5** adds optional
  `motionTracks` (per bank, 2..`MOTION_TRACK_COUNT` tracks). v1–v4 files load with
  tracks empty and unassigned. Export is default-sparse, and a bank of empty,
  unassigned tracks is omitted. The dialect has a matching key. The inner widening to
  `2..4` rides **v8** (REQ-the-motion-track-array-length-is-the-count).
- **REQ-the-motion-track-array-length-is-the-count** — A bank's track array length is
  its lane count, floored at `MIN_MOTION_TRACK_COUNT` (2) and capped at
  `MOTION_TRACK_COUNT` (ADR-022 one level in):
  - **Export trims trailing empties to the floor** (`motionTrackDepth(bank)`), so a
    song using only A and B still writes two entries, byte-identical to v5–v7 files and
    demos;
  - **load pads, never truncates**: C and D arrive blank and unassigned;
  - **a deeper bank is v8 content**: the dialect ladder's `anyMotionTrackGrown`
    stamps v8 ([song-file](song-file.md) REQ-song-file-v8-widens-the-bank-count), or
    an older build would accept v5 and silently drop the lane;
  - **the validator bounds the inner array**: a bank with more than
    `MOTION_TRACK_COUNT` tracks is an error, as `checkSeqTracks` does.

### The panel

The Motion tab — the step pads, the lanes, folding, the graph and their gestures
— is [motion-panel](motion-panel.md)'s.

## Technical design

### Contract / public interface

- `MotionStepPad` (`src/ui/components/motion-step-pad.ts`):

  ```yaml
  MotionStepPadOptions:
    beat: boolean
    mode: 'xy' | 'level'
    onSet(x, y): void          # the COMMIT
    onClear(): void
    onGesture?(g): void        # readout feed; null on release
  MotionGesture:
    x: number                  # 0..1, the value the readout should show
    y: number
    mode: 'press' | 'drag' | 'peek'
  HOLD_MS    = 350  # peek threshold; also the double-tap window
  SLOP_PX    = 6    # travel that turns a press into a drag
  SNAP_STEPS = 20   # coarse quantization: 1/20
  FINE_PX    = 400  # px of travel for the full 0..1 range under Shift
  ```

  The pad takes **no `ParamBus`**: it reports numbers, and the panel formats them. It
  caches its last painted value for the peek and Shift's anchor.
- `src/ui/format-param.ts`: `formatParam(def, v)` — discrete `labels`, then
  `def.format`, then `abs(v) >= 100 ? toFixed(0) : toFixed(2)`. Shared with `Knob`.
- `src/ui/components/value-bubble.ts`: `showValueBubble(anchor, text, opts?)` /
  `hideValueBubble()` — a module singleton (one fixed element on `document.body`,
  above the anchor, clamped to the viewport, `pointer-events: none`). It writes
  `textContent` only on change; `opts.peek` marks a read-only gesture.
- `MotionMachine` (`src/audio/transport/motion-machine.ts`): `setEnabled(on)`,
  `setMuted(m)`, `setSlide(on)`, `setTrackSlide(track, on)`, `onStep(cb)`; a
  `clock.onStop` restore and a `clock.onSeek` latch-clear. Latch state `held` (the bank
  whose writes are live, `-1` while resting) drives the park, cleared wherever the
  latch is and by every restore. The baseline map is registered as the bus's snapshot
  overlay at construction and never removed (REQ-a-capture-mid-play-stores-the-baselines). Built by `Engine.init()` after the sampler; exposed
  as `StudioApi.motion`. `MotionMachineOptions`: `now`, `fps`, `raf`/`caf`, `timer?:
  TickTimer` (default `defaultTickTimer()`), `doc?` (default `document`). The machine
  lives as long as the page, so its `visibilitychange` listener is never removed.
- `motion-curve.ts` (pure): `anchorIndices(bank)`; `scalarAt(bank, barPos, mode, get,
  neighbours?, cells?) → number | null`; `valueAt(bank, barPos, mode, neighbours?) →
  {x,y} | null` (two `scalarAt` calls); `valueAt1D(steps, …)` (one). `MotionNeighbours
  = { prev?, next?: readonly MotionStep[] | null }`: omitted means this bank (the
  self-wrap), and `null`/anchorless means hold flat. Deciding a neighbour's usability
  is the caller's job.
- `PatternStore`: `motionEditBank`, `motion`, `motionBank(i)`, `setMotionEditBank`,
  `setMotionStep(step, cell)`, `copyMotionBank(from,to)`, `motionAssign(i)`,
  `setMotionAssign(i, a|null)`, `onMotionChange`, `onMotionBankChange`,
  `motionTracks(bank)`, `motionTrack(track)`, `setMotionTrackStep(track, step, patch)`,
  `setMotionTrackParam(track, id|null)`, `clearMotionTrack(track)`,
  `onMotionTrackChange(fn)`. Track mutations emit the `motion-track` /
  `motion-track-param` undo kinds. `clearMotionBank` / `copyMotionBank` carry the
  whole bank in one `motion-copy` entry (step-grid-editing.md
  REQ-one-bulk-action-one-undo-entry).
- `src/state/patterns.ts`: `MOTION_TRACK_COUNT` (4), `MOTION_TRACK_LABELS` (derived),
  `MIN_MOTION_TRACK_COUNT` (2), and `motionTrackDepth(bank)`. The last is shared by
  `compactSongForExport` and the dialect's version ladder, so the exported depth and
  the stamped version cannot disagree.
- `Arrangement`: `motionPlayBank`, `motionResting`, `setMotionChain(steps, enabled)`,
  `motionChainPos`, `motion{Prev,Next}PlayBank`, `motion{Prev,Next}Resting`.
- `src/utils/taper.ts`: `toNorm(def, v)`, `fromNorm(def, n)`, in the shared layer so
  audio can map taper-correctly without importing UI.
- `src/state/xy-effective.ts`: `motionAxesFor(patterns, bank, base) → XyAssign` and
  `motionAxesMatch`, shared by `createEffectiveXy`, the machine's neighbour gate and
  the graph.
- `src/ui/components/motion-graph.ts` (pure): `motionGraphPoints(bank, view, mode,
  neighbours?, cells?) → { line: [x,y][]; dots: [x,y][]; carry: [x,y][][] }` in the
  0–100 viewBox space, and `motionGraphPoints1D(steps, mode, neighbours?, cells?)`.

### Data shapes

```yaml
MotionStep:
  on: boolean
  x: number   # 0..1 normalized (taper space)
  y: number   # 0..1
MotionAssign:        # per-bank override, each axis optional
  x: string | absent # ParamBus id
  y: string | absent
MotionTrackStep:
  on: boolean
  v: number          # 0..1 normalized (taper space)
MotionTrack:         # per bank, per track
  param: string | absent   # ParamBus id; absent = the track writes nothing
  steps: MotionTrackStep[16]
Params:
  motion.on / motion.mute
  motion.slide:       { discrete, labels: [step, slide], default: 1 }   # XY lane
  motion.t<i>.slide:  { discrete, labels: [step, slide], default: 1 }   # each track, i in 0..3
  motion.len / motion.rate                                               # meter.md
SongFile v4 (additive):
  motionBanks: MotionStep[4..16][16] | absent
  motionAssigns: (MotionAssign | null)[4..16] | absent
  motionChain: ChainData | absent
SongFile v5 (additive; inner widening rides v8):
  motionTracks: (MotionTrack | null)[4..16][2..4] | absent   # inner length == motionTrackDepth(bank)
Author dialect:
  motion: [ MotionBank, ... up to MAX_BANK_COUNT ]
  # MotionBank = [ {step, x, y}, ... ]  |  { assign?: {x?, y?}, steps: [ {step,x,y}, ... ] }
  motionChain: Chain
  motionTracks: [ [TrackSpec x up to MOTION_TRACK_COUNT], ... ]
  # TrackSpec = { param, steps: [ {step, v}, ... ] } | null; a bank deeper than 2 stamps v8
```

### Layer touchpoints & ordering

- `main.ts` creates `XyPadStore` and passes it into `Engine.init()`, so the machine
  can resolve assignments; the same instance flows to the UI.
- Engine order: Arrangement → Performance → machines, Motion after the sampler. It
  subscribes `motion.on` → `setEnabled`, `motion.mute` → `setMuted`, `motion.slide` →
  `setSlide`, `motion.t<i>.slide` → `setTrackSlide`.
- The Song panel's Motion card reuses `buildChainLane` with `{ mixer: 'mute' }`.

### Persistence

- Song: the v4/v5 fields; save slots, share links and project zips pass them through.
  Presets carry only the motion params (`motion.on`, the slide params), not pattern
  data.
- Lane folds: `websynth.ui.collapsed.motiontrack.<i>`.
- Not persisted: the Y/X view toggle and the baseline map.

## Scenarios (BDD)

```gherkin
Scenario: A one-bar cutoff sweep (slide)
  Given the XY Pad assigns x=filter.resonance, y=filter.cutoff
  And motion bank A has anchors step0 y=0, step8 y=1, step15 y=0 and slide mode
  When the transport plays bar after bar
  Then filter.cutoff ramps min→max→min continuously each bar
# pinned by: tests/audio/transport/motion-curve.test.ts, tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: An extra track drives a third parameter while the pad stays free
  Given motion track A on bank A is assigned to fx.delay.mix with anchors
  When the transport plays that bank
  Then fx.delay.mix follows the track's curve
  And the XY Pad's own two params are driven only by the XY anchors
  And stopping restores every driven param, tracks included
# pinned by: tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: Two lanes interpolate differently in the same bar (REQ-set-steps-are-anchors)
  Given track A is assigned with anchors and set to STEP
  And track B is assigned with anchors and set to SLIDE
  When the bar plays
  Then A jumps and holds while B ramps, in the same bar
  And the XY lane follows its own motion.slide, independent of both
# pinned by: tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: A third lane drives a third param with the pad still free (REQ-extra-single-param-tracks-per-bank)
  Given lanes A, B and C are each assigned to a different param with anchors
  When the transport plays that bank
  Then all three follow their own curves, on their own slide modes
  And the XY lane's anchors are the only thing driving the pad's two params
  And stopping restores every one of them
# pinned by: tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: A four-track song is stamped v8, a two-track one is not (REQ-the-motion-track-array-length-is-the-count)
  Given an authoring-dialect song whose motion bank assigns lane C
  When expandAuthorSong runs
  Then the canonical file is version 8 — not 5, which an older build would accept
    before silently dropping the lane
  And the same song using only lanes A and B still expands to version 5
# pinned by: tests/state/song-author.test.ts

Scenario: A song using only A and B exports byte-for-byte as before (REQ-the-motion-track-array-length-is-the-count)
  Given a song whose motion banks use at most lanes A and B
  When it is exported
  Then each bank's motionTracks entry still has exactly 2 elements
  And a bank that assigns lane C writes 3, and one that assigns D writes 4
# pinned by: tests/state/serialize.test.ts

Scenario: A file with too many tracks in a bank is rejected, not truncated (REQ-the-motion-track-array-length-is-the-count)
  Given a canonical song whose motionTracks bank holds 5 tracks
  When it is validated
  Then it reports an error naming the bank
  And a 2-entry bank from a v5 file still validates and loads with C and D blank
# pinned by: tests/state/song-validate.test.ts, tests/state/song.test.ts

Scenario: An unassigned extra track writes nothing
  Given motion track B has anchors but no parameter chosen
  When the transport plays
  Then nothing is written — the parameter is the track's on/off
  And its cells render inert while the param picker stays usable
# pinned by: tests/audio/transport/motion-machine.test.ts, tests/state/patterns.test.ts

Scenario: Extra tracks follow the XY lane's curve rules exactly (REQ-tracks-share-the-lanes-curve-semantics)
  Given a track and the XY lane's y axis carry the same anchors
  When both are sampled across the bar in slide and step mode
  Then their values are equal at every point, since one scalar core serves both
# pinned by: tests/audio/transport/motion-curve.test.ts

Scenario: Copying a bank carries the tracks and their parameters
  Given bank A has track B assigned with anchors
  When bank A is copied to bank C
  Then C's track B has the same parameter and anchors, deep-copied
# pinned by: tests/state/patterns.test.ts

Scenario: New Song clears the extra tracks (regression)
  Given a song assigned motion track A to fx.delay.mix
  When the user starts a New Song
  Then the track is blank AND unassigned, so nothing is still being automated
# pinned by: tests/state/patterns.test.ts, e2e/motion.spec.ts

Scenario: Step mode jumps and holds
  Given anchors at steps 0 and 8 and step mode
  When the bar plays
  Then the param jumps at step 0, holds, jumps at step 8, holds
# pinned by: tests/audio/transport/motion-curve.test.ts

Scenario: A bank parks at its last anchor when the chain hands over (REQ-a-bank-parks-at-its-last-anchor, regression)
  Given a 12/8 bar (24 ticks) and a motion lane of 9 cells at 1/8 — 18 ticks, so it
    does not tile the bar
  And bank B overrides the axes to params no other bank drives, sweeping up on its
    step-5 anchor and home again on its step-9 one
  When the chain plays bank B for its bar and moves on
  Then the bar ends mid-sweep on the raised value, but the handover writes bank B's
    step-9 anchor — the value the author drew as its resting place
  And the param stays there instead of holding the sweep until bank B comes round again
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A handover parks nothing the incoming bar drives itself (REQ-a-bank-parks-at-its-last-anchor)
  Given a chain A → B where both banks drive the same param
  When the bar line between them is crossed
  Then only bank B's value is written on that frame — A's seam value is never put
    in front of it, so the carry (REQ-cross-bank-carry) is bit-for-bit what it was
  And a lane that tiles the bar is unchanged either way: its bar already ends on
    its last cell, so the parked value is the one already there
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: Muting from the Song tab restores baselines and the pad's base axes (REQ-motion-mute-is-an-ordinary-param)
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

Scenario: The curve carries into the next bank instead of wrapping (REQ-cross-bank-carry, regression)
  Given slide mode and a chain D → A
  And bank D ends high (anchor at step 15) while bank A opens at that same value
  When the bar line between them is crossed
  Then D's final step holds its high value instead of ramping back to D's step-0 value
  And bank A opens on its own step-0 anchor, so the move is continuous
# pinned by: tests/audio/transport/motion-curve.test.ts, tests/audio/transport/motion-machine.test.ts

Scenario: An unusable neighbour holds the last anchor (REQ-cross-bank-carry)
  Given slide mode and a chain A → B where B has no anchors (or rests, or drives
    a different param than A)
  When bank A's last anchor is passed
  Then the value holds that anchor to the bar line
  And bank B — writing nothing — leaves it there
# pinned by: tests/audio/transport/motion-curve.test.ts, tests/audio/transport/motion-machine.test.ts

Scenario: A repeating bank is unchanged by the carry (REQ-cross-bank-carry, back-compat)
  Given a single-bank chain (or a disabled lane) with anchors at steps 4 and 12
  When the bar plays
  Then the curve is exactly the last→first wrap across the bar line
# pinned by: tests/audio/transport/motion-curve.test.ts

Scenario: Bank switches apply at the audible bar boundary, not at schedule time
  Given the chain moves from bank A to bank B with different anchor values
  When the new bar's first tick arrives ahead of its audible time
  Then frames before the audible boundary still evaluate bank A
  And frames from the boundary on evaluate bank B
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A slide stays a line under swing (REQ-the-motion-playhead-follows-the-swung-grid, regression)
  Given a straight slide from anchor 0 to anchor 15 and transport.swing 1
  When frames run every 10 ms with ticks arriving up to 100 ms early
  Then the written value never decreases
   And it reaches each cell's anchor-line value exactly at that cell's swung onset
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: Straight time is unchanged by the swung grid (REQ-the-motion-playhead-follows-the-swung-grid, back-compat)
  Given transport.swing 0
  Then every frame writes exactly what the even-cell position gives
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A bank switch lands on the heard boundary above 150 BPM (REQ-the-governing-cell-is-the-latest-heard, regression)
  Given 400 BPM, so several ticks sit inside the look-ahead at once
   And the chain moves from bank A to bank B
  When a frame runs after the last bank-A tick is heard but before bank B's first
  Then it still evaluates bank A — not the queued bank-B tick nobody has heard
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

Scenario: A song loaded mid-play keeps its own values after Stop (REQ-a-load-or-an-edit-rebaselines, regression)
  Given song A's motion lane drives filter.cutoff, whose saved value is 90
  When song B (cutoff 40) is loaded mid-play and the transport is then stopped
  Then filter.cutoff is 40, not A's 90
  And a sparse preset loaded mid-play re-baselines only the params it names
  And a knob turned on an automated param mid-play is the value Stop returns to
# pinned by: tests/audio/transport/motion-machine.test.ts, tests/state/params.test.ts

Scenario: Saving mid-play stores the authored value, not the automated one (REQ-a-capture-mid-play-stores-the-baselines, regression)
  Given filter.cutoff is 60 and motion drives it away from 60 while playing
  When a song (or a preset, or the session autosave) is captured mid-play
  Then the captured filter.cutoff is 60
  And the live value the knob and the audio see is still the automated one
# pinned by: tests/audio/transport/motion-machine.test.ts, tests/state/params.test.ts

Scenario: A knob turned mid-play is what a mid-play save stores (REQ-a-capture-mid-play-stores-the-baselines)
  Given motion drives filter.cutoff and the user turns it to 75 mid-play
  When a song is captured before the next stop
  Then the captured filter.cutoff is 75
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A capture while stopped is unchanged (REQ-a-capture-mid-play-stores-the-baselines, back-compat)
  Given the transport has stopped, so no param is held by automation
  Then snapshot() reports every live value exactly
# pinned by: tests/audio/transport/motion-machine.test.ts, tests/state/params.test.ts

Scenario: A seek keeps the baselines (REQ-a-seek-clears-the-tick-latch)
  Given motion drove filter.cutoff away from its saved value
  When the playhead is seeked mid-play
  Then the latch is cleared, so cutoff jumps to the curve's value at the new
       position instead of gliding from the old anchor
  And the recorded baseline is untouched — stopping afterwards still restores the
       ORIGINAL pre-play value, not an automated one
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: A cached anchor set still sees an edit (REQ-the-motion-frame-loop-allocates-nothing, regression)
  Given the machine has already evaluated a bank this play session
  When the user adds, removes, or loads over one of its steps
  Then the next frame automates from the edited anchors, not the memoized ones
# pinned by: tests/audio/transport/motion-machine.test.ts, tests/audio/transport/motion-curve.test.ts

Scenario: Caching changes no value (REQ-the-motion-frame-loop-allocates-nothing)
  Given a bank with both carry neighbours, in slide and in step mode
  When it is evaluated across the whole bar with and without a cache
  Then the two agree at every position
# pinned by: tests/audio/transport/motion-curve.test.ts

Scenario: Motion keeps automating while the document is hidden (REQ-the-motion-frame-loop-is-visibility-independent, regression)
  Given the transport is playing and motion is enabled with anchors
  When the document becomes hidden
  Then the rAF driver is cancelled and the worker-backed timer drives the loop at the perf fps
  And the assigned params keep moving as the audio clock advances
  And no baseline is restored
  When the document becomes visible again
  Then the timer is stopped and the rAF driver is re-armed
# pinned by: tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: Stopping while hidden still restores the baselines (REQ-the-motion-frame-loop-is-visibility-independent/REQ-motion-writes-go-through-bus-set)
  Given the transport is playing with the document hidden and motion writing
  When the transport stops
  Then the hidden driver is stopped
  And every automated param is back at its pre-automation value
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: Automation reaches the knobs but not the change signal (REQ-motion-automation-is-not-an-edit)
  Given a subscriber on filter.cutoff and a global bus.onChange listener
  When motion slides filter.cutoff across a bar and the transport then stops
  Then the per-param subscriber saw every written value, including the restore
  And the global listener saw nothing
  And a subsequent user edit of filter.cutoff does fire the global listener
# pinned by: tests/audio/transport/motion-machine.test.ts

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

Scenario: Extra tracks round-trip through a song
  Given a track assigned with anchors
  When the song is saved, a New Song started, and the song reloaded
  Then the track's parameter and anchors come back
# pinned by: tests/state/patterns.test.ts, e2e/motion.spec.ts

Scenario: Old songs load unchanged
  Given a v1/v2/v3 SongFile without motion fields
  When it is applied — even directly after a song that HAD motion banks/tracks
  Then motion banks are empty, the chain is disabled and nothing is written
  # authoritative apply (song-mode.md REQ-apply-resets-to-defaults-first): the store
  # is reset via emptyPatternSnapshot(), so earlier anchors can never linger
# pinned by: tests/state/song-validate.test.ts, tests/state/song.test.ts

Scenario: Dialect motion bank expands
  Given an author song with motion anchors and a per-bank assign
  When expandAuthorSong runs
  Then a canonical v4 file with motionBanks/motionAssigns and motion.on=1 results
# pinned by: tests/state/song-author.test.ts
```

## Tests & verification

- Unit: `tests/audio/transport/{motion-curve,motion-machine,arrangement}.test.ts`,
  `tests/state/{patterns,song-validate,serialize,song-author,authoring-docs}.test.ts`,
  `tests/ui/help-content.test.ts` (the panel's are [motion-panel](motion-panel.md)'s)
  — `npm test`. E2E: `e2e/motion.spec.ts` (fakes a suspended rAF; only a real
  backgrounded window proves the hidden driver).
- **By ear** (ADR-010): the handover park on **Gankogui** (lanes against a 12/8 bar:
  the DJ filter must return after bank B), A/B'd against a 4/4 demo with overrides
  (**First_Light**) that must not change; four lanes moving while the XY Pad is
  worked by hand.
- **By hand**: a demo using A/B (**Kutmuziek**, **Titulaer**) re-exports
  byte-identical. Device: background a playing motion song ~30 s; the sweep must
  continue.

## Pitfalls (documented behaviour)

- Dragging an automated knob mid-play: motion wins next write, and Stop returns to
  where you left the knob (REQ-a-load-or-an-edit-rebaselines).
- Assigning `transport.bpm` is allowed (tempo automation); slave-sync gating prevents
  clock conflicts.
- When the chain leaves a bank whose override drove other params, those params hold
  the bank's **last anchor** until stop (REQ-a-bank-parks-at-its-last-anchor). To
  bring a param home during anchorless bars, give the last anchor that value.
- A lane that does not tile the bar ([meter](meter.md)
  REQ-each-machine-has-a-loop-length) sees its anchors more or less than once per bar
  (Gankogui plays cells 3,4,5,6,7,8,0,1,2,3,4,5), so a bank's bar can end anywhere in
  its loop. The park keeps its resting value authorable.

## Open questions / future

- Free per-step param choice: whether a lane's parameter could change *within* a
  bank, decoupling the XY lane from the XY Pad.
- The lane count is fixed at four, not grown on demand like a bank
  ([banks](banks.md) REQ-a-bank-is-added-on-demand). Folding buys the space back. If
  four stops being enough, the count is one constant, but the per-bank array would
  then need the bank bar's shrink rules.
