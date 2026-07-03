# Input & control (keyboard · shortcuts · MIDI)

```yaml
id: input-control
status: implemented
version: 2
owner: core
related:
  - architecture
  - voicing
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
sequencer. The computer keyboard routes through a `UiBridge` so the on-screen
keyboard's visuals stay in sync (it presses/releases the same keys the engine
hears). MIDI is wired through Web MIDI when available and degrades silently when
not.

## Requirements

- **REQ-1** — All input sources call `bus.noteOn(note, velocity)` /
  `bus.noteOff(note)`; the engine handles the rest.
- **REQ-2** — Computer-keyboard input goes via `UiBridge.pressKey/releaseKey` so the
  on-screen keyboard repaints in lock-step.
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
UiBridge: pressKey(note) / releaseKey(note)             # syncs on-screen keys
initMIDI(engine, bus): Promise<void>                    # src/audio/midi.ts
  requestMIDIAccess({ sysex: false })  # explicit; called post-gesture (REQ-6)
  0x90 Note On (d2==0 -> noteOff) ; 0x80 Note Off  -> bus.noteOn/noteOff
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
arp/seq ownership: when passthroughSuppressed, the engine gates raw note passthrough
```

## Scenarios (BDD)

```gherkin
Scenario: A computer key plays a note and lights the on-screen key
  Given the audio context is running
  When the user presses 'z'
  Then bus.noteOn fires for C at the base octave and the on-screen C lights up
# pinned by: e2e/controls.spec.ts (keyboard interaction), e2e/smoke.spec.ts

Scenario: MIDI Note On with velocity 0 is a Note Off (edge)
  Given a MIDI device sends 0x90 note 60 velocity 0
  Then bus.noteOff(60) is called
# pinned by: midi.ts handleMessage contract

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
- `npm run e2e` / `npm run typecheck`.

## Open questions / future

- MIDI CC mapping (mod wheel, pitch bend) could route to `master.modWheel` /
  `master.pitchBend` through the same bus funnel.
