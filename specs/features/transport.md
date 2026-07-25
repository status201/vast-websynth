# Transport clock

```yaml
id: transport
status: implemented
version: 4
owner: core
related:
  - architecture
  - arpeggiator
  - sequencer
  - arrangement
  - performance-mode
  - midi-clock-sync
  - transport-position
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
- **REQ-5** (v3) — `start(fromStep = 0)` seeds `_step = fromStep & 0xffff`
  **before** firing `onStart`, so a subscriber (the [arrangement](arrangement.md))
  can read `clock.step` in `onStart` and seek to the implied bar. Plain
  `start()` / `start(0)` is bit-identical to v2 (step 0). Used by MIDI/WiFi
  clock-sync's Song-Position seek ([midi-clock-sync.md](midi-clock-sync.md)
  REQ-10). `TickSubscriber.start(): void` keeps its no-arg signature (the
  concrete `Clock` accepts the optional param).
- **REQ-6** (v4) — **`seek(step)` moves a *running* clock.** It sets `_step` (and
  the cue, REQ-7) but **never** `nextStepTime`, so the tempo grid is preserved and
  a live jump neither retriggers nor shifts phase — the deliberate contrast with
  `start()`, which re-origins `nextStepTime` to `ctx.currentTime + 0.05`. Valid
  while playing *and* while stopped. It fires a **new** listener channel
  `onSeek(fn)` **synchronously**, mirroring `onStart`'s ordering guarantee, so the
  [arrangement](arrangement.md) (constructed first) re-seeks its lanes before any
  machine reacts. `TickSubscriber` grows `onSeek` alongside `onStart`/`onStop`.
  Every consumer that counts position *relatively* must react — see
  [transport-position.md](transport-position.md) REQ-4.
- **REQ-7** (v4) — **The cue is the position a plain `start()` begins from.**
  `seek(step)` sets it, `get cue` reads it, and `start(fromStep = this.cue)`
  honours it; `stop()` leaves it alone, so Stop → Play resumes from the last
  seeked position. It defaults to `0`, so with no seek ever performed every REQ-5
  guarantee above holds unchanged. **Callers that require step 0 must now say so**:
  `RecorderController.exportSong` and `BankRenderController` both derive their
  capture bounds from absolute step numbers and call `start(0)` explicitly — a
  cued clock would otherwise truncate the capture silently.

## Technical design

### Contract / public interface

```yaml
Clock:   # src/audio/transport/clock.ts (implements TickSubscriber)
  new Clock(ctx, opts?: { timer?: TickTimer, scheduleAheadS?: number })
  get playing: boolean
  get step: number
  get bpm: number      # the tempo actually running — a slaved clock writes it
                       # directly, so it can differ from the bus's transport.bpm
                       # (midi-clock-sync.md); surfaced by debug-panel.md
  setBpm(b)            # clamped 20..400 internally
  setSwing(s)          # 0 (straight) .. 1
  get cue: number      # v4: where a plain start() begins; 0 until the first seek
  start(fromStep = this.cue) / stop()   # v3: fromStep seeds _step (& 0xffff) before
                       # onStart. v4: the default is the cue, not the literal 0
  seek(step)           # v4: _cue = _step = step & 0xffff; nextStepTime UNTOUCHED;
                       # fires onSeek synchronously. Playing or stopped.
  nudge(seconds)       # ±0.05 s future-grid shift (midi-clock-sync phase correction)
  onTick(fn) / onStart(fn) / onStop(fn) / onSeek(fn) -> unsubscribe
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
v4 seek fan-out (order guaranteed by the same construction order):
  clock.seek -> Arrangement (play banks settle) -> machines -> the UI ruler
  UI never calls clock.seek directly; it goes through Engine.seekTo, which owns
  the refusal states + the sync-master announce (transport-position.md REQ-6/7)
recorders: RecorderController.exportSong / BankRenderController call start(0)
  EXPLICITLY (REQ-7) — they bound their captures by absolute step number
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

Scenario: start(fromStep) seeds the step before onStart (v3)
  Given the clock is stopped
  When start(96) is called
  Then an onStart subscriber reads clock.step === 96
   And the first tick fires for step 96
   And start() / start(0) still begins at step 0 (regression)
# pinned by: tests/audio/transport/clock.test.ts

Scenario: seek moves the step without disturbing the grid (v4)
  Given the clock is playing
  When seek(37) is called
  Then clock.step is 37, nextStepTime is unchanged, and onSeek fired once
   And the next tick continues on the same tempo grid (no retrigger)
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A seek while stopped cues the next start (v4)
  Given the clock is stopped and has never been seeked
  When seek(64) is called and then start() (no argument)
  Then the first tick fires for step 64
   And with no seek at all, start() still begins at step 0 (REQ-5 regression)
# pinned by: tests/audio/transport/clock.test.ts

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
  SEQ_LENGTH` (consumed by the arrangement + step machines). `0x10000 %
  SEQ_LENGTH === 0`, so the 16-bit wrap is bar-aligned and never glitches phase.
- `nudge` and `seek` are deliberately different tools: `nudge` shifts *when* the
  future grid ticks (sub-10 ms, phase only); `seek` changes *which* step, leaving
  the grid alone. Neither is expressible in terms of the other.
