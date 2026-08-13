# Media Session keep-alive (Android background audio)

```yaml
id: media-session
status: implemented
version: 1
owner: core
related:
  - audio-lifecycle
  - ios-audio
  - transport
  - pwa-install
  - debug-panel
  - performance-mode
source:
  - src/platform/android.ts
  - src/audio/silent-loop.ts
  - src/audio/media-session.ts
  - src/audio/ios-audio-session.ts
  - src/audio/engine.ts
  - src/ui/studio-api.ts
  - src/ui/components/about-debug.ts   # the Media Session debug row
```

Make Android see the synth as what it is — a media player that is currently
playing — so the OS stops starving its audio when the screen goes off. A silent
looping `<audio>` element creates the session; `navigator.mediaSession` gives it
metadata, artwork and working transport controls.

## Background / Why

Bounding the transport's catch-up ([`transport`](transport.md) REQ-9) fixed the
*runaway clock* on a Pixel 8a but **not** the crackle, which rules out "a burst of
missed steps" as its cause and leaves the other half of the problem: Chrome on
Android protects a page it recognises as a **media player** — audio focus, a
notification, and exemption from the CPU/renderer throttling that a backgrounded
page otherwise gets. A page that makes sound purely through Web Audio gets none of
that: there is no media element, so there is no media session, so with the screen
off the renderer is throttled, the audio callback misses its deadlines, and the
output crackles. A device with different power management (the Samsung tablet)
never reaches that state, which is why the same build behaves.

The platform's answer is the [Media Session API](https://developer.mozilla.org/docs/Web/API/Media_Session_API),
but it engages for **media element** playback, not for an `AudioContext`. So the
fix is the Android sibling of the trick [`ios-audio`](ios-audio.md) already
plays: a silent, looping `<audio>` element — this time as the thing that *creates*
the session — plus the metadata and action handlers that make it a real player the
user can control from the lock screen.

This is a device-specific runtime workaround, so — like [`ios-audio`](ios-audio.md)
and [`performance-mode`](performance-mode.md) — it is gated on a device check and
never touches `ParamBus`, presets or songs.

## Requirements

- **REQ-1** — **Android only, and only where the API exists.**
  `isAndroid()` (`src/platform/android.ts`) is a UA match for `Android`, `false`
  when `navigator` is absent — the sibling of `isIOS()`, deliberately separate
  from `detectTier()` (OS identity vs. hardware capability). The keep-alive is
  `active` only when `isAndroid()` **and** `navigator.mediaSession` exists.
  Deliberately **not** enabled off Android: everywhere else it would add an
  unasked-for media notification and hand the OS's hardware media keys control of
  the transport.
- **REQ-2** — **A silent, looping `<audio>` element creates the session**, built
  lazily on first unlock from the same silent-WAV builder iOS uses (REQ-7) and
  played from the start gesture. Unlike iOS it is **detached** — *not* routed
  through the `AudioContext` — for two reasons: the routing exists to change the
  *context's* session category, which is an iOS-only concept; and a detached
  element keeps playing (and keeps the session alive) even while the context is
  suspended, which is exactly when the session must persist.
- **REQ-3** — **The session identifies the app**: `navigator.mediaSession.metadata`
  = title `VAST G1-J8`, artist `Vast Audio Synthesis Technology`, artwork from the
  existing `/icon-192.png` + `/icon-512.png`. Constructing `MediaMetadata` is
  feature-detected and guarded — it is absent in jsdom and older browsers, and a
  missing notification must never cost the synth its audio.
- **REQ-4** — **The notification's controls work.** `setActionHandler` is
  registered for `play`, `pause` and `stop`: **play** resumes the context and
  starts the transport, **pause** and **stop** both panic (stop the transport and
  silence every voice — [`architecture`](../architecture.md) `Engine.panic`). A
  handler that the browser refuses is skipped without failing the others. Not
  registering `pause` would leave Android pausing our own keep-alive element,
  which is the one thing that must not happen.
- **REQ-5** — **`playbackState` mirrors the audio session, not the transport.**
  It is set to `'playing'` at unlock and stays there while the transport is
  stopped, because this is an *instrument*: the keyboard makes sound with the
  transport stopped, so `'paused'` would be a lie — and Android treats a paused
  session as a candidate for teardown, which is the failure being fixed. It flips
  to `'paused'` only when the user pauses from the notification, and back on play.
  The transport's own state is not mirrored (and the clock is not subscribed to).
- **REQ-6** — **Re-armed on return to the foreground**, alongside the context
  re-arm ([`audio-lifecycle`](audio-lifecycle.md) REQ-4): `rearm()` replays the
  element if the OS paused it. No-op before the first unlock, and never throws (a
  rejected `play()` is caught into the diagnostic status, exactly as iOS does).
- **REQ-7** — **One silent-loop builder, two callers.** `createSilentLoop(ctx?)`
  (`src/audio/silent-loop.ts`) owns the encode-a-silent-WAV → object-URL →
  `loop`/`playsinline`/`preload` element construction, and routes it through the
  context when given one (iOS) or leaves it detached when not (Android). It is a
  pure extraction: [`ios-audio`](ios-audio.md) REQ-2's behaviour is unchanged.
- **REQ-8** — **Observable from the device.** `MediaSessionKeepAlive.diagnostics`
  (`{ active, status, playbackState, handlers, paused, currentTime }`) is
  re-exported as `Engine.mediaSession`, is part of `StudioApi`, and renders as one
  **Media session** row (`debug-media-session`) in the
  [`debug-panel`](debug-panel.md). This reproduces on one phone with no console;
  the row is how we tell "the session never formed" from "it formed and the
  crackle is something else".
