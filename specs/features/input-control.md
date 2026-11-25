# Input & control (keyboard · shortcuts)

```yaml
id: input-control
status: implemented
version: 24
owner: core
related:
  - architecture
  - voicing
  - midi-input        # the MIDI note source, its pedal, channels and expression
  - sequencer
  - onboarding
  - keyboard-layout
  - scale-quantization
source:
  - src/ui/key-roles.ts
  - src/ui/components/keyboard.ts
  - src/ui/shortcuts.ts
  - src/ui/ui-bridge.ts
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
note-ons, which the funnel forwards to every consumer. MIDI is the third source;
its own rules (pedal, channels, expression) are [midi-input](midi-input.md).

The funnel stays deliberately **undiscriminating** — it cannot know a note was meant
for one particular consumer — so a consumer that *captures* rather than plays notes
must scope itself. The sequencer's Step Input is the one such consumer: it is armed
only while its own grid is on screen ([sequencer](sequencer.md) REQ-step-input-arms-only-on-screen).

## Requirements

- **REQ-all-input-goes-through-the-bus** — All input sources call
  `bus.noteOn(note, velocity, source)` / `bus.noteOff(note, source)`; the engine
  handles the rest. `source` names who holds the note — `keys` (the computer
  keyboard), `pointer:<id>` (one per finger or mouse on the on-screen keyboard),
  `midi` — so a pitch two of them hold sounds until both let go
  ([voicing](voicing.md) REQ-a-note-sounds-while-any-source-holds-it). Omitted,
  it is `default`.

- **REQ-a-key-emits-exactly-one-note-on** — A computer key emits **exactly one**
  `bus.noteOn`/`noteOff` (from `installShortcuts`).
  `UiBridge.pressKey/releaseKey` only repaints the on-screen keyboard in
  lock-step (`keyboard.highlight`, a visual toggle); it never calls the bus, so
  no source double-fires the note funnel.

- **REQ-two-key-rows-an-octave-apart** — Two key rows (lower from C, upper one
  octave higher); a base octave is shiftable; auto-repeat is ignored. The
  note mapping is **exported** and is the single source for
  the About modal's keyboard diagram ([onboarding](onboarding.md) REQ-keys-are-drawn-as-keys),
  which derives each key's rank and column from its semitone rather than
  restating the letters, so a moved binding re-draws the diagram. What is
  exported is **`NOTE_ROWS`** — the canonical positional shape (`code → semitone`,
  the piano). The character-keyed `LOWER`/`UPPER` the keydown branch matches
  against are module-private and **composed** at runtime from `NOTE_ROWS` and
  the active layout's `code → character` table
  ([keyboard-layout](keyboard-layout.md)
  REQ-layout-is-a-code-to-character-table), rebuilt whenever it changes. The
  piano shape lives in one place; which characters reach it is the layout's
  business, and the diagram draws the shape rather than either set of letters.

- **REQ-shortcuts-are-suppressed-in-a-field** — Computer-keyboard shortcuts are
  suppressed while focus is in an editable field (`input` / `textarea` /
  `[contenteditable="true"]`): keystrokes reach the field and never play a note,
  toggle transport, bend pitch, shift octave, or trigger a drum fill. (Same
  `closest(...)` rule the `contextmenu` guard already uses.) **This gates
  presses, not releases.** A note, the fill or the bend pressed outside a field is
  released by its `keyup` even after focus moved into one (hold `Z`, click a name
  field, let go: the note must not hang), as REQ-shortcuts-yield-to-an-open-modal
  leaves `keyup` ungated. A key typed in the field was never recorded as held, so
  its `keyup` releases nothing, and the bend springs back only if a bend key is
  held, so typing `'` cannot reset a MIDI wheel.

