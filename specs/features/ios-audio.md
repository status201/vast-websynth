# iOS audio

```yaml
id: ios-audio
status: implemented
version: 2
owner: core
related:
  - architecture
  - performance-mode
  - audio-export
  - debug-panel
source:
  - src/platform/ios.ts
  - src/audio/ios-audio-session.ts
  - src/audio/engine.ts
  - src/ui/components/about.ts
  - src/ui/studio-api.ts
  - src/ui/app.ts
```

iOS-only audio-session workarounds: a silent looping `<audio>` element **routed
through the AudioContext** (played from the start gesture) so the context's own
audio session is upgraded off the *ambient* category that honors the ring/silent
switch, plus re-resume on interruption/backgrounding. Its diagnostics are surfaced
in the reusable [`debug-panel`](debug-panel.md).

## Background / Why

On iOS (every browser — they all use WebKit) pure Web Audio is routed as
*ambient* audio, which **honors the physical ring/silent switch**: the
`AudioContext` runs, nodes process, the scope animates from the analyser — but no
sound reaches the speaker when the switch is set to silent. Desktop browsers have
no such category, which is why the synth works there.

A first attempt played a **detached** silent `<audio>` element from the gesture
(the well-known "elevate the page's media session to *playback*" trick). On
BrowserStack Live this fixed the **iPad** (which has **no** hardware mute switch)
but **not the iPhone** (which does) — with the context confirmed `running` via the
Debug panel, the iPhone stayed silent. A detached element only elevates the *page*
session; it does not lift the **AudioContext's own** session category. The robust
fix is to feed the silent element **through the context** —
`ctx.createMediaElementSource(el).connect(ctx.destination)` — which makes the
context itself *media-backed* and lifts it off the ambient category. iOS
additionally drops the context into a non-standard `'interrupted'` state on phone
calls, Siri, and app-switching, after which `Engine.resume()` (which only checked
`'suspended'`) left it dead.

These are device-specific runtime quirks, so — like [`performance-mode`](performance-mode.md)
— they are gated on a device check and never touch `ParamBus`, presets, or songs.
On Safari 17+ `unlock()` additionally sets `navigator.audioSession.type =
'playback'` (the standardized fix for the same problem — feature-detected, and
additive to the silent loop, which Safari <17 still needs); see
[`pwa-install`](pwa-install.md) REQ-4.
Because the failure only reproduces on real iOS hardware (no console on a remote
rig), the iOS session exposes diagnostics rendered in the [`debug-panel`](debug-panel.md).

## Requirements

- **REQ-1** — `isIOS()` detects iOS: a UA match for `iPhone | iPad | iPod`, **or**
  the iPadOS-13+ desktop-mode case (`navigator.platform === 'MacIntel'` **and**
  `navigator.maxTouchPoints > 1`). Pure; safe when `navigator` is absent (returns
  `false`). Kept separate from `detectTier()` (`perf-mode.ts`) — different
  concern (OS identity vs. hardware capability).
- **REQ-2** — `IosAudioSession(ctx)` lazily builds **one** silent, **looping**
  `<audio>` element (source = a tiny silent stereo WAV from the existing `encodeWav`
  in `audio/recorder/encode.ts` via `URL.createObjectURL` — no hardcoded base64) **and
  routes it through the context**: `ctx.createMediaElementSource(el).connect(ctx.destination)`.
  A detached element only elevates the page session and proved insufficient on a muted
  iPhone (while the iPad, with no mute switch, was fine); a media-element source feeding
  the context makes the **context itself** media-backed, lifting it off the ambient
  category. `playsinline` is set as an attribute (TS `HTMLMediaElement` has no
  `playsInline`); `createMediaElementSource` is guarded (it throws if called twice on an
  element).
- **REQ-3** — `IosAudioSession.unlock()` (in-gesture) plays that element and `rearm()`
  replays it after an interruption. Both are **no-ops off iOS** (`active === false`) and
  never throw (a rejected `play()` is caught). The play outcome updates a diagnostic
  status: `idle → starting → playing | blocked:<name>`.
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
  true there too), no `<audio>` element / media-element source is created, and no
  listeners are added. `main.ts` is unchanged — `await engine.resume()` keeps doing
  everything.
- **REQ-7** — `IosAudioSession.diagnostics` (`{ active, status, routed, paused,
  currentTime }`) is re-exported by `Engine.iosAudio` and is part of `StudioApi`. These
  values are **displayed** in the [`debug-panel`](debug-panel.md), which owns the panel
  mechanics; ios-audio only owns the data and contributes two rows — **Audio unlock**
  (`debug-ios-unlock`: status + `· routed`) and **Silent loop** (`debug-ios-loop`:
  `paused` / `playing t=<currentTime>`). A live, advancing `currentTime` confirms the loop
  is actually playing on the device.