- **REQ-9** — **Inert and silent about it everywhere else.** Off Android nothing
  is built, no element plays, no handler is registered, `diagnostics.active` is
  `false` and the Debug row reads `n/a`. Nothing here is persisted — it describes
  the device, not the sound.

## Technical design

### Contract / public interface

```yaml
# src/platform/android.ts
isAndroid(): boolean                       # UA match; false without navigator

# src/audio/silent-loop.ts                 # shared with ios-audio (REQ-7)
createSilentLoop(ctx?: AudioContext): { el: HTMLAudioElement; src: MediaElementAudioSourceNode | null }
  # ~0.5 s silent stereo WAV (encodeWav) → object URL; loop + playsinline + preload
  # ctx given  → createMediaElementSource(el).connect(ctx.destination)  (iOS)
  # ctx absent → detached element, src === null                          (Android)

# src/audio/media-session.ts
MediaSessionDiagnostics: { active, status, playbackState, handlers, paused, currentTime }
class MediaSessionKeepAlive:
  constructor(handlers: { play(): void; pause(): void; stop(): void })
  active: boolean                          # isAndroid() && !!navigator.mediaSession
  unlock(): void                           # in-gesture: play the loop, set metadata/handlers/state
  rearm(): void                            # replay after the OS paused it; no-op before unlock
  get diagnostics(): MediaSessionDiagnostics

# src/audio/engine.ts
Engine.mediaSession: MediaSessionDiagnostics   # re-exports the diagnostics

# src/ui/studio-api.ts
StudioApi.mediaSession: MediaSessionDiagnostics
```

### Layer touchpoints & ordering

```yaml
engine ctor:    this.media = new MediaSessionKeepAlive({ play, pause, stop })
                # handlers close over this.clock/resume/panic — called long after construction
engine.resume(): iosSession.unlock(); media.unlock()   # both in-gesture, both no-ops off their OS
engine.installContextRearm(): on foreground → media.rearm() alongside the context resume
ui (about.ts):  one row reading engine.mediaSession (panel owned by debug-panel.md)
NOT wired:      clock.onStart/onStop — playbackState tracks the audio session (REQ-5)
```

### Persistence

Nothing. Like [`ios-audio`](ios-audio.md), this describes the device/runtime, not
the sound: no `ParamBus` param, no `SongFile` field, no `localStorage` key.

## Scenarios (BDD)

```gherkin
Scenario: The session forms on Android at the start gesture
  Given an Android device
  When Engine.resume() runs from the Tap-to-start handler
  Then a silent looping element is playing, detached from the AudioContext
   And mediaSession.metadata names the app and carries its icons
   And play / pause / stop action handlers are registered
   And playbackState is 'playing'
# pinned by: tests/audio/media-session.test.ts

Scenario: The notification's pause silences the synth (REQ-4/REQ-5)
  Given the session is active
  When the OS invokes the 'pause' action
  Then the transport stops and every voice is silenced
   And playbackState becomes 'paused'
   And the keep-alive element keeps playing (the session survives)
# pinned by: tests/audio/media-session.test.ts

Scenario: A stopped transport is still a playing session (REQ-5, edge)
  Given the session is active and the transport is stopped
  Then playbackState is still 'playing'
# pinned by: tests/audio/media-session.test.ts

Scenario: Off Android nothing happens at all (REQ-9)
  Given a desktop or iOS browser
  When Engine.resume() runs
  Then no element is built, no handler is registered, no metadata is set
   And the Debug panel's Media session row reads n/a
# pinned by: tests/audio/media-session.test.ts

Scenario: A browser that refuses playback does not break audio (edge)
  Given play() rejects (autoplay policy)
  When unlock() runs
  Then it does not throw and the status records the rejection
# pinned by: tests/audio/media-session.test.ts

Scenario: Playing with the screen off (device)
  Given the transport is playing on a Pixel 8a
  When the screen turns off for a minute
  Then a media notification for VAST G1-J8 is present
   And playback continues without crackling
   And the Debug panel's dropout count has not moved
# verified manually on device; jsdom cannot pin this
```

## Tests & verification

- `tests/audio/media-session.test.ts` — the gate, the element, metadata,
  handlers, `playbackState`, and the off-Android inertness (jsdom, with
  `navigator`/`MediaMetadata`/`HTMLMediaElement.play` stubbed as
  `ios-audio-session.test.ts` does).
- `tests/audio/ios-audio-session.test.ts` — unchanged, and must stay green: the
  silent-loop extraction (REQ-7) is behaviour-preserving.
- **The verdict is the device.** Screen off on the phone that crackles, with the
  Debug panel's Media session row and dropout count as the evidence
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)).

## Open questions / future

- If the session forms and the crackle survives, the next lever is the audio
  buffer itself: `latencyHint: 'playback'` on Android trades latency for a
  glitch-resistant buffer, but it is fixed when the `AudioContext` is built
  ([`performance-mode`](performance-mode.md)), so it would have to become a
  device-scoped setting rather than a silent default.
- A detached element (REQ-2) means Android could in principle report the page as
  playing media while the context is dead. Harmless — the element is silent and
  the Debug row shows both — but it is the reason `status` and `playbackState` are
  reported separately from the context state.
- `setPositionState` is deliberately unset: a synth has no duration or seekable
  position, and a fake one would put a scrub bar in the notification that lies.
