# Transport clock

```yaml
id: transport
status: implemented
version: 12
owner: core
related:
  - architecture
  - meter
  - arpeggiator
  - sequencer
  - arrangement
  - performance-mode
  - midi-clock-sync
  - transport-position
  - transport-window   # the Play/Pause button that calls pause()
  - transport-loop     # the step router's one consumer
  - untrusted-input
  - audio-lifecycle
  - ../decisions/adr-015-untrusted-input-is-bounded
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

Browser timers jitter, but `AudioParam` scheduling is sample-accurate. The **"two
clocks"** pattern (Chris Wilson, 2013): a timer wakes every ~25 ms to *enqueue* ticks,
each carrying the **absolute AudioContext time** it should sound, ~100 ms ahead. The
wakeup runs in a **Worker**, because a main-thread `setTimeout` is throttled to ≥ 1 s
in background tabs and delayed by jank, and a late wake gets hits clamped to
`currentTime` and bunched. Only the wakeup moves off-thread; the scheduling logic stays
on the main thread.

## Requirements

- **REQ-subscribers-get-step-and-audio-time** — Subscribers get `(stepIndex,
  audioTime)` per tick, scheduled `scheduleAheadS` ahead (default `SCHEDULE_AHEAD_S`;
  the weak tier widens it, [performance-mode](performance-mode.md)).
- **REQ-on-start-fires-before-the-first-tick** — `onStart` fires before the first tick,
  `onStop` on stop. The [arrangement](arrangement.md) subscribes first.
- **REQ-bpm-and-swing-are-live-settable** — `setBpm` clamps to `20..400` and `setSwing`
  to `0..1`, and both **reject non-finite input first**: the clamp idiom passes `NaN`,
  and a `NaN` tempo stalls the scheduler. A WiFi peer can send one
  ([webrtc-sync](webrtc-sync.md)). Swing delays off-beat 16ths.
- **REQ-the-wakeup-timer-is-off-the-main-thread** — The wakeup is a Worker
  `setInterval` wherever `Worker` exists, with a main-thread `setTimeout` loop as the
  fallback and test double. A wakeup that arrives after `stop()` emits nothing.
- **REQ-start-seeds-the-step** — `start(fromStep)` seeds `_step` (clamped,
  REQ-the-step-counter-is-bounded-at-ingress) **before** firing `onStart`, so the
  arrangement can read `clock.step` there and seek to the implied bar. Sync's Song
  Position join uses it ([midi-clock-sync.md](midi-clock-sync.md)
  REQ-song-position-pointer-jumps-the-slave). `TickSubscriber.start()` keeps a no-arg
  signature.
- **REQ-seek-moves-a-running-clock** — `seek(step)` sets `_step` and the cue, **never**
  `nextStepTime`, so a live jump keeps the grid (`start()` re-origins it to
  `currentTime + START_LEAD_S`). It works playing or stopped, and fires `onSeek`
  **synchronously**, so the arrangement re-seeks before any machine reacts. Every
  relative consumer must react ([transport-position.md](transport-position.md)
  REQ-every-relative-consumer-reacts-to-a-seek).
- **REQ-the-cue-is-where-start-begins** — `start(fromStep = this.cue)`. `seek` sets the
  cue and `stop()` leaves it, so Stop → Play resumes from the last seek. It defaults to
  0. **Callers that need step 0 say so**: `RecorderController.exportSong` and
  `BankRenderController` call `start(0)`, since their captures are bounded by absolute
  step.
- **REQ-a-subscriber-may-not-wedge-the-transport** — Every listener fan-out the clock
  owns (`onTick`, `onStart`, `onStop`, `onSeek`, the routed seek) goes through one
  helper, `fanOut`: each listener in its own `try`, the fan-out continuing, and the
  caller's work after it running regardless. A throwing start listener would otherwise
  leave `_playing` true with no timer armed and every retry returning early. A throwing
  stop listener would strand later ones (hanging notes, unrestored baselines). `tick()`
  advances `nextStepTime` / `_step` **whether or not a listener throws**, or the worker
  would re-enter the same step forever. Errors are reported **once per listener**, not
  per tick. Import validation bounds the values ([untrusted-input](untrusted-input.md)
  REQ-payload-values-are-bounded); this is the structural half (ADR-015).
- **REQ-a-step-limit-halts-before-the-step** — `limitSteps(n, onLimit)` lets a
  caller end the transport after exactly `n` more emitted steps. When the next
  step comes due, the clock calls `onLimit` and halts in its place: it does **not**
  emit that step to any listener. A listener that stopped the clock from inside
  its own tick could not promise this. Listeners run in registration order, so
  every lane registered before it would already have scheduled the step. That is
  how a song export rendered the next pass's first step into its tail
  ([audio-export](audio-export.md) REQ-the-capture-keeps-a-tail). The count is of
  emissions, not step numbers, so a loop or a scheduled jump cannot make it
  unreachable. Any stop clears the limit. `onLimit` runs isolated, like every
  fan-out (REQ-a-subscriber-may-not-wedge-the-transport), and the halt happens
  whether or not it throws.
- **REQ-the-transport-catch-up-is-bounded** — A stalled wakeup source (a frozen hidden
  renderer, screen off) recovers as **silence, not a burst**:
  - **Dropout recovery.** A wakeup that finds `nextStepTime < now - DROPOUT_S` (0.25 s)
    re-origins the grid to `now + DROPOUT_LEAD_S`, increments `dropouts`, and **emits
    nothing**. `DROPOUT_LEAD_S` is 0.1 s (`MAX_EARLY_S` + 40 ms), so the first step can
    take a deep early nudge ([step-settings](step-settings.md)
    REQ-an-early-offset-is-capped-in-seconds). `start()` keeps `START_LEAD_S` (0.05 s),
    part of the sync join timing. While the source stays stalled, every wakeup takes
    this path.
  - **A per-wakeup cap.** `MAX_STEPS_PER_WAKEUP` (16) breaks the drain loop, which
    re-reads `currentTime` and could chase slow listeners forever. After the dropout
    guard the widest real drain is ~13 steps (400 BPM, the 0.2 s horizon), and steady
    state is 1–2.

  `_step` is **not** fast-forwarded: a dropout is a pause, not a seek. The song then
  lags wall-clock by the gap, which the next Song Position re-anchors when slaved
  ([midi-clock-sync](midi-clock-sync.md)). The transport is not stopped, so devices
  that play with the screen off keep playing. `dropouts` is shown in the
  [debug panel](debug-panel.md) ([audio-lifecycle](audio-lifecycle.md) has the
  surrounding policy).
- **REQ-the-step-counter-is-bounded-at-ingress** — `_step` is a plain monotonic
  counter, never masked. A 16-bit wrap is bar-aligned only for bar lengths dividing
  65536, so 12/14/20-tick bars ([meter](meter.md)
  REQ-bar-ticks-is-the-arrangement-bar-line) would jump phase. The bound sits where a
  position **enters**: `start(fromStep)` and `seek(step)` clamp to `0..MAX_STEP`
  (`src/state/limits.ts`, `2**31`, ~8.5 years of 16ths), refusing non-finite input
  first (ADR-015: bound the payload, don't mask the state). `SyncMaster`'s `& 0x3fff`
  is the MIDI wire format, not this counter.
- **REQ-swing-offset-is-public** — `swingOffset(step)` is public, so a coarser-grid
  consumer can undo it and apply its own ([meter](meter.md)
  REQ-swing-is-computed-on-the-lanes-grid). The drain loop uses the same method.
- **REQ-pause-resumes-where-it-stopped** — `pause()` stops exactly as `stop()` does and
  records a **resume point**, as Elektron PLAY or MPC PLAY vs PLAY START do:
  - the resume point is `_step`, the first step not yet scheduled. Steps already in the
    look-ahead sound after the pause ([transport-position](transport-position.md)
    REQ-the-look-ahead-horizon-is-not-cancelled), so none plays twice or is skipped;
  - it is used once. `start()` uses and clears it, `seek()` clears it, and `stop()`
    clears it **even when already stopped**, so Esc/Panic after a pause returns to the
    cue;
  - `cue` stays the one public "where Play begins" number: `_resume ?? _cue`. Every
    surface showing the cue shows the resume point during a pause;
  - `paused` is true from `pause()` until the resume point clears.
- **REQ-a-step-router-can-redirect-the-next-step** — `setStepRouter(fn | null)`: after
  the counter advances past each emitted step, `fn(next)` returns the step to emit
  next. A different value is a **jump**: the very next tick on the unchanged grid,
  with no look-ahead leftover. The counter moves to `clampStep(result)` and `onSeek`
  fires (isolated), but the **cue does not move**. A throwing router counts as no jump
  and is reported once. The clock knows no bars or loops; the router is
  [transport-loop](transport-loop.md)'s, and the hot path costs one `null` check
  without it.
- **REQ-a-start-can-name-its-first-step-time** — `start(fromStep, firstStepAt?)`:
  `nextStepTime = max(firstStepAt, currentTime)`, otherwise `currentTime +
  START_LEAD_S`. A sync slave puts its first step on the master's first pulse
  ([midi-clock-sync](midi-clock-sync.md) REQ-a-join-is-timed-by-its-first-pulse).
  Bounding a remote time is the caller's job; non-finite falls back to the default.
- **REQ-a-jump-can-be-scheduled** — `seekAt(step, at)` is a router-style jump landing
  on the grid step nearest `at`. If that step is not yet emitted, the jump is held and
  applied inside the drain just before it. If the look-ahead already emitted `k` steps
  at or after `at`, it applies at once as `step + k`. Stopped, it is a plain `seek`.
  `start`, `stop` and `seek` drop a held jump. `nextStepAt` is the unswung grid time of
  the next step to be emitted, which is what a join is timed against.

## Technical design

### Contract / public interface

```yaml
Clock:   # src/audio/transport/clock.ts (implements TickSubscriber)
  new Clock(ctx, opts?: { timer?: TickTimer, scheduleAheadS?: number })
  get playing: boolean
  get step: number
  get bpm: number      # the tempo actually running — a slaved clock writes it directly,
                       # so it can differ from the bus's transport.bpm (debug-panel.md)
  setBpm(b)            # non-finite refused, then clamped 20..400
  setSwing(s)          # 0 (straight) .. 1
  swingOffset(step)    # the delay this tick carries; 0 on even steps
  get cue: number      # _resume ?? _cue — where a plain start() begins
  get paused: boolean
  start(fromStep = this.cue, firstStepAt?) / stop()   # fromStep clamped 0..MAX_STEP
  pause()              # no-op unless playing; _resume = _step, then stop's body
  seek(step)           # _cue = _step = clamp(step); nextStepTime UNTOUCHED; onSeek; clears _resume
  seekAt(step, at)     # a scheduled jump on the unchanged grid
  get nextStepAt: number
  setStepRouter(fn: StepRouter | null)
  limitSteps(n, onLimit)   # emit n more steps, then onLimit + halt instead of emitting the next
  nudge(seconds)       # ±0.05 s future-grid shift (midi-clock-sync phase correction)
  get dropouts: number # stalled-wakeup recoveries this session; monotonic
  onTick(fn) / onStart(fn) / onStop(fn) / onSeek(fn) -> unsubscribe
