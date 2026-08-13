# Audio lifecycle (start, background, recovery)

```yaml
id: audio-lifecycle
status: implemented
version: 4   # v4: REQ-10 — a severe reading trips on ONE window (measured: a Pixel
             #     8a runs its backgrounded audio clock at 36% of real time)
             # v3: REQ-9..REQ-12 — the background watchdog
owner: core
related:
  - architecture
  - transport
  - ios-audio
  - media-session
  - pwa-install
  - performance-mode
  - debug-panel
source:
  - src/audio/engine.ts
  - src/audio/background-watchdog.ts
  - src/audio/transport/clock.ts
  - src/audio/ios-audio-session.ts
  - src/types/pwa.d.ts                # AudioRenderCapacity ambient types
  - src/ui/studio-api.ts
  - src/ui/components/about-debug.ts   # the Debug rows that surface context state
```

What happens to the audio around the edges of a session: the moment the context
starts, the moment the OS takes it away (screen off / app switch), and the moment
it comes back. Cross-cutting glue between [`transport`](transport.md) (the clock),
[`ios-audio`](ios-audio.md) (the iOS session category) and
[`pwa-install`](pwa-install.md) (the wake lock) — each of which owns its own half.

## Background / Why

Two device-reported faults, both at a lifecycle edge and neither reproducible on
desktop.

**1. A click when the app opens.** `AudioContext.resume()` starts the output
stream with `master.gain` already at its full value, so whatever the graph's
first rendered block contains — the device's own stream-start transient, the
worklets' first output, an underrun while the tap-to-start handler is still
running `initMIDI` and fading the modal out — arrives as a step discontinuity at
full level. Nothing in the graph is *wrong*; there is simply no ramp between "not
rendering" and "rendering at 0.64 gain".

**2. Android (Pixel 8a) goes haywire when the screen turns off.** Crackling and a
runaway clock; a Samsung tablet on the same build is fine. The cause is not the
audio graph but what the OS does to a hidden page: Chrome/Android freezes or
heavily throttles its renderer (the same page on the tablet keeps running), so
the clock's worker wakeups stop arriving while `ctx.currentTime` keeps advancing.
The look-ahead drain loop had no bound, so the next wakeup — a minute later —
drained *every* missed 16th in one pass: several hundred notes all scheduled in
the past, clamped to `now` downstream and fired simultaneously, with `_step`
racing through the song. That is the **runaway clock**, and a bounded catch-up in
the clock fixes it ([`transport`](transport.md) REQ-9).

On the device it fixed the runaway and **not** the crackle — which is how we know
the two had different causes. The crackle is the throttling itself starving the
audio callback, so the second half of the answer is to stop Android throttling us:
be a media player it recognises ([`media-session`](media-session.md), REQ-8). This
spec owns the policy tying them together — what resumes, what fades, what keeps
the session alive, and what the Debug panel shows.

## Requirements

- **REQ-1** — **A start is click-free.** When `Engine.resume()` actually resumes a
  non-running context it fades the master bus in from silence: `cancelScheduledValues`
  → `setValueAtTime(0, t)` → `linearRampToValueAtTime(target, t + RESUME_FADE_S)`,
  where `t = ctx.currentTime` and `target` is the master-volume law already in force
  (`bus.get('master.volume') ** 2`, matching the `master.volume` subscription).
  `RESUME_FADE_S = 0.15` — long enough to swallow a stream-start transient and the
  first-block settling of the worklets, short enough to be inaudible as a fade after
  a deliberate tap.

