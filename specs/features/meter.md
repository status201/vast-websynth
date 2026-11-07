# Meter & polyrhythm

```yaml
id: meter
status: implemented
version: 3
owner: core
related:
  - architecture
  - transport
  - arrangement
  - sequencer
  - drum-machine
  - sampler
  - motion-sequencer
  - performance
  - transport-position
  - onboarding          # REQ-the-meter-has-a-help-topic there: the meter's help topic + badge
  - audio-export
  - webrtc-sync
  - midi-clock-sync
  - untrusted-input
  - ../decisions/adr-019-the-bar-is-a-tick-count
  - ../decisions/adr-006-no-op-param-defaults
source:
  - src/state/meter.ts                       # the vocabulary (REQ-meter-ts-names-the-three-jobs)
  - src/state/params.ts                      # the ten scalars
  - src/state/limits.ts                      # MAX_STEP (REQ-the-step-counter-must-not-wrap)
  - src/state/preset-session.ts              # the `motion.` prefix (REQ-motion-joins-the-non-patch-prefixes)
  - src/audio/transport/clock.ts             # unwrapped step + swingOffset
  - src/audio/transport/lane-meter.ts        # one lane's length/rate/swing
  - src/audio/transport/arrangement.ts       # the bar line (REQ-bar-ticks-is-the-arrangement-bar-line)
  - src/audio/transport/performance.ts       # mapStep, the stutter fold LaneMeter applies (REQ-stutter-composes-with-length-and-rate)
  - src/audio/transport/sequencer.ts
  - src/audio/transport/drum-machine.ts      # the meter-relative fill (REQ-the-drum-fill-is-relative-to-its-lane)
  - src/audio/transport/sampler-machine.ts
  - src/audio/transport/motion-machine.ts
  - src/audio/transport/motion-curve.ts      # scalarAt's `cells`
  - src/audio/transport/sync/sync-types.ts   # the `meter` message (REQ-meter-travels-on-the-wifi-wire)
  - src/audio/transport/sync/sync-master.ts
  - src/audio/transport/sync/sync-slave.ts
  - src/audio/transport/sync/sync-controller.ts
  - src/audio/transport/sync/webrtc-sync-transport.ts
  - src/audio/recorder/recorder-controller.ts  # bar-exact capture (REQ-bar-exact-capture-follows-bar-ticks)
  - src/audio/recorder/bank-render.ts
  - src/audio/engine.ts                      # resolves the pair, pushes barTicks
  - src/ui/lane-grid.ts                      # the UI's single grid resolver
  - src/ui/components/meter-picker.ts        # the header control (REQ-meter-is-two-bus-scalars)
  - src/ui/components/playhead-ruler.ts      # REQ-accents-and-ruler-derive-from-the-meter
  - src/ui/panels/step-panel-scaffold.ts     # the LEN/RATE pair
  - src/ui/studio-api.ts                     # `barTicks` for the UI
  - src/ui/onboarding/help-content.ts        # the `meter` help topic
  - src/ui/onboarding/info-badges.ts         # its anchor
  - src/state/authoring-guide.ts             # the METER block agents read
```

The cross-cutting facility that lets the instrument play outside 4/4, and lets one
machine fight the bar on purpose.

## Background / Why

`SEQ_LENGTH = 16` once did three unrelated jobs: cells per pattern, bar length and UI
columns. Splitting them is most of this feature; the rest is two controls per machine.
The model is every groovebox's: a bar is a number of ticks, and each machine loops
`length` cells at `rate` ticks per cell. A lane matching the bar is in meter, one that
doesn't phases against it (polymeter), and one on a triplet rate fights it inside the
bar (polyrhythm). [ADR-019](../decisions/adr-019-the-bar-is-a-tick-count.md) records
why meter is a tick count, why the grid stays 16 cells, and why the clock is left
alone.

## Vocabulary

```
tick          one 16th note — the clock's unit, unchanged
ticksPerBeat  4 (beat unit 1/4)  |  2 (beat unit 1/8)
barTicks      beats × ticksPerBeat          7/8 → 7 × 2 = 14
laneTicks     len cells × rate ticks/cell   len 10 × 1/8 → 20 ticks = 5/4
```

