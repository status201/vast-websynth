# Meter & polyrhythm

```yaml
id: meter
status: implemented
version: 1
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
  - onboarding          # REQ-23 there: the meter's help topic + badge
  - audio-export
  - webrtc-sync
  - midi-clock-sync
  - untrusted-input
  - ../decisions/adr-019-the-bar-is-a-tick-count
  - ../decisions/adr-006-no-op-param-defaults
source:
  - src/state/meter.ts                       # the vocabulary (REQ-2)
  - src/state/params.ts                      # the ten scalars (REQ-5/10/14)
  - src/state/limits.ts                      # MAX_STEP (REQ-4)
  - src/state/preset-session.ts              # the `motion.` prefix fix (REQ-13)
  - src/audio/transport/clock.ts             # unwrapped step + swingOffset
  - src/audio/transport/lane-meter.ts        # one lane's length/rate/swing
  - src/audio/transport/arrangement.ts       # the bar line (REQ-6)
  - src/audio/transport/performance.ts       # stepIndex(step, cells, rate) (REQ-17)
  - src/audio/transport/sequencer.ts
  - src/audio/transport/drum-machine.ts      # incl. the meter-relative fill (REQ-9)
  - src/audio/transport/sampler-machine.ts
  - src/audio/transport/motion-machine.ts
  - src/audio/transport/motion-curve.ts      # scalarAt's `cells` (REQ-10)
  - src/audio/transport/sync/sync-types.ts   # the `meter` message (REQ-18)
  - src/audio/transport/sync/sync-master.ts
  - src/audio/transport/sync/sync-slave.ts
  - src/audio/transport/sync/sync-controller.ts
  - src/audio/webrtc-sync-transport.ts
  - src/audio/recorder/recorder-controller.ts  # bar-exact capture (REQ-7)
  - src/audio/recorder/bank-render.ts
  - src/audio/engine.ts                      # resolves the pair, pushes barTicks
  - src/ui/lane-grid.ts                      # the UI's single grid resolver
  - src/ui/components/meter-picker.ts        # the header control (REQ-5)
  - src/ui/components/playhead-ruler.ts      # REQ-8
  - src/ui/panels/step-panel-scaffold.ts     # the LEN/RATE pair
  - src/ui/studio-api.ts                     # `barTicks` for the UI
  - src/ui/onboarding/help-content.ts        # the `meter` help topic
  - src/ui/onboarding/info-badges.ts         # its anchor
  - src/state/authoring-guide.ts             # the METER block agents read
```

The cross-cutting facility that makes the instrument play in something other than
4/4 — and lets one machine fight the bar on purpose.

## Background / Why

`SEQ_LENGTH = 16` was one constant doing three unrelated jobs: how many cells a
pattern holds, how long a bar is, and how many columns the UI draws. Every bar
line in the app was written `step % SEQ_LENGTH`, so 3/4 and 7/8 were not
*declined* — they were never expressible. Splitting the three jobs apart is most
of this feature; the rest is two controls per machine.

The model is the one every groovebox uses, so a player already knows it: a bar is
a number of ticks, and each machine loops over `length` cells at `rate` ticks per
cell. A lane matching the bar is in meter; a lane that doesn't phases against it
(polymeter); a lane on a triplet rate fights it inside the bar (polyrhythm).

[ADR-019](../decisions/adr-019-the-bar-is-a-tick-count.md) records why meter is a
tick count rather than a `{num, den}`, why the grid stays 16 cells (and what that
costs), and why the clock is left alone.

## Vocabulary

```
tick          one 16th note — the clock's unit, unchanged
ticksPerBeat  4 (beat unit 1/4)  |  2 (beat unit 1/8)
barTicks      beats × ticksPerBeat          7/8 → 7 × 2 = 14
laneTicks     len cells × rate ticks/cell   len 10 × 1/8 → 20 ticks = 5/4
```

| Signature | beats | unit | barTicks | at 1/16 | at 1/8 |
| --- | --- | --- | --- | --- | --- |
| 4/4 | 4 | 1/4 | 16 | 16 | 8 |
| 3/4 | 3 | 1/4 | 12 | 12 | 6 |
| 5/4 | 5 | 1/4 | 20 | — | 10 |
| 7/4 | 7 | 1/4 | 28 | — | 14 |
| 6/8 | 6 | 1/8 | 12 | 12 | 6 |
| 7/8 | 7 | 1/8 | 14 | 14 | 7 |
| 5/8 | 5 | 1/8 | 10 | 10 | 5 |
| 9/8 | 9 | 1/8 | 18 | — | 9 |
| 12/8 | 12 | 1/8 | 24 | — | 12 |

