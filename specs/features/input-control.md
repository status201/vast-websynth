# Input & control (keyboard · shortcuts · MIDI)

```yaml
id: input-control
status: implemented
version: 1
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

## Technical design

### Contract / public interface

```yaml
installShortcuts(engine, bus, bridge: UiBridge): void   # src/ui/shortcuts.ts
  LOWER: z s x d c v g b h n j m ,    # semitone offsets from C
  UPPER: q 2 w 3 e r 5 t 6 y 7 u i    # one octave up
  baseOctave (shiftable); ignores e.repeat
UiBridge: pressKey(note) / releaseKey(note)             # syncs on-screen keys
initMIDI(engine, bus): Promise<void>                    # src/audio/midi.ts
  0x90 Note On (d2==0 -> noteOff) ; 0x80 Note Off  -> bus.noteOn/noteOff
note funnel: bus.onNote -> Engine.playNote/releaseNote (unless passthroughSuppressed)
```

> Note: there is **no** `window.__synthKeyboard` / `window.__transportToggle`
> global anymore — input is driven via `UiBridge` and the bus. The only dev global
> is `window.__synth` (see [architecture](../architecture.md)).

### Layer touchpoints

```yaml
boot (main.ts): builds the UiBridge, installShortcuts(...), initMIDI(...)
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
```

## Tests & verification

- `e2e/controls.spec.ts`, `e2e/smoke.spec.ts` (input drives the engine; assert via
  `window.__synth.bus`).
- `npm run e2e` / `npm run typecheck`.

## Open questions / future

- MIDI CC mapping (mod wheel, pitch bend) could route to `master.modWheel` /
  `master.pitchBend` through the same bus funnel.
