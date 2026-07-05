# Performance (live DJ FX)

```yaml
id: performance
status: implemented
version: 1
owner: core
related:
  - architecture
  - transport
  - song-mode
  - xy-pad
source:
  - src/audio/transport/performance.ts
  - src/state/params.ts                 # fx.djfilter
  - src/audio/engine.ts                 # owns perf + the djFilter node
  - src/ui/panels/song-panel.ts
```

Momentary live "DJ" effects driven from the Song tab: stutter, fill, filter drop,
DJ filter sweep, and tape stop. The per-lane mute/solo **mixer** is specified with
[song-mode](song-mode.md).

## Background / Why

These are performance gestures, not patched params — held buttons that bend the
running transport in real time. They live in one engine-owned `Performance` object
so both step machines can consult the same timeline-warping state each tick, and
so the Song panel can drive momentary controls without reaching into the machines.

## Requirements

- **REQ-1** — **Stutter/beat-repeat**: loop a short slice; `mapStep` is consulted
  by the sequencer + drum machine each tick.
- **REQ-2** — **Fill**: `fillActive` makes the drum machine play a roll.
- **REQ-3** — **Filter Drop**: momentary lowpass dive on the master `djFilter`,
  overriding the manual DJ filter while held.
- **REQ-4** — **DJ Filter**: manual bipolar sweep on the same node (`fx.djfilter`,
  LP ← 0 → HP).
- **REQ-5** — **Tape Stop**: ramp `Clock` BPM down + pitch-bend down via rAF, then
  recover on release.

## Technical design

### Contract / public interface

```yaml
Performance:  # src/audio/transport/performance.ts
  fillActive: boolean
  setStutter(on) / setStutterSize(sixteenths)
  mapStep(rawStep): number          # stutter remap; identity when off
  setFill(on)
  setDrop(on)                       # momentary lowpass dive on djFilter
  setDjFilter(x)                    # manual sweep, -1..1 (LP..HP)
  setTapeStop(on)                   # BPM + pitch ramp via rAF
ctor deps: (ctx, clock, bus, djFilter: BiquadFilterNode)
```

### Data shapes (registry)

```yaml
fx.djfilter: { range: -1..1, default: 0 }    # |x|<0.02 = off; <0 LP, >0 HP
# momentary controls are buttons, not params (not persisted as state)
```

### Layer touchpoints

```yaml
engine: owns this.perf and the djFilter BiquadFilter, inserted preMaster -> djFilter
        -> masterComp -> analyser; fx.djfilter -> perf.setDjFilter(x)
machines: sequencer + drum machine call perf.mapStep() each tick; drum machine
          checks perf.fillActive
ui: src/ui/panels/song-panel.ts momentary buttons:
    perf-fill / perf-stutter / perf-drop / perf-tapestop, perf-stutter-size-<n>
    + perf-xypad (opens the XY Pad floating window — its own feature, see xy-pad.md)
```

## Scenarios (BDD)

```gherkin
Scenario: Stutter loops a short slice
  Given setStutter(true) with size 2 at anchor step a
  Then mapStep folds subsequent steps back into [a, a+2)
# pinned by: tests/audio/transport/performance.test.ts

Scenario: Filter Drop overrides the manual DJ filter while held (edge)
  Given a manual fx.djfilter sweep is active
  When the user holds Filter Drop
  Then the djFilter dives to lowpass until release, then the manual value resumes
# pinned by: tests/audio/transport/performance.test.ts, e2e/song-fx.spec.ts

Scenario: Tape Stop bends BPM and pitch down then recovers
  When the user holds then releases Tape Stop
  Then BPM + pitch ramp down (rAF) and recover on release
# pinned by: e2e/song-fx.spec.ts
```

## Tests & verification

- `tests/audio/transport/performance.test.ts`, `e2e/song-fx.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- Tape Stop drives `Clock.setBpm` below the UI's 40 bpm floor (the clock clamps at
  20) — keep that headroom if the BPM range changes (see [transport](transport.md)).