| Signature | barTicks | cells at 1/16 | cells at 1/8 |
| --- | --- | --- | --- |
| 4/4 | 16 | 16 | 8 |
| 3/4 · 6/8 | 12 | 12 | 6 |
| 5/4 | 20 | — | 10 |
| 7/4 | 28 | — | 14 |
| 7/8 | 14 | 14 | 7 |
| 5/8 | 10 | 10 | 5 |
| 9/8 | 18 | — | 9 |
| 12/8 | 24 | — | 12 |

A bar longer than `GRID_CELLS` ticks needs a coarser lane rate to fit one grid, the
trade ADR-019 accepts to leave the pattern shape, the schemas and every demo alone.

## Requirements

### Foundation

- **REQ-the-clock-stays-a-sixteenth-pulse** — Meter adds no tick rate, bar callback or
  state to `Clock` ([transport](transport.md) REQ-subscribers-get-step-and-audio-time).
  Every bar and lane notion is derived downstream from the monotonic `step`.
- **REQ-meter-ts-names-the-three-jobs** — `src/state/meter.ts` is the only place the
  three jobs are named: `GRID_CELLS` (cells per pattern; `SEQ_LENGTH` aliases it),
  `barTicks` (bar length) and `LANE_RATES` (ticks per cell), so a call site must say
  which it means. It is pure and dependency-free, so the MCP Node bundle can read it.
- **REQ-a-cell-index-is-a-pure-function-of-step** — No lane keeps a phase accumulator,
  so `seek`, Song Position join, WiFi sync and dropout recovery
  ([transport](transport.md)
  REQ-seek-moves-a-running-clock/REQ-the-transport-catch-up-is-bounded) need no repair
  step for a 12- or 14-tick lane (chain slots do need one: [arrangement](arrangement.md)
  REQ-a-mid-play-seek-re-seeks-every-lane). The one refinement,
  REQ-a-multi-bar-lane-restarts-with-its-chain, is still pure.
- **REQ-a-multi-bar-lane-restarts-with-its-chain** — A chained lane whose loop is a
  whole number of bars (≥ 2) restarts at cell 0 on its chain's slot 0: its slots
  address *pages* (a 16-cell 1/8 lane is two bars, and slot `A A` plays cells 0–7 then
  8–15), so the page follows the chain, not the absolute bar. The index is offset by
  the first cell beginning at or after the chain-loop start (`floor(step / loopTicks) ×
  loopTicks`, `loopTicks = steps.length × barTicks`). Only the index moves; grid, swing
  parity, fan-out and stutter stay absolute. **A polyrhythm is exempt** (a loop that is
  not whole bars, e.g. 12 cells at 1/16 in 4/4) and keeps drifting, as do unchained
  lanes. When the chain length is a multiple of the page count the offset is ≡ 0, so
  such songs play bit-identically (ADR-006). The METER block agents read
  (`authoring-guide.ts`, `llms.txt`) states the split.
- **REQ-the-step-counter-must-not-wrap** — A wrap that is not a multiple of every lane
  length jumps phase. [transport](transport.md) REQ-the-step-counter-is-bounded-at-ingress
  owns the bound.

### Global meter

- **REQ-meter-is-two-bus-scalars** — `transport.beats` (2..12) and `transport.beatUnit`
  (`1/4` | `1/8`), defaulting to 4/4, a no-op (ADR-006). They are song state:
  `NON_PATCH_PREFIXES` excludes `transport.`, so a preset never changes the meter. The
  header picker has no label.
- **REQ-bar-ticks-is-the-arrangement-bar-line** — Chain lanes advance on `step %
  barTicks === 0` and seek to `floor(step / barTicks)` ([arrangement](arrangement.md)
  REQ-a-chain-advances-one-slot-per-bar/REQ-start-seeks-every-lane). All four chain
  lanes share one bar grid; per-lane bar lengths are out of scope.
