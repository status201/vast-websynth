# Scope health (it never stops painting for good)

```yaml
id: scope-health
status: implemented
version: 1
owner: status201
related:
  - scope                             # the component this keeps alive
  - audio-lifecycle
  - runtime-performance               # the idle sleep is a cost-contract rule
  - debug-panel                       # the Scope row that reports this panel's liveness
source:
  - src/ui/components/scope.ts
  - src/state/debug-sources.ts        # setScopeStatsSource — the Debug panel's reader
  - src/ui/components/about-debug.ts  # the "Scope" row
```

## Background / Why

A frozen or black [scope](scope.md) with every toggle dead is the failure mode this
component has hit on real devices (a backgrounded Android tablet; a desktop
GPU-process crash). So no state may exist from which it cannot start drawing again,
and a timer that checks pixels are still arriving replaces guessing which event the
platform will send. The same loop sleeps when there is nothing to show, and a
sleeping loop is not a stall.

## Requirements

- **REQ-the-redraw-loop-can-always-restart** — **The redraw loop can
  always be restarted.** `start()` cancels any pending frame and re-arms
  unconditionally, never early-returning on `running`: with `running` latched
  true and no frame queued, an early return makes every restart path a no-op.
  Restarting an already-running loop is harmless — the
  pending frame is cancelled first, so there is never more than one callback in
  flight.

- **REQ-one-bad-frame-cannot-end-the-loop** — **One bad frame cannot end
  the loop.** The next `requestAnimationFrame` is issued **before** `draw()`,
  not after. A throw is therefore not swallowed — it still reaches the console,
  which is where a bug like this needs to be visible — but the following frame
  is already queued when it happens, so the scope keeps drawing.

- **REQ-canvas-context-loss-is-survivable** — **Canvas context loss is
  survivable.** The canvas listens for `contextlost` → `preventDefault()`
  (**without which the browser never restores it**) then `stop()`; and
  `contextrestored` → drop the cached gradients, zero the cached bitmap size so
  `measure()` re-allocates, then `start()`. Both listeners are removed in
  `destroy()`. This is the failure a backgrounded tab hits when the OS reclaims
  its canvas backing store, and the only one of the three that is not the app's
  own fault.

- **REQ-becoming-visible-re-measures** — **Becoming visible re-measures.**
  The `visibilitychange` → visible path, and a `pageshow` (a bfcache restore can
  reach a visible page without a `visibilitychange`), both call `measure()`
  before `start()`. `ResizeObserver` does not fire for a box that comes back the
  size it left, and `measure()` already refuses a 0×0 read
  (REQ-no-per-frame-layout-read), so this is free and cannot make things worse.
  `setFps` likewise rejects a non-finite or non-positive rate — `frameInterval`
  of `NaN`/`Infinity` is a loop that spins and never draws, which is the same
  black panel by a fourth route.

- **REQ-the-scope-proves-it-is-painting** — **The scope proves it is
  painting, not merely looping.** Two timestamps: `lastFrameTs`, written at the
  top of **every** rAF callback before the fps throttle, and `lastPaintTs`,
  written once `draw()` has returned without throwing. Nothing infers liveness
  from `running` — v12 already learned that flag latches `true` over a dead
  chain. `lastPaintTs` proves only that `syncSize()` passed and nothing threw;
  it is **not** evidence of pixels, and nothing here asks it to be. Its job is
  to separate a dead frame chain from a live one drawing into no layout box.

- **REQ-a-watchdog-restarts-a-stalled-loop** — **A ~1 Hz watchdog restarts
  a stalled loop.** A `window.setInterval` inside the component checks — and
  **only while `document.hidden` is false** — whether the last frame is older
  than `SCOPE_STALL_MS`; if it is, it `measure()`s and `start()`s (a sleeping
  loop is not a stall: REQ-a-scope-with-nothing-to-show-sleeps). Frames
  arriving while paints are not means the layout box is gone, not the loop: that
  escalates to `measure()` alone and never to a canvas rebuild, because a panel
  with no box has nothing to draw and reports `no box` instead. The timer
  returns on its first line while hidden, so
  [performance-mode](performance-mode.md) REQ-scope-fps-and-fft-apply-live and
  [runtime-performance](runtime-performance.md)
  REQ-visibility-gating-is-for-pixels-not-sound's pause-while-hidden rule stay
  literally true; it allocates nothing, reads no layout, and `destroy()` clears
  it. The gate reads `document.hidden` rather than `visibilityState` so it
  agrees with `onVisibility` and stays drivable from one stub in the unit suite.