- **REQ-shortcuts-yield-to-an-open-modal** — **While a modal is open, the
  global shortcuts do nothing.** A dialog is the whole of the user's attention,
  and the keys belong to it: Space and Enter press its focused button, Tab moves
  through it, Escape closes it (owned by `Modal`,
  [add-a-modal-dialog](../recipes/add-a-modal-dialog.md)); otherwise Delete would
  clear a step on the tab underneath and Space's `preventDefault` would swallow
  the focused button's click. `installShortcuts` asks `anyModalOpen()` (modal-stack.ts) at the top of
  `keydown`. `keyup` and `blur` are **not** gated: a key held when the dialog
  opened must still be released when it comes up, or its note would hang.
  Non-modal floating windows do not count — they are tools you play alongside.
  Every modal counts, `Modal` or not: About, the AI Prompt and the start modal
  join the stack themselves ([add-a-modal-dialog](../recipes/add-a-modal-dialog.md)).

- **REQ-octave-shift-is-minus-and-equal** — **The keyboard octave shifts
  on `-` and `=`, not the arrow keys.** The bare arrows are navigation — a focused
  slider, knob or list owns them ([knob-keyboard-access](knob-keyboard-access.md),
  [dropdown](dropdown.md) REQ-arrow-keys-move-the-selection). `-` shifts
  down and `=` up, matched on `e.code` (`Minus` / `Equal`) for the reason the bend
  is (REQ-pitch-bend-is-quote-and-slash): the pair is chosen for *where it sits*,
  the two keys right of `0`, and on QWERTZ/AZERTY those codes carry other
  characters (one of them a dead key). The numpad's `-` / `+`
  (`NumpadSubtract` / `NumpadAdd`) do the same. The range is unchanged (base
  octave 0..7). Shift+arrows still move the playhead a bar
  ([transport-position](transport-position.md) REQ-home-and-shift-arrows-seek); a
  bare arrow does nothing globally.

- **REQ-question-mark-toggles-the-badges** — **`?` toggles the info
  badges.** It is free by construction: `e.key` for Shift+`/` is `?`, so neither
  the `/` pitch-bend branch nor its
  `keyup` twin matches, and the blanket `ctrlKey || metaKey || altKey` bail-out
  does not test `shiftKey`. It is still ordered **above** the `'`/`/` branch
  (REQ-pitch-bend-is-quote-and-slash) so a future layout quirk can't turn a help request into a pitch bend.
  Like every
  other non-note key it goes through the `UiBridge` (`toggleInfoBadges`) rather
  than importing the onboarding layer into `shortcuts.ts` — same reason as
  `toggleTransport` / `undoActiveMachine`. Behaviour is owned by
  [info-badges](info-badges.md) REQ-the-info-button-gesture-inventory; it is the
  second route to the badges, the first being the header's ⓘ button
  (info-badges REQ-the-info-button-is-a-toggle).

- **REQ-a-lit-key-is-remembered-as-an-element** — **A lit key is remembered
  as an element, never re-derived.** `keyboard.transpose` (the OCT strip) shifts
  the note→element mapping: an element sounds `note + transpose * 12`, so the
  key *for* a sounding note is `note - transpose * 12`. Both highlight APIs
  resolve that through **one** private `keyFor(note)`, so `highlight` and
  `seqHighlight` agree (at OCT +2 a computer key playing C4 lights nothing: it has
  no key on the drawn board). The light-up **stores the resolved element**; the
  light-down removes the class from *that* element, never re-resolving — the
  sequencer's on and off are two deferred timers (`shell/bottom.ts`), and an OCT
  change between them (a song or demo load restores `keyboard.transpose`) would
  resolve the off to another key or none. Lit entries are **refcounted**, so two of the four
  sequencer tracks sounding the same note cannot have the first release dim a
  key the second is still holding.

- **REQ-a-note-off-names-the-pressed-note** — **A note-off always names the
  note that was pressed.** Two sources re-computed it at release time against
  mutable state and stranded the note when that state moved mid-hold:
    - the **on-screen keyboard** stores the sounding note alongside the element at
      `pointerdown` and releases *that*, so moving OCT while a key is held cannot
      send `noteOff` for a different MIDI number;
    - **`installShortcuts`** keys its held-note map by the **physical key**
      (`e.code`; the case-folded `e.key` only where a browser reports no code) and
      stores the note it pressed, so neither the octave shift (`-`/`=`) nor a Shift
      press mid-hold can make `keyup` miss the map and skip `release()`. Matching
      by character is what the note rows do; *holding* by character stranded the
      digit-row notes, where Shift does not change case but the character
      (`2` ↔ `@`, `5` ↔ `%`).
  This is the input-layer twin of [sequencer](sequencer.md) REQ-a-stop-releases-every-tracks-note: nothing may
  hold a note whose release depends on state that is free to change underneath it.

  **Two computer keys on one note release it once, with the last key.**
  `,` and `Q` both play C5, and an octave shift mid-hold can line any two keys
  up on one note. The synth has one voice set per note, so a second press only
  retriggers it, and the first release must not end it while the other key is
  still down. `installShortcuts` counts the keys holding each note. The first
  key sounds the note, a further key does nothing, and only the last key up
  sends `noteOff`. Across sources (a finger on the on-screen key, MIDI) the
  same holds one level up: the note ends when the last *source* lets go
  ([voicing](voicing.md) REQ-a-note-sounds-while-any-source-holds-it).