- **REQ-2** — **The fade only ever happens on a real resume.** It is gated on the
  same `shouldResumeContext(ctx.state)` check as `ctx.resume()` itself, so calling
  `resume()` on an already-running context (the About panel's toggle, the iOS
  re-arm path, `app.ts`'s `resumeAudio`) neither dips nor re-ramps live audio.
  `iosSession.unlock()` still runs unconditionally first (it is the in-gesture
  session-category call — [`ios-audio`](ios-audio.md) REQ-4).

- **REQ-3** — **The ramp is scheduled before the resume is awaited.** `currentTime`
  is frozen while a context is suspended, so scheduling at `t = ctx.currentTime`
  before `await ctx.resume()` guarantees the ramp covers the *first* rendered
  blocks rather than starting somewhere inside them.

- **REQ-4** — **Returning to the foreground re-arms the context on every platform.**
  `Engine.init()` installs a `document` `visibilitychange` listener unconditionally:
  on becoming visible it calls `resume()` when `shouldResumeContext(ctx.state)` —
  Android suspends a hidden page's context and it stays suspended on return. On iOS
  the call is unconditional (the silent loop must be replayed to hold the media-backed
  session category even when the context survived), and the `ctx` `statechange`
  listener stays iOS-only. See [`ios-audio`](ios-audio.md) REQ-5.

- **REQ-5** — **`statechange` must not fight a deliberate suspend.** The Debug
  panel's Suspend action suspends a *visible* context; auto-resuming from
  `statechange` off iOS would undo it instantly, so that listener is not installed
  there (REQ-4). The iOS case is the deliberate exception: `'interrupted'` arrives
  while visible and there is nothing else to recover from it.

- **REQ-6** — **A frozen renderer produces silence, never a burst.** While the
  wakeup source is stalled the transport emits nothing at all, and it resumes from
  the step it was on once wakeups return — see [`transport`](transport.md) REQ-9 for
  the mechanism and for why the playhead does not fast-forward across the gap. The
  transport is deliberately **not** stopped and no user-visible state changes:
  screen-off playback that works (the Samsung tablet, desktop, iOS with the silent
  loop) is unaffected, and a device that cannot deliver wakeups goes quiet instead
  of going haywire.

- **REQ-7** — **The recovery is observable.** `Clock.dropouts` counts recoveries
  for the session and is appended to the Debug panel's Transport row
  ([`debug-panel`](debug-panel.md)), so the failure this spec exists for can be
  confirmed from a phone with no console — which is the only place it reproduces.

- **REQ-8** (v2) — **The OS is told there is a player here.** `resume()` also
  unlocks the [`media-session`](media-session.md) keep-alive, and the foreground
  re-arm (REQ-4) re-arms it, both alongside their iOS counterparts and both
  no-ops off their platform. REQ-6 above is the *safe* outcome for a page the OS
  has throttled; the keep-alive is the attempt to stop it being throttled at all.
  It was added after REQ-6 shipped and fixed the runaway clock on a Pixel 8a
  without fixing the crackle — which is what ruled out the missed-step burst as
  the crackle's cause.

- **REQ-9** (v3) — **Backgrounded audio that is measurably breaking up is
  suspended, not left to crackle.** While the page is **hidden** and the context
  is **running**, a watchdog samples how the audio thread is actually doing every
  `SAMPLE_S` (0.25 s) and, when the windows come back bad (REQ-10), fades the
  master out and suspends the context. Returning to the foreground resumes and
  fades back in through the existing path (REQ-4/REQ-1), and because a suspended
  context freezes `currentTime`, the transport's grid is untouched — it picks up
  exactly where it was, the same "a dropout is a pause" contract as REQ-6.

- **REQ-10** (v3) — **The trip is measured, never inferred from the device.** Two
  signals, in order of precision:
  - **`AudioContext.renderCapacity`** (Chrome 115+) reports `underrunRatio` — the
    fraction of render quanta that missed their deadline, i.e. the crackle itself.
    A window is bad at `underrunRatio > 0.01` (≈4 glitches a second at a 128-frame
    quantum, already plainly audible). Started on hide, stopped on show, so it
    costs nothing in the foreground. **Not universal**: the Pixel 8a this was
    built for runs a Chrome that does not expose it, which is why the fallback
    below is not optional.
  - **Audio-clock drift** — `ctx.currentTime` advancing slower than
    `performance.now()` over the window, bad below 90 %. This is the fallback
    where `renderCapacity` is absent, and the only signal that catches an outright
    *frozen* renderer (where the audio thread is not underrunning, it is not
    running at all). Sampled from a **worker-backed** `TickTimer`, the same
    facility [`transport`](transport.md) REQ-4 uses, so throttled main-thread
    timers cannot blind it.

  **Two bad windows trip — or one, when the reading is severe** (v4:
  `underrunRatio > 0.1`, or the audio clock under `SEVERE_DRIFT` = 50 % of real
  time). The second window only ever bought *confirmation*, and it is paid for in
  audible crackle: the device this exists for measured **35.7 %** — a third of
  real time — so there was nothing left to confirm. A false trip is close to free
  (the page is hidden, and returning resumes and fades in either way), while a
  slow trip is heard. Marginal readings still need their second window.

  **No user-agent check anywhere.** The failing device was a Pixel 8a while a
  Samsung tablet on the same build played through a screen-off fine; gating on
  "is Android" would have stopped the tablet too. A device that does not underrun
  never trips.

- **REQ-11** (v3) — **It never interrupts a real-time capture.** The trip is
  refused while `recorder.isCapturing()` or `bankRender.isRendering()`
  ([audio-export](audio-export.md), [render-to-sampler](render-to-sampler.md)):
  both record the live output in real time, so suspending mid-take would silently
  truncate the file. A capture running in a backgrounded tab keeps whatever
  crackle the device gives it — a damaged take beats a truncated one, and the
  Debug row still shows what happened.

- **REQ-12** (v3) — **The measurement is visible whether or not it trips.**
  `Engine.backgroundAudio` (`{ supported, watching, underrunRatio, worstUnderrunRatio,
  driftRatio, suspensions }`) is part of `StudioApi` and renders as the **Background
  audio** row (`debug-background`) in the [`debug-panel`](debug-panel.md). This is
  deliberate: if a device crackles while its `underrunRatio` reads **zero**, the
  glitching is happening downstream of the renderer and nothing in this app can
  reach it — which is a finding, not a dead end.

## Technical design

### Contract / public interface

```yaml
# src/audio/engine.ts
RESUME_FADE_S = 0.15                 # module constant
Engine.resume(): Promise<void>       # unlock()s (iOS + Android) → (if resuming) fadeInMaster() → ctx.resume()
Engine.installContextRearm(): void   # private, called from init(); replaces installIosRearm
                                     #   visibilitychange (all platforms) + statechange (iOS only)

# src/audio/transport/clock.ts       — see transport.md REQ-9
Clock.dropouts: number               # recoveries this session (monotonic, never reset)

# src/audio/background-watchdog.ts   — v3
SAMPLE_S = 0.25, UNDERRUN_TRIP = 0.01, DRIFT_TRIP = 0.9, BAD_WINDOWS = 2
SEVERE_UNDERRUN = 0.1, SEVERE_DRIFT = 0.5      # v4: one window is enough
WatchdogDiagnostics: { supported, watching, underrunRatio, worstUnderrunRatio, driftRatio, suspensions }
class BackgroundAudioWatchdog:
  constructor(ctx, opts: { onGlitch(): void; isBusy?(): boolean; doc?; timer?; now? })
  start(): void                      # install the visibilitychange listener
  get diagnostics(): WatchdogDiagnostics
Engine.backgroundAudio: WatchdogDiagnostics

# src/types/pwa.d.ts                 — ambient, not in lib.dom
AudioRenderCapacity: start({ updateInterval }) / stop() / 'update' event
  AudioRenderCapacityEvent: { timestamp, averageLoad, peakLoad, underrunRatio }
AudioContext.renderCapacity?: AudioRenderCapacity
```

### Layer touchpoints & ordering

```yaml
engine.resume():   iosSession.unlock(); media.unlock()       # sync, inside the gesture
                   #   ios-audio REQ-4 / media-session REQ-2 — each inert off its OS
                   shouldResumeContext(ctx.state) ? fadeInMaster() : return
                   await ctx.resume()                        # ramp already on the timeline (REQ-3)
engine.init():     installContextRearm()                     # after the graph + voices exist
                   #   on foreground: resume() as below, plus media.rearm() (REQ-8)
                   watchdog.start()                          # v3: AFTER recorder/bankRender —
                   #   isBusy() reads them (REQ-11)
watchdog trip:     master.gain → 0 over GLITCH_FADE_S, then ctx.suspend()
                   #   the fade first so the exit is not itself a click (REQ-1's sibling)
main.ts:           unchanged — the start handler still awaits engine.resume()
ui (about.ts):     Transport row appends `· <n> dropouts` (debug-panel.md)
wake lock:         unchanged — it follows ctx.state from main.ts and the OS drops it
                   on screen-off anyway (pwa-install.md REQ-1)
```

The fade writes the same `master.gain` the `master.volume` subscription ramps.
A volume change landing inside the 150 ms fade wins from that point (its
`setTargetAtTime` supersedes the ramp) — acceptable, and only reachable by
dragging master volume within 150 ms of pressing Start.

## Scenarios (BDD)

```gherkin
Scenario: Tap to start does not click
  Given a suspended AudioContext and master.volume at its default
  When Engine.resume() runs
  Then master.gain is set to 0 at ctx.currentTime
   And ramped to master.volume² at ctx.currentTime + RESUME_FADE_S
   And the ramp is scheduled before ctx.resume() is awaited
# pinned by: tests/audio/engine-resume.test.ts

Scenario: Resuming an already-running context does not dip the audio (edge)
  Given a running AudioContext
  When Engine.resume() runs (About-panel toggle, iOS re-arm)
  Then master.gain is left alone entirely
   And ctx.resume() is not called again
# pinned by: tests/audio/engine-resume.test.ts

Scenario: Android suspends the context while the screen is off
  Given the page is hidden and the OS suspended the context
  When the page becomes visible again
  Then Engine.resume() runs, fading the master back in
# pinned by: tests/audio/engine-resume.test.ts

Scenario: A deliberate suspend stays suspended (edge, off iOS)
  Given the Debug panel's Suspend action suspended a visible context
  When the statechange event fires
  Then the context is NOT auto-resumed
# pinned by: tests/audio/engine-resume.test.ts

Scenario: A backgrounded tab that underruns is suspended (v3)
  Given the page is hidden with the context running
  When two consecutive sample windows report underrunRatio above the trip
  Then the master is faded out and the context is suspended
   And returning to the foreground resumes it and fades back in
   And the transport continues from the step it was on
# pinned by: tests/audio/background-watchdog.test.ts

Scenario: A device that plays cleanly in the background is left alone (v3)
  Given the page is hidden and every window reports no underruns
  Then nothing is suspended, however long it stays hidden
# pinned by: tests/audio/background-watchdog.test.ts

Scenario: One bad window is not a trip (v3, edge)
  Given the page has just been hidden
  When a single window reports underruns and the next is clean
  Then the context keeps running
# pinned by: tests/audio/background-watchdog.test.ts

Scenario: A severe window is a trip on its own (v4)
  Given the page is hidden
  When one window reports the audio clock at 36% of real time
  Then the context is suspended without waiting for a second window
   And a merely marginal reading (80%) still waits for its second
# pinned by: tests/audio/background-watchdog.test.ts

Scenario: A capture in a backgrounded tab is never cut short (v3, REQ-11)
  Given an export is running and the page is hidden
  When the windows report underruns
  Then the context is NOT suspended
# pinned by: tests/audio/background-watchdog.test.ts

Scenario: A frozen renderer trips on drift where underruns cannot (v3)
  Given no renderCapacity support
  When the audio clock advances far slower than wall time while hidden
  Then the context is suspended
# pinned by: tests/audio/background-watchdog.test.ts

Scenario: Screen off on a device that freezes the renderer (device)
  Given the transport is playing on a Pixel 8a
  When the screen turns off for a minute and comes back on
  Then nothing was heard while it was off (no burst, no runaway)
   And playback continues from the step it was on
   And the Debug panel's Transport row shows the dropouts it recovered from
# verified manually on device; jsdom cannot pin this
```

## Tests & verification

- `tests/audio/engine-resume.test.ts` — the fade + re-arm policy, driven against
  `Engine.prototype` with a structural stub (the same technique as
  `engine-seek.test.ts`: it pins the production method, not a copy of it).
- `tests/audio/transport/clock.test.ts` — the dropout mechanism (transport.md REQ-9).
- By ear on device: the click is a startup transient, so the only real verification
  is opening the app on the phone that clicked ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md),
  `recipes/verify-audio-by-ear.md`).

