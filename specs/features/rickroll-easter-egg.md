# Rickroll easter egg

```yaml
id: rickroll-easter-egg
status: implemented
version: 1
owner: core
related:
  - architecture        # REQ-ui-and-audio-never-call-each-other: the egg listens on the bus's note channel
  - input-control       # the QWERTY note keys, which drop key auto-repeat
  - toast               # the offer is a toast; REQ-a-caller-can-ask-whether-a-toast-is-showing
  - song-mode           # loadDemo, REQ-a-load-lands-on-bar-one
  - demo-library        # the demo the egg loads is an ordinary drop-in
  - play-button-blink   # bridge.toggleTransport starts the song
source:
  - src/state/tune-matcher.ts     # the pure phrase matcher
  - src/ui/shell/easter-egg.ts    # wiring: bus.onNote -> offer toast -> loadDemo + Play
  - src/ui/app.ts                 # installs it once the Song panel exists
  - src/ui/components/toast.ts    # isToastShowing()
```

## Background / Why

An app this size deserves an easter egg, and the shipped **Rickroll** demo
(Never Gonna Give You Up) is its payload. The trigger is musical. When someone
plays the opening of the chorus hook ("Never gonna give you up") on the
instrument, the instrument recognises its own song and offers to play it. So the
player rickrolls themselves. Anyone who noodles the tune finds it by accident,
and that discovery is the point. Nothing in the UI or the help mentions it.

An easter egg is hidden on purpose, which suspends ADR-014 law 1 (self-evident
beats documented) for this one feature. The other laws still hold. A hidden
feature must never cost the player their work (law 3). So the egg only *offers*.
Nothing is replaced until the player clicks, and the load then goes through the
same door as a demo button, Undo toast included.

## Requirements

- **REQ-the-hook-is-matched-by-intervals** — The trigger is seven consecutive
  note-ons whose six successive intervals are `+2 +3 −3 +7 0 −2` semitones
  (`HOOK_INTERVALS`). In the record's key that is A♭ B♭ D♭ B♭ F F E♭, "nev-er
  gon-na give you up". Intervals rather than pitches make it work in any key
  and any octave. They also make it indifferent to where each input applies
  its octave: the QWERTY keys shift their own base octave, the on-screen
  keyboard adds `keyboard.transpose`, and MIDI sends the raw note. The match
  is on the notes *pressed*, before the key filter and chord memory: scale
  snapping and chord expansion happen downstream in `Engine.handleNote`, and
  the egg never sees them.
- **REQ-the-hook-allows-a-slow-player** — Rhythm is ignored, but every gap
  between two consecutive note-ons of the phrase must be at most
  `HOOK_MAX_GAP_MS` (1500 ms). A careful player picking the notes out one by one
  still triggers it. Seven notes scattered over a minute do not.
- **REQ-a-match-consumes-the-phrase** — A match clears the matcher's history.
  The next match needs seven new notes, so one note added after a match does not
  re-match on the old six.
- **REQ-only-human-notes-count** — The egg listens on `bus.onNote` note-ons and
  nothing else. The bus note channel is fed only by the three human inputs
  (input-control.md REQ-all-input-goes-through-the-bus): the on-screen
  keyboard, the QWERTY note keys and MIDI in. MIDI channel 10 goes to the
  sampler and never reaches the bus. The sequencer and the arpeggiator play
  their notes straight into the synth output; the sequencer has its own
  `engine.seq.onNote` channel. The arpeggiator and chord memory listen on the
  bus rather than feed it. So a song, a demo or the arp can never set the
  egg off by itself, including the Rickroll demo playing the hook. Note-offs are
  ignored. A held QWERTY key's auto-repeat is already dropped at its source
  (`e.repeat` in `shortcuts.ts`), so holding a key is one note.
- **REQ-a-match-offers-never-loads** — A match shows a toast,
  `Never gonna give you up…`, with one action, **Play it** (testid
  `easter-egg-toast`, the default 8 s timeout). The match itself changes nothing:
  no song, no param, no transport. Ignoring the toast or closing it with ✕
  leaves the session exactly as it was.
- **REQ-the-offer-plays-through-the-demo-door** — **Play it** awaits
  `loadDemo(EGG_DEMO)`, the same call a demo button makes. That call brings the
  shadow-name question (`REQ-one-name-two-songs-ask`), the fetch, the Undo
  toast and the playhead on bar 1 (`REQ-a-load-lands-on-bar-one`). Afterwards,
  if the demo actually loaded and the transport is stopped, the egg starts it
  with `bridge.toggleTransport()`. The tour does the same after its demo
  (`if (!clock.playing) toggleTransport()`), and Space uses the same call. A running transport is left running: the load already put it on bar 1.
  A cancelled shadow question, or a failed fetch (which reports itself), starts
  nothing.
- **REQ-the-egg-never-takes-a-toast** — No offer is shown while another toast
  is showing (`isToastShowing()`). The toast host is single-slot, so the offer
  would replace that toast. If it were a load's Undo toast, the egg would take
  away the player's way back.
