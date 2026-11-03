# Sampler

```yaml
id: sampler
status: implemented
version: 15
owner: core
related:
  - architecture
  - drum-machine
  - onboarding              # the strip's five info badges
  - sample-chop             # chopping a break across these slots
  - time-stretch            # the FIT button on each slot row
  - scratch                 # the other offline rewrite of a slot, in the editor
  - step-settings
  - step-grid-editing
  - banks
  - meter
  - sample-recorder
  - song-mode
  - project-export
  - sample-persistence
  - dialog
  - transport
  - effects
source:
  - src/audio/transport/sampler-machine.ts
  - src/state/patterns.ts
  - src/audio/engine.ts
  - src/ui/panels/sampler-panel.ts
  - src/ui/panels/step-panel-scaffold.ts   # the Clear ▾ row
  - src/audio/recorder/audio-buffer.ts     # reverseBuffer
  - src/audio/param-utils.ts               # the shared toneCutoff
```

An 8-slot one-shot sampler: structurally a sibling of the
[drum machine](drum-machine.md), but each slot plays a user-loaded `AudioBuffer`.

## Background / Why

The sampler reuses the drum machine's grid/bank/step model and
[grid gestures](step-grid-editing.md), with decoded buffers instead of synthesised
voices. **Buffers are not part of a song**: they live in `SamplerMachine`, and a song
saves only the filenames (`patterns.sampleNames`). A song `.json` therefore stays
small, and a slot without its audio shows a `.needs-reload` hint. On the device the
buffers outlive a reload through IndexedDB ([sample-persistence](sample-persistence.md)),
and a [project zip](project-export.md) carries them.

## Requirements

- **REQ-eight-sampler-slots** — 8 slots (`SAMPLER_SLOT_COUNT`), each playing a loaded
  `AudioBuffer` one-shot with the shared [per-step settings](step-settings.md).
- **REQ-slots-are-filled-by-load-or-record** — Slots are filled by **Load** (WAV/MP3)
  or the [record-sound modal](sample-recorder.md). **The last file picked wins**: each
  Load takes a ticket for its slot, and a decode whose ticket is no longer newest is
  discarded, audio and name both.
- **REQ-the-sampler-reads-its-play-bank** — It reads
  `patterns.samplerBank(arrangement.samplerPlayBank)` each tick. Buffers live in the
  machine, **not** in `PatternStore`.
- **REQ-only-sample-filenames-persist** — Only filenames persist in a song. A
  [project-zip](project-export.md) import repopulates the buffers, which clears the hint.
