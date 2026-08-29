# Input & control (keyboard · shortcuts · MIDI)

```yaml
id: input-control
status: implemented
version: 14  # v14: the keyboard carries a third highlight layer — static musical
             #      roles, written as an attribute, outranked by the lit classes
             #      (REQ-14; the behaviour itself is scale-quantization.md REQ-10)
             # v13: the note maps are composed from a positional shape + the
             #      active keyboard layout, switchable at runtime (REQ-3/REQ-13)
             # v12: pitch bend matches e.code (Quote/Slash), not e.key — fixes
             #      dead keys, non-US layouts and a stuck bend on Shift-mid-hold
             #      (REQ-12)
             # v11: LOWER/UPPER are exported — the About keyboard diagram is
             #      derived from them (REQ-3, onboarding.md REQ-17c)
             # v10: the badges the `?` key toggles are now "info badges", reached
             #      through UiBridge.toggleInfoBadges (onboarding.md v15); pitch
             #      bend up moves from `.` to `'`, above `/` (REQ-12)
             # v9: lit keys + note-offs survive an OCT change (REQ-10, REQ-11)
owner: core
related:
  - architecture
  - voicing
  - midi-clock-sync
  - sequencer
  - onboarding
  - keyboard-layout
  - scale-quantization
source:
  - src/ui/key-roles.ts
  - src/ui/components/keyboard.ts
  - src/ui/shortcuts.ts
  - src/ui/ui-bridge.ts
  - src/audio/midi.ts
  - src/audio/sustain-pedal.ts
  - src/main.ts
