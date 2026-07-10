# Input & control (keyboard · shortcuts · MIDI)

```yaml
id: input-control
status: implemented
version: 5
owner: core
related:
  - architecture
  - voicing
  - midi-clock-sync
source:
  - src/ui/components/keyboard.ts
  - src/ui/shortcuts.ts
  - src/ui/ui-bridge.ts
  - src/audio/midi.ts
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

## Requirements

- **REQ-1** — All input sources call `bus.noteOn(note, velocity)` /
  `bus.noteOff(note)`; the engine handles the rest.
- **REQ-2** — A computer key emits **exactly one** `bus.noteOn`/`noteOff` (from
  `installShortcuts`). `UiBridge.pressKey/releaseKey` only repaints the on-screen
  keyboard in lock-step (`keyboard.highlight`, a visual toggle); it never calls the
  bus, so no source double-fires the note funnel.
- **REQ-3** — Two key rows (lower from C, upper one octave higher); a base octave is
  shiftable; auto-repeat is ignored.
- **REQ-4** — MIDI (Web MIDI) maps Note On (vel 0 = off) / Note Off to the bus;
  absence of Web MIDI is a no-op (logged), not an error.
- **REQ-6** — MIDI access is requested only after the "Tap to start" gesture,
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
- **REQ-5** — Computer-keyboard shortcuts are suppressed while focus is in an
  editable field (`input` / `textarea` / `[contenteditable="true"]`): keystrokes
  reach the field and never play a note, toggle transport, bend pitch, shift
  octave, or trigger a drum fill. (Same `closest(...)` rule the `contextmenu`
  guard already uses.)

## Technical design

### Contract / public interface

```yaml
installShortcuts(engine, bus, bridge: UiBridge): void   # src/ui/shortcuts.ts
  LOWER: z s x d c v g b h n j m ,    # semitone offsets from C
  UPPER: q 2 w 3 e r 5 t 6 y 7 u i    # one octave up
  baseOctave (shiftable); ignores e.repeat
UiBridge: pressKey(note) / releaseKey(note)             # visual-only -> keyboard.highlight(note, on)
  # never calls bus.noteOn/off; the one note-on per key is installShortcuts' (REQ-2)
initMIDI(engine, bus): Promise<void>                    # src/audio/midi.ts
  requestMIDIAccess({ sysex: false })  # explicit; called post-gesture (REQ-6)
  status >= 0xF8 -> MidiSyncTransport.handleRealtimeByte(byte, ev.timeStamp)  # REQ-7, before the mask
  data[0] === 0xF2 -> MidiSyncTransport.handleSongPosition(((d2)<<7)|d1, ev.timeStamp)  # REQ-7 (v2), before the mask
  0x90 Note On (d2==0 -> noteOff) ; 0x80 Note Off  -> bus.noteOn/noteOff
  builds MidiSyncTransport(access) -> engine.sync.addTransport('midi', ...)  # midi-clock-sync v2
note funnel: bus.onNote -> Engine.playNote/releaseNote (unless passthroughSuppressed)
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
app.ts wiring: bridge.pressKey/releaseKey -> keyboard.highlight(note, true/false)
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

Scenario: MIDI Note On with velocity 0 is a Note Off (edge)
  Given a MIDI device sends 0x90 note 60 velocity 0
  Then bus.noteOff(60) is called
# pinned by: midi.ts handleMessage contract

Scenario: A MIDI clock pulse never reaches note handling (edge)
  Given a MIDI device interleaves 0xF8 clock bytes with note messages
  When a single-byte 0xF8 message arrives
  Then it is routed to the sync transport before the 0xf0 status mask
  And no note or CC handler runs for it
# pinned by: tests/audio/midi-sync-transport.test.ts; midi.ts handleMessage guard

Scenario: A Song Position Pointer routes to the sync transport (edge)
  Given a MIDI master sends 0xF2 lsb msb (beat position)
  When the 3-byte message arrives
  Then it routes to handleSongPosition(((msb)<<7)|lsb, ts) before the 0xf0 mask
  And no note or CC handler runs for it
# pinned by: tests/audio/midi-sync-transport.test.ts; midi.ts handleMessage guard

Scenario: No Web MIDI is a silent no-op
  Given navigator.requestMIDIAccess is undefined
  When initMIDI runs
  Then it logs and returns without throwing
# pinned by: midi.ts (guarded)

Scenario: MIDI permission is not requested before the start gesture
  Given the page has just loaded (start modal showing)
  Then requestMIDIAccess has not been called
  When the user taps to start
  Then initMIDI runs (a browser permission prompt may appear)
  And a denied prompt is a logged no-op, like absence of Web MIDI
# pinned by: main.ts showStartModal onStart -> initMIDI; midi.ts try/catch

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
  regression); `tests/ui/keyboard.test.ts` (`keyboard.highlight` is visual-only).
- `npm run e2e` / `npm test` / `npm run typecheck`.

## Open questions / future

- MIDI CC mapping (mod wheel, pitch bend) could route to `master.modWheel` /
  `master.pitchBend` through the same bus funnel.
