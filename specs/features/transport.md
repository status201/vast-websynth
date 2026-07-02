# Transport clock

```yaml
id: transport
status: implemented
version: 2
owner: core
related:
  - architecture
  - arpeggiator
  - sequencer
  - arrangement
  - performance-mode
source:
  - src/audio/transport/clock.ts
  - src/audio/transport/tick-timer.ts
  - src/audio/transport/clock-timer-worker.ts
  - src/audio/transport/tick-source.ts
  - src/state/params.ts
  - src/audio/engine.ts
```

The look-ahead clock that drives every timed module (arp, sequencer, drum machine,
sampler, arrangement, performance, recorder).

## Background / Why

Timers in the browser are jittery, but `AudioParam` scheduling is sample-accurate.
The clock uses the classic **"two clocks"** pattern (Chris Wilson, 2013): a timer
wakes us every ~25 ms to *enqueue* upcoming ticks, but each tick carries the
**absolute AudioContext time** it should sound, ~100 ms ahead, so consumers
schedule with `setValueAtTime` etc. and stay tight regardless of timer jitter.

The wakeup timer runs in a **Worker** (v2): a main-thread `setTimeout` is
throttled to ≥1 s in background tabs (transport stalls) and is delayed by any
main-thread jank — on mobile, a wake slipping past the look-ahead horizon means
events get clamped to `currentTime` downstream (`Math.max(when, now)`) and hits
bunch up. Worker timers are exempt from background-tab throttling and keep
firing through main-thread jank. Only the *wakeup* moves off-thread; the
scheduling logic (drain loop, swing, step math) stays on the main thread,
untouched.

## Requirements

- **REQ-1** — Subscribers get `(stepIndex, audioTime)` per 16th-note tick,
  scheduled `scheduleAheadS` ahead (default `SCHEDULE_AHEAD_S`).
- **REQ-2** — `onStart` fires before the first tick; `onStop` on stop. Order
  matters: the [arrangement](arrangement.md) subscribes first.
- **REQ-3** — BPM and swing are live-settable; swing delays off-beat 16ths.
- **REQ-4** — The wakeup timer runs off the main thread (Worker `setInterval`)
  wherever `Worker` is available, so the transport survives main-thread jank
  and background-tab timer throttling. A main-thread `setTimeout` loop is the
  fallback (and the injectable test double). A wakeup that arrives after
  `stop()` must not emit ticks.

## Technical design

### Contract / public interface

```yaml
Clock:   # src/audio/transport/clock.ts (implements TickSubscriber)
  new Clock(ctx, opts?: { timer?: TickTimer, scheduleAheadS?: number })
  get playing: boolean
  get step: number
  setBpm(b)            # clamped 20..400 internally
  setSwing(s)          # 0 (straight) .. 1
  start() / stop()
  onTick(fn) / onStart(fn) / onStop(fn) -> unsubscribe
constants: LOOKAHEAD_MS = 25, SCHEDULE_AHEAD_S = 0.1 (default; perf tier may widen it)
TickListener: (step, when) => void        # tick-source.ts
TickTimer:   # src/audio/transport/tick-timer.ts — the wakeup source
  start(cb, intervalMs) / stop()
  WorkerTimer   # setInterval in a Worker (clock-timer-worker.ts, Vite `new URL` bundling)
  TimeoutTimer  # main-thread setTimeout loop — fallback + test double
  defaultTickTimer() -> WorkerTimer if `Worker` exists, else TimeoutTimer
```

The worker protocol is `postMessage({cmd:'start', ms} | {cmd:'stop'})` in,
empty wakeup messages out. One persistent worker per `WorkerTimer` (lazy on
first `start()`), message-driven start/stop — no per-play worker spawn. The
`Clock` guards its drain with `playing`, so a wakeup landing after `stop()`
(message in flight) emits nothing (REQ-4).

### Data shapes (registry)

```yaml
transport.bpm:   { range: 40..240, default: 120, step: 1, format: bpm }
transport.swing: { range: 0..1, default: 0 }
```

### Layer touchpoints & ordering

```yaml
engine (subscribeParams): transport.bpm -> clock.setBpm; transport.swing -> clock.setSwing
construction order (engine): new Arrangement(...) BEFORE the machines, so on each
  tick the play banks are settled before the machines read them (see arrangement.md)
UI: header transport-play button toggles clock.start()/stop()
```

Note the registry clamps BPM to `40..240` for the UI knob, while `Clock.setBpm`
clamps to `20..400` — Tape Stop ([performance](performance.md)) ramps BPM below
the UI floor.

## Scenarios (BDD)

```gherkin
Scenario: Ticks carry absolute audio time ahead of now
  Given the clock is started
  When a tick fires for step n
  Then its `when` is in the future by up to SCHEDULE_AHEAD_S
# pinned by: tests/audio/transport/clock.test.ts

Scenario: Swing delays the off-beat 16ths (edge)
  Given setSwing(0.5)
  Then even steps keep their time and odd steps are pushed later
# pinned by: tests/audio/transport/clock.test.ts

Scenario: No ticks after stop, even from an in-flight wakeup (edge)
  Given the clock is started with an injected timer
  When the clock is stopped and the timer fires once more
  Then no tick is emitted and the timer has been told to stop
# pinned by: tests/audio/transport/tick-timer.test.ts

Scenario: Transport survives a backgrounded tab (device)
  Given the transport is playing on a phone
  When the tab is backgrounded for 30s and foregrounded again
  Then the grid held (worker timers are exempt from tab timer throttling)
# verified manually on device; jsdom cannot pin this
```

## Tests & verification

- `tests/audio/transport/clock.test.ts` (fake timers driving the injected
  `TimeoutTimer` — jsdom has no `Worker`).
- `tests/audio/transport/tick-timer.test.ts` (timer protocol: mock-timer Clock
  integration, `TimeoutTimer` loop semantics, `WorkerTimer` message protocol
  against a stubbed `Worker`).
- E2E `patterns`/`arp` specs exercise the real worker path in Chromium.
- `npm test`.

## Open questions / future

- `step` is a monotonically increasing 16th counter; bar logic is `step %
  SEQ_LENGTH` (consumed by the arrangement + step machines).