- **REQ-gate-chokes-the-hit-gain** — Gate < 1 chokes the per-hit velocity gain (the
  drums' model).
- **REQ-set-buffer-is-the-one-door** — `setBuffer` emits `onBufferChange(slot)`. It is
  where every slot-filling path converges, so
  [sample-persistence](sample-persistence.md) mirrors slots without a caller knowing.
- **REQ-a-slots-audio-matches-its-label** — A song load that renames a slot evicts its
  buffer (`Song.apply`'s optional `sampler` handle, [song-mode](song-mode.md)
  REQ-stale-sampler-audio-is-evicted). So the hint appears exactly when a named slot
  lacks matching audio.
- **REQ-a-stop-cuts-in-flight-one-shots** — A slot plays arbitrary-length audio, and a
  **tied** cell gets no choke, so a long sample would play on after Stop with nothing
  to silence it (Panic kills synth voices only). `SamplerMachine` keeps a handle on
  every in-flight hit (`{src, g}`, removed by its `onended`). `stopAll()` cuts each
  through **`cutHit`**, the choke path, over the same 5 ms fade: the level comes from
  `gainAt(h, at)`, never a live `.value` read (ADR-027), and a hit already ending
  sooner is not pushed later. A scheduled-but-unplayed hit never plays. The fade is on
  the per-hit gain, upstream of `samplerBus`, so FX tails ring on. **`stopAll` is
  public and `Engine` subscribes `clock.onStop`** (ADR-008), because Engine owns the
  exception: a stop that ends a capture (`recorder.isCapturing()` or
  `bankRender.isRendering()`) is rendering the tail, so it is not cut. That is
  deliberately **not** `canSeek()`'s pair, which tests `isExporting()`. Drums need
  nothing like it: every drum voice schedules a finite `src.stop()` via
  `chokeRoute(...).stopAt(natural)`.
- **REQ-clear-ejects-the-slot** — `Clear ▾ → Clear <name>` is labelled with the
  filename ([step-grid-editing](step-grid-editing.md) REQ-clear-menu-clears-in-bulk),
  so it removes the slot's steps in the edit bank, **and** `sampleNames[slot] →
  null`, **and** `setBuffer(slot, null)`. Otherwise a name-only slot (the shape after a
  song import) could not be cleared, would ride along in every saved song, and could
  only be removed with **New song**. Ejecting through `setBuffer` drops the stored clip
  ([sample-persistence](sample-persistence.md)
  REQ-clip-writes-are-debounced-through-one-hook). A slot with steps *or* a name *or* a
  buffer counts as content. **`Clear bank` does NOT eject**: names are per slot,
  shared by every bank. The row owns its reversal: the toast's **Undo** restores name
  and buffer (still referenced, nothing re-decoded) and calls the lane's pattern undo
  **only** if a step mutation was pushed.
- **REQ-sampler-lane-length-comes-from-the-meter** — `sampler.len` / `sampler.rate`
  decide how many cells play and how long each lasts ([meter](meter.md)
  REQ-each-machine-has-a-loop-length/REQ-each-machine-has-a-step-rate). The defaults
  follow the bar at one cell per tick. The sampler has no fill of its own.
- **REQ-a-slot-starts-from-zero** — Matching the drum voices
  ([drum-machine](drum-machine.md) REQ-a-voice-envelope-reaches-true-zero,
  REQ-a-clamped-hit-carries-its-choke):
  - the per-hit gain **ramps up from 0** over `SAMPLER_ATTACK` (0.5 ms, ~24 samples).
    That turns a non-zero first frame's step into a slope, far too short to soften a
    transient;
  - a start clamped out of the past shifts the **choke by the same delta**, so a short
    gate keeps its length instead of collapsing or dropping the hit. The ramp anchors
    at the clamped start.
- **REQ-a-slot-ends-at-zero** — The end's twin of REQ-a-slot-starts-from-zero:
  a hit whose window runs to the end of its buffer (forwards, the window's end is
  the buffer's; reversed, its start is) fades its per-hit gain to 0 over
  `CHOKE_FADE`, **finishing as the buffer runs out**. Without it nothing shaped a
  natural end, and a clip whose last frame is not near zero (a chopped slice, a
  cropped take, a loop cut on the beat) stopped on a full-scale step, a click on
  every hit. A window that ends inside the buffer still fades after its end, where the
  buffer has audio to fade through.
- **REQ-each-slot-has-a-channel** — Each slot carries the drum tracks' channel shape
  ([drum-machine](drum-machine.md) REQ-per-track-drum-params), downstream of the
  per-hit gain:

  ```
  perHitGain → slotIn → slotTone → slotGain → slotPan → samplerBus
  ```

  - `sampler.t{i}.vol` → `slotGains[i].gain`, `.pan` → `slotPans[i].pan`, `.tone` /
    `.res` → the lowpass `slotTones[i]`. All ramp through `rampTo`.
  - `slotIn` (unity) is what a group choke cuts, **upstream of the tone filter**, so a
    cut tail does not ring through a resonant filter.
  - **`vol` defaults to 1, not the drum machine's 0.85**, because a slot was always
    unity (ADR-006). `sampler.master` (0.85) supplies the headroom.
  - **The panner's input is forced stereo** (`slotGains` declares `channelCount = 2,
    'explicit'`), or a mono clip would arrive 3 dB down at centre. The up-mix is unity,
    and the filter still runs mono for a mono clip.
  - At `tone` 1 / `res` 0 the lowpass is at 20 kHz, Q 0.7 (flat within ~0.1 dB below
    12 kHz): the same near-no-op every drum track carries. A true bypass would need
    eight more wrappers and a mid-hit rewire.
- **REQ-a-hit-plays-a-window-of-the-buffer** — Six per-slot values are read by `play()`
  at trigger time, since each shapes one hit: `pitch`, `start`, `end`, `rev`, `attack`,
  `decay`.
  - `pitch` (semitones) is `playbackRate = 2 ** (pitch/12)`: varispeed, so pitch also
    changes length. It is per slot. Motion automation is no substitute for a step
    field, since hits are scheduled ahead of the frame that wrote it.
  - `start` / `end` are buffer fractions, clamped so `end ≥ start + MIN_WINDOW`. A
    crossed pair clamps, and the hit is never dropped.
  - `rev` plays a **cached reversed copy**, built on the first reversed hit and dropped
    by `setBuffer`. The window stays in forward coordinates (`offset = duration −
    endSec`). The copy is kept when `rev` goes off (ADR-018), since re-reversing would
    stall mid-song.
  - `attack` resolves to `max(attack, SAMPLER_ATTACK)`: the floor is not overridable.
  - The hit is cut at the **earliest** of the window's end, `attack + decay` (when
    `decay > 0`) and the gate's `chokeAt`, through one `cutHit` path.
  - **At its defaults the path is unchanged**: `play()` writes no `playbackRate`, passes
    no offset and schedules no stop. This is a claim about a *code path*, which is what
    a test can pin.
- **REQ-a-slot-can-cut-another-slot** — `sampler.t{i}.choke` puts a slot in one of four
  groups that cut each other (closed hat stops open hat). `sampler.t{i}.poly = mono`
  cuts the slot's own previous hit (an 808 slide). Both default to no group and poly.
  Unlike `drum.choke` ([drum-machine](drum-machine.md) REQ-a-closed-hat-cuts-an-open-hat),
  which infers from voice models, a slot holds arbitrary audio, so the group is stated.
  **The cut is scheduled at the new hit's time**, not `currentTime`, or it would open a
  hole up to a look-ahead wide. `stopAll` does cut at `currentTime`, so the two must
  not share an implementation. The value at the cut is computed from the shape each
  in-flight hit carries (`t0`, `atk`, `vel`, decay): exact, with no
  `cancelAndHoldAtTime`.
- **REQ-a-slots-polyphony-is-bounded** — `MAX_SLOT_VOICES` caps in-flight hits per
  slot, stealing the oldest (nearest its end). It is a guard rail set above ordinary
  playing, against a fast ratchet on a long sample stacking gain.
- **REQ-a-slot-row-carries-a-fit-button** — A slot row with a buffer has a **FIT**
  button ([time-stretch](time-stretch.md)
  REQ-the-slot-fit-button-is-a-quick-fit/REQ-the-quick-fit-is-reversible). It fills
  through `setBuffer` and does **not** rename the clip, which would evict it.

## Technical design

### Contract / public interface

```yaml
SamplerMachine:  # src/audio/transport/sampler-machine.ts
  slotGains: GainNode[]; buffers: (AudioBuffer | null)[]; muted: boolean[]
  setEnabled(on)
  setBuffer(slot, buf | null)
  setSlotMute(slot, muted)
  setSlotVol(slot, v) / setSlotPan(slot, v) / setSlotTone(slot, v) / setSlotRes(slot, v)  # ramped
  setSlotPitch(slot, semitones) / setSlotStart(slot, f) / setSlotEnd(slot, f)              # read at trigger
  setSlotRev(slot, on) / setSlotAttack(slot, s) / setSlotDecay(slot, s)
  setSlotChokeGroup(slot, group) / setSlotMono(slot, on)   # 0 = no group
  triggerSlot(slot, velocity?)     # manual audition — same play(), reproduces a voice bug stopped; one render burst ahead (live-trigger-timing.md)
  onStep(fn) -> unsubscribe
  onBufferChange(fn) -> unsubscribe   # slot's buffer replaced/cleared
  stopAll()                        # fade + stop every in-flight hit (through cutHit)
engine (init):                     # the POLICY, so the capture exception fits
  clock.onStop(() => { if (recorder.isCapturing() || bankRender.isRendering()) return;
                       sampler.stopAll(); })
samplerSlotClearRow(engine, undo, slot): ClearRow   # src/ui/panels/step-panel-scaffold.ts
  # reads name + buffer when the MENU OPENS (the label, and hasContent), so its undo can
  # restore them; clear() reports true if steps, name or buffer went
```

### Data shapes (registry + store)

```yaml
sampler.on:     { discrete, labels: [off, on], default: 0 }
sampler.master: { range: 0..1, default: 0.85 }
sampler.mute / sampler.solo:  # lane mixer (song-mode)
sampler.len / sampler.rate:   # meter.md
sampler.t{i}.mute:   { discrete, labels: [on, mute], default: 0 }   # per slot 0..7
sampler.t{i}.vol:    { range: 0..1,    default: 1 }
sampler.t{i}.pan:    { range: -1..1,   default: 0 }
sampler.t{i}.tone:   { range: 0..1,    default: 1 }    # 1 = open (20 kHz)
sampler.t{i}.res:    { range: 0..1,    default: 0 }    # 0 = Q 0.7
sampler.t{i}.pitch:  { range: -24..24, default: 0, step: 1, unit: st }
sampler.t{i}.start:  { range: 0..1,    default: 0 }    # fraction of the buffer
sampler.t{i}.end:    { range: 0..1,    default: 1 }
sampler.t{i}.rev:    { discrete, labels: [fwd, rev], default: 0 }
sampler.t{i}.attack: { range: 0..0.5,  default: 0 }    # s, floored at SAMPLER_ATTACK
sampler.t{i}.decay:  { range: 0..4,    default: 0 }    # s, 0 = off (natural length)
sampler.t{i}.choke:  { discrete, labels: [off, 1, 2, 3, 4], default: 0 }
sampler.t{i}.poly:   { discrete, labels: [poly, mono], default: 0 }
store:
  PatternStore.samplerBanks: SamplerStep[4..16][slot][16]
  PatternStore.sampleNames:  (string | null)[8]              # in the song; buffers are NOT
  SamplerMachine.buffers:    (AudioBuffer | null)[8]         # device-local (sample-persistence.md)
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  sampler.on -> setEnabled; sampler.master -> laneMixer.setSamplerVol
  sampler.t{i}.* -> the matching setters
graph: perHitGain -> slotIn -> slotTone -> slotGain -> slotPan -> samplerBus
       -> the sampler FX chain (effects.md REQ-the-drum-bus-chain-order) -> preMaster
ui: src/ui/panels/sampler-panel.ts
  sampler-step-<slot>-<s> grid; sampler-load/name/edit/file-<slot>; per-slot mute
  a selected-slot strip below the grid (like the drum tuning strip), rebinding on a row
  change so it never widens the row controls: PITCH START END ATK DECAY TONE RES PAN VOL,
  a REV switch and sampler-slot-reset. Knob/Switch testids derive from the paramId.
  Explained controls sit in persistent `data-help` cells, so the five badges survive a
  slot change (onboarding.md REQ-the-sampler-strip-carries-five-badges).
  A Load decode failure reports via alertDialog (dialog.md), not alert()
```

## Scenarios (BDD)

```gherkin
Scenario: Load a WAV and trigger it from the grid
  Given a WAV is loaded into slot 0
  When a step for slot 0 fires
  Then the decoded buffer plays one-shot at the step velocity
# pinned by: tests/audio/transport/sampler-machine.test.ts, e2e/sampler.spec.ts

Scenario: Buffers are not embedded in a saved song (edge)
  Given slot 0 has a loaded sample
  When the song file is exported and imported elsewhere
  Then only the filename travels; the slot shows a needs-reload hint until re-loaded
# pinned by: tests/state/song.test.ts (sampleNames round-trip), song-mode.md

Scenario: Loading another song does not leave the old song's audio behind (regression)
  Given slot 0 plays "beep.wav"
  When a song naming slot 0 differently (or not at all) is loaded
  Then slot 0 is empty and its label reverts to the placeholder — never the new
    name over the old audio
# pinned by: e2e/song.spec.ts, tests/state/song.test.ts

Scenario: A hit that plays to its buffer's end fades out before it (REQ-a-slot-ends-at-zero, regression)
  Given a slot whose sample ends mid-waveform, and a hit with no window, decay or short gate
  When the hit plays
  Then its gain ramps to 0 over CHOKE_FADE, reaching 0 at the buffer's natural end
  And a reversed hit does the same at the end of its reversed window
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A slot ramps up from zero rather than jumping to velocity (REQ-a-slot-starts-from-zero, regression)
  Given a sample whose first frame is not near silence
  When a slot fires it
  Then the per-hit gain starts at 0 and ramps to velocity over SAMPLER_ATTACK
  And the ramp is anchored at the same clamped time the source starts
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A clamped sampler hit keeps its gate length (REQ-a-slot-starts-from-zero, regression)
  Given a gated slot step whose scheduled time has already passed
  When the start is clamped forward to now
  Then the choke shifts by the same delta and the hit still sounds
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: Stopping the transport cuts a long tied sample (REQ-a-stop-cuts-in-flight-one-shots, regression)
  Given a tied step is playing a long sample, so no choke was ever scheduled
  When the transport stops
  Then the hit fades out over the choke fade and its source is stopped
  And the FX tails keep ringing, because the fade is upstream of the sampler bus
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A song export keeps its final one-shot (REQ-a-stop-cuts-in-flight-one-shots, edge)
  Given the last bar of a song triggers a long sample
  When the export's own clock.stop ends the rendered pass
  Then the one-shot is NOT cut, so the render tail captures it
# pinned by: engine.ts clock.onStop guard (recorder.isCapturing / bankRender.isRendering)

Scenario: Clearing a slot that holds only a name empties it (REQ-clear-ejects-the-slot, regression)
  Given slot 0 is named "kick.wav" with no steps anywhere in the edit bank
  When the user picks Clear ▾ → "Clear kick.wav"
  Then sampleNames[0] is null, the slot's buffer is null, and the label reverts
    to the "S1 …" placeholder
  And a toast reports it — the item is no longer silently inert
  And a song saved next carries sampleNames[0] = null, not the old filename
# pinned by: tests/ui/clear-menu-sampler.test.ts, e2e/sampler.spec.ts

Scenario: Undoing that clear restores name, audio and steps together (REQ-clear-ejects-the-slot)
  Given slot 0 plays "kick.wav" and has steps in the edit bank
  When the user clears it and presses the toast's Undo
  Then the name, the same AudioBuffer and every step come back in one press
# pinned by: tests/ui/clear-menu-sampler.test.ts, e2e/sampler.spec.ts

Scenario: Undoing a name-only clear does not pop someone else's edit (REQ-clear-ejects-the-slot, edge)
  Given an earlier sampler edit sits on the pattern-undo stack
  And slot 0 holds a name but no steps
  When the user clears the slot and presses Undo
  Then the name and buffer return and the earlier edit is still on the stack —
    the lane's pattern undo was never called, because no step mutation was pushed
# pinned by: tests/ui/clear-menu-sampler.test.ts

Scenario: Clear bank leaves the filenames alone (REQ-clear-ejects-the-slot, edge)
  Given slots are named and banks A and B both trigger them
  When the user picks Clear ▾ → Clear bank A
  Then bank A's steps are cleared and every sampleName survives
  And bank B still plays the same audio — a bank-scoped clear never ejects a
    slot shared by the other banks
# pinned by: tests/ui/clear-menu-sampler.test.ts

Scenario: A slot at its defaults takes the plain code path (REQ-a-hit-plays-a-window-of-the-buffer, regression)
  Given every sampler.t0.* param is at its default
  When slot 0 fires
  Then play() writes no playbackRate, passes no start offset and schedules no stop
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: Pitch is varispeed (REQ-a-hit-plays-a-window-of-the-buffer)
  Given sampler.t0.pitch is -12
  When slot 0 fires
  Then playbackRate is 0.5, so the hit sounds an octave down and lasts twice as long
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A trimmed window starts and ends where it says (REQ-a-hit-plays-a-window-of-the-buffer)
  Given start 0.25 and end 0.5 on a 2 s buffer
  When slot 0 fires at time t
  Then the source starts at offset 0.5 s and is faded out 0.5 s after t
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: Reverse keeps the window in forward coordinates (REQ-a-hit-plays-a-window-of-the-buffer, edge)
  Given start 0 and end 0.25 on a 2 s buffer, with rev on
  When slot 0 fires
  Then the cached reversed buffer plays from offset 1.5 s for 0.5 s — the same
    half-second the forward window names, backwards
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: Replacing a slot's buffer drops its reversed copy (REQ-a-hit-plays-a-window-of-the-buffer, edge)
  Given slot 0 has played reversed, so a reversed copy is cached
  When setBuffer(0, other) runs
  Then the cache is dropped, and the next reversed hit reverses the NEW buffer
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: The shortest reason wins (REQ-a-hit-plays-a-window-of-the-buffer, edge)
  Given a 2 s decay, a 1 s window and a step gate that chokes 0.3 s in
  When slot 0 fires
  Then the hit is cut once, at 0.3 s — not three times, and not at the longest
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A crossed window clamps rather than dropping the hit (REQ-a-hit-plays-a-window-of-the-buffer, edge)
  Given end is set below start
  When slot 0 fires
  Then the window clamps to MIN_WINDOW and the hit still sounds
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A mono sample is not quietened by the pan stage (REQ-each-slot-has-a-channel, regression)
  Given a mono buffer in slot 0 and pan at its centre default
  When it plays
  Then the slot's volume stage declares an explicit stereo output, so the panner
    passes it through rather than applying equal-power gain and losing 3 dB
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A slot's volume default does not re-voice existing songs (REQ-each-slot-has-a-channel, regression)
  Given a song carrying no sampler.t*.vol
  When it is loaded
  Then every slot gain resolves to 1 — the unity the slot has always had, not 0.85
# pinned by: tests/state/params.test.ts

Scenario: A closed hat cuts the open hat sharing its group (REQ-a-slot-can-cut-another-slot)
  Given slots 0 and 1 are both in choke group 1, and slot 1 is sounding
  When slot 0 fires
  Then slot 1's hit is faded out and stopped
  And slot 0 sounds normally
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: The cut is scheduled at the new hit, not at "now" (REQ-a-slot-can-cut-another-slot, regression)
  Given a hit is scheduled 80 ms ahead of the audio clock
  When it chokes a sounding slot
  Then the fade is scheduled at the new hit's time, not at currentTime
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A slot in a group does not cut slots outside it (REQ-a-slot-can-cut-another-slot, edge)
  Given slot 0 is in group 1 and slot 2 is in no group
  When slot 0 fires while slot 2 is sounding
  Then slot 2 keeps playing
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A mono slot cuts its own previous hit (REQ-a-slot-can-cut-another-slot)
  Given slot 0 is mono and is already sounding
  When slot 0 fires again
  Then the earlier hit is cut and only the new one continues
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A poly slot still layers (REQ-a-slot-can-cut-another-slot, regression)
  Given slot 0 is at its defaults
  When it fires twice in quick succession
  Then both hits sound
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A slot cannot stack without limit (REQ-a-slots-polyphony-is-bounded)
  Given a slot has MAX_SLOT_VOICES hits in flight
  When it fires again
  Then the oldest hit is stolen rather than the total growing
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: Filling a slot notifies exactly once
  Given a listener registered via onBufferChange
  When setBuffer(3, buf) runs
  Then the listener fires once with slot 3
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: The last file picked into a slot wins (REQ-slots-are-filled-by-load-or-record, regression)
  Given a first file whose decode is slow and a second, picked after it, whose decode is fast
  When both decodes finish, the first one last
  Then the slot holds the second file's audio and name
# pinned by: tests/ui/sampler-panel.test.ts
```

## Tests & verification

- `tests/audio/transport/sampler-machine.test.ts`, `tests/ui/clear-menu-sampler.test.ts`,
  `tests/ui/sampler-panel.test.ts`, `e2e/sampler.spec.ts` (WAV via `setInputFiles` + a
  Node-built fixture) — `npm test` / `npm run e2e`.

## Open questions / future

- **Per-step pitch / slice (p-locks)** need a field on `SamplerStep`, which is exactly
  `TriggerCell`; splitting them costs a sampler branch in `serialize.ts`,
  `song-validate.ts` and `song-author.ts`. Any such field must be optional and a no-op.
- **Loop mode / bar-synced varispeed**: `bindTempoLocked` + `TEMPO_LOCKS`
  ([tempo-lock](tempo-lock.md)) make the sync half nearly free. Offline time-stretch
  exists ([time-stretch](time-stretch.md)); a slot that re-fits itself on a BPM change
  is the open realtime half.
- **Live scratching** stays out: a per-voice anti-aliased variable-rate reader on the
  audio thread is what ADR-010's budget refuses ([scratch](scratch.md) does it offline).
- **Per-slot drive**: the sampler bus already has Dirt, and eight waveshapers are a
  real idle cost.
- **QWERTY pads** would need a mode, since every letter row is the synth keyboard. MIDI
  channel 10 already plays the slots ([input-control](input-control.md)
  REQ-channel-ten-plays-the-sampler).