## Open questions / future

- A dropout while **slaved** to MIDI/WiFi clock leaves the phase behind by the gap
  until the next re-anchor ([`midi-clock-sync`](midi-clock-sync.md) REQ-23/24). Not
  worth special-casing: a device that cannot run its own wakeups cannot hold sync
  either.
- ~~A `MediaSession`-backed keep-alive would let playback continue rather than go
  quiet.~~ **Built** (v2) — see [`media-session`](media-session.md). REQ-6 stayed:
  it is the safe outcome whenever the keep-alive is not enough (or not enabled).
- **Remembering the verdict per device — considered and deliberately not built.**
  The watchdog measures afresh on every backgrounding, so a device that starves
  its audio pays a short burst of crackle *each time* before the trip (v4 cut that
  to roughly a quarter-second). Persisting the verdict — a `localStorage` flag set
  the first time it trips, after which hiding the page fades and suspends
  immediately with no measurement — would take that to **zero**.

  It is not built because the failure mode is worse than the symptom it removes: a
  single false trip (a device momentarily starved by something else entirely) would
  silently disable background playback on hardware that is perfectly capable of it,
  permanently, via a flag nobody would think to look for. The measurement is
  self-correcting; a remembered verdict is not.

  If it is ever wanted, the shape that bounds the downside is: **re-measure once
  per app launch** (the flag only skips measurement for *subsequent* backgroundings
  within a session) and surface it in the Debug row + clear it on factory reset, so
  a wrong verdict can never outlive the session that formed it. Cost/benefit says
  wait for a device where a quarter-second is genuinely unacceptable.