constants: LOOKAHEAD_MS = 25, SCHEDULE_AHEAD_S = 0.1, START_LEAD_S = 0.05,
           DROPOUT_S = 0.25, DROPOUT_LEAD_S = 0.1, MAX_STEPS_PER_WAKEUP = 16
TickListener: (step, when) => void        # tick-source.ts
StepRouter:   (next: number) => number     # clock.ts
TickTimer:   # src/audio/transport/tick-timer.ts — the wakeup source
  start(cb, intervalMs) / stop()
  WorkerTimer   # setInterval in a Worker (clock-timer-worker.ts, Vite `new URL` bundling)
  TimeoutTimer  # main-thread setTimeout loop — fallback + test double
  defaultTickTimer() -> WorkerTimer if `Worker` exists, else TimeoutTimer
```

The worker protocol is `postMessage({cmd:'start', ms} | {cmd:'stop'})` in, empty
wakeups out: one persistent worker per `WorkerTimer`, lazy on first `start()`.

### Data shapes (registry)

```yaml
transport.bpm:   { range: 40..240, default: 120, step: 1, format: bpm }
transport.swing: { range: 0..1, default: 0 }
```

The knob clamps `40..240` and the clock `20..400`, because Tape Stop
([performance](performance.md)) ramps below the UI floor.

### Layer touchpoints & ordering

```yaml
engine (subscribeParams): transport.bpm -> clock.setBpm; transport.swing -> clock.setSwing
construction order (engine): new Arrangement(...) BEFORE the machines, so the play banks
  are settled before the machines read them (arrangement.md)
