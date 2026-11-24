# MIDI input (notes · pedal · channels · expression)

```yaml
id: midi-input
status: implemented
version: 1
owner: core
related:
  - architecture
  - input-control      # the bus funnel MIDI notes join
  - midi-clock-sync    # the clock bytes midi.ts hands off
  - sampler            # channel 10's slots
  - audio-lifecycle    # the gesture MIDI access waits for
  - presets
  - song-file
source:
  - src/audio/midi.ts
  - src/audio/sustain-pedal.ts
  - src/state/midi-channel.ts
  - src/state/master-level.ts     # masterLevel — the one volume law, read by the engine and the knob
  - src/ui/components/sync-section.ts
```

External MIDI through Web MIDI: notes join the same `bus.noteOn` / `bus.noteOff`
funnel as the on-screen and computer keyboards ([input-control](input-control.md)
REQ-all-input-goes-through-the-bus), and the pedal, channel, expression and pressure
rules that only a MIDI device can exercise.

## Background / Why

Web MIDI is optional and permission-gated, so everything here degrades to a silent
no-op when it is absent or denied. `midi.ts` is the one place raw bytes arrive: the
clock bytes go to the sync transport ([midi-clock-sync](midi-clock-sync.md)) and
the rest become bus notes, a sampler trigger, or writes to the master performance
params. Those performance params (expression, the pitch wheel) belong to the
performer's hands, not to a sound, which is why they are never saved.

## Requirements

- **REQ-midi-maps-note-on-and-off** — MIDI (Web MIDI) maps Note On (vel 0 = off)
  / Note Off to the bus; absence of Web MIDI is a no-op (logged), not an error.

- **REQ-midi-access-follows-a-gesture** — MIDI access is requested only after a
  **user gesture** — the "Tap to start" click where there is one, and otherwise
  the first touch anywhere after an auto-start
  ([audio-lifecycle](audio-lifecycle.md) REQ-post-gesture-work-is-deferred) — and never at page load:
  Chrome ≥124 shows a permission prompt for *all* MIDI access (sysex or not),
  and an unprompted load-time permission dialog is hostile to the (majority)
  MIDI-less visitor. The request passes an explicit `{ sysex: false }`; a denied
  prompt degrades exactly like absence of Web MIDI (logged, no error).

- **REQ-one-module-owns-the-midi-access** — `midi.ts` is the **sole owner** of
  the shared `MIDIAccess` handler properties (`onmidimessage`/`onstatechange`
  are single-assignment — a second owner would silently clobber them). System
  Real-Time bytes (≥ 0xF8) and a leading **`0xF2` Song Position Pointer** are
  dispatched **before** the `& 0xf0` channel-voice mask (0xF8 & 0xF0 = 0xF0 would
  mis-dispatch) to the clock-sync transport ([midi-clock-sync](midi-clock-sync.md)
  REQ-song-position-pointer-jumps-the-slave), never to note/CC handling.
  `midi.ts` registers that transport, and `onstatechange` refreshes its port
  counts.

- **REQ-the-sustain-pedal-is-midi-layer** — **Sustain pedal (CC64)**, MIDI-layer:
  while the pedal is down (CC64 value ≥ 64) a MIDI note-off (0x80, or 0x90
  vel 0) is **deferred** — it never reaches `bus.noteOff`; the note is
  remembered as *sustained*. Pedal release (value < 64) flushes `bus.noteOff`
  for every sustained note. A note re-pressed while sustained is live again (its
  later note-off obeys the pedal state at that moment — no stuck note, no double
  note-off). The pedal sits **before** the bus funnel, so it applies to MIDI
  input only (on-screen / computer keys are unaffected) and every bus consumer
  sees the deferral — with the arpeggiator on, the pedal behaves as an arp latch
  (accepted behaviour). State lives in the pure `SustainPedal` helper
  (`src/audio/sustain-pedal.ts`).

### Channels