- **REQ-the-egg-is-quiet-over-its-own-song** — No offer while the session's
  loaded demo is `EGG_DEMO`. Someone who has just been rickrolled will play
  along, and offering the song they are listening to would be noise.
- **REQ-an-offer-not-taken-silences-the-egg** — An offer that closes without
  **Play it** (✕ or the timeout) silences the egg until the page is reloaded.
  A player practising the tune gets asked once, not on every pass. Taking the
  offer does not silence it.
- **REQ-the-egg-is-inert-without-its-demo** — `EGG_DEMO` is a demo *name*, and
  demo files are data that a rename can orphan without touching code. The egg
  checks `demoNames()` when it matches, and if the name is missing it offers
  nothing. It must never fall through to `loadDemo`'s unknown-name fallback,
  which would load a different song under a Rick Astley toast.

## Technical design

### Contract / public interface

```yaml
src/state/tune-matcher.ts:      # pure: no DOM, no clock, time is passed in
  HOOK_INTERVALS: readonly number[]   # [2, 3, -3, 7, 0, -2]
  HOOK_MAX_GAP_MS: 1500
  createTuneMatcher(intervals, maxGapMs) -> TuneMatcher
  TuneMatcher.feed(note: number, timeMs: number) -> boolean   # true on the note that completes the phrase
  TuneMatcher.reset() -> void
src/ui/shell/easter-egg.ts:
  EGG_DEMO: 'Rickroll'
  installEasterEgg(deps: EasterEggDeps) -> () => void   # returns an uninstall (tests)
src/ui/components/toast.ts:
  isToastShowing() -> boolean   # toast.md REQ-a-caller-can-ask-whether-a-toast-is-showing
```

### Data shapes

```yaml
EasterEggDeps:
  bus: ParamBus                       # onNote only
  loadDemo: (name) => Promise<void>   # SongPanel.loadDemo
  loadedDemo: () => string | null     # SongPanel.loadedDemo
  isPlaying: () => boolean            # engine.clock.playing
  startTransport: () => void          # bridge.toggleTransport, called only when stopped
  demoNames: () => string[]           # state/song.ts demoNames
  now?: () => number                  # performance.now; injectable for tests
```

The matcher keeps at most the last seven note-ons, each as `{ note, timeMs }`.
A gap longer than `maxGapMs` drops the history before the new note, so the new
note starts a fresh phrase.

### Layer touchpoints & ordering

- `tune-matcher.ts` is state-layer and pure. It knows nothing about the hook's
  meaning, so it is unit-tested with plain numbers.
- `easter-egg.ts` is a UI-shell module. It subscribes to `bus.onNote` the way
  `seq-panel.ts` and the tour do, so the UI listens on the bus and never calls
  audio (`REQ-ui-and-audio-never-call-each-other`). Its one engine read is
  `clock.playing`, passed in as `isPlaying`.
- `app.ts` installs it right after `buildPatternRow`, the first point where the
  Song panel's `loadDemo`/`loadedDemo` exist (the same late-bound pair the tour
  reads). The header's Play button, which
  binds `bridge.toggleTransport`, is already built by then.

### Persistence

None. The "silenced" flag is module state and a reload clears it, on purpose.
The egg is found again by whoever plays the tune in a fresh session.

### Gesture inventory

| Target | Gesture | Outcome | Not to be confused with |
| --- | --- | --- | --- |
| any human note input | play the hook (7 notes, gaps ≤ 1.5 s) | the offer toast appears; nothing else changes | the notes themselves, which sound as normal |
| offer toast | **Play it** | Rickroll loads through `loadDemo` (Undo toast follows) and plays | a demo button, which loads but does not start the transport |
| offer toast | ✕, or the 8 s timeout | closes; the egg stays silent until reload | the Undo toast's ✕, which keeps the loaded song |

## Scenarios (BDD)

