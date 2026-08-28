# Performance (live DJ FX)

```yaml
id: performance
status: implemented
version: 7   # v7: REQ-10 — the DJ filter sweeps `detune` with `setTargetAtTime`
             #     only; the unanchored cancel it used to issue restarted every
             #     ramp from the constructed value on Gecko (a crackle)
             # v6: REQ-9 — the DJ filter is a SERIES lowpass->highpass pair, so
             #     crossing centre no longer swaps a live biquad's type (a click)
             # v5: stutter composes with a lane's length + rate (REQ-8)
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

These are performance gestures, not patched params — held buttons that bend the
running transport in real time. They live in one engine-owned `Performance` object
so both step machines can consult the same timeline-warping state each tick, and
so the Song panel can drive momentary controls without reaching into the machines.

## Requirements

- **REQ-1** — **Stutter/beat-repeat**: loop a short slice; `mapStep` is consulted
  by the sequencer + drum machine each tick.
- **REQ-2** — **Fill**: `fillActive` makes the drum machine play a roll.
- **REQ-3** — **Filter Drop**: momentary lowpass dive on the master `djLow`,
  overriding the manual DJ filter while held. The dive glides from wherever the
  filter currently sits (v7 — REQ-10 removed the jump that used to start it).
- **REQ-4** — **DJ Filter**: manual bipolar sweep on the same pair (`fx.djfilter`,
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


- **REQ-9** (v6) — **The DJ filter is a series lowpass → highpass pair, and its
  type is never reassigned.** It used to be one `BiquadFilterNode` whose `.type`
  was assigned `'lowpass'` or `'highpass'` on every write, flipping as the value
  crossed the `|x| < 0.02` dead zone. Swapping a biquad's type swaps its
  coefficients **instantaneously** while its state variables still hold values for
  the old ones — a transient, i.e. a click, on the master bus where every voice
  passes through. Automation makes that pathological rather than rare: a motion
  lane whose anchors straddle centre crossed the boundary six times a bar.

  Two nodes instead, each keeping the type it was constructed with, forever:
  - `djLow` (lowpass) rests **transparent** at `DJ_OPEN_HZ` and sweeps down to
    130 Hz as `x → -1`;
  - `djHigh` (highpass) rests **transparent** at 20 Hz and sweeps up to 4 kHz as
    `x → +1`.

  Each side's frequency and Q curve is unchanged, so the sweep sounds as it did.
  What changes is the middle: crossing centre is now two frequency ramps toward
  transparency, continuous by construction, with nothing to click. The dead zone
  survives as the point where both are transparent. Filter Drop dives `djLow` and
  leaves `djHigh` alone.

  Cost is one extra biquad permanently in the master path — accepted: it is two
  filters' worth of arithmetic on one stereo bus, against a defect that is audible
  on every shipped song that automates the knob
  ([runtime-performance](runtime-performance.md)).

- **REQ-10** (v7) — **The sweep rides `detune`, through `setTargetAtTime` alone.
  The DJ filter path never calls `cancelScheduledValues` and never reads a live
  `.value`.** Both nodes' `frequency` is a fixed reference set once at
  construction (20 kHz on `djLow`, 20 Hz on `djHigh`) and never written again;
  the sweep is `detune`, in cents.

  v6 left a defect behind that only Gecko exposes. `rampSide` cancelled both
  params and re-issued a 40 ms `exponentialRampToValueAtTime` on every write:

  ```ts
  node.frequency.cancelScheduledValues(now);          // event list now EMPTY
  node.frequency.exponentialRampToValueAtTime(hz, now + smooth);
  ```

  The nodes are seeded with `.value =`, which sets the *intrinsic* value rather
  than an automation event, so after the first cancel there is no preceding event
  at all — and a ramp without one starts from "the value of the AudioParam".
  Blink reads that as the automation's computed value; Gecko does not write
  automation results back to the intrinsic value, so **every write restarted the
  ramp from the constructed 20 kHz / 20 Hz** — and since the 40 ms ramp was
  longer than the interval between writes, it was cancelled before it could ever
  arrive.

  Measured directly, rendering `ConstantSource → Gain` through an
  `OfflineAudioContext` so the samples *are* the automation curve, commanding a
  1.0 → 0.2 descent 60 times a second:

  ```
                          sampled every 100 ms
  commanded          [1, 0.92, 0.84, 0.76, 0.68, 0.60, 0.52, 0.44, 0.36, 0.28]
  Blink,  cancel+ramp[1, 0.86, 0.74, 0.64, 0.55, 0.47, 0.40, 0.35, 0.30, 0.26]  lags, but tracks
  Gecko,  cancel+ramp[1, 1,    1,    1,    1,    1,    1,    1,    1,    1   ]  never moves
  both,   setTarget  [1, 0.94, 0.86, 0.78, 0.70, 0.62, 0.54, 0.46, 0.38, 0.30]  identical
  ```

  So on Gecko the filter did not sweep *at all* while it was being written. It
  moved only when the writes paused long enough for one ramp to land — and the
  next write snapped it back to the reference. Irregular gaps (rAF jitter, an
  un-coalesced `pointermove` burst) make that an irregular series of jumps on the
  master bus: the crackle, present whenever the value moved and absent whenever
  it was parked, which is exactly how it was reported. `setTargetAtTime` renders
  the same curve on both engines, to within 2e-5 per sample.

  This is the failure mode [sidechain-ducking](sidechain-ducking.md) already
  records: cancelling without pinning lets a param snap back to the cancelled
  ramp's start, and `cancelAndHoldAtTime` — which would pin it natively — is not
  implemented in Firefox. Every other cancel site in `src/audio/**` anchors with
  `setValueAtTime` first. This one did not.

  Three consequences follow from fixing it with `setTargetAtTime`:

  - **No cancel is needed.** `setTargetAtTime` is a *retarget*: a fresh call
    starts from the value the previous curve has reached, so repeating it at any
    rate is continuous by construction. This is the house style already
    (`rampTo` / `RAMP_SMOOTH`, [architecture](../architecture.md)); the DJ filter
    was the one continuous control that departed from it.
  - **The sweep must ride `detune`, not `frequency`.** `setTargetAtTime`
    approaches its target exponentially in *linear* units. On `frequency` that
    would collapse six of the sweep's seven octaves inside the first time
    constant — trading the crackle for a thump on every large jump (Drop release,
    a step-mode motion anchor). Cents *are* log-frequency, so the same curve the
    `Math.pow` mapping drew is what a linear approach in cents draws. The
    endpoints are unchanged: `1200·log2(130/20000)` ≈ -8800 cents of lowpass,
    `1200·log2(4000/20)` ≈ +9171 cents of highpass.
  - **`Math.max(f.value, 400)` goes** (REQ-3). It forced Filter Drop's dive to
    *start* at ≥400 Hz, which from a knob already parked at 130 Hz was an
    instantaneous jump up — a coefficient step, i.e. exactly the click REQ-9
    exists to abolish. Drop now glides from where the filter is. It also read a
    live `.value`, the same Gecko trap in its other form.

  A side whose target is unchanged is not written at all. `applyDjFilter` drives
  both sides on every call although only one ever moves, so caching the last
  commanded pair halves the master-bus automation churn
  ([runtime-performance](runtime-performance.md)). The cache is invalidated when
  Filter Drop takes or releases the lowpass side.

## Technical design

### Contract / public interface

```yaml
Performance:  # src/audio/transport/performance.ts
  fillActive: boolean
  setStutter(on) / setStutterSize(sixteenths)
  mapStep(rawStep): number          # stutter remap; identity when off
  setFill(on)
  setDrop(on)                       # momentary lowpass dive on djLow (djHigh opens out)
  setDjFilter(x)                    # manual sweep, -1..1 (LP..HP)
  # v7 (REQ-10): both write djLow/djHigh `detune` (cents) via setTargetAtTime only.
  #              `frequency` is a fixed reference, never written after construction.
  setTapeStop(on)                   # BPM + pitch ramp via rAF
  clockRampAllowed: () => boolean   # v3: default () => true; gates Tape Stop's clock ramp + restore
ctor deps: (ctx, clock, bus, djLow: BiquadFilterNode, djHigh: BiquadFilterNode)  # v6: a series pair (REQ-9)
# v4: subscribes clock.onSeek -> re-anchor the stutter window (REQ-7)
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
        sets each node's reference frequency once (20000 / 20 Hz) and never
        again — Performance sweeps `detune` (v7, REQ-10);
        fx.djfilter -> perf.setDjFilter(x)
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

Scenario: Crossing the centre of the DJ filter never swaps a filter type (v6, REQ-9, regression)
  Given the DJ filter is swept from lowpass through centre into highpass
  When each value is applied
  Then djLow and djHigh keep the types they were constructed with
  And only their detune moves, so the crossing carries no discontinuity
# pinned by: tests/audio/transport/performance.test.ts

Scenario: Each side rests transparent while the other works (v6, REQ-9)
  Given a lowpass-side value
  Then djHigh stays at its 0-cent resting detune and only djLow sweeps
# pinned by: tests/audio/transport/performance.test.ts

Scenario: A repeated sweep never cancels automation (v7, REQ-10, regression)
  Given the DJ filter is written many times in quick succession
  When each value is applied
  Then cancelScheduledValues is never called on either side
  And every write is a setTargetAtTime, so each continues from the value now
# pinned by: tests/audio/transport/performance.test.ts, tests/audio/no-unanchored-cancel.test.ts

Scenario: The sweep rides detune, so its curve is logarithmic by construction (v7, REQ-10)
  Given any DJ filter value
  When it is applied
  Then the moving side's detune is retargeted in cents
  And neither node's frequency is ever written
# pinned by: tests/audio/transport/performance.test.ts

Scenario: A side already at its target is not rewritten (v7, REQ-10)
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
