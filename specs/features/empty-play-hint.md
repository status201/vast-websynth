# Empty-play hint (nothing to play modal)

```yaml
id: empty-play-hint
status: implemented
version: 1
owner: core
related:
  - play-button-blink
  - song-mode
  - dialog
  - midi-clock-sync
source:
  - src/audio/transport/anything-to-play.ts   # the pure "would it sound?" rule
  - src/ui/components/empty-play-modal.ts     # the modal + persisted opt-out
  - src/ui/app.ts                             # buildHeader — Play-click intercept
  - src/ui/styles/empty-play-modal.module.css
```

Pressing Play with nothing loaded starts a transport nobody can hear. Instead
of silence, a modal explains why, tells the user what to do about it, and
offers to start a demo — with a persistent "don't show again" opt-out.

## Background / Why

The [attract/cue blinks](play-button-blink.md) get users *to* the Play button,
but a fresh boot has every machine switched off — pressing Play then runs a
silent transport and looks broken. The modal converts that dead end into a
guided next step. Users who know the synth opt out once and are never nagged
again (the flag survives sessions).

## Requirements

- **REQ-1 (trigger)** — Clicking Play while the transport is **stopped** shows
  the modal *instead of starting* when nothing would sound
  (REQ-2) — unless the user opted out (REQ-5) or a sync mode is active
  (REQ-6). Stopping is never intercepted. All start surfaces that click the
  real button (Space bar, `UiBridge.toggleTransport`) inherit the check.
- **REQ-2 (the pure rule)** — `anythingToPlay(get, patterns, lanes, buffers)`
  returns true when any of:
  - `arp.on` — an enabled arp sounds as soon as a key is held (never nag it);
  - `seq.on` and a bank the sequencer *would play* has an active step;
  - `drum.on` and such a drum bank has an active cell;
  - `sampler.on` and such a sampler bank has an active cell **on a slot with a
    loaded buffer**.
  "Would play" = the distinct banks in the lane's chain (RESTs skipped) when
  the chain is enabled, else the machine's edit bank. Pure and dependency-
  injected (a `get(id)` fn, the `PatternStore`, `ChainLane`s, the buffer
  array), so it is unit-testable without an engine.
- **REQ-3 (modal content)** — Explains that Play runs the pattern machines and
  none has anything to play; lists what to do (switch a machine on + add
  steps, load/import a song from the Song tab); notes the keyboard always
  plays live. Actions: **▶ Play a demo** (primary, focused) and **Close**.
  Built on the shared [Modal](dialog.md) (Escape / backdrop-click close).
- **REQ-4 (play a demo)** — The demo action closes the modal, loads a random
  `DEMO_SONGS` entry (JSON demos only — synchronous, so playback can start in
  the same gesture) via the Song panel's `loadDemo` (dropdown stays in sync),
  then re-clicks Play: the check now passes and the transport starts.
- **REQ-5 (persistent opt-out)** — A "Don't show this again" checkbox persists
  `localStorage['websynth.hint.emptyplay'] = '1'` the moment it is checked
  (unchecking removes it). Device-scoped like `websynth.perf` — **not** a bus
  param, never part of songs/presets. The flag is read at click time, not
  boot. localStorage failures (private mode) fail open: the hint just shows
  again.
- **REQ-6 (sync exception)** — No modal while `engine.sync.mode !== 'off'`: a
  sync **master** legitimately runs an empty transport to drive external
  gear, and a **slave**'s transport belongs to its master.

## Technical design

### Contract / public interface

```yaml
anything-to-play.ts (pure):
  anythingToPlay(get: (id) => number, patterns: PatternStore,
                 lanes: { seq, drum, sampler: ChainLane },
                 samplerBuffers: (AudioBuffer|null)[]): boolean
empty-play-modal.ts:
  EMPTY_PLAY_HINT_KEY = 'websynth.hint.emptyplay'
  emptyPlayHintDismissed(): boolean
  openEmptyPlayModal({ onPlayDemo }): void
testids: empty-play-modal, empty-play-demo, empty-play-close, empty-play-dismiss
```

### Layer touchpoints & ordering

```yaml
buildHeader (app.ts): playBtn onClick gates start on
  !dismissed && sync.mode === 'off' && !anythingToPlay(...)
  onPlayDemo -> loadDemo(random JSON demo) -> playBtn.click() (re-entry passes)
mountApp: threads a lazy loadDemo closure into buildHeader (reads the
  late-bound songLoadDemo, which buildPatternRow rebinds to the Song panel's
  dropdown-syncing loader — same pattern as the tour's applyDemo)
e2e: helpers.gotoAndStart seeds the opt-out flag (like websynth.onboarding.done)
  so legacy specs press Play unhindered; the dedicated spec removes the key.
```

### Persistence

`websynth.hint.emptyplay` (localStorage, device-scoped): `'1'` = opted out;
absent = show the hint. Deliberately not persisted anywhere else.

## Scenarios (BDD)

```gherkin
Scenario: Play on a fresh boot shows the hint instead of silence
  Given a fresh boot (all machines off) and no opt-out flag
  When the user clicks Play
  Then the transport does NOT start and the empty-play modal is shown
# pinned by: e2e/empty-play.spec.ts

Scenario: Play a demo starts sound in one click
  Given the empty-play modal is open
  When the user clicks "Play a demo"
  Then a demo song is applied and the transport is playing
# pinned by: e2e/empty-play.spec.ts

Scenario: The opt-out survives sessions
  Given the user checked "Don't show this again" and reloaded the page
  When the user clicks Play with nothing to play
  Then no modal appears and the transport starts (silent, as asked)
# pinned by: e2e/empty-play.spec.ts

Scenario: Something to play → no modal
  Given a demo/song is loaded or a machine with steps is on
  When the user clicks Play
  Then the transport starts immediately
# pinned by: e2e/song.spec.ts (post-demo play), tests/audio/transport/anything-to-play.test.ts

Scenario: The rule ignores content on silent machines (edge)
  Given drum bank A has the seeded groove but drum.on is 0
  Then anythingToPlay is false
   And with drum.on 1 it is true
# pinned by: tests/audio/transport/anything-to-play.test.ts

Scenario: Sampler hits without buffers do not count (edge)
  Given sampler.on is 1 and a cell is active on an empty slot
  Then anythingToPlay is false until that slot has a buffer
# pinned by: tests/audio/transport/anything-to-play.test.ts

Scenario: Sync master keeps its empty transport (edge)
  Given sync mode is master and nothing would sound
  When the user clicks Play
  Then no modal appears (the clock must drive external gear)
# by design: mode gate in buildHeader; timing pinned by midi-clock-sync tests
```

## Tests & verification

- Unit: `tests/audio/transport/anything-to-play.test.ts` — `npm test`
- E2E: `e2e/empty-play.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`

## Open questions / future

- The chain-aware bank walk intentionally ignores lane mute/solo: a muted lane
  is one click from audible, so nagging there would be wrong more often than
  right.