UI: the header transport-play button toggles start/stop; the song transport's
  Play/Pause calls clock.pause() (transport-window.md)
step router: installed only by LoopDriver (transport-loop.md), only while a loop is engaged
seek fan-out: clock.seek -> Arrangement (play banks settle) -> machines -> the UI ruler;
  the UI goes through Engine.seekTo (transport-position.md
  REQ-seeking-is-refused-in-three-states/REQ-a-sync-master-announces-its-seek)
```

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

Scenario: A throwing subscriber cannot wedge the clock (regression)
  Given a running clock with a subscriber that throws on every tick
  When the timer fires
  Then the step counter still advances and nextStepTime still moves
  And the other subscribers still receive their ticks
  And the error is reported once for that listener, not once per tick
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A step limit halts before the step, not after it (REQ-a-step-limit-halts-before-the-step)
  Given a tick listener registered before the limit is set
  When the clock is started with limitSteps(n, onLimit)
  Then the listener receives exactly the steps 0..n-1
  And onLimit fires once, then the clock stops, in the wakeup where step n came due
  And the limit counts emissions, so a step router looping back still stops it after n
  And a stop before the limit is reached clears it, so the next start runs unlimited
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A throwing start listener cannot wedge the transport (regression)
  Given a stopped clock with an onStart listener that throws
  When start() is called
  Then the remaining start listeners still run
  And the first tick is still emitted and the timer is still armed
  And a later stop() then start() plays normally
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A throwing stop listener does not strand the later ones (regression)
  Given a running clock with two onStop listeners, the first of which throws
  When stop() is called
  Then the second stop listener still runs
  And the error is reported once for that listener
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A throwing seek listener does not escape a user scrub (regression)
  Given a clock with an onSeek listener that throws
  When seek(n) is called directly, not through the router
  Then the remaining seek listeners still run
  And the step counter is still at n
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A non-finite tempo leaves the clock alone (edge)
  Given a clock at 120 BPM
  When setBpm(NaN) — or setSwing(NaN) — is called
  Then the tempo and swing are unchanged
# pinned by: tests/audio/transport/clock.test.ts

Scenario: No ticks after stop, even from an in-flight wakeup (edge)
  Given the clock is started with an injected timer
  When the clock is stopped and the timer fires once more
  Then no tick is emitted and the timer has been told to stop
# pinned by: tests/audio/transport/tick-timer.test.ts

Scenario: start(fromStep) seeds the step before onStart (REQ-start-seeds-the-step)
  Given the clock is stopped
  When start(96) is called
  Then an onStart subscriber reads clock.step === 96
   And the first tick fires for step 96
   And start() / start(0) still begins at step 0 (regression)
# pinned by: tests/audio/transport/clock.test.ts

Scenario: seek moves the step without disturbing the grid (REQ-seek-moves-a-running-clock)
  Given the clock is playing
  When seek(37) is called
  Then clock.step is 37, nextStepTime is unchanged, and onSeek fired once
   And the next tick continues on the same tempo grid (no retrigger)
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A seek while stopped cues the next start (REQ-the-cue-is-where-start-begins)
  Given the clock is stopped and has never been seeked
  When seek(64) is called and then start() (no argument)
  Then the first tick fires for step 64
   And with no seek at all, start() still begins at step 0 (REQ-start-seeds-the-step regression)
# pinned by: tests/audio/transport/clock.test.ts

Scenario: Transport survives a backgrounded tab (device)
  Given the transport is playing on a phone
  When the tab is backgrounded for 30s and foregrounded again
  Then the grid held (worker timers are exempt from tab timer throttling)
# verified manually on device; jsdom cannot pin this

Scenario: A stalled wakeup source drops the gap instead of bursting it (REQ-the-transport-catch-up-is-bounded, regression)
  Given the clock is playing at 120 BPM
  When the audio clock jumps 60 s ahead before the next wakeup
  Then that wakeup emits no ticks at all
   And `dropouts` has incremented once
   And the following wakeup emits again, from the step the clock was on
   And its `when` is in the future, not the past
# pinned by: tests/audio/transport/clock.test.ts

Scenario: The step after a dropout has room for an early nudge (REQ-the-transport-catch-up-is-bounded)
  Given the clock has just recovered from a dropout
  When the next wakeup emits the first step
  Then that step's `when` is at least MAX_EARLY_S after the wakeup's currentTime
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A jitter-sized delay is still absorbed, not treated as a dropout (edge)
  Given the clock is playing at 120 BPM
  When a wakeup arrives late enough to owe two steps (under DROPOUT_S)
  Then both steps are emitted on that wakeup and `dropouts` stays 0
# pinned by: tests/audio/transport/clock.test.ts

Scenario: One wakeup can never emit an unbounded run (edge)
  Given a clock whose listeners advance the audio clock as they run
  When the timer fires
  Then at most MAX_STEPS_PER_WAKEUP ticks are emitted before the wakeup ends
# pinned by: tests/audio/transport/clock.test.ts

Scenario: The step counter passes 65536 without folding (REQ-the-step-counter-is-bounded-at-ingress)
  Given a clock started just below 65536
  When it ticks past it
  Then the step keeps increasing — no wrap, so no lane changes phase
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A position is clamped at ingress, not masked (REQ-the-step-counter-is-bounded-at-ingress, edge)
  Given a stopped clock
  When seek(1e12) — or seek(-5), or seek(NaN) — is called
  Then the position lands inside 0..MAX_STEP and never as a folded remainder
# pinned by: tests/audio/transport/clock.test.ts

Scenario: swingOffset agrees with the times the drain loop emits (REQ-swing-offset-is-public)
  Given setSwing(0.5)
  When a tick fires for an odd step
  Then swingOffset(step) equals the delay that tick's `when` carried
   And it is 0 for an even step at any swing amount
# pinned by: tests/audio/transport/clock.test.ts

Scenario: Pause resumes from the first unscheduled step (REQ-pause-resumes-where-it-stopped)
  Given a playing clock that has emitted steps 0..4
  When pause() is called
  Then playing is false, onStop fired once, paused is true and cue reads 5
  And the next start() emits step 5 first
# pinned by: tests/audio/transport/clock.test.ts

Scenario: Stop after a resumed run still returns to the cue (REQ-pause-resumes-where-it-stopped)
  Given the cue is 0, and the clock was paused at 5 and then resumed
  When stop() and then start() are called
  Then the first tick is step 0, not 5
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A seek or a stop cancels a pending resume (REQ-pause-resumes-where-it-stopped, edge)
  Given the clock is paused at step 5
  When seek(12) is called, then start()
  Then the first tick is step 12
  And paused at 5 again, stop() while already stopped makes cue read the old cue
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A routed step is a jump on the same grid (REQ-a-step-router-can-redirect-the-next-step)
  Given a playing clock whose router sends 8 to 2
  When the drain emits step 7
  Then the next tick is step 2 at exactly one 16th after step 7's grid time
  And onSeek fired once, while cue and nextStepTime were not re-seeded
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A throwing router or seek listener cannot wedge the drain (REQ-a-step-router-can-redirect-the-next-step, edge)
  Given a router that throws, or an onSeek listener that throws on a jump
  When the timer fires
  Then the step counter still advances and later tick listeners still run
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A start can put its first step at a given time (REQ-a-start-can-name-its-first-step-time)
  Given a stopped clock and currentTime 1.0
  When start(4, 1.3) is called
  Then step 4 is emitted with when 1.3
   And start(4) alone still puts it at 1.05, and start(4, 0.2) at 1.0
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A scheduled jump lands on the step nearest its time (REQ-a-jump-can-be-scheduled)
  Given a playing clock whose look-ahead has not reached time T
  When seekAt(32, T) is called
  Then the step emitted at T's grid time is 32, the steps before it keep counting
   And onSeek fired once, the cue did not move, and the grid was not re-seeded
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A scheduled jump the look-ahead has passed is caught up (REQ-a-jump-can-be-scheduled, edge)
  Given a playing clock that has already emitted the steps at T and T + one 16th
  When seekAt(32, T) is called
  Then the next emitted step is 34 — where the new position has got to by then
# pinned by: tests/audio/transport/clock.test.ts
```

## Tests & verification

- `tests/audio/transport/clock.test.ts` (fake timers driving the injected
  `TimeoutTimer`; jsdom has no `Worker`), `tests/audio/transport/tick-timer.test.ts`
  (the timer protocol, `WorkerTimer` against a stubbed `Worker`). The `patterns`/`arp`
  E2E specs exercise the real worker in Chromium. `npm test`.

## Open questions / future

- `nudge` and `seek` are different tools: `nudge` shifts *when* the future grid ticks
  (phase only), and `seek` changes *which* step, leaving the grid alone. Neither can
  be expressed with the other.