- **REQ-waiting-for-contextrestored-is-bounded** — **Waiting for a
  `contextrestored` is bounded.** `contextlost` still `preventDefault()`s and
  still stops the loop (REQ-canvas-context-loss-is-survivable) — but it now
  records *when*, and if no `contextrestored` arrives within
  `CONTEXT_RESTORE_MS` the component stops waiting and recovers itself. An
  unbounded wait is a dead panel no toggle can undo, and needs no backgrounding:
  a GPU-process crash fires `contextlost` on a visible, foregrounded tab. Stopping is also how you stop giving a browser that restores lazily any
  reason to restore.

- **REQ-a-lost-context-is-escaped-by-replacing-the-canvas** — **A provably
  lost context is escaped by replacing the canvas, not by asking for another
  one.** `getContext('2d')` on a canvas whose context is lost returns *that same
  lost context*, so a fresh `<canvas>` is the only guaranteed escape. The
  rebuild takes the new context **first** and abandons the swap if that returns
  `null` — never trade a live canvas for one that cannot be drawn into — then
  copies the class and `data-testid`, `replaceWith`s in the same DOM slot (which
  keeps it above `.scopeScreen` and below the three corner buttons — slot order
  is load-bearing), moves the `click`, `contextlost`/`contextrestored` and
  mode-scoped hover registrations and the `ResizeObserver`, drops every cache
  **and every dataset mirror** — REQ-the-scope-canvas-carries-a-testid's
  change-only write would otherwise leave the replacement's readouts blank for
  the life of the page — then `measure()`s and `start()`s. When the canvas has
  no parent (the unit suite) the field is still swapped, because `replaceWith`
  on an unparented node is a silent no-op. `el` becomes a getter over a mutable
  field and stays read-only to callers. The rebuild is **rate-limited** to one
  per `REBUILD_MIN_GAP_MS`: a machine whose GPU process is really gone answers
  `isContextLost()` truthfully every time it is asked, and an unbounded watchdog
  would mint a fresh canvas and a fresh bitmap every second for the life of the
  page — turning the recovery into a leak. Recovery stays automatic when the GPU
  returns; only the retry rate is bounded.

- **REQ-scope-detection-is-free-or-it-does-not-happen** — **Detection is
  free or it does not happen.** A lost context is found by
  `ctx.isContextLost?.()` and by REQ-waiting-for-contextrestored-is-bounded's
  unanswered `contextlost` — **never by reading pixels back.** `getImageData`
  forces a GPU→CPU readback with a pipeline flush onto the thread the audio
  control path shares, and browsers de-accelerate a canvas that is read back
  often, so the probe would cost the panel its frame rate to ask whether it has
  one. It is also circular: a lost 2D context makes every method a no-op rather
  than throwing, so the fill the probe reads back is the very thing under test.
  Where a browser offers neither signal the scope does not guess — it keeps
  restarting the loop, which is free, and the Debug row
  (REQ-the-panel-says-whether-it-is-drawing) is what says so.

- **REQ-every-public-mutator-is-a-recovery-path** — **Every public mutator
  is a recovery path, and costs nothing when there is nothing to recover.**
  `setMode`, `setChannels`, `setZones`, `resetPeak`, `setFps` and `setFftSize`
  each call `ensureLive()`, as do a **non-capturing** `window` `focus` listener
  and the Page Lifecycle `resume` on `document` — a renderer frozen and resumed
  while already visible fires neither `visibilitychange` nor `pageshow`. The
  user's instinct on a dead scope is to poke a button, and that instinct must
  work. `ensureLive()` returns immediately when frames are arriving and the
  context is sound, so poking a *healthy* scope forces no layout read and
  re-arms no frame. The focus listener must not be registered with `capture`:
  `focus` does not bubble, so a capturing listener would route every knob,
  button and field in the app through here.