A bar longer than `GRID_CELLS` ticks needs a coarser lane rate to fit one grid;
that is the trade [ADR-019](../decisions/adr-019-the-bar-is-a-tick-count.md)
accepts in exchange for leaving the pattern shape, the schemas and every demo
alone.

## Requirements

### Foundation

- **REQ-1** — **The clock stays a plain 16th pulse.** Meter adds no tick rate, no
  bar callback and no state to `Clock` ([transport](transport.md) REQ-1). Every
  bar and lane notion is derived downstream from the monotonic `step`.

- **REQ-2** — **`src/state/meter.ts` is the only place the three jobs are named.**
  `GRID_CELLS` (cells per pattern — what `SEQ_LENGTH` now aliases), `barTicks`
  (bar length) and `LANE_RATES` (ticks per cell) are separate exports, so a call
  site has to say which one it means. The module is pure and dependency-free,
  like `song-version.ts`, so the MCP Node bundle can read it.

- **REQ-3** — **A lane's cell index is a pure function of `clock.step`.** No lane
  keeps a phase accumulator. This is what makes `seek`, Song-Position join, WiFi
  sync and dropout recovery ([transport](transport.md) REQ-6/REQ-9) work for a
  12- or 14-tick lane with no repair step — the defect `Arrangement.seekTo`
  ([arrangement](arrangement.md) REQ-7) exists to fix for chain slots.

- **REQ-4** — **The step counter must not wrap**, because a wrap that is not a
  multiple of every lane length jumps its phase. See
  [transport](transport.md) REQ-10, which owns the change; this REQ records
  *why* meter needed it.

### Global meter

- **REQ-5** — **Meter is two `ParamBus` scalars**, `transport.beats` (2..12) and
  `transport.beatUnit` (discrete `1/4` | `1/8`), defaulting to 4 and `1/4` — i.e.
  4/4, a no-op ([ADR-006](../decisions/adr-006-no-op-param-defaults.md)). They are
  song state, not patch state: `NON_PATCH_PREFIXES` already excludes
  `transport.`, so loading a preset can never change the meter. The global meter
  setting has no label ('Meter') since it's self-obvious.

- **REQ-6** — **`barTicks` is the arrangement's bar line.** Chain lanes advance on
  `step % barTicks === 0` and seek to `floor(step / barTicks)`
  ([arrangement](arrangement.md) REQ-2/REQ-4). One bar grid is still shared by all
  four chain lanes — per-lane *bar counts* were already independent, per-lane bar
  *lengths* remain out of scope.

- **REQ-7** — **Bar-exact capture follows `barTicks`.** Song export's bar count
  and tail bar ([audio-export](audio-export.md)) and the sampler bank render
  ([render-to-sampler](render-to-sampler.md)) all measure a bar as
  `barTicks × sixteenthDuration()`, so a 7/8 song exports 7/8 bars.