- **REQ-channel-ten-plays-the-sampler** — **MIDI channel 10 plays the
  sampler's slots.** Channel 10 is the General MIDI drum channel, where every
  pad controller and drum module already sends, so it needs no setup: a note-on on channel 10 triggers slot
  `note − 36` (C1 = slot 1 … G1 = slot 8) through `SamplerMachine.triggerSlot`
  at the note's velocity. Notes outside 36..43 are ignored; note-offs are
  ignored (a slot plays its own length, like a step). **Channel 10 never reaches
  the synth** — not its notes, CCs, bend or pressure — so a drum pad cannot
  also play a lead. This is the one input that does not go through the bus
  ([input-control](input-control.md) REQ-all-input-goes-through-the-bus): a slot
  trigger is not a note, and the sampler panel's own click already calls
  `triggerSlot` directly. Sustain does not apply. The sampler **lane's** mute and
  solo apply — they act on its bus — but a **slot's** own mute does not: it
  filters the pattern's hits, and a pad is played by hand, like the slot-name
  audition.
- **REQ-the-midi-input-channel-is-selectable** — **The synth's MIDI
  channel is selectable.** With two devices on one interface, omni plays both
  into the synth. A **MIDI in** picker in the Song tab's Sync section
  (`sync-midi-channel`) offers **Omni** and channels 1–16 except 10 (which is
  the sampler's). Omni is the default and means every channel but 10. The
  choice is device-scoped and remembered (`websynth.midi.channel`,
  `src/state/midi-channel.ts`), like the sync mode — not a param, because it
  describes the rig, not the song. A stored value that is not a valid channel
  reads as omni. It filters channel-voice messages only; clock and Song Position
  have no channel.
- **REQ-a-midi-note-is-released-by-whatever-ended-it** — **A MIDI note
  the synth sounded is always released.** `midi.ts` remembers, per input port,
  the (channel, note) pairs it sent `noteOn` for. Two rules follow:
  - **The channel filter gates note-ons, not note-offs.** A note-off for a
    pair the synth sounded is honoured even if the input channel has changed
    since (REQ-the-midi-input-channel-is-selectable), so changing the channel
    with a key down cannot hang its note.
  - **A port that goes away releases what it was holding.** On every
    `statechange`, a remembered port that is missing from `access.inputs` or
    reads `disconnected` has its notes released. If that port is holding the
    sustain pedal, the pedal is lifted, which flushes its deferred note-offs,
    and if it set the pitch bend last, the bend goes back to centre. A pedal
    held on another, still-connected device stays down, and an unplugged keyboard
    never leaves a note, the pedal or the bend stranded until a Panic.
  - **The pedal and the bend are released the same way.** The (port, channel)
    holding the pedal down, and the one that moved the bend off centre, are
    remembered. Their pedal-up (CC64 below 64) and their bend messages pass the
    channel filter until the pedal is up and the bend is back at centre, so a
    channel change with the pedal down cannot strand it.

### Expression, pressure and the master controls

- **REQ-cc11-is-expression** — **CC11 is expression.** An expression
  pedal or breath controller sends CC11. It writes
  `master.expression` (0..1, **default 1 — a no-op**, ADR-006), which scales the
  master gain together with the volume: the gain is `volume² × expression²`,
  the same law the volume already uses, so CC7 sets the level and CC11 rides
  inside it instead of fighting it for one value. It is a performance control,
  not part of a sound (`isPatchParam` excludes it, like the mod wheel), and the
  graph gains no node: the one master gain value is computed from both.
  It is also **never saved** — not in a song, the session autosave or a preset
  (`UNSAVED_PARAMS` / `savedParams`, applied by `Song.capture` and
  `Presets.capture`): a pedal resting heel-down when Save is pressed would
  otherwise produce a song that loads silent. Loading a song resets it to 1, its
  default, until the pedal next moves.
- **REQ-the-pitch-wheel-is-never-saved** — `master.pitchBend` joins
  `UNSAVED_PARAMS`, for the reason REQ-cc11-is-expression gives. The PITCH strip,
  `'` / `/`, MIDI pitch bend and Tape Stop's dive all write it, and all of them
  spring back. So a song, session autosave or preset taken while one is held, or
  mid-dive, would otherwise load detuned. Loading resets it to 0, its default.
  Only the live wheel is excluded. A sequencer step's `bend` / `bendShape`
  ([step-settings](step-settings.md) REQ-a-seq-step-carries-a-bend) is pattern data
  and saves as before, and so does a motion lane assigned to `master.pitchBend`.
- **REQ-the-volume-knob-reads-the-gain-it-applies** — **The volume knob
  reads the gain it applies.** The `master.volume` readout is the dB of the gain
  the engine applies at expression 1: `20·log10(masterLevel(volume, 1))`, which
  is `40·log10(volume)`. Expression is left out on purpose — the pedal is a
  gesture riding inside the level, and the knob shows the level. The engine's
  gain and the knob's text both call `masterLevel` in `src/state/master-level.ts`,
  so the number and the sound cannot disagree (the role `src/state/eq.ts` plays
  for the EQ's filters and its drawn curve).
- **REQ-aftertouch-joins-the-mod-wheel** — **Channel aftertouch joins the
  mod wheel.** Pressing into the keys (0xD0) is the most common expressive
  gesture a keyboard offers. It drives the same destination as the mod wheel —
  LFO 1 depth and the matrix's mod-wheel source — so it means something on every
  patch with no new routing. The two do not fight: `master.modWheel` takes the
  **larger** of the last CC1 and the last pressure, so letting go of the keys
  falls back to wherever the wheel was left. Polyphonic aftertouch (0xA0) stays
  unmapped.

## Technical design

### Contract / public interface

```yaml
initMIDI(engine, bus): Promise<void>                    # src/audio/midi.ts
  requestMIDIAccess({ sysex: false })  # explicit; called post-gesture (REQ-midi-access-follows-a-gesture)
  status >= 0xF8 -> MidiSyncTransport.handleRealtimeByte(byte, ev.timeStamp)  # REQ-one-module-owns-the-midi-access, before the mask
  data[0] === 0xF2 -> MidiSyncTransport.handleSongPosition(((d2)<<7)|d1, ev.timeStamp)  # before the mask
  0x90 Note On (d2==0 -> noteOff) ; 0x80 Note Off  -> bus.noteOn/noteOff
  note on/off route through SustainPedal first (REQ-the-sustain-pedal-is-midi-layer); CC64 -> pedal.setPedal(v>=64)
  builds MidiSyncTransport(access) -> engine.sync.addTransport('midi', ...)  # midi-clock-sync
SustainPedal                                            # src/audio/sustain-pedal.ts (pure, REQ-the-sustain-pedal-is-midi-layer)
  noteOn(note): void          # marks held; un-sustains a retriggered note
  noteOff(note): boolean      # false = deferred (pedal down); true = pass to bus.noteOff
  setPedal(down): number[]    # on release: the sustained notes to flush via bus.noteOff
```

### Layer touchpoints

```yaml
start gesture (main.ts showStartModal): initMIDI(...) fires on tap-to-start (REQ-midi-access-follows-a-gesture)
Song tab Sync section (sync-section.ts): the MIDI in picker (REQ-the-midi-input-channel-is-selectable)
```

## Scenarios (BDD)

```gherkin
Scenario: Channel 10 plays the sampler, never the synth (REQ-channel-ten-plays-the-sampler)
  Given MIDI input
  When a note-on for note 36 velocity 100 arrives on channel 10
  Then sampler slot 1 is triggered at velocity 100/127 and no synth note plays
  And note 43 triggers slot 8, and note 44 or a channel-10 CC does nothing
# pinned by: tests/audio/midi.test.ts

Scenario: The input channel filters what plays the synth (REQ-the-midi-input-channel-is-selectable)
  Given the MIDI in channel is set to 2
  When notes arrive on channels 1 and 2
  Then only the channel 2 note plays
  And with Omni, both play
  And a stored channel of 10 or 99 reads as Omni
# pinned by: tests/audio/midi.test.ts, tests/state/midi-channel.test.ts

Scenario: CC11 rides inside the volume (REQ-cc11-is-expression)
  Given master.volume is 0.8
  When CC11 sends 64
  Then master.expression is 64/127 and master.volume is unchanged
  And neither a preset nor a saved song carries master.expression
# pinned by: tests/audio/midi.test.ts, tests/state/preset-session.test.ts, tests/audio/engine-resume.test.ts, tests/state/song.test.ts

Scenario: A bend held at Save time is not saved (REQ-the-pitch-wheel-is-never-saved, regression)
  Given the pitch wheel (or `'`, or MIDI bend, or a Tape Stop dive) holds master.pitchBend at 1
  When a song, the session autosave or a preset is captured
  Then the capture carries no master.pitchBend, so the song loads in tune
  And a sequencer step's bend of +2 is still in the captured song
# pinned by: tests/state/song.test.ts

Scenario: The volume readout is the applied gain (REQ-the-volume-knob-reads-the-gain-it-applies)
  Given master.volume is 0.5
  Then the knob reads -12.0dB, and the engine's master gain is 0.25
  And at 0.8 it reads -3.9dB, and at 1 it reads 0.0dB
# pinned by: tests/state/master-level.test.ts

Scenario: Aftertouch and the mod wheel take the larger (REQ-aftertouch-joins-the-mod-wheel)
  Given the mod wheel at 0.25
  When channel pressure rises to 1 and falls back to 0
  Then master.modWheel goes to 1 and returns to 0.25
# pinned by: tests/audio/midi.test.ts

Scenario: Changing the MIDI channel with a key down still releases it (REQ-a-midi-note-is-released-by-whatever-ended-it, regression)
  Given the synth listens on channel 1 and a channel-1 key is held
  When the input channel is switched to 2 and the key is released
  Then the note is released
  And a channel-1 note-on is still ignored
  And a channel-1 pedal-up, or a bend back to centre, from the holder of that pedal or bend still lands
# pinned by: tests/audio/midi.test.ts

Scenario: Unplugging a keyboard releases its notes, pedal and bend (REQ-a-midi-note-is-released-by-whatever-ended-it, regression)
  Given a key held, the sustain pedal down and the bend pushed up on one port
  When that port disappears and statechange fires
  Then every note it held is released, the sustained ones too, and the bend is centred
  And a second port's held note keeps sounding
  And a pedal held down on a second, still-connected port stays down
# pinned by: tests/audio/midi.test.ts

Scenario: MIDI Note On with velocity 0 is a Note Off (edge)
  Given a MIDI device sends 0x90 note 60 velocity 0
  Then bus.noteOff(60) is called
# pinned by: tests/audio/midi.test.ts (channel-voice messages)

Scenario: Clock pulses and Song Position never reach note handling (edge)
  Given a MIDI device interleaves 0xF8 clock bytes and 0xF2 lsb msb with note messages
  Then each routes to the sync transport before the 0xf0 status mask — 0xF2 as handleSongPosition(((msb)<<7)|lsb, ts)
  And no note or CC handler runs for either
# pinned by: tests/audio/midi.test.ts, tests/audio/transport/sync/midi-sync-transport.test.ts

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
  When 0x90 note 60 velocity 0 arrives (a note-off in disguise, REQ-midi-maps-note-on-and-off)
  Then it is deferred exactly like an 0x80 note-off
# pinned by: tests/audio/midi.test.ts (both paths through midi.ts), tests/audio/sustain-pedal.test.ts

Scenario: CC64 63/64 boundary (edge)
  Given CC64 value 64 arrives, then a note-off
  Then the note-off is deferred (64 is "down")
  Given CC64 value 63 arrives instead
  Then sustained notes flush and later note-offs pass through (63 is "up")
# pinned by: tests/audio/midi.test.ts (the 63 case over the wire), tests/audio/sustain-pedal.test.ts
```

## Tests & verification

- `tests/audio/midi.test.ts` (the byte-level dispatch: the CC map, the vel-0
  note-off, System Real-Time / Song Position routing ahead of the channel mask,
  and REQ-one-module-owns-the-midi-access's sole ownership of `onmidimessage`, driven through `initMIDI`
  against `tests/audio/fake-midi-access.ts`).
- `tests/audio/sustain-pedal.test.ts` (the CC64 deferral state machine, REQ-the-sustain-pedal-is-midi-layer).
- `tests/state/midi-channel.test.ts` (the stored channel, untrusted),
  `tests/state/master-level.test.ts` (the volume law and its readout),
  `tests/state/song.test.ts` (expression is never saved). **By ear, with a
  pedal**: sweep CC11 during a demo — a smooth swell, no zipper or click.

## Open questions / future

- Unmapped MIDI: CC64 half-pedalling (treated as a switch), polyphonic
  aftertouch, and program change — which first needs a decision about what a
  program number names (a factory preset by index? a saved slot?).