```gherkin
Scenario: The hook in the record's key matches on its seventh note (REQ-the-hook-is-matched-by-intervals)
  Given a fresh matcher
  When A♭3 B♭3 D♭4 B♭3 F4 F4 E♭4 are fed 200 ms apart
  Then feed returns false for the first six and true for the seventh
# pinned by: tests/state/tune-matcher.test.ts

Scenario: Any key and octave match (REQ-the-hook-is-matched-by-intervals)
  When the same phrase is fed transposed by -17, +5 and +24 semitones
  Then each completes a match
# pinned by: tests/state/tune-matcher.test.ts

Scenario: A wrong interval does not match (REQ-the-hook-is-matched-by-intervals, edge)
  When the phrase is fed with its fifth note a semitone sharp
  Then no note returns true
# pinned by: tests/state/tune-matcher.test.ts

Scenario: The phrase can follow other notes (REQ-the-hook-is-matched-by-intervals)
  Given ten unrelated notes have been fed
  When the hook's seven notes follow within the gap limit
  Then the seventh returns true
# pinned by: tests/state/tune-matcher.test.ts

Scenario: A slow player matches, a pause breaks the phrase (REQ-the-hook-allows-a-slow-player)
  When the phrase is fed with every gap exactly 1500 ms
  Then it matches
  When it is fed again with one gap of 1501 ms
  Then it does not match, and the notes after the pause start a new phrase
# pinned by: tests/state/tune-matcher.test.ts

Scenario: A match consumes its notes (REQ-a-match-consumes-the-phrase)
  Given the phrase has just matched
  When one more note continuing the pattern is fed
  Then it returns false, and a full new phrase is needed to match again
# pinned by: tests/state/tune-matcher.test.ts

Scenario: Playing the hook offers the song and changes nothing (REQ-a-match-offers-never-loads)
  Given the egg is installed and no toast is showing
  When the hook is played through bus.noteOn
  Then the easter-egg-toast shows "Never gonna give you up…" with a "Play it" action
  And loadDemo has not been called and the transport has not been touched
# pinned by: tests/ui/easter-egg.test.ts

Scenario: Note-offs do not count (REQ-only-human-notes-count)
  When the hook is sent as noteOff events only
  Then nothing is offered
# pinned by: tests/ui/easter-egg.test.ts

Scenario: Play it loads the demo through the shared door and starts the transport (REQ-the-offer-plays-through-the-demo-door)
  Given the offer is showing and the transport is stopped
  When the player clicks "Play it"
  Then loadDemo is awaited with EGG_DEMO
  And once it resolves with EGG_DEMO loaded, the transport is started exactly once
# pinned by: tests/ui/easter-egg.test.ts

Scenario: A running transport is not toggled off (REQ-the-offer-plays-through-the-demo-door, edge)
  Given the offer is showing and the transport is running
  When the player clicks "Play it"
  Then the demo loads and startTransport is not called
# pinned by: tests/ui/easter-egg.test.ts

Scenario: A declined load starts nothing (REQ-the-offer-plays-through-the-demo-door, edge)
  Given loadDemo resolves without EGG_DEMO becoming the loaded demo (the shadow question was cancelled)
  When the player clicks "Play it"
  Then the transport is not started
# pinned by: tests/ui/easter-egg.test.ts

Scenario: The offer never replaces a live toast (REQ-the-egg-never-takes-a-toast)
  Given an Undo toast is showing
  When the hook is played
  Then the Undo toast is still the one showing
# pinned by: tests/ui/easter-egg.test.ts

Scenario: Quiet while its own song is loaded (REQ-the-egg-is-quiet-over-its-own-song)
  Given the loaded demo is EGG_DEMO
  When the hook is played
  Then nothing is offered
# pinned by: tests/ui/easter-egg.test.ts

Scenario: An offer not taken silences the egg (REQ-an-offer-not-taken-silences-the-egg)
  Given the offer was closed with ✕
  When the hook is played again
  Then nothing is offered
  And likewise after the offer timed out
# pinned by: tests/ui/easter-egg.test.ts

Scenario: No demo, no egg (REQ-the-egg-is-inert-without-its-demo)
  Given demoNames() does not include EGG_DEMO
  When the hook is played
  Then nothing is offered and loadDemo is never called
# pinned by: tests/ui/easter-egg.test.ts

Scenario: The shipped library carries the egg's demo (REQ-the-egg-is-inert-without-its-demo)
  Then demoNames() includes EGG_DEMO
  # a rename of the demo then fails a test instead of silently disarming the egg
# pinned by: tests/ui/easter-egg.test.ts

Scenario: The real keyboard reaches the egg (REQ-only-human-notes-count)
  Given the app is booted
  When the hook is typed on the QWERTY note keys
  Then the easter-egg-toast appears
# pinned by: e2e/easter-egg.spec.ts
```

## Tests & verification

- Unit: `tests/state/tune-matcher.test.ts` (node) and `tests/ui/easter-egg.test.ts`
  (jsdom; a real `ParamBus`, the real toast, stubbed `loadDemo`/`demoNames`, an
  injected `now`) — `npm test`. Tests import `EGG_DEMO` and never spell the
  name (`tests/no-shipped-demo-names.test.ts`).
- E2E: `e2e/easter-egg.spec.ts` types the hook on the QWERTY keys and checks
  that the toast appears. It does not click Play it, because that would fetch an
  11 MB zip — `npm run e2e`.
- Typecheck: `npm run typecheck`.
- By ear: play the hook on the on-screen keyboard and on a MIDI keyboard, take
  the offer, and hear Rickroll start (ADR-010).

## Open questions / future

- The egg is deliberately absent from the help (`help-content.ts`) and the
  authoring guide. If that changes, it is a decision, not a docs gap.
- Played as chords, the hook does not match: chord notes interleave their
  note-ons. That's acceptable for a melody line, and it's how people hum it.
- With a key filter on, the egg matches the keys pressed, not the snapped
  notes heard. A player whose wrong keys the scale corrects into the hook does
  not trigger it.