- **REQ-bar-exact-capture-follows-bar-ticks** — Song export's bar count and tail bar
  ([audio-export](audio-export.md)) and the bank render
  ([render-to-sampler](render-to-sampler.md)) measure a bar as `barTicks ×
  sixteenthDuration()`.
- **REQ-accents-and-ruler-derive-from-the-meter** — Beat accents, the ruler's numbered
  beats and its tooltip come from `ticksPerBeat` (scaled by the lane's rate), never
  from `% 4` ([transport-position](transport-position.md)
  REQ-a-position-ruler-above-every-grid).
- **REQ-the-drum-fill-is-relative-to-its-lane** — `DrumMachine.playFill` derives its
  shape from the lane's length, so a 7/8 fill lands on the bar's own last step
  ([drum-machine](drum-machine.md) REQ-drum-lane-follows-the-meter).

### Per-lane length — polymeter

- **REQ-each-machine-has-a-loop-length** — `seq.len`, `drum.len`, `sampler.len`,
  `motion.len`, `0..GRID_CELLS`, default **0 = follow the bar** (`clamp(barTicks /
  rate, 1, GRID_CELLS)`). Picking 7/8 puts all four machines in 7/8 with no setup.
- **REQ-cells-beyond-the-length-are-hidden** — The grid's column count follows the lane
  (`--steps`), so 3/4 draws twelve columns, not sixteen with four dead ones (ADR-014).
  `hidden`, not removed: DOM, testids, selection and stored steps survive, so shortening
  and lengthening a lane returns every step, and a meter change is a class flip. The
  ruler hides its ticks by the same rule from the same resolver.
- **REQ-pattern-arrays-stay-grid-cells-long** — Pattern arrays are always `GRID_CELLS`
  long; only the played window shrinks. That keeps `song-validate.ts`'s exact-length
  checks, the JSON schemas' `minItems/maxItems: 16`, the dialect's rest-padding and the
  demos untouched.
- **REQ-motion-joins-the-non-patch-prefixes** — `motion.` is in `NON_PATCH_PREFIXES`,
  so `motion.on`/`mute`/`slide`/`len`/`rate` are never captured into presets, and
  auditioning a sound cannot switch the motion machine off ([presets](presets.md)).

### Per-lane rate — polyrhythm

- **REQ-each-machine-has-a-step-rate** — `seq.rate`, `drum.rate`, `sampler.rate`,
  `motion.rate`: a discrete index into `LANE_RATES` (ticks per cell), default `1/16`, a
  no-op. The values mirror the straight/dotted/triplet table in `src/utils/tempo.ts`
  ([tempo-lock](tempo-lock.md)), pinned to it by a drift test.
- **REQ-coarser-skips-ticks-finer-fans-out** — A rate of 2 ticks/cell fires every second
  tick; a rate of ⅔ schedules that tick's sub-hits at absolute `when` offsets, as
  [arpeggiator](arpeggiator.md) REQ-a-sub-16th-rate-schedules-its-own-hits does. The
  clock is untouched and a triplet lane is sample-accurate.
- **REQ-swing-is-computed-on-the-lanes-grid** — The clock delays odd *ticks*
  ([transport](transport.md) REQ-bpm-and-swing-are-live-settable), so a lane at 2
  ticks/cell would play straight under swung hats. A lane whose rate is not 1 subtracts
  the clock's offset for its tick and adds the one its own alternating cells imply; at
  the default rate this is nil. Every hit also reports its **span**, the seconds to
  the next cell's onset on the same swung grid. The trigger machines ignore it (gate and
  ratchet are fractions of the cell); the motion sequencer interpolates across it
  ([motion-sequencer](motion-sequencer.md)
  REQ-the-motion-playhead-follows-the-swung-grid).
- **REQ-stutter-composes-with-length-and-rate** — `Performance.mapStep` folds the
  *absolute* step and only the modulo after it is lane-aware, so a stutter over a
  12-cell lane repeats 12-cell material ([performance](performance.md)). Motion reads
  the raw step; automation does not follow a stutter.

### Sync & persistence