- **REQ-8** — **Beat accents and the ruler derive from the meter**, never from
  `% 4`. The red accent column, the ruler's numbered beats and its tooltip all
  come from `ticksPerBeat` (scaled by the lane's rate), so 7/8 reads as seven
  eighths and not as four-plus-a-bit ([transport-position](transport-position.md)
  REQ-9).

- **REQ-9** — **The drum fill is expressed relative to its lane**, not to 16.
  `DrumMachine.playFill` hard-coded `s % 8`, `s >= 12` and `s === 15`
  ([performance](performance.md)); the same shape is re-derived from the lane's
  length so a fill in 7/8 lands on the bar's own last step.

### Per-lane length — polymeter

- **REQ-10** — **Each machine has a loop length**: `seq.len`, `drum.len`,
  `sampler.len`, `motion.len`, `0..GRID_CELLS`, default **0 = follow the bar**
  (`clamp(barTicks / rate, 1, GRID_CELLS)`). So picking 7/8 puts all four
  machines in 7/8 with no further setup, and the default is a no-op.

- **REQ-11** — **Cells beyond the length are hidden, never destroyed.** The grid's
  column count follows the lane (`--steps`), so a 3/4 song draws twelve columns
  rather than sixteen with four dead ones — a dead column is exactly the control
  that does nothing which
  [ADR-014](../decisions/adr-014-dont-make-me-think.md) rules out, and letting the
  extra cells stay visible would wrap them onto a second row.

  `hidden`, not removed: the DOM, the testids, the selection cursor and the stored
  steps all survive, so shortening a lane and lengthening it again returns every
  step untouched, and a meter change is a class flip rather than a DOM rebuild.
  The position ruler above the grid hides its ticks by the same rule and from the
  same resolver, so the two cannot disagree.

- **REQ-12** — **Pattern arrays stay `GRID_CELLS` long, always.** Only the played
  *window* shrinks. This is what keeps `song-validate.ts`'s exact-length checks,
  the published JSON schemas' `minItems/maxItems: 16`, the authoring dialect's
  rest-padding and all shipped demos untouched.

- **REQ-13** — **`motion.` joins `NON_PATCH_PREFIXES`.** `motion.on`, `motion.mute`
  and `motion.slide` were being captured into presets and reapplied on load, so
  auditioning a sound switched the motion machine off — the exact defect the
  predicate exists to prevent ([presets](presets.md)). `motion.len`/`motion.rate`
  would inherit it, so the prefix is corrected here rather than worked around.

### Per-lane rate — polyrhythm

- **REQ-14** — **Each machine has a step rate**: `seq.rate`, `drum.rate`,
  `sampler.rate`, `motion.rate`, a discrete index into `LANE_RATES` — *ticks per
  cell* — defaulting to `1/16` (one tick), a no-op. The values are derived from
  the straight/dotted/triplet table in `src/utils/tempo.ts`
  ([tempo-lock](tempo-lock.md)), pinned to it by a drift test so the two
  spellings of a musical division can never disagree.

- **REQ-15** — **Coarser than a 16th skips ticks; finer fans out inside one.**
  A rate of 2 ticks/cell fires on every second tick; a rate of ⅔ schedules that
  tick's sub-hits at absolute `when` offsets. Both are exactly what
  [arpeggiator](arpeggiator.md) REQ-6 already does, so the clock is untouched and
  a triplet lane is as sample-accurate as a straight one.

- **REQ-16** — **Swing is computed on the lane's own grid.** The clock delays odd
  *ticks* ([transport](transport.md) REQ-3), so a lane at 2 ticks/cell fires only
  on even ticks and would play dead straight under swung hats. A lane whose rate
  is not 1 subtracts the clock's offset for its tick and adds the offset its own
  alternating cells imply. At the default rate this is arithmetically nil.

- **REQ-17** — **Stutter composes with length and rate.** `Performance.mapStep`
  keeps folding the *absolute* step; only the modulo that follows it becomes
  lane-aware, so a stutter over a 12-cell lane repeats 12-cell material
  ([performance](performance.md)). Motion still reads the raw step — automation
  must not follow a stutter remap.

### Sync & persistence

- **REQ-18** — **Meter travels on the WiFi wire, not the MIDI one.** WebRTC sync
  gains a `meter` message so peers agree on bar boundaries
  ([webrtc-sync](webrtc-sync.md)), bounded like every other payload
  ([untrusted-input](untrusted-input.md)). MIDI real-time has no meter message at
  all: Song Position stays correct (it counts 16ths, which is meter-neutral) but
  two peers in different meters will number bars differently — a stated limit in
  [midi-clock-sync](midi-clock-sync.md), not a silent one.

- **REQ-19** — **No `SongFile` version bump.** All ten scalars ride in the open
  `params` map, so there is no new top-level key, no schema change and no
  migration ([ADR-007](../decisions/adr-007-songfile-additive-versioning.md)).
  Every default is a no-op, so an **absent** key means 4/4 and a pre-meter file
  loads and sounds exactly as before.

  Note what this does *not* claim: `capture` writes the whole param snapshot,
  defaults included (that is how the format has always worked — `fx.dist.on: 0`
  is present in every file), so **re-saving** an old song adds these ten keys at
  their defaults. That is a larger file, not a different song. The committed
  demos are unaffected because they are normalized as stored, never re-captured
  (`npm run check:demos` is the guard).

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
cellIndex(step, cells, rateIdx): number        # REQ-3: pure in `step`
cellsInTick(step, rateIdx): { from, count }    # which cells BEGIN in this tick
cellOffsetTicks(cell, rateIdx, step): number   # 0 .. <1, for sub-tick scheduling

Performance:   # src/audio/transport/performance.ts
  stepIndex(step, cells, rateIdx): number      # was stepIndex(step)

Clock:         # src/audio/transport/clock.ts
  swingOffset(step): number          # REQ-16 — the delay applied to this tick
  get step: number                   # REQ-4 — unbounded, no longer masked
```

**Rates are exact rationals, not floats.** `cellsInTick` decides membership by
comparing `cell × num/den` against integer tick bounds; as a float, `2 / (2/3)`
is `3.0000000000000004` and a triplet cell lands one tick late. The table mirrors
`utils/tempo.ts`'s straight/dotted/triplet divisions (`beats × 4 === num / den`)
and is **pinned to it by a drift test** rather than imported, so this module stays
arithmetic-only for the MCP bundle.

### Gesture inventory — METER, and a machine's GRID pair (ADR-014)

Three new controls, all dropdowns, so every gesture each can receive is decided
here including the ones left unused.

| Gesture | METER (header) | GRID `LEN` / `RATE` (machine header) | Precedent |
| --- | --- | --- | --- |
| tap / click | open the list; pick a signature | open the list; pick a length or a rate | every `Dropdown` in the app |
| pick an option | writes **both** meter params at once | writes that one param | — |
| hover | — | the cluster's `title` reads the pair out in full (`14 steps of 1/16 = one 7/8 bar`) | the FX-group and bank-bar tooltips |
| wheel over the control | — a wheel here would change the bar of a *playing* song by a flick of the finger, and there is no undo for a transport-wide setting. The chain chip's wheel ([arrangement](arrangement.md)) is safe because a slot transpose is per bar and reversible | — | — |
| double-click | — nothing to reset to that the list does not already offer (`4/4`, `BAR`, `1/16` are all one click away) | — | — |
| long-press / right-click | — the control has one job | — | — |
| keyboard | the shared `Dropdown`'s own arrow/Enter/Escape handling, unchanged | same | [dropdown](dropdown.md) |

The **hint** beside the pair is not interactive: it renders only while the lane
is off the bar, and says so in words (REQ-11's reasoning applied to text — a
label that is always present stops being read).

### Data shapes (registry)

```yaml
transport.beats:    { range: 2..12, default: 4, step: 1 }
transport.beatUnit: { discrete, labels: ['1/4', '1/8'], default: 0 }
seq.len | drum.len | sampler.len | motion.len:
                    { range: 0..16, default: 0, step: 1 }   # 0 = follow the bar
seq.rate | drum.rate | sampler.rate | motion.rate:
                    { discrete, labels: LANE_RATE_LABELS, default: index of '1/16' }
# src/state/limits.ts
MAX_STEP = 2 ** 31   # the transport position bound that replaced the 16-bit mask
```

### Layer touchpoints & ordering

```yaml
engine (subscribeParams):
  transport.beats / transport.beatUnit -> barTicks -> arrangement, performance,
    motion machine, recorder controller (one resolved number, pushed on change)
  <m>.len / <m>.rate -> that machine only
machines: seq / drum / sampler read perf.stepIndex(step, cells, rateIdx);
  motion derives the same index raw (no stutter remap)
construction order is unchanged: Arrangement before the machines (arrangement.md REQ-5)
ui: meter picker in transport-controls.ts; LEN/RATE per machine in
  panels/step-panel-scaffold.ts (all four grids already route through it)
css: the three `repeat(16, …)` grids become `repeat(var(--steps, 16), …)`
```

### Persistence

Ten `ParamBus` scalars in `SongFile.params`; nothing else. Deliberately **not**
persisted: the resolved `barTicks` and lane cell counts (derived every read), and
anything per-bank — meter is global to the song (REQ-6).

## Scenarios (BDD)

```gherkin
Scenario: The transport counter no longer wraps (REQ-4)
  Given a clock started at a very large step
  When it ticks
  Then the step keeps increasing and is never folded back to 0
  And seek clamps an out-of-range position instead of masking it
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A lane index is unchanged by how the playhead got there (REQ-3)
  Given a lane of 12 cells
  When the transport reaches step 40 by playing, and again by seeking
  Then the cell index is the same both times
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: 7/8 advances the chain every 14 ticks (REQ-6)
  Given transport.beats 7 and beat unit 1/8
  When the transport plays two bars
  Then the chain advances at step 14 and step 28, not at 16 and 32
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: Picking a meter moves every machine at once (REQ-10)
  Given all four lanes at the default length
  When the meter is set to 3/4
  Then each machine loops over 12 cells and cells 13-16 fall dark
# pinned by: tests/audio/transport/sequencer.test.ts, e2e/patterns.spec.ts

Scenario: A shortened lane keeps the steps it is not playing (REQ-11)
  Given a full 16-step drum pattern
  When drum.len is set to 12 and back to 16
  Then every step is exactly as it was
# pinned by: tests/state/patterns.test.ts

Scenario: A 12-cell lane phases against a 16-tick bar and re-aligns (REQ-10)
  Given drum.len 16 and seq.len 12 in 4/4
  When the transport plays four bars
  Then the two lanes start together only on bars 1 and 5
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A triplet lane fires three cells against two ticks (REQ-15)
  Given seq.rate is 1/16T
  When the transport plays one bar
  Then 24 cells fire in 16 ticks, each at its own scheduled time
  And no two hits share a `when`
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A slower lane still swings (REQ-16, regression)
  Given transport.swing 0.5 and drum.rate 1/8
  When the transport plays a bar
  Then the lane's off-beat cells are delayed on the lane's own grid
  And at the default rate the scheduled times are bit-identical to pre-meter
# pinned by: tests/audio/transport/drum-machine.test.ts

Scenario: A pre-meter song loads as 4/4 (REQ-19, back-compat)
  Given any v1-v7 SongFile with no meter params
  And a session already dirtied with a 7/8 meter and a shortened lane
  When it is applied
  Then the meter is 4/4 and every lane follows the bar again
# pinned by: tests/state/song.test.ts

Scenario: The meter never moves the format version (REQ-19)
  Given a song in 7/8 with a 12-cell drum lane
  When it is captured, exported and re-imported
  Then the meter survives, in `params`, with no new top-level key
  And the SongFile version is exactly what it was
# pinned by: tests/state/song.test.ts

Scenario: Loading a preset no longer switches the motion machine off (REQ-13, regression)
  Given the motion machine is on
  When a preset is loaded
  Then motion.on is untouched
# pinned by: tests/state/preset-session.test.ts

Scenario: 5/4 is reachable at eighth-note resolution (REQ-14)
  Given transport.beats 5, unit 1/4, and every lane at rate 1/8
  Then each lane loops 10 cells and one bar is 20 ticks
# pinned by: tests/state/meter.test.ts

Scenario: A meter is not a sound (REQ-5, edge)
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

- Unit: `tests/state/meter.test.ts` (the vocabulary + every conversion),
  `tests/audio/transport/clock.test.ts` (REQ-4),
  `tests/audio/transport/arrangement.test.ts` (REQ-6),
  `tests/audio/transport/sequencer.test.ts` (REQ-3/10/15),
  `tests/audio/transport/drum-machine.test.ts` (REQ-9/16),
  `tests/state/song.test.ts` + `tests/state/preset.test.ts` (REQ-13/19) — `npm test`
- E2E: `e2e/patterns.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- **By ear** ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md),
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)) — the real gate.
  Render with `npm run bench:audio` against a 4/4 baseline and listen for the
  three things no suite can catch: a 7/8 groove that limps because an accent or a
  fill still thinks in four; a 3-over-4 lane that smears instead of locking; and
  a 1/8 lane that sits dead straight under swung hats (REQ-16).

## Open questions / future

- **Per-bank or per-chain-slot meter** — a song that moves from 4/4 to 7/8 mid
  arrangement. The model supports it; the arrangement's seek math and the UI do
  not.
- **A 32-cell grid with pages** — the only route to 5/4 at 1/16 resolution.
  `GRID_CELLS` is the single constant it would change; everything else here
  composes on top ([ADR-019](../decisions/adr-019-the-bar-is-a-tick-count.md)).
- **`'1/1' = 4 beats` in `src/utils/tempo.ts`** still means a whole note, which is
  correct nomenclature but is no longer *a bar* in 3/4. `SYNC_LABELS` is
  append-only (the index is stored in every preset, song and share link), so a
  meter-aware `1 BAR` division would have to be appended, never substituted.
  Tempo-locked LFOs and delays are free-running and never bar-phase-reset, so
  they behave in 7/8 exactly as they do today.
