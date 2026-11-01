# Performance (live DJ FX)

```yaml
id: performance
status: implemented
version: 9
owner: core
related:
  - architecture
  - transport
  - transport-position
  - song-mode
  - xy-pad
  - live-fx-window
  - midi-clock-sync
source:
  - src/audio/transport/performance.ts
  - src/state/params.ts                 # fx.djfilter
  - src/audio/engine.ts                 # owns perf + the djLow/djHigh nodes
  - src/ui/panels/song-panel.ts
```

Momentary live "DJ" effects driven from the Song tab: stutter, fill, filter drop,
DJ filter sweep, and tape stop. The per-lane mute/solo **mixer** is specified with
[song-mode](song-mode.md).

## Background / Why

These are performance gestures, not patched params. They are held buttons that
bend the running transport in real time. They live in one engine-owned
`Performance` object so both step machines consult the same timeline-warping
state each tick. That also lets the Song panel drive momentary controls without
reaching into the machines.

## Requirements

- **REQ-stutter-loops-a-short-slice** — **Stutter/beat-repeat**: loop a short
  slice; `mapStep` is consulted by the sequencer + drum machine each tick.
- **REQ-fill-makes-the-drums-roll** — **Fill**: `fillActive` makes the drum
  machine play a roll.
- **REQ-filter-drop-is-momentary** — **Filter Drop**: a momentary lowpass dive on
  `djLow`, overriding the manual DJ filter while held. It glides from wherever
  the filter sits, with no jump to a starting frequency.
- **REQ-dj-filter-is-a-manual-sweep** — **DJ Filter**: manual bipolar sweep on
  the same pair (`fx.djfilter`, LP ← 0 → HP).
