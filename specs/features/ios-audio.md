# iOS audio

```yaml
id: ios-audio
status: implemented
version: 1
owner: core
related:
  - architecture
  - performance-mode
  - audio-export
source:
  - src/platform/ios.ts
  - src/audio/ios-audio-session.ts
  - src/audio/engine.ts
  - src/ui/components/about.ts
  - src/ui/app.ts
```

iOS-only audio-session workarounds: a silent looping `<audio>` element played
from the start gesture to upgrade the page's audio session to the **playback**
category (so output ignores the ring/silent switch), plus re-resume on
interruption/backgrounding. Ships alongside a small, **cross-platform** Debug
section in the About modal that surfaces live `AudioContext` state.

## Background / Why

On iOS (every browser — they all use WebKit) pure Web Audio is routed as
*ambient* audio, which **honors the physical ring/silent switch**: the
`AudioContext` runs, nodes process, the scope animates from the analyser — but no
sound reaches the speaker when the switch is set to silent. Desktop browsers have
no such category, which is why the synth works there and is silent on iPhone/iPad.
The fix is the well-known trick: play a silent **HTMLMediaElement** from within a
user gesture, which flips the page's audio session to the *playback* category
(ignores the switch, like YouTube/Spotify). iOS additionally drops the context
into a non-standard `'interrupted'` state on phone calls, Siri, and app-switching,
after which `Engine.resume()` (which only checked `'suspended'`) left it dead.

These are device-specific runtime quirks, so — like [`performance-mode`](performance-mode.md)
— they are gated on a device check and never touch `ParamBus`, presets, or songs.
The work is hard to debug without a console on the device, so it also seeds a
keepable Debug section in the About modal (`ctx.state` + iOS flag today; more
later).

## Requirements

- **REQ-1** — `isIOS()` detects iOS: a UA match for `iPhone | iPad | iPod`, **or**
  the iPadOS-13+ desktop-mode case (`navigator.platform === 'MacIntel'` **and**
  `navigator.maxTouchPoints > 1`). Pure; safe when `navigator` is absent (returns
  `false`). Kept separate from `detectWeakDevice()` (`perf-mode.ts`) — different
  concern (OS identity vs. weak hardware).
- **REQ-2** — `IosAudioSession` lazily builds **one** silent, **looping**
  `<audio>` element whose source is a tiny silent stereo WAV produced by the
  existing `encodeWav` (`audio/recorder/encode.ts`) via `URL.createObjectURL` —
  no hardcoded base64, one WAV encoder in the codebase. `playsinline` is set as an
  attribute (TS `HTMLMediaElement` has no `playsInline`).
- **REQ-3** — `IosAudioSession.unlock()` plays that element (errors swallowed) to
  switch the session to *playback*; `rearm()` replays it after an interruption.
  Both are **no-ops off iOS** (`active === false`) and never throw.
- **REQ-4** — `Engine.resume()` calls `iosSession.unlock()` first (synchronous,
  within the gesture), then resumes the context whenever
  `shouldResumeContext(ctx.state)` is true — i.e. the state is neither `'running'`
  nor `'closed'`. This covers `'suspended'` **and** the non-standard
  `'interrupted'` without referencing a literal outside TS's `AudioContextState`.
- **REQ-5** — On iOS only (`iosSession.active`), `Engine.init()` installs a
  `document` `visibilitychange` listener and a `ctx` `statechange` listener; on
  return-to-foreground / a non-running state while visible they call
  `Engine.resume()` (which re-arms the silent loop). Off iOS, no listeners are
  added. Resume may still need a fresh gesture on some iOS versions — the next tap
  is the natural fallback (no extra code).
- **REQ-6** — Fully inert off iOS: `Engine` builds and resumes exactly as before
  (`resume()` still only acts on `'suspended'` because `shouldResumeContext` is
  true there too), no `<audio>` element is created, and no listeners are added.
  `main.ts` is unchanged — `await engine.resume()` keeps doing everything.
- **REQ-7** — The About modal gains a **default-collapsed** "Debug" section
  (cross-platform), built with the existing `createCollapseToggle` (persisted
  under `localStorage['websynth.debug.about']`). It shows a key/value list seeded
  with **AudioContext state** (live: refreshed on open + a `statechange` listener
  while the modal is open), **iOS** (`isIOS()` yes/no), **sample rate**. Structured
  so more rows can be appended later. `createAboutButton` takes a `StudioApi` to
  read `ctx`.

## Technical design

### Contract / public interface

