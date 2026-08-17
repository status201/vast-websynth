# Performance (live DJ FX)

```yaml
id: performance
status: implemented
version: 5   # v5: stutter composes with a lane's length + rate (REQ-8)
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
- **REQ-6** (v3) — **Clock-ramp gate**: a public settable predicate
  `clockRampAllowed: () => boolean` (default `() => true`) guards *both* the
  per-frame `clock.setBpm(...)` and the final `clock.setBpm(origBpm)` restore in
  Tape Stop's rAF tick — an ungated restore would stomp an externally-followed
  tempo with the local knob value. The pitch-bend ramp is unaffected. Engine
  wires `perf.clockRampAllowed = () => sync.activeMode !== 'slave'` — the mode
  that is actually RUNNING, not the selected preference — so a slaved
  instance's Tape Stop bends pitch only and never fights the followed clock
  ([midi-clock-sync.md](midi-clock-sync.md) REQ-13).
- **REQ-7** (v4) — **A transport seek re-anchors stutter.** `mapStep` returns
  `anchor + ((rawStep - anchor) mod n)`, and `anchor` is captured from the live
  clock when stutter engages. After a playhead jump
  ([transport-position.md](transport-position.md) REQ-4) that anchor belongs to the
  old position, so the mapping silently clamps the new position back into the old
  window — a backwards jump replays it forever and a forward jump goes nowhere.
  `Performance` subscribes `clock.onSeek` and, **while stutter is engaged**,
  re-anchors to the new `clock.step`; with stutter off there is nothing to do
  (`mapStep` is the identity). Fill / Drop / DJ Filter hold no position state and
  are unaffected; Tape Stop's rAF ramp is a BPM ramp, not a position, so it too is
  untouched.

- **REQ-8** (v5) — **Stutter composes with a lane's length and rate.**
  `stepIndex(step, cells, rateIdx)` still folds the **absolute** step through
  `mapStep` first and only then resolves a cell, so a stutter window is unchanged
  by the meter and a stutter over a 12-cell lane repeats 12-cell material
  ([meter](meter.md) REQ-17). Both extra arguments default to the pre-meter
  values, so an un-metered caller behaves exactly as before.

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
  clockRampAllowed: () => boolean   # v3: default () => true; gates Tape Stop's clock ramp + restore
ctor deps: (ctx, clock, bus, djFilter: BiquadFilterNode)
# v4: subscribes clock.onSeek -> re-anchor the stutter window (REQ-7)
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
ui: momentary buttons are built by the shared `buildLiveFxControls(engine, bus, opts)`
    (src/ui/components/live-fx.ts) — used by both the Song panel (testids
    perf-fill / perf-stutter / perf-drop / perf-tapestop, perf-stutter-size-<n>)
    and the LIVE FX floating window (livefx-* testids; see live-fx-window.md).
    perf-xypad opens the XY Pad floating window — its own feature, see xy-pad.md.
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

Scenario: Tape Stop gated while slaved ramps pitch only (v3)
  Given clockRampAllowed() returns false (slave mode)
  When the user holds then releases Tape Stop
  Then clock.setBpm is never called (per-frame nor the restore)
   And the pitch-bend ramp still runs
# pinned by: tests/audio/transport/performance.test.ts

Scenario: A seek under active stutter re-anchors (v4, REQ-7)
  Given stutter is engaged at anchor step a
  When the playhead is seeked backwards past a
  Then the window re-anchors to the new step instead of replaying [a, a+n)
  And with stutter off a seek changes nothing (mapStep stays the identity)
# pinned by: tests/audio/transport/performance.test.ts
```

## Tests & verification

- `tests/audio/transport/performance.test.ts`, `e2e/song-fx.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- Tape Stop drives `Clock.setBpm` below the UI's 40 bpm floor (the clock clamps at
  20) — keep that headroom if the BPM range changes (see [transport](transport.md)).