- **REQ-tape-stop-ramps-bpm-and-pitch** — **Tape Stop**: ramp `Clock` BPM down +
  pitch-bend down, then recover on release. Each ramp starts from the tempo the
  clock is actually running at (and the live `master.pitchBend`), so a release
  mid-dive or a press mid-recovery continues from where it got to. It ends at the
  20 BPM floor on press and at the `transport.bpm` knob on release. The ramp runs
  on a `TickTimer` (the clock's worker timer, ~60 Hz, spawned on first use), not
  rAF, so it finishes in a hidden tab. It is timed by `performance.now()`, so a
  late wakeup costs smoothness, never duration.
- **REQ-a-clock-ramp-gate-predicate** (v3) — **Clock-ramp gate**: a settable
  predicate `clockRampAllowed: () => boolean` (default `() => true`) guards *both*
  the per-frame `clock.setBpm(...)` and the final restore. An ungated restore
  would stomp a followed tempo. The pitch ramp is unaffected. Engine wires
  `perf.clockRampAllowed = () => sync.activeMode !== 'slave'`, using the *running*
  mode, not the selected preference
  ([midi-clock-sync.md](midi-clock-sync.md) REQ-tape-stop-is-gated-while-slaved).
- **REQ-a-seek-re-anchors-stutter** (v4) — **A seek re-anchors stutter.**
  `mapStep` returns `anchor + ((rawStep - anchor) mod n)`, with `anchor` captured
  when stutter engages. `Performance` subscribes `clock.onSeek` and, while stutter
  is engaged, re-anchors to the new `clock.step`
  ([transport-position.md](transport-position.md) REQ-every-relative-consumer-reacts-to-a-seek).
  Otherwise the old anchor would clamp the new position back into the old window.
  Fill / Drop / DJ Filter / Tape Stop hold no position and are unaffected.
- **REQ-stutter-composes-with-lane-length** (v5) — `stepIndex(step, cells, rateIdx)`
  folds the **absolute** step through `mapStep` before resolving a cell. So a
  stutter window is independent of the meter, and over a 12-cell lane it repeats
  12-cell material ([meter](meter.md) REQ-stutter-composes-with-length-and-rate).
- **REQ-the-dj-filter-is-a-series-pair** (v6) — **The DJ filter is a series
  lowpass → highpass pair, and neither node's `.type` is ever reassigned.** A
  biquad type swap changes coefficients instantly while the state holds the old
  ones, which clicks on the master bus. A motion lane straddling centre would do
  that several times a bar. `djLow` rests transparent and sweeps down to 130 Hz
  as `x → -1`. `djHigh` rests at 20 Hz and sweeps up to 4 kHz as `x → +1`. Centre
  is where both are transparent (`|x| < 0.02`). Filter Drop dives `djLow` only.
  The extra biquad in the master path is an accepted cost.
- **REQ-the-dj-sweep-rides-detune** (v7) — **The sweep rides `detune`, through
  `setTargetAtTime` alone. The DJ filter path never calls
  `cancelScheduledValues` and never reads a live `.value`** (ADR-027, which this
  path's Gecko crackle taught). Each node's `frequency` is a fixed reference set
  once at construction (20 kHz / 20 Hz). The sweep is cents on `detune`:
  `1200·log2(130/20000)` ≈ −8800 on the lowpass side and `1200·log2(4000/20)` ≈
  +9171 on the highpass side. A side whose target is unchanged is not rewritten.
  The last commanded pair is cached as four plain numbers, not a record, because
  a motion lane on `fx.djfilter` drives this path at frame rate
  (runtime-performance.md REQ-no-allocation-in-a-hot-loop).

## Technical design

### Contract / public interface

```yaml
Performance:  # src/audio/transport/performance.ts
  fillActive: boolean
  setStutter(on) / setStutterSize(sixteenths)
  mapStep(rawStep): number          # stutter remap; identity when off
  setFill(on)
  setDrop(on)                       # momentary lowpass dive on djLow (djHigh opens out)
  setDjFilter(x)                    # manual sweep, -1..1 (LP..HP); detune via setTargetAtTime only
  setTapeStop(on)                   # BPM + pitch ramp on a TickTimer
  clockRampAllowed: () => boolean   # default () => true; gates Tape Stop's clock ramp + restore
ctor deps: (ctx, clock, bus, djLow: BiquadFilterNode, djHigh: BiquadFilterNode)
# subscribes clock.onSeek -> re-anchor the stutter window
```

### Data shapes (registry)

```yaml
fx.djfilter: { range: -1..1, default: 0 }    # |x|<0.02 = off; <0 LP, >0 HP
# momentary controls are buttons, not params (not persisted as state)
```

### Layer touchpoints

```yaml
engine: owns this.perf and the djLow/djHigh BiquadFilters, inserted
        preMaster -> djLow -> djHigh -> masterComp -> analyser;
        fx.djfilter -> perf.setDjFilter(x)
machines: sequencer + drum machine call perf.mapStep() each tick; drum machine
          checks perf.fillActive
ui: buildLiveFxControls(engine, bus, opts) (src/ui/components/live-fx.ts) builds the
    momentary buttons for both the Song panel (perf-* testids) and the LIVE FX window
    (livefx-*; live-fx-window.md). perf-xypad opens the XY Pad window (xy-pad.md).
```

## Scenarios (BDD)

```gherkin
Scenario: Stutter loops a short slice
  Given setStutter(true) with size 2 at anchor step a
  Then mapStep folds subsequent steps back into [a, a+2)
# pinned by: tests/audio/transport/performance.test.ts

Scenario: Crossing the centre of the DJ filter never swaps a filter type (REQ-the-dj-filter-is-a-series-pair, regression)
  Given the DJ filter is swept from lowpass through centre into highpass
  When each value is applied
  Then djLow and djHigh keep the types they were constructed with
  And only their detune moves, so the crossing carries no discontinuity
# pinned by: tests/audio/transport/performance.test.ts

Scenario: Each side rests transparent while the other works (REQ-the-dj-filter-is-a-series-pair)
  Given a lowpass-side value
  Then djHigh stays at its 0-cent resting detune and only djLow sweeps
# pinned by: tests/audio/transport/performance.test.ts

Scenario: A repeated sweep never cancels automation (REQ-the-dj-sweep-rides-detune, regression)
  Given the DJ filter is written many times in quick succession
  When each value is applied
  Then cancelScheduledValues is never called on either side
  And every write is a setTargetAtTime, so each continues from the value now
# pinned by: tests/audio/transport/performance.test.ts, tests/audio/no-unanchored-cancel.test.ts

Scenario: The sweep rides detune, so its curve is logarithmic by construction (REQ-the-dj-sweep-rides-detune)
  Given any DJ filter value
  When it is applied
  Then the moving side's detune is retargeted in cents
  And neither node's frequency is ever written
# pinned by: tests/audio/transport/performance.test.ts

Scenario: A side already at its target is not rewritten (REQ-the-dj-sweep-rides-detune)
  Given a lowpass-side sweep, so the highpass side rests
  When many values are applied
  Then djHigh is written once, not once per value
# pinned by: tests/audio/transport/performance.test.ts

Scenario: Filter Drop overrides the manual DJ filter while held (edge)
  Given a manual fx.djfilter sweep is active
  When the user holds Filter Drop
  Then djLow dives and djHigh opens back out until release, then the manual value resumes
# pinned by: tests/audio/transport/performance.test.ts, e2e/song-fx.spec.ts

Scenario: Tape Stop bends BPM and pitch down then recovers
  When the user holds then releases Tape Stop
  Then BPM + pitch ramp down and recover on release
# pinned by: e2e/song-fx.spec.ts

Scenario: Tape Stop finishes in a hidden tab (REQ-tape-stop-ramps-bpm-and-pitch, regression)
  Given the document is hidden, so rAF never fires
  When Tape Stop is pressed and released
  Then both ramps still run to their ends — the tempo back on the knob, the bend at 0
# pinned by: tests/audio/transport/performance.test.ts

Scenario: Releasing Tape Stop early recovers from where it got to (REQ-tape-stop-ramps-bpm-and-pitch, regression)
  Given Tape Stop has been held long enough to slow 120 BPM to about 110
  When the user releases it
  Then the recovery starts at about 110 BPM and rises to 120, never dipping first
   And pressing again mid-recovery dives from wherever the recovery had reached
# pinned by: tests/audio/transport/performance.test.ts

Scenario: Tape Stop gated while slaved ramps pitch only (REQ-a-clock-ramp-gate-predicate)
  Given clockRampAllowed() returns false (slave mode)
  When the user holds then releases Tape Stop
  Then clock.setBpm is never called (per-frame nor the restore)
   And the pitch-bend ramp still runs
# pinned by: tests/audio/transport/performance.test.ts

Scenario: A seek under active stutter re-anchors (REQ-a-seek-re-anchors-stutter)
  Given stutter is engaged at anchor step a
  When the playhead is seeked backwards past a
  Then the window re-anchors to the new step instead of replaying [a, a+n)
  And with stutter off a seek changes nothing (mapStep stays the identity)
# pinned by: tests/audio/transport/performance.test.ts
```

## Tests & verification

- `tests/audio/transport/performance.test.ts`, `e2e/song-fx.spec.ts` — `npm test` / `npm run e2e`.

## Open questions / future

- Tape Stop drives `Clock.setBpm` below the UI's 40 bpm floor (the clock clamps at
  20). Keep that headroom if the BPM range changes ([transport](transport.md)).