- **REQ-pitch-bend-is-quote-and-slash** — **Pitch bend is `'` up and `/`
  down, chosen for where the keys sit.** Both write `master.pitchBend` (+1 / −1)
  on keydown and spring back to 0 on keyup. On the standard layout `'` sits
  directly **above** `/`, so the arrangement states the vertical gesture, and the
  About list draws them as two stacked rows ([onboarding](onboarding.md)
  REQ-about-key-symbols-are-drawn/REQ-the-key-list-folds-to-six-rows).
  - `.` is **unbound** — no alias: two keys for one outcome is what
    [ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2 rules out. `'` is
    in neither note row.
  - **Matched on `e.code` (`Quote` / `Slash`), not `e.key`** — the only such
    bindings in `installShortcuts`. The pair is chosen for *position*, so position
    is what is matched: a dead `'` (US-International) still fires the right
    `code`, QWERTZ and AZERTY bend on the keys the diagram draws, and a `Shift`
    pressed mid-hold cannot make the `keyup` miss (`?` / `"`) and strand the bend —
    REQ-a-note-off-names-the-pressed-note's rule: no state whose release depends on
    a value free to change mid-hold.
  - **Losing the window releases the bend**, in the `blur` handler beside held
    notes and Fill — a `keyup` never arrives once focus has left.
  - `?` keeps its branch **above** this one, so `Shift`+`Slash` toggles the info
    badges (REQ-question-mark-toggles-the-badges); `Shift`+`Quote` bends.
  - The `pitchBend` help topic names the same two keys, pinned by a test.

- **REQ-note-keys-follow-the-layout** — **The note keys follow a
  switchable keyboard layout.** `installShortcuts` rebuilds `LOWER`/`UPPER`
  whenever [keyboard-layout](keyboard-layout.md) reports a change
  (REQ-layout-change-needs-no-reload there), so a pick in the About modal's gear
  takes effect on the next keystroke without a reload. Load-bearing details:
  - **Held notes are released before the rebuild.** `held` is keyed by
    *character*, so a remap would leave whatever is down with no key that can
    ever match its `keyup` — a hung voice, the exact failure REQ-a-note-off-names-the-pressed-note exists to
    prevent. The `blur` handler is the precedent for the bulk release.
  - Only the note rows move. `Shift`+`R`, `Shift`+`L` and `Ctrl/Cmd`+`Z` keep
    their `e.key` letters, and the fill is the KeyF position wherever `f` is a
    note ([keyboard-layout](keyboard-layout.md) REQ-layout-scope-is-note-keys-only); the bend
    pair stays positional (REQ-pitch-bend-is-quote-and-slash).
  - The picker's residual risk — a wrong selection means wrong notes, where
    `e.code` could not be wrong — is recorded as
    [keyboard-layout](keyboard-layout.md) REQ-character-bindings-carry-a-known-risk, not re-argued here.

- **REQ-a-third-highlight-layer** — **A third highlight layer, and it is
  not a lit key.**
  `Keyboard.setKeyRoles(state | null)` marks each key with the musical role its pitch
  class plays in the current key ([scale-quantization](scale-quantization.md) REQ-the-key-is-shown-where-you-play,
  which owns *what* the roles mean):
  - **Static, not evented.** A role is a standing property of a pitch class, written
    to every key at once when the key changes — no refcount, nothing to unwind.
  - **An attribute, never `setLit`.** Roles go to `data-role`; the lit states stay
    the global `active` / `seq` classes, so a full-keyboard sweep can never touch the
    refcounted maps REQ-a-lit-key-is-remembered-as-an-element pins.
  - **Pitch class, so OCT is free**: a role needs no de-transposing and no repaint
    when `keyboard.transpose` moves.
  - **The lit classes win.** A key that is pressed or sequenced shows that, and its
    role tint steps aside — enforced in CSS, so no JS ordering can get it wrong.

- **REQ-a-lit-white-key-sits-lower** — **A lit white key sits lower than its
  neighbours.** A lit black key already reads as pressed: its cast shadow shrinks
  and it sinks (REQ-a-black-key-casts-a-shadow-from-the-top-left). A lit white key
  (`active` or `seq`) carries a thin inset shade on its left and right edges, as if
  the raised keys beside it cast it.
  - **Where two lit white keys meet there is no shade.** They sit at the same depth,
    so there is no step between them. Hold C4 and D4 and C4 is shaded only on its left,
    D4 only on its right; in a run of three the middle key has no side shade at all.
  - **Whichever way a key is lit.** A pressed key next to a sequenced one joins the
    same way. Depth is about being down, not about who put it there.
  - **CSS only.** The white keys are the board's in-order siblings (the black-key
    overlay comes after them), so `+` and `:has(+ …)` find the neighbour. Each side's
    shade is a custom property that the adjacency rules blank out, and `keyboard.ts`
    knows nothing about it.
  - **Its glow stays on the board.** A lit white key's halo spreads sideways onto its
    neighbours but is clipped flush at the key's top and bottom, and at the board's
    outer ends, so no light reaches the bed around the keys.