```

The three ways notes enter the synth: the on-screen keyboard, the computer
keyboard, and external MIDI — all converging on `bus.noteOn` / `bus.noteOff`.

## Background / Why

The `ParamBus` note path (`onNote`/`noteOn`/`noteOff`) is the single funnel for note
input, so every source is treated identically by the [engine](voicing.md), arp, and
sequencer. The computer keyboard is that source: `installShortcuts` calls
`bus.noteOn`/`noteOff` **once** per key, and separately drives a `UiBridge` purely
to *repaint* the on-screen keyboard (highlight the matching key). The bridge must
stay visual-only — if it also fired the bus, a computer key would emit **two**
note-ons, which the funnel forwards to every consumer (double-triggering a voice,
and advancing the sequencer's Step-Input cursor by two). MIDI is wired through Web
MIDI when available and degrades silently when not.

The funnel stays deliberately **undiscriminating** — it cannot know a note was meant
for one particular consumer — so a consumer that *captures* rather than plays notes
must scope itself. The sequencer's Step Input is the one such consumer: it is armed
only while its own grid is on screen ([sequencer](sequencer.md) REQ-5), which is why
notes played on another tab no longer overwrite its bank.

## Requirements

- **REQ-1** — All input sources call `bus.noteOn(note, velocity)` /
  `bus.noteOff(note)`; the engine handles the rest.

- **REQ-2** — A computer key emits **exactly one** `bus.noteOn`/`noteOff` (from
  `installShortcuts`). `UiBridge.pressKey/releaseKey` only repaints the on-screen
  keyboard in lock-step (`keyboard.highlight`, a visual toggle); it never calls the
  bus, so no source double-fires the note funnel.

- **REQ-3** — Two key rows (lower from C, upper one octave higher); a base octave is
  shiftable; auto-repeat is ignored. (v11, re-based v13) The note mapping is
  **exported** and is the single source for the About modal's keyboard diagram
  ([onboarding](onboarding.md) REQ-17c), which derives each key's rank and column
  from its semitone rather than restating the letters. Adding or moving a binding
  therefore re-draws the diagram; a hand-copied one would drift, and a picture of
  the keyboard that disagrees with the keyboard is worse than no picture.
  (v13) What is exported is now **`NOTE_ROWS`** — the canonical positional shape
  (`code → semitone`, the piano). The character-keyed `LOWER`/`UPPER` the
  keydown branch matches against are module-private and **composed** at runtime
  from `NOTE_ROWS` and the active layout's `code → character` table
  ([keyboard-layout](keyboard-layout.md) REQ-1), rebuilt whenever it changes.
  The piano shape lives in one place; which characters reach it is the layout's
  business, and the diagram draws the shape rather than either set of letters.

- **REQ-4** — MIDI (Web MIDI) maps Note On (vel 0 = off) / Note Off to the bus;
  absence of Web MIDI is a no-op (logged), not an error.

- **REQ-5** — Computer-keyboard shortcuts are suppressed while focus is in an
  editable field (`input` / `textarea` / `[contenteditable="true"]`): keystrokes
  reach the field and never play a note, toggle transport, bend pitch, shift
  octave, or trigger a drum fill. (Same `closest(...)` rule the `contextmenu`
  guard already uses.)

- **REQ-6** — MIDI access is requested only after a **user gesture** — the
  "Tap to start" click where there is one, and otherwise the first touch anywhere
  after an auto-start ([audio-lifecycle](audio-lifecycle.md) REQ-21) — and
  never at page load: Chrome ≥124 shows a permission prompt for *all* MIDI
  access (sysex or not), and an unprompted load-time permission dialog is
  hostile to the (majority) MIDI-less visitor. The request passes an explicit
  `{ sysex: false }`; a denied prompt degrades exactly like absence of Web
  MIDI (logged, no error). Note: Chrome's DevTools deprecation line ("Web MIDI
  will ask a permission…") is informational and cannot be silenced from code.

- **REQ-7** — `midi.ts` is the **sole owner** of the shared `MIDIAccess`
  handler properties (`onmidimessage`/`onstatechange` are single-assignment —
  a second owner would silently clobber them). System Real-Time bytes
  (status ≥ 0xF8) are dispatched **before** the `& 0xf0` channel-voice mask
  (0xF8 & 0xF0 = 0xF0 would mis-dispatch) and routed to the clock-sync
  transport (see [midi-clock-sync](midi-clock-sync.md)); they never reach
  note/CC handling. A leading **`0xF2` Song Position Pointer** (System Common,
  3 bytes, < 0xF8) is routed on its own explicit branch — after the ≥0xF8 branch
  and before the mask — to `MidiSyncTransport.handleSongPosition(((d2)<<7)|d1,
  ts)` (v2; midi-clock-sync REQ-10). `midi.ts` registers the transport via
  `engine.sync.addTransport('midi', sync)` (v2; was `attachTransport`);
  `onstatechange` additionally refreshes the sync transport's port counts.

- **REQ-8** — **Sustain pedal (CC64)**, MIDI-layer (v6): while the pedal is down
  (CC64 value ≥ 64) a MIDI note-off (0x80, or 0x90 vel 0) is **deferred** — it
  never reaches `bus.noteOff`; the note is remembered as *sustained*. Pedal
  release (value < 64) flushes `bus.noteOff` for every sustained note. A note
  re-pressed while sustained is live again (its later note-off obeys the pedal
  state at that moment — no stuck note, no double note-off). The pedal sits
  **before** the bus funnel, so it applies to MIDI input only (on-screen /
  computer keys are unaffected) and every bus consumer sees the deferral — with
  the arpeggiator on, the pedal behaves as an arp latch (accepted behaviour).
  State lives in the pure `SustainPedal` helper (`src/audio/sustain-pedal.ts`).

- **REQ-9** (v8) — **`?` toggles the info badges.** It is free by construction:
  `e.key` for Shift+`/` is `?`, so neither the `/` pitch-bend branch nor its
  `keyup` twin matches, and the blanket `ctrlKey || metaKey || altKey` bail-out
  does not test `shiftKey`. It is still ordered **above** the `'`/`/` branch
  (REQ-12) so a future layout quirk can't turn a help request into a pitch bend.
  Like every
  other non-note key it goes through the `UiBridge` (`toggleInfoBadges`) rather
  than importing the onboarding layer into `shortcuts.ts` — same reason as
  `toggleTransport` / `undoActiveMachine`. Behaviour is owned by
  [onboarding](onboarding.md) REQ-19; since v15 it is the *second* route to the
  badges rather than a shortcut past a modal, the first being the header's ⓘ
  button (onboarding REQ-8).