- **REQ-meter-travels-on-the-wifi-wire** — WebRTC sync carries a bounded `meter`
  message so peers agree on bar boundaries ([webrtc-sync](webrtc-sync.md)). MIDI has no
  meter message: Song Position (16ths) stays correct, but peers in different meters
  number bars differently, a stated limit of [midi-clock-sync](midi-clock-sync.md).
- **REQ-meter-needs-no-song-file-bump** — The ten scalars ride in the open `params`
  map: no new key, no schema change, no migration (ADR-007). An absent key means 4/4.
  Re-saving an old song writes the ten keys at their defaults, which is a larger file,
  not a different song; the demos are stored normalized (`npm run check:demos`).

## Technical design

### Contract / public interface

```yaml
# src/state/meter.ts — arithmetic only (it reaches the MCP Node bundle)
GRID_CELLS: 16                       # cells per pattern (SEQ_LENGTH aliases this)
MIN_BEATS: 2 / MAX_BEATS: 12
BEAT_UNITS: [4, 2]                   # ticks per beat, indexed by transport.beatUnit
BEAT_UNIT_LABELS: ['1/4', '1/8']
DEFAULT_BEATS: 4 / DEFAULT_BEAT_UNIT: 0 / DEFAULT_BAR_TICKS: 16
LaneRate: { label: string, num: number, den: number }   # ticks/cell = num/den
LANE_RATES: LaneRate[]               # '1/32' … '1/4', ascending by duration
LANE_RATE_LABELS: string[]
DEFAULT_LANE_RATE: number            # index of '1/16' — one cell per tick
LEN_FOLLOW: 0                        # the `<m>.len` sentinel
METER_PRESETS: { label, beats, unit }[]        # 4/4 3/4 2/4 5/4 7/4 5/8 6/8 7/8 9/8 12/8
barTicks(beats, unitIdx) / ticksPerBeat(unitIdx) / meterLabel(beats, unitIdx)
laneRate(rateIdx): LaneRate / ticksPerCell(rateIdx): number
laneCells(len, rateIdx, barTicks): number      # LEN_FOLLOW -> follow the bar
laneTicks(len, rateIdx, barTicks): number
cellIndex(step, cells, rateIdx): number        # pure in `step`
loopCellShift(step, cells, rateIdx, barTicks, loopTicks): number  # REQ-a-multi-bar-lane-restarts-with-its-chain; 0 = none
loopCellIndex(step, cells, rateIdx, barTicks, loopTicks): number  # cellIndex minus that shift
cellsInTick(step, rateIdx): { from, count }    # which cells BEGIN in this tick
cellOffsetTicks(cell, rateIdx, step): number   # 0 .. <1, for sub-tick scheduling

LaneMeter:     # src/audio/transport/lane-meter.ts — one per machine, and one in the arpeggiator
  setLen(len) / setRate(rateIdx) / setBarTicks(ticks)
  get cells / get rate / cellDuration()
  new LaneMeter(clock, mapStep?, loopTicks)   # mapStep = perf.mapStep, except motion and the arp (raw)
  forEachHit(step, when, fn: (cellIdx, at, cellDur, span) => void)   # the machines' one entry point

Arrangement:   # src/audio/transport/arrangement.ts
  loopTicks(lane): number            # steps.length × barTicks, 0 when the lane is not chained

Performance:   # src/audio/transport/performance.ts
  mapStep(step): number              # the stutter fold; LaneMeter resolves the cell from it

Clock:         # src/audio/transport/clock.ts
  swingOffset(step): number          # the delay applied to this tick
  get step: number                   # unbounded, never masked
```

**Rates are exact rationals, not floats.** `cellsInTick` compares `cell × num/den`
against integer tick bounds; as a float, `2 / (2/3)` is `3.0000000000000004` and a
triplet cell lands a tick late. The table mirrors `utils/tempo.ts` and is pinned to it
by a drift test rather than imported, so this module stays arithmetic-only.

### Gesture inventory — METER, and a machine's GRID pair (ADR-014)