- **REQ-a-black-key-casts-a-shadow-from-the-top-left** — **A black key casts a soft
  shadow down-right onto the whites**, lit from the top-left like the faceplate. Lit
  (`active` or `seq`), it keeps a shorter one, so it reads as pressed.
  - **The shadow starts at the board's top edge**, as if the keys ran on under a
    fallboard: it is cast by a `::after` that reaches above the key, and the
    black-key overlay clips to the board (`overflow: clip`), so the offset never
    leaves a gap at the top and nothing spills onto the bed above.

## Technical design

### Contract / public interface

```yaml
installShortcuts(engine, bus, bridge: UiBridge): void   # src/ui/shortcuts.ts
  LOWER: z s x d c v g b h n j m ,    # semitone offsets from C
  UPPER: q 2 w 3 e r 5 t 6 y 7 u i    # one octave up
  baseOctave (shiftable); ignores e.repeat
  keyId(k) = k.length === 1 ? k.toLowerCase() : k   # one key identity
  NOTE_ROWS.lower / .upper: Record<code, semitone>  # the piano shape
  LOWER / UPPER: Record<char, semitone>             # composed with the layout
                                     # (REQ-two-key-rows-an-octave-apart); also the source for About's
                                     # keyboard diagram. Rebuilt on layout change.
  held: Map<keyId, note>             # the note PRESSED (REQ-a-note-off-names-the-pressed-note)
  '?' -> bridge.toggleInfoBadges()   # REQ-question-mark-toggles-the-badges; ordered above the bend branch below
  code 'Quote' -> master.pitchBend +1   # REQ-pitch-bend-is-quote-and-slash; matched on e.code, not e.key
  code 'Slash' -> master.pitchBend -1   # REQ-pitch-bend-is-quote-and-slash; '.' is unbound
  keyup on either code -> 0             # same code both ways
UiBridge: pressKey(note) / releaseKey(note)             # visual-only -> keyboard.highlight(note, on)
  # never calls bus.noteOn/off; the one note-on per key is installShortcuts' (REQ-a-key-emits-exactly-one-note-on)
  toggleInfoBadges()                 # -> Onboarding.toggleInfoBadges (REQ-question-mark-toggles-the-badges)
note funnel: bus.onNote -> Engine.playNote/releaseNote (unless passthroughSuppressed)
  capture consumers scope themselves; seq Step Input is armed only while visible
  (sequencer.md REQ-step-input-arms-only-on-screen) — the funnel itself stays undiscriminating
```

