# Audio lifecycle (start, background, recovery)

```yaml
id: audio-lifecycle
status: implemented
version: 1
owner: core
related:
  - architecture
  - transport
  - ios-audio
  - pwa-install
  - performance-mode
  - debug-panel
source:
  - src/audio/engine.ts
  - src/audio/transport/clock.ts
  - src/audio/ios-audio-session.ts
  - src/ui/components/about.ts
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
audio graph but the *wakeup source*: Chrome/Android freezes or heavily throttles
the renderer of a hidden page (the same page on the tablet keeps its timers), so
the clock's worker wakeups stop arriving while `ctx.currentTime` keeps advancing.
The look-ahead drain loop had no bound, so the next wakeup — a minute later —
drained *every* missed 16th in one pass: several hundred notes all scheduled in
the past, clamped to `now` downstream and fired simultaneously (the crackle),
with `_step` racing through the song (the runaway clock). The fix is a bounded
catch-up in the clock ([`transport`](transport.md) REQ-9); this spec owns the
surrounding policy — what resumes, what fades, and what the Debug panel shows.

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

## Technical design

### Contract / public interface

```yaml
# src/audio/engine.ts
RESUME_FADE_S = 0.15                 # module constant
Engine.resume(): Promise<void>       # unlock() → (if resuming) fadeInMaster() → ctx.resume()
Engine.installContextRearm(): void   # private, called from init(); replaces installIosRearm
                                     #   visibilitychange (all platforms) + statechange (iOS only)

# src/audio/transport/clock.ts       — see transport.md REQ-9
Clock.dropouts: number               # recoveries this session (monotonic, never reset)
```

### Layer touchpoints & ordering

```yaml
engine.resume():   iosSession.unlock()                       # sync, inside the gesture (ios-audio REQ-4)
                   shouldResumeContext(ctx.state) ? fadeInMaster() : return
                   await ctx.resume()                        # ramp already on the timeline (REQ-3)
engine.init():     installContextRearm()                     # after the graph + voices exist
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
- If a device turns out to *keep* rendering audio with the screen off while its
  timers stall, a `MediaSession`-backed keep-alive (the Android sibling of the iOS
  silent loop) would let playback continue rather than go quiet. Not built: it
  needs the failing device in hand to tell "renderer frozen" from "context
  suspended", and REQ-6 is already the safe outcome for both.