| Gesture | METER (header) | GRID `LEN` / `RATE` (machine header) |
| --- | --- | --- |
| tap / click | open the list; pick a signature (writes **both** params) | open the list; pick a length or rate |
| hover | — | the cluster's `title` reads the pair out (`14 steps of 1/16 = one 7/8 bar`) |
| wheel | — deliberately: a flick would change the bar of a playing song, with no undo | — |
| double-click / long-press / right-click | — every reset value is one pick away | — |
| keyboard | the shared [dropdown](dropdown.md) handling | same |

The **hint** beside the pair is not interactive and renders only while the lane is off
the bar; a label that is always present stops being read.

### Data shapes (registry)

```yaml
transport.beats:    { range: 2..12, default: 4, step: 1 }
transport.beatUnit: { discrete, labels: ['1/4', '1/8'], default: 0 }
seq.len | drum.len | sampler.len | motion.len:
                    { range: 0..16, default: 0, step: 1 }   # 0 = follow the bar
seq.rate | drum.rate | sampler.rate | motion.rate:
                    { discrete, labels: LANE_RATE_LABELS, default: index of '1/16' }
# src/state/limits.ts
MAX_STEP = 2 ** 31   # the transport position bound
```

### Layer touchpoints & ordering

```yaml
engine (subscribeParams):
  transport.beats / transport.beatUnit -> barTicks -> arrangement, performance,
    every LaneMeter, recorder controller (one resolved number, pushed on change)
  <m>.len / <m>.rate -> that machine's LaneMeter only
machines: seq / drum / sampler / motion iterate this.lane.forEachHit(step, when, …);
  seq / drum / sampler map the step through perf.mapStep, motion uses the raw step (no stutter remap)
construction order: Arrangement before the machines (arrangement.md REQ-arrangement-is-built-before-the-machines)
ui: the meter picker (components/meter-picker.ts) in the header; LEN/RATE per machine in
  panels/step-panel-scaffold.ts; every grid resolves through src/ui/lane-grid.ts
css: the step grids are `repeat(var(--steps, 16), …)`
```

### Persistence

Ten `ParamBus` scalars in `SongFile.params`, nothing else. The resolved `barTicks` and
lane cell counts are derived on every read, and meter is global to the song, not per
bank.

## Scenarios (BDD)

