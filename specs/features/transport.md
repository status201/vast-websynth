# Transport clock

```yaml
id: transport
status: implemented
version: 10  # v10: REQ-a-start-can-name-its-first-step-time start(fromStep, firstStepAt) and
             #      REQ-a-jump-can-be-scheduled seekAt(step, at) / nextStepAt — for a sync slave
             #      that joins on the master's first pulse and follows a jump in place
             # v9: REQ-a-subscriber-may-not-wedge-the-transport covers ALL FIVE listener fan-outs, not just
             #     tick and the routed seek — start/stop/seek were bare, and a throwing
             #     start listener wedged the transport permanently
             # v8: REQ-pause-resumes-where-it-stopped pause() — a one-shot resume point the cue reports while
             #     paused; REQ-a-step-router-can-redirect-the-next-step a step router, which the loop wraps through
             # v7: REQ-the-step-counter-is-bounded-at-ingress the step counter no longer wraps (bounded at ingress
             #     instead), REQ-swing-offset-is-public swingOffset is public — both for meter.md
             # v6: REQ-the-transport-catch-up-is-bounded bounded catch-up — a stalled wakeup source (backgrounded
             #     phone) recovers as silence, never as a burst of missed steps
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
  - transport-window   # v8: the Play/Pause button that calls pause()
  - transport-loop     # v8: the step router's one consumer
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

- **REQ-subscribers-get-step-and-audio-time** — Subscribers get `(stepIndex,
  audioTime)` per 16th-note tick, scheduled `scheduleAheadS` ahead (default
  `SCHEDULE_AHEAD_S`).

- **REQ-on-start-fires-before-the-first-tick** — `onStart` fires before the
  first tick; `onStop` on stop. Order matters: the [arrangement](arrangement.md)
  subscribes first.

- **REQ-bpm-and-swing-are-live-settable** — BPM and swing are live-settable;
  swing delays off-beat 16ths. `setBpm` clamps to `20..400` and `setSwing` to
  `0..1` — and both **reject non-finite input first** (v5). `Math.max(20,
  Math.min(400, NaN))` is `NaN`, so the clamp idiom used app-wide does not
  survive a `NaN`, and a `NaN` tempo makes `sixteenth` `NaN` and stalls the
  scheduler. The reachable source is a peer: the WiFi sync wire carries
  `{t:'tempo', bpm}` ([webrtc-sync](webrtc-sync.md)).

- **REQ-the-wakeup-timer-is-off-the-main-thread** — The wakeup timer runs off
  the main thread (Worker `setInterval`) wherever `Worker` is available, so the
  transport survives main-thread jank and background-tab timer throttling. A
  main-thread `setTimeout` loop is the fallback (and the injectable test
  double). A wakeup that arrives after `stop()` must not emit ticks.

- **REQ-start-seeds-the-step** (v3) — `start(fromStep = 0)` seeds `_step =
  fromStep` (masked `& 0xffff` until v7, clamped since —
  REQ-the-step-counter-is-bounded-at-ingress) **before** firing `onStart`, so a
  subscriber (the [arrangement](arrangement.md)) can read `clock.step` in
  `onStart` and seek to the implied bar. Plain `start()` / `start(0)` is
  bit-identical to v2 (step 0). Used by MIDI/WiFi clock-sync's Song-Position
  seek ([midi-clock-sync.md](midi-clock-sync.md)
  REQ-song-position-pointer-jumps-the-slave). `TickSubscriber.start(): void`
  keeps its no-arg signature (the concrete `Clock` accepts the optional param).

- **REQ-seek-moves-a-running-clock** (v4) — **`seek(step)` moves a *running*
  clock.** It sets `_step` (and the cue, REQ-the-cue-is-where-start-begins) but
  **never** `nextStepTime`, so the tempo grid is preserved and a live jump
  neither retriggers nor shifts phase — the deliberate contrast with `start()`,
  which re-origins `nextStepTime` to `ctx.currentTime + 0.05`. Valid while
  playing *and* while stopped. It fires a **new** listener channel `onSeek(fn)`
  **synchronously**, mirroring `onStart`'s ordering guarantee, so the
  [arrangement](arrangement.md) (constructed first) re-seeks its lanes before
  any machine reacts. `TickSubscriber` grows `onSeek` alongside
  `onStart`/`onStop`. Every consumer that counts position *relatively* must
  react — see [transport-position.md](transport-position.md) REQ-every-relative-consumer-reacts-to-a-seek.

- **REQ-the-cue-is-where-start-begins** (v4) — **The cue is the position a plain
  `start()` begins from.** `seek(step)` sets it, `get cue` reads it, and
  `start(fromStep = this.cue)` honours it; `stop()` leaves it alone, so Stop →
  Play resumes from the last seeked position. It defaults to `0`, so with no
  seek ever performed every REQ-start-seeds-the-step guarantee above holds
  unchanged. **Callers that require step 0 must now say so**:
  `RecorderController.exportSong` and `BankRenderController` both derive their
  capture bounds from absolute step numbers and call `start(0)` explicitly — a
  cued clock would otherwise truncate the capture silently.

- **REQ-a-subscriber-may-not-wedge-the-transport** (v5, v9) — **A subscriber may not
  wedge the transport.** **(v9) This holds for every listener fan-out the clock
  owns — `onTick`, `onStart`, `onStop`, `onSeek` and the routed seek — not just
  the two that had it.** Each listener runs inside its own `try`, the fan-out
  continues to the remaining listeners, and the caller's own work after the
  fan-out runs whether or not one threw. One helper (`fanOut`) does this for all
  five, so a sixth cannot be added without it.

  The three that were bare are the ones that mattered most. `start()` fires its
  listeners **before** `this.tick()` and `this.timer.start(...)`, with
  `_playing` already `true` — so a throw escaped past both, leaving a transport
  that believed it was playing with no timer armed and an early return
  (`if (this._playing) return`) on every retry: permanently wedged, and
  unrecoverable without `stop()`. `halt()` fires stop listeners in registration
  order, so a throw in an early one stranded every later one — hanging the
  sequencer's notes (`releaseAllAtGateEnd`) and the motion machine's baselines
  (`restoreBaselines`). `seek()` is the same loop `route()` already guarded,
  reached instead by a user scrub.

  `tick()` additionally advances `nextStepTime` / `_step` **whether or not one
  throws**. Previously a
  throwing listener escaped the `while` body *before* those two lines, leaving
  `_playing` true and `nextStepTime` unmoved — so the worker re-entered the same
  step every 25 ms forever and every later-registered lane (drums, sampler,
  motion, arrangement, the UI playhead) stopped, unrecoverable without a reload.
  A song with an out-of-range `note` reached this through a throwing
  `AudioParam` write; the range is now validated at import
  ([untrusted-input](untrusted-input.md) REQ-payload-values-are-bounded), but this requirement is the
  structural half — it closes every future variant, not just that one. A caught
  error is reported **once per listener**, not once per tick: at 40 Hz the
  latter is a console flood that hides the first, most useful stack. See
  [ADR-015](../decisions/adr-015-untrusted-input-is-bounded.md) for why
  isolation lives here rather than around each `AudioParam` write.

- **REQ-the-transport-catch-up-is-bounded** (v6) — **The catch-up is bounded: a
  stalled wakeup source recovers as silence, not as a burst.** The drain loop is
  a `while` over `nextStepTime < now + scheduleAheadS`, so if the grid falls far
  behind `now` it used to emit *every* missed 16th in one pass — each with a
  `when` in the past, clamped to `now` downstream (`Math.max(when, now)`) and
  therefore all sounding at once. Chrome/Android freezes or throttles a hidden
  page's renderer when the screen turns off (a Pixel 8a does; a Samsung tablet
  does not), which stops the worker wakeups while `ctx.currentTime` keeps
  advancing — so a minute of missed steps arrived as one machine-gun burst of
  several hundred notes with `_step` racing through the song. Two bounds close
  it:
  - **Dropout recovery.** A wakeup that finds `nextStepTime < now - DROPOUT_S`
    (0.25 s — well past what the look-ahead horizon absorbs) treats it as a
    dropout: it re-origins the grid to `now + 0.05` exactly as `start()` does,
    increments `dropouts`, and **returns without emitting anything**. The missed
    steps are never played. The next healthy wakeup drains a grid that is in the
    present, so recovery costs one skipped horizon and no burst — and while the
    source stays stalled, every wakeup takes this path, so a frozen renderer is
    simply silent.
  - **A per-wakeup cap.** `MAX_STEPS_PER_WAKEUP` (16) breaks the drain loop. The
    loop re-reads `ctx.currentTime` on every iteration, so a slow enough set of
    listeners can make it chase its own tail and never terminate; the cap ends
    the wakeup and the backlog is re-evaluated (and, if it grew past `DROPOUT_S`,
    dropped) on the next one. Normal operation never reaches it: after the
    dropout guard the widest possible drain is `(DROPOUT_S + scheduleAheadS) /
    sixteenth` ≈ 13 steps at the extreme corner (400 BPM, the weak tier's 0.2 s
    horizon), and steady state is 1–2.

  **The playhead does not fast-forward across the gap.** `_step` is left where it
  was, so playback resumes from the step it was on: a dropout is a *pause*, not a
  seek. Fast-forwarding would jump the [arrangement](arrangement.md) to an
  arbitrary bar with none of the intervening steps ever having sounded, and the
  cost of not doing it is that song position drifts behind wall-clock time by the
  gap — invisible for a standalone transport, and re-anchored by the next Song
  Position message when slaved ([midi-clock-sync](midi-clock-sync.md)
  REQ-a-midi-master-announces-its-seek/REQ-a-slave-refuses-to-seek-locally).
  The transport is deliberately **not** stopped, so devices that do play with the
  screen off keep doing so. `dropouts` is exposed for the Debug panel
  ([debug-panel](debug-panel.md)) — on the phone where this reproduces there is no
  console. See [audio-lifecycle](audio-lifecycle.md) for the surrounding policy
  (context re-arm, click-free start).

- **REQ-the-step-counter-is-bounded-at-ingress** (v7) — **The step counter does
  not wrap; it is bounded at ingress.** `_step` was masked with `& 0xffff` in
  `start`, `seek` and the drain loop, and the "Open questions" note below
  justified it: `0x10000 % SEQ_LENGTH === 0`, so the wrap was bar-aligned. That
  holds **only for bar lengths dividing 65536** — i.e. powers of two. `65536 %
  12 === 4`, `% 20 === 16`, `% 14 === 2`, so as soon as [meter](meter.md) REQ-bar-ticks-is-the-arrangement-bar-line
  made a bar 12, 14 or 20 ticks, the wrap would jump bar *and* lane phase
  mid-song (~2 h 16 min at 120 BPM, and immediately reachable via a large
  `seek`).

  `_step` is therefore a plain monotonic counter, and the bound moves to the two
  places a position **enters** the clock: `start(fromStep)` and `seek(step)` clamp
  to `0..MAX_STEP` (`src/state/limits.ts`), refusing non-finite input first — the
  same shape `setBpm` uses (REQ-bpm-and-swing-are-live-settable), and what
  [ADR-015](../decisions/adr-015-untrusted-input-is-bounded.md) actually asks for
  (*bound the payload*, not *mask the state*). `MAX_STEP` is `2**31`, ~8.5 years of
  16ths at 120 BPM, so it is a guard rail rather than a reachable limit.

  Two call sites lose a workaround rather than gaining one:
  `SyncSlave.reanchor`'s `(a - b) & 0xffff` plus a `> 0x8000` "wrapped negative"
  test becomes a plain subtraction and a `< 0` test, and
  `RecorderController.exportSong`'s elapsed-step counting no longer *has* to be
  elapsed-based (it stays, being correct either way). `SyncMaster` keeps its
  `& 0x3fff` — that is the MIDI Song-Position wire format, not our counter.

- **REQ-swing-offset-is-public** (v7) — **`swingOffset(step)` is public**, so a
  consumer scheduling on a coarser grid than a 16th can undo the clock's swing
  and apply its own ([meter](meter.md) REQ-swing-is-computed-on-the-lanes-grid). The drain loop computes its
  offset through the same method, so there is one definition of swing, not two.

- **REQ-pause-resumes-where-it-stopped** (v8) — **`pause()` stops, and the next
  `start()` resumes where this run stopped.** Stop → Play returns to the cue
  (REQ-the-cue-is-where-start-begins), which is the right behaviour for Stop but
  leaves no way to continue from the middle of a song. `pause()` stops exactly
  as `stop()` does (same listeners, same `onStop` reactions everywhere) and also
  records a **resume point**: the step the run would have emitted next. Hardware
  and DAWs handle it the same way: Elektron's PLAY pauses and resumes while STOP
  returns, and an MPC has PLAY next to PLAY START.
  - **The resume point is the first step not yet scheduled** (`_step`), not the
    step audible at that moment. Steps already inside the look-ahead were handed
    to the machines at absolute times, and they sound after the pause just as
    they do after a stop ([transport-position](transport-position.md) REQ-the-look-ahead-horizon-is-not-cancelled).
    Resuming at `_step` therefore plays no step twice and skips none.
  - **It is used once and cleared by anything that sets a position.** `start()`
    uses it and clears it. `seek()` clears it, because the user has chosen a new
    position. `stop()` clears it **even when already stopped**: Stop
    always means "back to the cue", so Esc/Panic after a pause cancels the
    resume. Stop → Play after a paused run has resumed therefore still returns
    to the cue, not to where the pause happened.
  - **`cue` stays the one public "where Play begins" number.** It returns the
    resume point while one is set and the seek position otherwise. Every surface
    that already shows the cue (the rulers' cue ring, the song readout) shows the
    resume point during a pause without any change. While playing the resume
    point is always clear, so the ring still marks where Stop → Play returns.
    The two inputs are private, which keeps transport-position REQ-one-position-number-not-two's "one
    position number" true.
  - `paused` is `true` from a `pause()` until the resume point is cleared.
    Plain `start()` without a pause still behaves as REQ-start-seeds-the-step/REQ-the-cue-is-where-start-begins describe:
    `_resume` is `null`, so `cue` is the seek position.

- **REQ-a-step-router-can-redirect-the-next-step** (v8) — **A step router can
  redirect the next step, as a jump.**
  `setStepRouter(fn | null)` installs a function the drain loop consults
  **after** the counter advances past each emitted step: `fn(next)` returns the
  step to emit next. Returning `next` changes nothing. Any other value is a
  **jump**, which differs from a seek in three ways:
  - it happens **inside the drain**, so the routed step is the very next tick on
    the unchanged grid. There is no look-ahead leftover and no retrigger, which
    a seek clicked mid-horizon cannot guarantee
    ([transport-position](transport-position.md) REQ-the-look-ahead-horizon-is-not-cancelled);
  - the counter moves to `clampStep(result)` and `onSeek` fires synchronously
    so every relative consumer catches up (transport-position REQ-every-relative-consumer-reacts-to-a-seek), but the
    **cue does not move**, since the user did not choose that position;
  - each `onSeek` listener runs in its own `try`, as REQ-a-subscriber-may-not-wedge-the-transport requires for tick
    listeners, because a throw here would escape the drain loop the same way.
    A throwing router counts as "no jump" and is reported once.
  The clock knows nothing about bars or loops. The router is supplied by
  [transport-loop](transport-loop.md), which keeps the clock's hot path at one
  `null` check while nothing is installed.

- **REQ-a-start-can-name-its-first-step-time** (v10) — **`start(fromStep,
  firstStepAt?)` can say when its first step sounds.** Without it the first step
  sounds `START_LEAD_S` (50 ms) after `start()` is called, exactly as before —
  the default is unchanged, and `START_LEAD_S` is the named constant the literal
  `0.05` used to be. With it, `nextStepTime = max(firstStepAt, currentTime)`: a
  time in the past sounds now, never earlier. A sync slave uses it to put its
  first step on the master's first pulse rather than on the moment a message
  happened to arrive ([midi-clock-sync](midi-clock-sync.md)
  REQ-a-join-is-timed-by-its-first-pulse). Bounding a remote-supplied time is
  the caller's job; the clock only refuses non-finite input (it falls back to
  the default lead).

- **REQ-a-jump-can-be-scheduled** (v10) — **`seekAt(step, at)` jumps at an audio
  time, on the unchanged grid.** It is a jump in exactly the router's sense
  (REQ-a-step-router-can-redirect-the-next-step): the counter moves, the grid does
  not, `onSeek` fires, the cue does not move. What it adds is *when*: the jump
  lands on the grid step nearest `at`.
  - If that step has **not been emitted yet**, the jump is held and applied
    inside the drain, just before that step is emitted — so it sounds as the
    new position.
  - If the look-ahead has **already emitted** it (and perhaps more), the jump
    applies at once, advanced by the `k` steps already emitted at or after `at`:
    the next emitted step is `step + k`, which is where the new position has
    got to by then. Those `k` steps have gone out with their old numbers; that
    cannot be undone, only not compounded.
  Stopped, it is a plain `seek(step)`. `start`, `stop` and `seek` drop a held
  jump. `nextStepAt` exposes the grid time of the next step to be emitted —
  unswung, the time a jump announced now would sound
  ([midi-clock-sync](midi-clock-sync.md) REQ-a-join-is-timed-by-its-first-pulse).

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
  setBpm(b)            # non-finite refused (v5), then clamped 20..400
  setSwing(s)          # 0 (straight) .. 1
  swingOffset(step)    # v7: the delay this tick carries; 0 on even steps (REQ-swing-offset-is-public)
  get cue: number      # v4: where a plain start() begins; 0 until the first seek
                       # v8: _resume ?? _cue — the resume point while paused (REQ-pause-resumes-where-it-stopped)
  get paused: boolean  # v8: a resume point is set (REQ-pause-resumes-where-it-stopped)
  start(fromStep = this.cue) / stop()   # v3: fromStep seeds _step before onStart.
                       # v4: the default is the cue, not the literal 0.
                       # v7: clamped 0..MAX_STEP, not masked (REQ-the-step-counter-is-bounded-at-ingress)
                       # v8: start clears _resume; stop clears it even when stopped
  pause()              # v8: no-op unless playing; _resume = _step, then stop's body
                       # (onStop fires with `cue` already reading the resume point)
  seek(step)           # v4: _cue = _step = step; nextStepTime UNTOUCHED;
                       # fires onSeek synchronously. Playing or stopped.
                       # v7: clamped 0..MAX_STEP, non-finite refused (REQ-the-step-counter-is-bounded-at-ingress)
                       # v8: also clears _resume (REQ-pause-resumes-where-it-stopped)
  setStepRouter(fn: StepRouter | null)  # v8 (REQ-a-step-router-can-redirect-the-next-step): consulted after each _step++;
                       # a different result -> _step = clampStep(it), onSeek fires
                       # (each listener isolated); _cue, _resume, nextStepTime untouched
  nudge(seconds)       # ±0.05 s future-grid shift (midi-clock-sync phase correction)
  get dropouts: number # v6: stalled-wakeup recoveries this session (REQ-the-transport-catch-up-is-bounded);
                       # monotonic, never reset — surfaced by debug-panel.md
  onTick(fn) / onStart(fn) / onStop(fn) / onSeek(fn) -> unsubscribe
constants: LOOKAHEAD_MS = 25, SCHEDULE_AHEAD_S = 0.1 (default; perf tier may widen it)
           DROPOUT_S = 0.25, MAX_STEPS_PER_WAKEUP = 16   # v6, REQ-the-transport-catch-up-is-bounded
TickListener: (step, when) => void        # tick-source.ts
StepRouter:   (next: number) => number     # clock.ts, v8 (REQ-a-step-router-can-redirect-the-next-step)
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
(message in flight) emits nothing (REQ-the-wakeup-timer-is-off-the-main-thread).

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
    v8: the song transport's Play/Pause calls clock.pause() to pause, and the
    header button (via UiBridge.toggleTransport) to play — transport-window.md
v8 step router: installed only by LoopDriver (transport-loop.md), only while a
  loop is engaged; a jump's onSeek fan-out has the same order as a seek's
v4 seek fan-out (order guaranteed by the same construction order):
  clock.seek -> Arrangement (play banks settle) -> machines -> the UI ruler
  UI never calls clock.seek directly; it goes through Engine.seekTo, which owns
  the refusal states + the sync-master announce (transport-position.md
  REQ-seeking-is-refused-in-three-states/REQ-a-sync-master-announces-its-seek)
recorders: RecorderController.exportSong / BankRenderController call start(0)
  EXPLICITLY (REQ-the-cue-is-where-start-begins) — they bound their captures by absolute step number
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

Scenario: A throwing subscriber cannot wedge the clock (v5, regression)
  Given a running clock with a subscriber that throws on every tick
  When the timer fires
  Then the step counter still advances and nextStepTime still moves
  And the other subscribers still receive their ticks
  And the error is reported once for that listener, not once per tick
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A throwing start listener cannot wedge the transport (v9, regression)
  Given a stopped clock with an onStart listener that throws
  When start() is called
  Then the remaining start listeners still run
  And the first tick is still emitted and the timer is still armed
  And a later stop() then start() plays normally
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A throwing stop listener does not strand the later ones (v9, regression)
  Given a running clock with two onStop listeners, the first of which throws
  When stop() is called
  Then the second stop listener still runs
  And the error is reported once for that listener
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A throwing seek listener does not escape a user scrub (v9, regression)
  Given a clock with an onSeek listener that throws
  When seek(n) is called directly, not through the router
  Then the remaining seek listeners still run
  And the step counter is still at n
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A non-finite tempo leaves the clock alone (v5, edge)
  Given a clock at 120 BPM
  When setBpm(NaN) — or setSwing(NaN) — is called
  Then the tempo and swing are unchanged
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
   And with no seek at all, start() still begins at step 0 (REQ-start-seeds-the-step regression)
# pinned by: tests/audio/transport/clock.test.ts

Scenario: Transport survives a backgrounded tab (device)
  Given the transport is playing on a phone
  When the tab is backgrounded for 30s and foregrounded again
  Then the grid held (worker timers are exempt from tab timer throttling)
# verified manually on device; jsdom cannot pin this

Scenario: A stalled wakeup source drops the gap instead of bursting it (v6, regression)
  Given the clock is playing at 120 BPM
  When the audio clock jumps 60 s ahead before the next wakeup
  Then that wakeup emits no ticks at all
   And `dropouts` has incremented once
   And the following wakeup emits again, from the step the clock was on
   And its `when` is in the future, not the past
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A jitter-sized delay is still absorbed, not treated as a dropout (v6, edge)
  Given the clock is playing at 120 BPM
  When a wakeup arrives late enough to owe two steps (under DROPOUT_S)
  Then both steps are emitted on that wakeup and `dropouts` stays 0
# pinned by: tests/audio/transport/clock.test.ts

Scenario: One wakeup can never emit an unbounded run (v6, edge)
  Given a clock whose listeners advance the audio clock as they run
  When the timer fires
  Then at most MAX_STEPS_PER_WAKEUP ticks are emitted before the wakeup ends
# pinned by: tests/audio/transport/clock.test.ts

Scenario: The step counter passes 65536 without folding (v7, REQ-the-step-counter-is-bounded-at-ingress)
  Given a clock started just below 65536
  When it ticks past it
  Then the step keeps increasing — no wrap, so no lane changes phase
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A position is clamped at ingress, not masked (v7, REQ-the-step-counter-is-bounded-at-ingress, edge)
  Given a stopped clock
  When seek(1e12) — or seek(-5), or seek(NaN) — is called
  Then the position lands inside 0..MAX_STEP and never as a folded remainder
# pinned by: tests/audio/transport/clock.test.ts

Scenario: swingOffset agrees with the times the drain loop emits (v7, REQ-swing-offset-is-public)
  Given setSwing(0.5)
  When a tick fires for an odd step
  Then swingOffset(step) equals the delay that tick's `when` carried
   And it is 0 for an even step at any swing amount
# pinned by: tests/audio/transport/clock.test.ts

Scenario: Pause resumes from the first unscheduled step (v8, REQ-pause-resumes-where-it-stopped)
  Given a playing clock that has emitted steps 0..4
  When pause() is called
  Then playing is false, onStop fired once, paused is true and cue reads 5
  And the next start() emits step 5 first
# pinned by: tests/audio/transport/clock.test.ts

Scenario: Stop after a resumed run still returns to the cue (v8, REQ-pause-resumes-where-it-stopped)
  Given the cue is 0, and the clock was paused at 5 and then resumed
  When stop() and then start() are called
  Then the first tick is step 0, not 5
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A seek or a stop cancels a pending resume (v8, REQ-pause-resumes-where-it-stopped, edge)
  Given the clock is paused at step 5
  When seek(12) is called, then start()
  Then the first tick is step 12
  And paused at 5 again, stop() while already stopped makes cue read the old cue
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A routed step is a jump on the same grid (v8, REQ-a-step-router-can-redirect-the-next-step)
  Given a playing clock whose router sends 8 to 2
  When the drain emits step 7
  Then the next tick is step 2 at exactly one 16th after step 7's grid time
  And onSeek fired once, while cue and nextStepTime were not re-seeded
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A throwing router or seek listener cannot wedge the drain (v8, REQ-a-step-router-can-redirect-the-next-step, edge)
  Given a router that throws, or an onSeek listener that throws on a jump
  When the timer fires
  Then the step counter still advances and later tick listeners still run
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A start can put its first step at a given time (v10, REQ-a-start-can-name-its-first-step-time)
  Given a stopped clock and currentTime 1.0
  When start(4, 1.3) is called
  Then step 4 is emitted with when 1.3
   And start(4) alone still puts it at 1.05, and start(4, 0.2) at 1.0
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A scheduled jump lands on the step nearest its time (v10, REQ-a-jump-can-be-scheduled)
  Given a playing clock whose look-ahead has not reached time T
  When seekAt(32, T) is called
  Then the step emitted at T's grid time is 32, the steps before it keep counting
   And onSeek fired once, the cue did not move, and the grid was not re-seeded
# pinned by: tests/audio/transport/clock.test.ts

Scenario: A scheduled jump the look-ahead has passed is caught up (v10, REQ-a-jump-can-be-scheduled, edge)
  Given a playing clock that has already emitted the steps at T and T + one 16th
  When seekAt(32, T) is called
  Then the next emitted step is 34 — where the new position has got to by then
# pinned by: tests/audio/transport/clock.test.ts
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
  barTicks` (consumed by the arrangement + step machines — [meter](meter.md)).
  It no longer wraps at all: the old 16-bit mask was only phase-safe for bar
  lengths dividing 65536, and REQ-the-step-counter-is-bounded-at-ingress replaced it with a clamp at ingress.
- `nudge` and `seek` are deliberately different tools: `nudge` shifts *when* the
  future grid ticks (sub-10 ms, phase only); `seek` changes *which* step, leaving
  the grid alone. Neither is expressible in terms of the other.