```yaml
# src/platform/ios.ts
isIOS(): boolean

# src/audio/ios-audio-session.ts
shouldResumeContext(state: string): boolean        # state !== 'running' && state !== 'closed'
class IosAudioSession:
  active: boolean                                   # = isIOS(), read once
  unlock(): void                                    # play silent looping <audio> (in-gesture); no-op off iOS
  rearm(): void                                     # replay after interruption; no-op off iOS / before first unlock

# src/audio/engine.ts
Engine.resume(): Promise<void>                      # iosSession.unlock(); if shouldResumeContext(ctx.state) → ctx.resume()
# Engine.init(): if iosSession.active → add visibilitychange + ctx 'statechange' listeners → resume()

# src/ui/components/about.ts
createAboutButton(engine: StudioApi): HTMLButtonElement
# Debug section testids: debug-section (collapsible body), debug-ctx-state row
```

### Layer touchpoints & ordering

```yaml
engine ctor: this.iosSession = new IosAudioSession()        # cheap; element built lazily on first unlock
engine.init(): if iosSession.active → install resume listeners (after graph + voices exist)
engine.resume(): unlock() (sync, in gesture) → shouldResumeContext(ctx.state) ? ctx.resume()
main.ts: unchanged — start handler still calls `await engine.resume()`
ui (app.ts): createAboutButton(engine)  # engine is the StudioApi already threaded everywhere
```

### Persistence

`localStorage['websynth.debug.about']` = collapse state (`0|1`) of the Debug
section, default collapsed — same `websynth.*` + try/catch convention as
`collapse-toggle.ts`. **Deliberately not persisted into presets or songs**: the
iOS workaround and the debug panel describe the device/runtime, not the sound; no
`ParamBus` param and no `SongFile`/preset field (mirrors `performance-mode`).

## Scenarios (BDD)

```gherkin
Scenario: iPhone is detected as iOS
  Given navigator.userAgent contains "iPhone"
  When isIOS runs
  Then it returns true
# pinned by: tests/platform/ios.test.ts

Scenario: iPadOS desktop mode is detected as iOS
  Given navigator.platform is "MacIntel" and maxTouchPoints is 5
  When isIOS runs
  Then it returns true
# pinned by: tests/platform/ios.test.ts

Scenario: Desktop and Android are not iOS
  Given a Windows or Android user agent with no touch points
  When isIOS runs
  Then it returns false
# pinned by: tests/platform/ios.test.ts

Scenario: Resume acts on suspended and interrupted, not running or closed
  Given an AudioContext state
  When shouldResumeContext runs
  Then it is true for "suspended" and "interrupted" and false for "running" and "closed"
# pinned by: tests/audio/ios-audio-session.test.ts

Scenario: Off iOS the session is inert
  Given isIOS returns false
  When a new IosAudioSession is created and unlock/rearm are called
  Then active is false, no <audio> element is created, and play is never called
# pinned by: tests/audio/ios-audio-session.test.ts

Scenario: On iOS unlock plays a silent looping element
  Given isIOS returns true
  When unlock is called
  Then a looping, playsinline <audio> element is created and play() is invoked
# pinned by: tests/audio/ios-audio-session.test.ts

Scenario: About modal has a collapsed Debug section reflecting context state
  Given a StudioApi whose ctx.state is "running"
  When the About modal is opened
  Then a Debug section exists, is collapsed by default, and shows the context state
# pinned by: tests/ui/about.test.ts
```

## Tests & verification

- Unit: `tests/platform/ios.test.ts` (detection branches via `vi.stubGlobal('navigator', …)`),
  `tests/audio/ios-audio-session.test.ts` (`shouldResumeContext` + on/off-iOS
  `unlock`/`rearm`; stubs `URL.createObjectURL` and `HTMLMediaElement.prototype.play`),
  `tests/ui/about.test.ts` (Debug section present, collapsed, shows ctx state) — `npm test`
- Typecheck: `npm run typecheck`
- Manual (the silent-switch + interruption paths can only be seen on real iOS;
  headless Chromium can't): `npm run dev` prints a LAN URL — **http LAN is fine**
  (plain audio + `<audio>` need no secure context; only the mic does). On an
  iPhone/iPad with the **ring/silent switch set to silent**: Tap to start, play a
  key → sound should now come out. Open About → Debug → confirm `state = running`
  and `iOS = yes`. Trigger Siri / background the tab and return → audio resumes.

## Open questions / future

- A future adaptive layer could *measure* underruns; out of scope here.
- The Debug section is intentionally minimal and extensible — more rows
  (perf-mode resolution, voice count, sample-rate mismatch, last error) can be
  appended without a contract change.