```gherkin
Scenario: The transport counter no longer wraps (REQ-the-step-counter-must-not-wrap)
  Given a clock started at a very large step
  When it ticks
  Then the step keeps increasing and is never folded back to 0
  And seek clamps an out-of-range position instead of masking it
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A lane index is unchanged by how the playhead got there (REQ-a-cell-index-is-a-pure-function-of-step)
  Given a lane of 12 cells
  When the transport reaches step 40 by playing, and again by seeking
  Then the cell index is the same both times
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: 7/8 advances the chain every 14 ticks (REQ-bar-ticks-is-the-arrangement-bar-line)
  Given transport.beats 7 and beat unit 1/8
  When the transport plays two bars
  Then the chain advances at step 14 and step 28, not at 16 and 32
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: Picking a meter moves every machine at once (REQ-each-machine-has-a-loop-length)
  Given all four lanes at the default length
  When the meter is set to 3/4
  Then each machine loops over 12 cells and cells 13-16 fall dark
# pinned by: tests/audio/transport/sequencer.test.ts, e2e/patterns.spec.ts

Scenario: A shortened lane keeps the steps it is not playing (REQ-cells-beyond-the-length-are-hidden)
  Given a full 16-step drum pattern
  When drum.len is set to 12 and back to 16
  Then every step is exactly as it was
# pinned by: tests/state/patterns.test.ts

Scenario: A 12-cell lane phases against a 16-tick bar and re-aligns (REQ-each-machine-has-a-loop-length)
  Given drum.len 16 and seq.len 12 in 4/4
  When the transport plays four bars
  Then the two lanes start together only on bars 1 and 5
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A 2-bar lane in an odd-length chain plays its pages in order on every pass (REQ-a-multi-bar-lane-restarts-with-its-chain, regression)
  Given seq.len 16 at 1/8 in 4/4 (a 2-bar lane) and a seq chain of 3 slots
  When the transport plays 6 bars
  Then bars 4-6 play the same cells as bars 1-3 (0-7, 8-15, 0-7)
  And a seek into bar 4 plays cells 0-7
# pinned by: tests/state/meter.test.ts, tests/audio/transport/sequencer.test.ts

Scenario: A polyrhythmic lane keeps drifting across chain loops (REQ-a-multi-bar-lane-restarts-with-its-chain)
  Given a 12-cell 1/16 lane in 4/4 on a 3-bar chain, or a 9-cell 1/8 lane in 12/8 on a 14-bar chain
  When the chain wraps
  Then the cell index is exactly the absolute `cellIndex` — no re-phase
# pinned by: tests/state/meter.test.ts

Scenario: A triplet lane fires three cells against two ticks (REQ-coarser-skips-ticks-finer-fans-out)
  Given seq.rate is 1/16T
  When the transport plays one bar
  Then 24 cells fire in 16 ticks, each at its own scheduled time
  And no two hits share a `when`
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A slower lane still swings (REQ-swing-is-computed-on-the-lanes-grid, regression)
  Given transport.swing 0.5 and drum.rate 1/8
  When the transport plays a bar
  Then the lane's off-beat cells are delayed on the lane's own grid
  And at the default rate the scheduled times are bit-identical to pre-meter
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A pre-meter song loads as 4/4 (REQ-meter-needs-no-song-file-bump, back-compat)
  Given any v1-v7 SongFile with no meter params
  And a session already dirtied with a 7/8 meter and a shortened lane
  When it is applied
  Then the meter is 4/4 and every lane follows the bar again
# pinned by: tests/state/song.test.ts

Scenario: The meter never moves the format version (REQ-meter-needs-no-song-file-bump)
  Given a song in 7/8 with a 12-cell drum lane
  When it is captured, exported and re-imported
  Then the meter survives, in `params`, with no new top-level key
  And the SongFile version is exactly what it was
# pinned by: tests/state/song.test.ts

Scenario: Loading a preset no longer switches the motion machine off (REQ-motion-joins-the-non-patch-prefixes, regression)
  Given the motion machine is on
  When a preset is loaded
  Then motion.on is untouched
# pinned by: tests/state/preset-session.test.ts

Scenario: 5/4 is reachable at eighth-note resolution (REQ-each-machine-has-a-step-rate)
  Given transport.beats 5, unit 1/4, and every lane at rate 1/8
  Then each lane loops 10 cells and one bar is 20 ticks
# pinned by: tests/state/meter.test.ts

Scenario: A meter is not a sound (REQ-meter-is-two-bus-scalars, edge)
  Given a song in 7/8
  When a preset is loaded
  Then the meter is still 7/8
# pinned by: tests/state/preset-session.test.ts

Scenario: 7/8 feels like 7/8
  Given a groove written in 7/8 with a fill on the last bar
  Then it plays with an even seven, and the fill lands on the bar's own last step
# not automated — meter is a musical claim (ADR-010); see "Tests & verification"
```

## Tests & verification

- Unit: `tests/state/meter.test.ts`, `tests/audio/transport/{clock,arrangement,sequencer,drum-machine}.test.ts`,
  `tests/state/song.test.ts`, `tests/state/preset-session.test.ts` — `npm test`.
  E2E: `e2e/patterns.spec.ts`.
- **By ear** (ADR-010, [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)) is the
  real gate. Render with `npm run bench:audio` against a 4/4 baseline and listen for a
  7/8 groove that limps (an accent or fill still thinking in four), a 3-over-4 lane that
  smears instead of locking, and a 1/8 lane dead straight under swung hats.

## Open questions / future

- **Per-bank or per-slot meter** (4/4 to 7/8 mid-song): the model allows it; the
  arrangement's seek math and the UI do not.
- **A 32-cell grid with pages**, the only route to 5/4 at 1/16. `GRID_CELLS` is the one
  constant it would change (ADR-019).
- **`'1/1'` in `src/utils/tempo.ts`** is a whole note, no longer a bar in 3/4.
  `SYNC_LABELS` is append-only, so a meter-aware `1 BAR` would be appended. Tempo-locked
  LFOs and delays are free-running and never bar-reset, so they are meter-neutral.