- **REQ-the-panel-says-whether-it-is-drawing** — **The panel says out loud
  whether it is drawing.** `Scope.health` reports drawing/asleep/stalled, the age of
  the last frame and paint, whether there is a layout box, whether the context
  is lost, and the restart/rebuild/loss counters. It reaches the Debug panel
  through `setScopeStatsSource` ([debug-panel](debug-panel.md)
  REQ-the-debug-extension-contract/REQ-an-unbound-row-reads-n-a) and increments
  `data-rebuilds` on the canvas — on change only, per REQ-the-scope-canvas-carries-a-testid/REQ-no-per-frame-layout-read, which here
  means essentially never. A device with no console must still be able to report it.

- **REQ-a-scope-with-nothing-to-show-sleeps** — **The redraw loop sleeps
  while there is nothing to draw.** Once every channel's input has stayed at or
  under `WAVE_SILENCE_PEAK` for `SCOPE_SLEEP_AFTER_MS` (500 ms) and the frame on
  screen has settled (in Spectrum, every peak-hold at the floor; no hover readout
  showing), the loop draws that frame and stops arming `requestAnimationFrame`.
  Asleep, a `SCOPE_WAKE_POLL_MS` (50 ms) timer reads each analyser's time-domain
  data and nothing else: no canvas, no layout, no dataset write. A sample over
  the gate restarts the loop, so a sound's first frame is at most one poll late.
  Every other way in wakes it too and draws: a public mutator
  (REQ-every-public-mutator-is-a-recovery-path), a pointer move, leave or click on
  the canvas, a re-measure, a restored or rebuilt canvas, becoming visible. Sleep
  is a liveness state, not a stall: the watchdog and `ensureLive` leave a sleeping
  loop alone, `health` reports it as `asleep` rather than stalled, and the Debug
  panel's Scope row says so. While hidden the poll is stopped as well, so the
  pause-while-hidden rule is unchanged. Why: a rAF chain is a main-thread frame
  every vsync even when each frame redraws a flat line, so an idle app spent most
  of its main-thread time redrawing silence, and every such frame also restyled
  the play button's composited attract pulse, 60 style recalcs a second that the
  pulse alone never needs ([runtime-performance](runtime-performance.md)).

## Technical design

### Contract / public interface

`Scope.ensureLive()` and `Scope.health` are on the [scope](scope.md) contract.

```ts
// Liveness (REQ-the-scope-proves-it-is-painting and the REQs after it). Exported ms constants, one record, one reader:
const SCOPE_WATCHDOG_MS = 1000;    // how often the watchdog looks; gated on document.hidden
const SCOPE_STALL_MS = 1200;       // no rAF callback for this long => the frame chain is dead
const SCOPE_PAINT_STALL_MS = 1500; // frames but no paints => no layout box (clears 15fps weak tier)
const CONTEXT_RESTORE_MS = 3000;   // a contextrestored that has not come by now is not coming
const REBUILD_MIN_GAP_MS = 5000;   // one canvas rebuild per this, so a dead GPU cannot leak
const SCOPE_SLEEP_AFTER_MS = 500;  // quiet frames for this long => asleep (REQ-a-scope-with-nothing-to-show-sleeps)
const SCOPE_WAKE_POLL_MS = 50;     // a sleeping scope's analyser read: its only work
interface ScopeHealth {
  asleep: boolean; drawing: boolean; frameAgeMs: number; paintAgeMs: number;
  hasBox: boolean; contextLost: boolean;
  restarts: number; rebuilds: number; losses: number;
}

// src/state/debug-sources.ts — the Debug panel's late-bound reader (REQ-the-panel-says-whether-it-is-drawing):
function setScopeStatsSource(fn: () => ScopeHealth): void;
function scopeStats(): ScopeHealth | undefined;   // undefined => the row reads "n/a"
```