## Technical design

### Contract / public interface

```yaml
# src/platform/ios.ts
isIOS(): boolean

# src/audio/ios-audio-session.ts
shouldResumeContext(state: string): boolean        # state !== 'running' && state !== 'closed'
IosAudioDiagnostics: { active: boolean; status: string; routed: boolean; paused: boolean | null; currentTime: number | null }
class IosAudioSession:
  constructor(ctx: AudioContext)
  active: boolean                                   # = isIOS(), read once
  unlock(): void                                    # build+route+play silent loop (in-gesture); no-op off iOS
  rearm(): void                                     # replay after interruption; no-op off iOS / before first unlock
  get diagnostics(): IosAudioDiagnostics

# src/audio/engine.ts
Engine.resume(): Promise<void>                      # iosSession.unlock(); if shouldResumeContext(ctx.state) → ctx.resume()
Engine.iosAudio: IosAudioDiagnostics                # re-exports iosSession.diagnostics
# Engine.init(): if iosSession.active → add visibilitychange + ctx 'statechange' listeners → resume()

# src/ui/studio-api.ts
StudioApi.iosAudio: IosAudioDiagnostics             # Engine satisfies it structurally
```

### Layer touchpoints & ordering

```yaml
engine ctor: this.iosSession = new IosAudioSession(this.ctx)   # after ctx exists; element built lazily on first unlock
engine.init(): if iosSession.active → install resume listeners (after graph + voices exist)
engine.resume(): unlock() (sync, in gesture) → shouldResumeContext(ctx.state) ? ctx.resume()
main.ts: unchanged — start handler still calls `await engine.resume()`
ui (about.ts): buildDebugSection reads engine.iosAudio for its two rows (panel owned by debug-panel)
```

### Persistence

Nothing iOS-specific is persisted (the debug-panel's collapse state is its own — see
[`debug-panel`](debug-panel.md)). **Deliberately not persisted into presets or songs**:
the iOS workaround describes the device/runtime, not the sound; no `ParamBus` param and no
`SongFile`/preset field (mirrors `performance-mode`).

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
  Then active is false, no element or media-element source is created, and play is never called
# pinned by: tests/audio/ios-audio-session.test.ts

Scenario: On iOS unlock plays a silent looping element routed into the context
  Given isIOS returns true
  When unlock is called
  Then a looping, playsinline <audio> element is created, createMediaElementSource is connected
       to the destination, play() is invoked, and the status resolves to "playing"
# pinned by: tests/audio/ios-audio-session.test.ts

Scenario: The element and media-element source are built once and reused
  Given isIOS returns true
  When unlock then rearm are called
  Then play() runs twice but createMediaElementSource runs once
# pinned by: tests/audio/ios-audio-session.test.ts

Scenario: The Debug panel shows the iOS audio-unlock status
  Given a StudioApi whose iosAudio status is known
  When the About modal is opened
  Then the Audio unlock row renders that status
# pinned by: tests/ui/about.test.ts
```

## Tests & verification

- Unit: `tests/platform/ios.test.ts` (detection branches via `vi.stubGlobal('navigator', …)`),
  `tests/audio/ios-audio-session.test.ts` (`shouldResumeContext`; on/off-iOS `unlock`/`rearm`
  with a fake ctx exposing `createMediaElementSource`/`destination`; `diagnostics`; stubs
  `URL.createObjectURL` and `HTMLMediaElement.prototype.play`),
  `tests/ui/about.test.ts` (Debug rows incl. `debug-ios-unlock`) — `npm test`
- Typecheck: `npm run typecheck`
- Manual (the silent-switch + interruption paths can only be seen on real iOS;
  headless Chromium can't): `npm run dev` prints a LAN URL — **http LAN is fine**
  (plain audio + `<audio>` need no secure context; only the mic does). On an iPhone
  with the **ring/silent switch set to silent**: Tap to start, play a key → sound
  should now come out. Open About → Debug → **Audio unlock = `playing · routed`** and
  **Silent loop** `currentTime` advancing on reopen confirms the fix engaged;
  `blocked:<name>` / `paused` points the next step at the gesture, not the category.
  Trigger Siri / background the tab and return → audio resumes.

## Open questions / future

- A future adaptive layer could *measure* underruns; out of scope here.
- There is no web API to set AVAudioSession categories directly; if a live, advancing
  silent loop still does not sound on a muted iPhone, the remaining suspect is the
  device/rig itself — which the Debug rows make visible rather than leaving us guessing.