- **REQ-10** (v9) — **A lit key is remembered as an element, never re-derived.**
  `keyboard.transpose` (the OCT strip) shifts the note→element mapping: an element
  sounds `note + transpose * 12`, so the key *for* a sounding note is
  `note - transpose * 12`. Both highlight APIs resolve that through **one**
  private `keyFor(note)` — including `highlight`, which previously did not
  de-transpose and so disagreed with `seqHighlight` about where the same MIDI note
  lives. (Visible consequence, and correct: at OCT +2 a computer key playing C4 has
  no key on the drawn board and lights nothing, rather than lighting the key that
  actually sounds C6.)
  The light-up **stores the resolved element**; the light-down removes the class
  from *that* element rather than resolving the note again. Re-deriving was the
  bug: the sequencer's viz schedules its on and its off as two separate deferred
  timers (`app.ts`, at the notes' audible moments), so any OCT change in between —
  including a **song/demo load**, since `Song.apply` restores `keyboard.transpose`
  and most demos ship a non-zero one — resolved the off to a different element, or
  to none at all (`keys.get` misses silently). The key stayed lit until the next
  transport stop, the only caller of `clearSeqHighlights`. Lit entries are
  **refcounted**, so two of the four sequencer tracks sounding the same note cannot
  have the first release dim a key the second is still holding.

- **REQ-11** (v9) — **A note-off always names the note that was pressed.** Two
  sources re-computed it at release time against mutable state and stranded the
  note when that state moved mid-hold:
    - the **on-screen keyboard** stores the sounding note alongside the element at
      `pointerdown` and releases *that*, so moving OCT while a key is held no
      longer sends `noteOff` for a different MIDI number (a hung voice);
    - **`installShortcuts`** keys its held-note map by the *case-folded key* and
      stores the note it pressed, so neither the `←`/`→` octave shift nor a Shift
      press mid-hold (which flips `e.key` between `z` and `Z`) can make `keyup`
      compute a different identity, miss the map, and skip `release()` entirely
      (a hung voice *and* a stuck-lit key until the window lost focus).
  This is the input-layer twin of [sequencer](sequencer.md) REQ-15: nothing may
  hold a note whose release depends on state that is free to change underneath it.

- **REQ-12** (v10) — **Pitch bend is `'` up and `/` down, chosen for where the
  keys sit.** Both write `master.pitchBend` (+1 / −1) on keydown and spring back
  to 0 on keyup, as before. What changed is which key means *up*: it was `.`,
  and `.` and `/` are **horizontally** adjacent while bend is a **vertical**
  gesture, so neither assignment was derivable — you memorised it or you guessed.
  On the standard layout `'` sits directly **above** `/`, one row up, so the
  physical arrangement states the mapping and the About list can show it as two
  stacked rows that mirror the keys
  ([onboarding](onboarding.md) REQ-17/REQ-17b).
  - `.` is left **unbound**. It is not kept as an alias: two keys for one
    outcome is what
    [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2 rules out, and a
    silent alias would keep teaching the arrangement this REQ exists to replace.
  - `'` collides with nothing — it is in neither note row, `keyToMidi` returns
    null for it.
  - **(v12) These two are matched on `e.code` (`Quote` / `Slash`), not
    `e.key`** — the only bindings in `installShortcuts` that are. `e.key` answers
    "what character was typed", but this pair is chosen for *where the keys sit*,
    so position is the thing to match. Three failures fall out of that one
    change:
    - **Dead keys.** Where `'` is a dead key (US-International; several European
      layouts) `e.key` is `Dead` and bend-up was simply unreachable. A dead key
      still fires `keydown` with the right `code`.
    - **Layouts.** On QWERTZ and AZERTY neither `'` nor `/` is where a `e.key`
      match assumes; `Quote`/`Slash` name the physical keys the diagram draws.
    - **A stuck bend.** Hold `/`, press `Shift`, release: `e.key` on the `keyup`
      is `?`, the release branch missed, and the bend **stayed at −1** until the
      next bend press. `'` had the same hole via `"`. Matching `code` makes the
      press and its release agree by construction — the same rule REQ-11 sets
      for note-offs: nothing may hold state whose release depends on a value
      free to change mid-hold.
  - `?` keeps its branch **above** this one and returns, so `Shift`+`Slash`
    toggles the info badges rather than bending (REQ-9). With modifiers
    otherwise ignored, `Shift`+`Quote` does bend — the physical key bends,
    which is the whole premise.

- **REQ-13** (v13) — **The note keys follow a switchable keyboard layout.**
  `installShortcuts` rebuilds `LOWER`/`UPPER` whenever
  [keyboard-layout](keyboard-layout.md) reports a change (REQ-4 there), so a
  pick in the About modal's gear takes effect on the next keystroke without a
  reload. Load-bearing details:
  - **Held notes are released before the rebuild.** `held` is keyed by
    *character*, so a remap would leave whatever is down with no key that can
    ever match its `keyup` — a hung voice, the exact failure REQ-11 exists to
    prevent. The `blur` handler is the precedent for the bulk release.
  - Only the note rows move. `F`, `Shift`+`R` and `Ctrl/Cmd`+`Z` keep their
    `e.key` letters ([keyboard-layout](keyboard-layout.md) REQ-5), and the bend
    pair stays positional (REQ-12).
  - The picker's residual risk — a wrong selection means wrong notes, where
    `e.code` could not be wrong — is recorded as
    [keyboard-layout](keyboard-layout.md) REQ-6, not re-argued here.

- **REQ-14** (v14) — **A third highlight layer, and it is not a lit key.**
  `Keyboard.setKeyRoles(state | null)` marks each key with the musical role its pitch
  class plays in the current key ([scale-quantization](scale-quantization.md) REQ-10,
  which owns *what* the roles mean). It is a different kind of state from the two that
  came before, and the difference is what keeps it safe:
  - **Static, not evented.** `active` and `seq` are transient and refcounted, so they
    must remember the element they lit (REQ-10). A role is a *standing* property of a
    pitch class that changes only when the user changes the key, so it is written to
    every key at once and needs no bookkeeping to unwind.
  - **An attribute, never `setLit`.** Roles go to `data-role`; the lit states stay the
    global `active` / `seq` classes. Routing a third state through `setLit` would put
    it in the same refcounted maps as the two whose element-remembering REQ-10 and
    REQ-11 pin, where a full-keyboard sweep could strand a held note's light. Separate
    channels cannot interfere; the same reason `litActive` and `litSeq` are two maps
    and not one.
  - **Pitch class, so OCT is free.** `keyFor` shifts by whole octaves and pitch class
    survives that, so unlike everything else in REQ-10 a role needs no de-transposing
    and no repaint when `keyboard.transpose` moves.
  - **The lit classes win.** A key that is pressed or sequenced shows that, and its
    role tint steps aside — enforced in CSS, so no JS ordering can get it wrong.

## Technical design

### Contract / public interface

```yaml
installShortcuts(engine, bus, bridge: UiBridge): void   # src/ui/shortcuts.ts
  LOWER: z s x d c v g b h n j m ,    # semitone offsets from C
  UPPER: q 2 w 3 e r 5 t 6 y 7 u i    # one octave up
  baseOctave (shiftable); ignores e.repeat
  keyId(k) = k.length === 1 ? k.toLowerCase() : k   # v9: one key identity
  NOTE_ROWS.lower / .upper: Record<code, semitone>            # v13 — the piano shape
  LOWER / UPPER: Record<char, semitone>             # composed with the layout
                                     # (REQ-3); also the source for About's
                                     # keyboard diagram. Rebuilt on layout change.
  held: Map<keyId, note>             # v9, REQ-11: the note PRESSED, so keyup never
                                     # recomputes it against a shifted baseOctave
  '?' -> bridge.toggleInfoBadges()   # REQ-9; ordered above the bend branch below
  code 'Quote' -> master.pitchBend +1   # REQ-12; matched on e.code, not e.key
  code 'Slash' -> master.pitchBend -1   # REQ-12; '.' is unbound
  keyup on either code -> 0             # same code both ways, so Shift mid-hold
                                        #   can no longer strand the bend
UiBridge: pressKey(note) / releaseKey(note)             # visual-only -> keyboard.highlight(note, on)
  # never calls bus.noteOn/off; the one note-on per key is installShortcuts' (REQ-2)
  toggleInfoBadges()                 # -> Onboarding.toggleInfoBadges (REQ-9)
initMIDI(engine, bus): Promise<void>                    # src/audio/midi.ts
  requestMIDIAccess({ sysex: false })  # explicit; called post-gesture (REQ-6)
  status >= 0xF8 -> MidiSyncTransport.handleRealtimeByte(byte, ev.timeStamp)  # REQ-7, before the mask
  data[0] === 0xF2 -> MidiSyncTransport.handleSongPosition(((d2)<<7)|d1, ev.timeStamp)  # REQ-7 (v2), before the mask
  0x90 Note On (d2==0 -> noteOff) ; 0x80 Note Off  -> bus.noteOn/noteOff
  note on/off route through SustainPedal first (REQ-8); CC64 -> pedal.setPedal(v>=64)
  builds MidiSyncTransport(access) -> engine.sync.addTransport('midi', ...)  # midi-clock-sync v2
SustainPedal                                            # src/audio/sustain-pedal.ts (pure, REQ-8)
  noteOn(note): void          # marks held; un-sustains a retriggered note
  noteOff(note): boolean      # false = deferred (pedal down); true = pass to bus.noteOff
  setPedal(down): number[]    # on release: the sustained notes to flush via bus.noteOff
note funnel: bus.onNote -> Engine.playNote/releaseNote (unless passthroughSuppressed)
  capture consumers scope themselves; seq Step Input is armed only while visible
  (sequencer.md REQ-5) — the funnel itself stays undiscriminating
```

> Note: there is **no** `window.__synthKeyboard` / `window.__transportToggle`
> global anymore — input is driven via `UiBridge` and the bus. The only dev global
> is `window.__synth` (see [architecture](../architecture.md)).

### Layer touchpoints

```yaml
boot (main.ts): builds the UiBridge, installShortcuts(...)
start gesture (main.ts showStartModal): initMIDI(...) fires on tap-to-start (REQ-6)
on-screen keyboard: src/ui/components/keyboard.ts -> bus.noteOn/noteOff directly
  keyboard.highlight(note, on): visual-only key toggle (the UiBridge target; no bus call)
  keyFor(note) = keys.get(note - transpose * 12)   # v9, REQ-10 — the ONE resolver,
    shared by highlight + seqHighlight; lit elements are stored, never re-derived
  litActive / litSeq: Map<note, {el, count}>       # v9 — refcounted, cleared by
    clearSeqHighlights() (litSeq only; its sole caller is clock.onStop in app.ts)
  activeByPointer: Map<pointerId, {key, sounding}> # v9, REQ-11 — release `sounding`
  setKeyRoles(state|null): el.dataset.role per key # v14, REQ-14 — no map, no refcount,
    keyed by (midi % 12); null clears. Guarded: skips a write already in place.
app.ts wiring: bridge.pressKey/releaseKey -> keyboard.highlight(note, true/false)
  onKeyChange(bus, ...) -> keyboard.setKeyRoles(...)  # v14 — src/ui/key-roles.ts owns
    the vocabulary; the component takes a state object and stays free of music theory
arp/seq ownership: when passthroughSuppressed, the engine gates raw note passthrough
```

## Scenarios (BDD)

```gherkin
Scenario: A computer key plays a note and lights the on-screen key
  Given the audio context is running
  When the user presses 'z'
  Then bus.noteOn fires for C at the base octave and the on-screen C lights up
# pinned by: e2e/controls.spec.ts (keyboard interaction), e2e/smoke.spec.ts

Scenario: A single computer key fires exactly one note-on (regression, no double-trigger)
  Given the Sequencer's Step Input is armed with the cursor at step 0
  When the user presses one computer key (e.g. 'x' = D)
  Then that single step is filled and the cursor advances by exactly one
  # because the UiBridge highlight is visual-only — the key emits one bus.noteOn,
  # not two (which would fill two steps / play two voices)
# pinned by: e2e/patterns.spec.ts, tests/ui/keyboard.test.ts

Scenario: Moving OCT mid-playback leaves no key lit (v9, REQ-10, regression)
  Given the sequencer is playing and has lit a key for a sounding note
  When keyboard.transpose changes before that note's light-off is due
  Then the light-off clears the key that was actually lit
  And no key is left glowing until the next transport stop
# pinned by: tests/ui/keyboard.test.ts

Scenario: Loading a demo mid-playback leaves no key lit (v9, REQ-10, regression)
  Given a demo is playing with keys lit by the sequencer
  When another demo is loaded, restoring its own keyboard.transpose
  Then every previously lit key still clears on its own schedule
# pinned by: tests/ui/keyboard.test.ts

Scenario: Two tracks on the same note do not dim each other (v9, edge)
  Given two sequencer tracks sound the same note with different gates
  When the shorter one releases
  Then the key stays lit until the longer one releases too
# pinned by: tests/ui/keyboard.test.ts

Scenario: A role does not disturb a lit key (v14, REQ-14)
  Given a key is lit by the sequencer and carries an in-scale role
  When the key is re-roled by a change of scale, and then the light-off falls due
  Then the light-off still clears the element it lit
  And the key keeps whichever role it now has
# pinned by: tests/ui/keyboard.test.ts

Scenario: Moving OCT while a key is held does not hang the voice (v9, REQ-11)
  Given a key on the on-screen keyboard is held down
  When keyboard.transpose changes and the pointer is then released
  Then bus.noteOff names the note that pointerdown played, so no voice hangs
# pinned by: tests/ui/keyboard.test.ts

Scenario: Shifting octave while a computer key is held releases it (v9, REQ-11, regression)
  Given the user holds 'z'
  When they press the right-arrow octave shift and then release 'z'
  Then exactly one bus.noteOff fires, for the note 'z' originally played
  And the on-screen key un-lights — previously both waited for a window blur
# pinned by: tests/ui/shortcuts.test.ts

Scenario: MIDI Note On with velocity 0 is a Note Off (edge)
  Given a MIDI device sends 0x90 note 60 velocity 0
  Then bus.noteOff(60) is called
# pinned by: tests/audio/midi.test.ts (channel-voice messages)

Scenario: A MIDI clock pulse never reaches note handling (edge)
  Given a MIDI device interleaves 0xF8 clock bytes with note messages
  When a single-byte 0xF8 message arrives
  Then it is routed to the sync transport before the 0xf0 status mask
  And no note or CC handler runs for it
# pinned by: tests/audio/midi.test.ts (system messages route before the channel
#            mask), tests/audio/midi-sync-transport.test.ts

Scenario: A Song Position Pointer routes to the sync transport (edge)
  Given a MIDI master sends 0xF2 lsb msb (beat position)
  When the 3-byte message arrives
  Then it routes to handleSongPosition(((msb)<<7)|lsb, ts) before the 0xf0 mask
  And no note or CC handler runs for it
# pinned by: tests/audio/midi.test.ts (system messages route before the channel
#            mask), tests/audio/midi-sync-transport.test.ts

Scenario: No Web MIDI is a silent no-op
  Given navigator.requestMIDIAccess is undefined
  When initMIDI runs
  Then it logs and returns without throwing
# pinned by: tests/audio/midi.test.ts (initMIDI wiring)

Scenario: MIDI permission is not requested before the start gesture
  Given the page has just loaded (start modal showing)
  Then requestMIDIAccess has not been called
  When the user taps to start
  Then initMIDI runs (a browser permission prompt may appear)
  And a denied prompt is a logged no-op, like absence of Web MIDI
# pinned by: tests/audio/midi.test.ts (the denial no-op); the ordering itself is
#            main.ts showStartModal onStart -> initMIDI

Scenario: Sustain pedal defers note-offs until release
  Given a MIDI device sends CC64 value 127 (pedal down)
  And note-on 60 then note-off 60 arrive
  Then bus.noteOff(60) is NOT called (the voice keeps ringing)
  When CC64 value 0 arrives (pedal up)
  Then bus.noteOff(60) is called exactly once
# pinned by: tests/audio/midi.test.ts (control change map), tests/audio/sustain-pedal.test.ts

Scenario: A note retriggered while sustained does not get a stale note-off (edge)
  Given the pedal is down and note 60 was released (sustained)
  When note-on 60 arrives again and the pedal is then released
  Then no bus.noteOff(60) fires from the flush (the new press is still held)
  And the note's own later note-off passes through normally
# pinned by: tests/audio/sustain-pedal.test.ts

Scenario: Velocity-0 note-on obeys the pedal (edge)
  Given the pedal is down and note 60 is playing
  When 0x90 note 60 velocity 0 arrives (a note-off in disguise, REQ-4)
  Then it is deferred exactly like an 0x80 note-off
# pinned by: tests/audio/midi.test.ts (both paths through midi.ts), tests/audio/sustain-pedal.test.ts

Scenario: CC64 63/64 boundary (edge)
  Given CC64 value 64 arrives, then a note-off
  Then the note-off is deferred (64 is "down")
  Given CC64 value 63 arrives instead
  Then sustained notes flush and later note-offs pass through (63 is "up")
# pinned by: tests/audio/midi.test.ts (the 63 case over the wire), tests/audio/sustain-pedal.test.ts

Scenario: Pitch bend sits on the vertically stacked keys (v10, REQ-12)
  Given no editable field has focus
  When the user holds the Quote key then releases it
  Then master.pitchBend went to 1 and sprang back to 0
  When the user holds the Slash key then releases it
  Then master.pitchBend went to -1 and sprang back to 0
  When the user presses .
  Then nothing happens — it is unbound, not an alias for bend up
# pinned by: tests/ui/shortcuts.test.ts

Scenario: Shift pressed mid-hold still releases the bend (regression, v12, REQ-12)
  Given the user is holding Slash and master.pitchBend is -1
  When they press Shift and then release Slash, so e.key reads '?' not '/'
  Then master.pitchBend returns to 0
  And the same holds for Quote, whose shifted e.key is '"'
# pinned by: tests/ui/shortcuts.test.ts

Scenario: A dead-key layout can still bend (v12, REQ-12)
  Given a layout where the Quote key is dead, so e.key reports 'Dead'
  When the user presses it
  Then master.pitchBend goes to 1 — the branch matches e.code, not e.key
# pinned by: tests/ui/shortcuts.test.ts

Scenario: ? toggles the info badges without bending pitch (v8, REQ-9)
  Given no editable field has focus
  When the user presses ? (Shift + /)
  Then UiBridge.toggleInfoBadges is called once
  And master.pitchBend is still 0
# pinned by: tests/ui/shortcuts.test.ts

Scenario: Typing in a text field does not play notes
  Given a textarea is focused (e.g. the AI Prompt "Describe your song" field)
  When the user presses 'z'
  Then no note is played (UiBridge.pressKey is not called)
  And a 'z' that originates outside an editable field still plays a note
# pinned by: tests/ui/shortcuts.test.ts
```

## Tests & verification

- `e2e/controls.spec.ts`, `e2e/smoke.spec.ts` (input drives the engine; assert via
  `window.__synth.bus`).
- `e2e/patterns.spec.ts` (one key = one Step-Input step, the no-double-trigger
  regression); `tests/ui/keyboard.test.ts` (`keyboard.highlight` is visual-only, and
  v14: `setKeyRoles` writes roles without touching the lit maps).
- `tests/audio/midi.test.ts` (the byte-level dispatch: the CC map, the vel-0
  note-off, System Real-Time / Song Position routing ahead of the channel mask,
  and REQ-7's sole ownership of `onmidimessage`, driven through `initMIDI`
  against `tests/audio/fake-midi-access.ts`).
- `tests/audio/sustain-pedal.test.ts` (the CC64 deferral state machine, REQ-8).
- `npm run e2e` / `npm test` / `npm run typecheck`.

## Open questions / future

- ~~MIDI CC mapping (mod wheel, pitch bend)~~ — done: CC1/7/71/74 + pitch bend
  map to bus params, CC64 is the sustain pedal (REQ-8). Still unmapped: channel
  aftertouch, CC11 expression, CC64 half-pedalling (we treat it as a switch),
  program change, per-channel filtering.