## Scenarios (BDD)

```gherkin
Scenario: The scope comes back after the tab was hidden (regression)
  Given the scope is drawing and the tab is hidden, pausing the loop
  When the tab becomes visible again
  Then the canvas is measured and the loop restarts and draws
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A frame that throws does not kill the loop for good (regression)
  Given the scope is drawing
  When one draw throws
  Then the next animation frame is still delivered and draws
   And a restart after a broken frame chain re-arms rather than early-returning
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A lost canvas context is restored, not left black
  Given the browser reclaims the canvas backing store and fires contextlost
  Then the event's default is prevented, so the browser will restore it
   And the loop stops until it is restored
  When contextrestored fires
  Then the cached bitmap size and gradients are dropped and the loop draws again
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A nonsense frame rate cannot silently stop the drawing (edge)
  Given a mounted scope
  When setFps is called with 0, a negative number or NaN
  Then the target rate falls back to the default instead of never drawing
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The watchdog restarts a loop the browser stopped delivering (REQ-a-watchdog-restarts-a-stalled-loop)
  Given the scope is drawing and the tab is visible
  When the renderer drops the queued frame with nothing to announce it
   And more than SCOPE_STALL_MS passes
  Then the next watchdog tick measures and restarts the loop, and it draws
   And health.restarts has incremented
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The watchdog does nothing at all while the tab is hidden (REQ-a-watchdog-restarts-a-stalled-loop)
  Given the tab is hidden, so the loop is paused
  When many watchdog ticks pass with the loop stalled
  Then no frame is queued and nothing is drawn
   And the pause performance-mode.md REQ-scope-fps-and-fft-apply-live requires is untouched
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The watchdog leaves a healthy loop completely alone (REQ-a-watchdog-restarts-a-stalled-loop/REQ-every-public-mutator-is-a-recovery-path)
  Given frames are arriving on time
  When several watchdog ticks pass
  Then no frame is cancelled or re-armed and health.restarts is 0
   And a mutator called on that healthy loop cancels nothing either
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: Frames without paints measure rather than rebuild (REQ-a-watchdog-restarts-a-stalled-loop)
  Given the loop is ticking but the canvas reports a 0x0 layout box
  When the paint age passes SCOPE_PAINT_STALL_MS
  Then the watchdog measures, health.hasBox is false, and the canvas is not replaced
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The scope stops waiting for a contextrestored that never comes (REQ-waiting-for-contextrestored-is-bounded)
  Given contextlost fired and its default was prevented, stopping the loop
   And no contextrestored arrives within CONTEXT_RESTORE_MS
  When the next watchdog tick runs
  Then the scope recovers itself instead of waiting forever
   And this needs no visibilitychange, because the page never stopped being visible
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A provably lost context is escaped by replacing the canvas (REQ-a-lost-context-is-escaped-by-replacing-the-canvas)
  Given the 2D context reports isContextLost
  When any control is used, or the watchdog ticks
  Then a fresh canvas replaces the old one in the same DOM slot
   And it carries the class, the testid and every listener the old one had
   And the dataset mirror is cleared, so its readouts appear again
   And health.rebuilds has incremented
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A GPU that never comes back is retried, not rebuilt every second (REQ-a-lost-context-is-escaped-by-replacing-the-canvas)
  Given the context reports itself lost on every ask, as a dead GPU process does
  When several REBUILD_MIN_GAP_MS pass
  Then the canvas is replaced at most once per gap, not once per watchdog tick
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A live canvas is never traded for one that cannot be drawn into (REQ-a-lost-context-is-escaped-by-replacing-the-canvas, edge)
  Given the context is lost and a rebuild is due
  When getContext on the replacement returns null
  Then the swap is abandoned and the existing canvas is kept
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: Every control revives a stalled scope (REQ-every-public-mutator-is-a-recovery-path)
  Given the loop is stalled and the tab is visible
  When any of setMode, setChannels, setZones, resetPeak, setFps or setFftSize is called
  Then the loop is live again and draws
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A window focus and a Page Lifecycle resume both revive it (REQ-every-public-mutator-is-a-recovery-path)
  Given the loop is stalled
  When window fires focus, or document fires resume
  Then the loop is live again
   And a focus on an element inside the app does not reach the handler
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The watchdog dies with the scope (REQ-a-watchdog-restarts-a-stalled-loop)
  Given a mounted scope
  When destroy() is called and the clock runs far past several watchdog periods
  Then no frame is queued, nothing throws, and no restart is counted
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: The panel reports what it is doing (REQ-the-panel-says-whether-it-is-drawing)
  Given a mounted scope
  Then health reports drawing, the frame and paint ages, the box and the context
   And the restart, rebuild and loss counters rise with the events that cause them
   And data-rebuilds is written only when it increments
# pinned by: tests/ui/scope-lifecycle.test.ts

Scenario: A silent scope stops arming frames (REQ-a-scope-with-nothing-to-show-sleeps)
  Given the Wave view and an input at or under WAVE_SILENCE_PEAK
  When SCOPE_SLEEP_AFTER_MS passes
  Then it draws once more and requests no further animation frame
  And only the wake poll runs, reading the analysers and touching no canvas
# pinned by: tests/ui/scope-sleep.test.ts

Scenario: A sound wakes it within one poll (REQ-a-scope-with-nothing-to-show-sleeps)
  Given a sleeping scope
  When a poll reads a sample over WAVE_SILENCE_PEAK
  Then the loop restarts and draws on the next frame
# pinned by: tests/ui/scope-sleep.test.ts

Scenario: The Spectrum stays awake until its peak-holds have fallen (REQ-a-scope-with-nothing-to-show-sleeps, edge)
  Given the Spectrum view with a held peak above the floor and a silent input
  Then the loop keeps drawing while the peak decays, and sleeps once every hold is at the floor
# pinned by: tests/ui/scope-sleep.test.ts

Scenario: Any control or pointer wakes it and it redraws (REQ-a-scope-with-nothing-to-show-sleeps)
  Given a sleeping scope
  When the mode or channel toggle, the fps or FFT setter, a pointer over the canvas or a click acts on it
  Then a frame is drawn showing the change
# pinned by: tests/ui/scope-sleep.test.ts

Scenario: A sleeping loop is not a stall (REQ-a-scope-with-nothing-to-show-sleeps, REQ-a-watchdog-restarts-a-stalled-loop)
  Given a scope that has slept for longer than SCOPE_STALL_MS
  When the watchdog ticks and ensureLive is called
  Then neither restarts it, and health reports asleep, not stalled
  And while the page is hidden no wake poll runs
# pinned by: tests/ui/scope-sleep.test.ts

Scenario: An idle app costs almost nothing on the main thread (REQ-a-scope-with-nothing-to-show-sleeps, perf)
  Given the app open, the transport stopped and nothing sounding
  When npm run bench:perf measures idle
  Then main-thread busy falls to near zero against a before run
# pinned by: npm run bench:perf --compare (a before/after pair)
```

## Tests & verification

- `tests/ui/scope-lifecycle.test.ts` (one case per recovery route, and the watchdog
  under fake timers; its frame scheduler and recording context are
  `tests/ui/scope-harness.ts`), `tests/ui/scope-sleep.test.ts` (sleep, wake, and
  that a sleeping loop is no stall); `e2e/scope.spec.ts` (an unanswered
  `contextlost`, a real backgrounding).
- **By hand**, in Firefox and Chrome with a demo playing: stub
  `requestAnimationFrame` away, watch `debug-scope` go `stalled`, restore it and see
  the trace return within about a second; dispatch an unanswered `contextlost` and
  see the panel return within ~4 s with `rebuilds` at `1`; while stalled, each of
  Wave/Spectrum, Mono/Stereo and Zones must revive it; background the tab (on
  Android under Battery Saver, through recents, with a rotation) and check the
  frame age on return reads large.