### Layer touchpoints

```yaml
boot (main.ts): builds the UiBridge, installShortcuts(...)
on-screen keyboard: src/ui/components/keyboard.ts -> bus.noteOn/noteOff directly
  keyboard.highlight(note, on): visual-only key toggle (the UiBridge target; no bus call)
  keyFor(note) = keys.get(note - transpose * 12)   # the ONE resolver (REQ-a-lit-key-is-remembered-as-an-element)
  litActive / litSeq: Map<note, {el, count}>       # refcounted; clearSeqHighlights() on clock.onStop
  activeByPointer: Map<pointerId, {key, sounding}> # release `sounding` (REQ-a-note-off-names-the-pressed-note)
  setKeyRoles(state|null): el.dataset.role per key # REQ-a-third-highlight-layer — keyed by midi % 12, no refcount
shell/bottom.ts wiring: bridge.pressKey/releaseKey -> keyboard.highlight(note, true/false)
  onKeyChange(bus, ...) -> keyboard.setKeyRoles(...)  # src/ui/key-roles.ts owns the vocabulary
arp ownership: when the arp's passthroughSuppressed is set, the engine gates raw note
  passthrough (Engine.arpPassthroughSuppressed); the sequencer never does
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
# pinned by: e2e/patterns.spec.ts, tests/ui/keyboard.test.ts

Scenario: Moving OCT mid-playback leaves no key lit (REQ-a-lit-key-is-remembered-as-an-element, regression)
  Given the sequencer is playing and has lit a key for a sounding note
  When keyboard.transpose changes before that note's light-off is due — by OCT, or by a demo load restoring its own
  Then the light-off clears the key that was actually lit, and no key is left glowing
# pinned by: tests/ui/keyboard.test.ts

Scenario: Two tracks on the same note do not dim each other (edge)
  Given two sequencer tracks sound the same note with different gates
  When the shorter one releases
  Then the key stays lit until the longer one releases too
# pinned by: tests/ui/keyboard.test.ts

Scenario: A role does not disturb a lit key (REQ-a-third-highlight-layer)
  Given a key is lit by the sequencer and carries an in-scale role
  When the key is re-roled by a change of scale, and then the light-off falls due
  Then the light-off still clears the element it lit
  And the key keeps whichever role it now has
# pinned by: tests/ui/keyboard.test.ts

Scenario: Two lit white keys side by side read as one pressed span (REQ-a-lit-white-key-sits-lower)
  Given C4 and D4 are both lit, by a finger, a computer key, MIDI or the sequencer
  Then C4 is shaded on its left edge only and D4 on its right edge only
  And a lone lit white key is shaded on both edges
  And no lit key's glow reaches the bed above, below or beside the keys
# pinned by: keyboard.module.css sibling rules; appearance by eye (jsdom computes no box-shadow)

Scenario: A pressed black key casts less shadow than a resting one (REQ-a-black-key-casts-a-shadow-from-the-top-left)
  Given a black key at rest, it casts a soft shadow down-right onto the whites
  When it is lit, by any source
  Then its shadow is shorter and tighter
  And either way the shadow runs right up to the top edge of the board
# pinned by: keyboard.module.css; appearance by eye (jsdom computes no box-shadow)

Scenario: Moving OCT while a key is held does not hang the voice (REQ-a-note-off-names-the-pressed-note)
  Given a key on the on-screen keyboard is held down
  When keyboard.transpose changes and the pointer is then released
  Then bus.noteOff names the note that pointerdown played, so no voice hangs
# pinned by: tests/ui/keyboard.test.ts

Scenario: Shifting octave while a computer key is held releases it (REQ-a-note-off-names-the-pressed-note, regression)
  Given the user holds 'z'
  When they press the octave-up key (`=`) and then release 'z'
  Then exactly one bus.noteOff fires, for the note 'z' originally played
  And the on-screen key un-lights
# pinned by: tests/ui/shortcuts.test.ts

Scenario: Shift pressed while a digit-row note is held still releases it (REQ-a-note-off-names-the-pressed-note, regression)
  Given the user holds '2', which plays C#5
  When they press Shift, so the key now reads '@', and release '2'
  Then exactly one bus.noteOff fires, for C#5, and the on-screen key un-lights
  # the bug: the held map was keyed by the character, and '@' was never pressed
# pinned by: tests/ui/shortcuts.test.ts

Scenario: Two keys on one note release it with the last key (REQ-a-note-off-names-the-pressed-note, regression)
  Given the user holds ',' and 'q', which both play C5
  When they release ','
  Then the note keeps sounding: no bus.noteOff, and no second noteOn when 'q' went down
  And releasing 'q' sends the one noteOff
# pinned by: tests/ui/shortcuts.test.ts

Scenario: A key held by two fingers, or a finger and a computer key, sounds until both let go (REQ-all-input-goes-through-the-bus, regression)
  Given C4 is held by one finger on the on-screen keyboard
  And a second finger, or the computer key for C4, presses it too
  When the first of them lets go
  Then C4 keeps sounding, as the key keeps looking pressed
  And it is released when the last one lets go
# pinned by: tests/audio/engine-scale.test.ts, tests/ui/keyboard.test.ts

Scenario: Pitch bend sits on the physical Quote and Slash keys (REQ-pitch-bend-is-quote-and-slash)
  Given no editable field has focus
  When the user holds Quote, then Slash, releasing each
  Then master.pitchBend goes to 1, then -1, springing back to 0 each time
  And . does nothing — it is unbound
  And a dead Quote key (e.key 'Dead') still bends, because the branch matches e.code
  And Shift pressed mid-hold (e.key '?' or '"' on the keyup) still releases the bend
  And losing the window mid-hold returns the bend to 0, with the held notes and Fill
# pinned by: tests/ui/shortcuts.test.ts

Scenario: The Pitch wheel help names the keys that bend (REQ-pitch-bend-is-quote-and-slash)
  Given the `pitchBend` help topic
  Then it names ' for up and / for down, and not the unbound . key
# pinned by: tests/ui/help-content.test.ts

Scenario: ? toggles the info badges without bending pitch (REQ-question-mark-toggles-the-badges)
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

Scenario: A note held into a text field is still released (REQ-shortcuts-are-suppressed-in-a-field, regression)
  Given 'z' is held, playing a note, with no field focused
  When focus moves into a text field and 'z' is released there
  Then the note is released
  And a ' typed in the field does not reset a pitch bend nobody is holding on the keyboard
# pinned by: tests/ui/shortcuts.test.ts

Scenario: An open modal silences the shortcuts behind it (REQ-shortcuts-yield-to-an-open-modal, regression)
  Given a confirm dialog is open over a machine tab with a selected step
  When the user presses Delete, Space, Home or 'z'
  Then no step is cleared, the transport does not toggle, nothing seeks and no note plays
   And a note held when the dialog opened is still released on its keyup
# pinned by: tests/ui/shortcuts.test.ts

Scenario: A hand-built dialog counts as a modal too (REQ-shortcuts-yield-to-an-open-modal, regression)
  Given About or the AI Prompt is open
  Then anyModalOpen() is true, so the shortcuts and the file drop stand down
   And with a confirm raised over the AI Prompt, Escape closes only the confirm
# pinned by: tests/ui/about.test.ts, tests/ui/ai-prompt.test.ts

Scenario: - and = shift the octave; the bare arrows do not (REQ-octave-shift-is-minus-and-equal)
  Given the default base octave
  When the user presses = and then 'z'
  Then 'z' plays one octave higher, and - brings it back
   And the numpad - and + do the same
   And a bare ArrowRight changes nothing
# pinned by: tests/ui/shortcuts.test.ts
```

## Tests & verification

- `e2e/controls.spec.ts`, `e2e/smoke.spec.ts` (input drives the engine; assert via
  `window.__synth.bus`).
- `e2e/patterns.spec.ts` (one key = one Step-Input step, the no-double-trigger
  regression); `tests/ui/keyboard.test.ts` (`keyboard.highlight` is visual-only;
  `setKeyRoles` never touches the lit maps).
- `tests/ui/shortcuts.test.ts` — every global key and the modal stand-down;
  `tests/ui/modal.test.ts` for the stack it asks.
- `npm run e2e` / `npm test` / `npm run typecheck`.
