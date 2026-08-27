# Sampler

```yaml
id: sampler
status: implemented
version: 9   # v9: REQ-14/15 — per-slot choke groups and a mono mode, and a
             #     polyphony cap so a slot can no longer stack without limit
             # v8: REQ-12/13 — each slot gains a channel (vol/pan/tone/res) and a
             #     per-hit voice window (pitch/start/end/rev/attack/decay); every
             #     default reproduces v7 exactly
             # v7: REQ-11 — a slot ramps up from zero and carries its choke when
             #     a hit is clamped out of the past (drum-machine.md REQ-15/17)
             # v6: the lane's length + step rate come from the meter (REQ-10)
             # v5: the Clear ▾ row item ejects the slot's sample, not just its
             #     steps (REQ-9)
             # v4: a transport stop cuts in-flight one-shots (REQ-8)
owner: core
related:
  - architecture
  - drum-machine
  - onboarding              # REQ-25: the strip's five info badges
  - sample-chop             # chopping a break across these slots
  - step-settings
  - step-grid-editing
  - banks
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
  - src/ui/panels/step-panel-scaffold.ts   # the Clear ▾ row (REQ-9)
  - src/audio/recorder/audio-buffer.ts     # reverseBuffer (REQ-13)
  - src/audio/param-utils.ts               # the shared toneCutoff (REQ-12)
```

An 8-slot one-shot sampler — structurally a sibling of the
[drum machine](drum-machine.md), but each slot plays a user-loaded `AudioBuffer`.

## Background / Why

The sampler reuses the drum machine's grid/bank/step model — including the
shared [grid gestures](step-grid-editing.md) — but swaps synthesised
voices for decoded audio buffers. Crucially, **buffers are not part of a song** —
they live in `SamplerMachine`; a song saves only the filenames
(`patterns.sampleNames`), and after import the user re-loads the files (the UI shows
a `.needs-reload` hint). This keeps song files small and avoids embedding audio.
Device-locally the buffers *do* outlive a reload: they are mirrored into
IndexedDB by [sample-persistence](sample-persistence.md), which is invisible to
the song format.

## Requirements

- **REQ-1** — 8 slots (`SAMPLER_SLOT_COUNT`), each plays a loaded `AudioBuffer`
  one-shot, honouring the shared [per-step settings](step-settings.md).
- **REQ-2** — Slots filled by **Load** (WAV/MP3) or the
  [record-sound modal](sample-recorder.md).
- **REQ-3** — Reads `patterns.samplerBank(arrangement.samplerPlayBank)` each tick;
  buffers live in the machine, **not** in `PatternStore`.
- **REQ-4** — Only filenames persist in a song; buffers are reloaded after a
  song import (`.needs-reload` hint). A [project-zip](project-export.md) import
  repopulates the buffers directly — the hint clears without a manual reload.
- **REQ-5** — Gate < 1 chokes the per-hit velocity gain (same choke model as drums).
- **REQ-6** — `setBuffer` emits `onBufferChange(slot)`. It is the **one** place
  every slot-filling path converges, which is what lets
  [sample-persistence](sample-persistence.md) mirror slots to storage without a
  single caller knowing.
- **REQ-7** — **A slot's audio never disagrees with its label.** A buffer
  belongs to the name beside it, so a song load that renames a slot evicts that
  slot's buffer (`Song.apply`'s optional `sampler` handle — see
  [song-mode](song-mode.md) REQ-3b). The `.needs-reload` hint is therefore
  trustworthy: it appears whenever a named slot has no matching audio, and a
  slot showing no hint really is playing what it says.
- **REQ-8** (v4) — **A transport stop cuts in-flight one-shots.** Unlike a drum
  voice, a slot plays a user-supplied buffer of arbitrary length, and a **tied**
  cell gets no choke at all (`chokeAt` returns `undefined` when the hit holds), so
  a long sample kept playing to its end after Stop — with no way to silence it,
  since Panic only kills synth voices. `SamplerMachine` therefore keeps a handle
  on every hit still in flight (`{src, g}`, added in `play` and removed by the
  `onended` it already installs) and `stopAll()` fades each one out over the same
  5 ms the choke uses before `src.stop()` — no click, and a hit still scheduled
  inside the look-ahead simply never plays. The fade is on the per-hit gain,
  upstream of `samplerBus`, so the [FX](effects.md) tails ring out untouched: Stop
  silences the *source*, never the room.
  **`stopAll` is public and `Engine` subscribes `clock.onStop`, not the machine**
  ([ADR-008](../decisions/adr-008-components-self-wire-params.md)) — because the one
  exception is Engine's to know. A stop that *ends a capture*
  ([audio-export](audio-export.md), [render-to-sampler](render-to-sampler.md)) is
  deliberately rendering the tail, so the cut is skipped while
  `recorder.isCapturing()` or `bankRender.isRendering()`. Note this is
  **deliberately not** the pair `canSeek()` guards on: `canSeek()` tests
  `recorder.isExporting()`, because an offline export may be seeked while a live
  capture may not (`Engine`, with a code comment saying so). Chopping the last bar's one-shots out of an
  export would be a worse bug than the hang this fixes.
  **Drums need no equivalent**: every drum voice already schedules a finite
  `src.stop()` via `chokeRoute(...).stopAt(natural)`, so a tied drum cell decays
  naturally and terminates. Cutting that decay would remove a tail, not a hang.
- **REQ-9** (v5) — **`Clear ▾ → Clear <name>` ejects the slot, not just its
  steps.** The sampler's row-scoped clear
  ([step-grid-editing](step-grid-editing.md) REQ-6) is labelled with the slot's
  **filename**, so it must remove the file: the slot's steps in the edit bank,
  **and** `sampleNames[slot] → null`, **and** `setBuffer(slot, null)`. Until v5 it
  cleared only steps, which left three defects with one cause — a name no gesture
  could remove:
    - a slot holding *just* a name (the common shape after a song import, before
      the audio is re-loaded) had nothing to clear, so the item was silently
      inert — no change, no toast;
    - the name kept riding along in every saved song, so an emptied sampler still
      exported filenames and greeted the next load with `.needs-reload` hints;
    - the only route to an empty slot was **New song**, which throws the whole
      arrangement away to delete one filename.
  Ejecting through `setBuffer` is what lets
  [sample-persistence](sample-persistence.md) REQ-2 drop the stored clip without
  this caller knowing, and REQ-7's invariant survives untouched: name and audio
  go together, so the slot ends up genuinely empty rather than named-and-silent.
  Because the item removes the sample, **a named slot counts as content** for the
  no-dead-item rule ([step-grid-editing](step-grid-editing.md) REQ-6): the row is
  offered whenever the slot holds steps *or* a name *or* a buffer, and only a slot
  with none of the three is left out. Getting that wrong in either direction
  reintroduces the bug — filter on steps alone and the name-only slot is
  unreachable again; filter on nothing and an empty slot gets an inert item.
  **`Clear bank` deliberately does NOT do this.** `sampleNames` is per-slot and
  shared by all four banks while steps are per-bank, so a bank-scoped eject would
  silently un-sound the same slots in the three banks the user is not looking at.
  Because the pattern-undo stack carries steps only
  ([step-grid-editing](step-grid-editing.md) REQ-7), the row owns its own
  reversal: the toast's **Undo** puts the name and the buffer back — the
  `AudioBuffer` is still referenced by that closure, so nothing is re-decoded —
  and calls the lane's pattern undo **only** if the store actually pushed a step
  mutation. An unconditional call would pop an unrelated edit off the stack when
  the slot held no steps, which is the failure the conditional pins.

- **REQ-10** (v6) — **The lane's length and step rate come from the meter.**
  `sampler.len` / `sampler.rate` decide how many of the 16 slots-worth of cells
  play and how long each lasts ([meter](meter.md) REQ-10/REQ-14). Defaults follow
  the bar at one cell per tick, so a 4/4 song is unchanged. The sampler still has
  no fill behaviour of its own and plays straight through the drum machine's.


- **REQ-11** (v7) — **A slot starts from zero, and a clamped hit keeps its gate.**
  Two edges the drum voices already own ([drum-machine](drum-machine.md) REQ-15
  and REQ-17), stated here because `SamplerMachine.play` schedules its own gain:
  - The per-hit gain **ramps up from 0** over `SAMPLER_ATTACK` (0.5 ms) instead of
    being assigned with `gain.value = velocity`. A sample whose first frame is not
    near zero otherwise starts on a full-scale step — a click on every hit, and
    user audio is exactly the material we cannot assume anything about. 0.5 ms is
    ~24 samples at 48 kHz: enough to turn a step into a slope, far too short to
    soften a transient (a chop's own attack is orders of magnitude longer).
  - The start is clamped forward out of the past, and the **choke shifts by the
    same delta**, so a short gate keeps its length rather than collapsing — or
    resolving to 0 and dropping the hit outright. The ramp is anchored at the
    clamped start for the same reason.

- **REQ-12** (v8) — **Each slot has a channel.** Until v8 a slot's only per-slot
  control was its mute: `slotGains[i]` was created at unity and never written again, so
  a break the user recorded was the one voice in the instrument that could not be
  levelled, placed or filtered — while every *synthesised* drum track could
  ([drum-machine](drum-machine.md) REQ-2). A slot now carries the same shape of channel,
  downstream of the per-hit gain:

  ```
  perHitGain → slotIn → slotTone → slotGain → slotPan → samplerBus
  ```

  - `sampler.t{i}.vol` → `slotGain.gain`; `.pan` → `slotPan.pan`; `.tone` / `.res` →
    the lowpass `slotTone`'s `frequency` and `Q`. All four are `AudioParam`s written
    through `rampTo`, so a knob drag never zippers.
  - `slotIn` is unity and inert today. It exists so REQ-14's group choke has a node to
    cut that is **upstream of the tone filter** — a cut tail must not go on ringing
    through a resonant filter — and so adding that later re-wires nothing.
  - **`vol` defaults to 1, not the drum machine's 0.85.** A default is the
    compatibility surface ([ADR-006](../decisions/adr-006-no-op-param-defaults.md)):
    today's slot is unity, so 0.85 would quietly pull every existing song and demo down
    by ~1.4 dB. Matching the drum machine here would be tidiness bought with the corpus.
    `sampler.master` (0.85) already supplies the bus-level headroom.
  - **The panner's input is forced stereo.** At pan 0 a `StereoPannerNode` passes a
    *stereo* input straight through, but applies equal-power gain to a *mono* one —
    so a mono clip would arrive 3 dB down, which is exactly the silent re-voicing
    ADR-006 exists to prevent. `slotGain` therefore declares
    `channelCount = 2, channelCountMode = 'explicit'`. The up-mix it performs
    (L = R = input, unity) is what the graph did downstream anyway, so stereo
    material is untouched and the filter upstream still runs mono for a mono clip.
  - **What the channel is not is bit-transparent, and that is stated rather than
    claimed away.** At `tone` 1 / `res` 0 the lowpass sits at 20 kHz with Q 0.7:
    flat to within ~0.1 dB below 12 kHz, −3 dB at 20 kHz. That is the *same* no-op
    every drum track has carried since the machine existed
    ([drum-machine](drum-machine.md) REQ-2), and it is the honest boundary of
    REQ-13's exact-path guarantee — which is about `play()`'s scheduling, not about
    the graph. Making it truly transparent would need a per-slot bypass
    ([ADR-012](../decisions/adr-012-true-bypass-disconnects.md)) — eight more
    wrappers, and a rewire that can land mid-hit — for a hair of air at the very
    top. Not worth it; revisit only if a listening test says otherwise.

- **REQ-13** (v8) — **A hit plays a *window* of a slot's buffer.** Six per-slot values
  are read by `play()` at trigger time rather than living on an `AudioParam`, because
  each shapes an individual hit: `pitch`, `start`, `end`, `rev`, `attack`, `decay`.
  - `pitch` is semitones, applied as `playbackRate = 2 ** (pitch/12)` — varispeed, so a
    pitched hit also changes length. It is per **slot**, not per step. Automating
    `sampler.t{i}.pitch` from the [motion sequencer](motion-sequencer.md) is *not* a
    substitute for a step field: motion writes on animation frames while hits are
    scheduled up to `SCHEDULE_AHEAD_S` ahead, so the value read when a hit is scheduled
    is not the value showing when it sounds.
  - `start` / `end` are fractions of the buffer, clamped so `end ≥ start + MIN_WINDOW`.
    A crossed pair clamps — it never drops the hit silently, which is the same choice
    REQ-11 made for a choke that resolved to 0.
  - `rev` plays a **cached reversed copy** of the buffer, built on the first reversed
    hit and dropped by `setBuffer` — REQ-6 is the one convergence point, so no caller
    has to know the cache exists. The window stays stated in *forward* coordinates and
    is mapped onto the copy (`offset = duration − endSec`), so the numbers keep meaning
    what the waveform shows. The copy is **kept** when `rev` goes back off
    ([ADR-018](../decisions/adr-018-audio-graph-memory-is-committed-not-reclaimed.md)):
    re-reversing on a live toggle would stall the main thread mid-song.
  - `attack` resolves to `max(attack, SAMPLER_ATTACK)`. REQ-11's 0.5 ms floor is not a
    default to be overridden downward — it is what stops user audio clicking, and a
    0 ms attack would reintroduce exactly the bug REQ-11 fixed.
  - The hit is cut at the **earliest** of three reasons: the window's end, the decay's
    end (`attack + decay`, when `decay > 0`), and the per-step gate's `chokeAt`. One
    cut path, reusing REQ-8's `CHOKE_FADE`/`CHOKE_STOP` fade, so a shortened hit never
    clicks whichever reason shortened it.
  - **At its defaults the path is the v7 path.** With
    `pitch 0 · start 0 · end 1 · fwd · attack 0 · decay 0` `play()` writes no
    `playbackRate`, passes no offset and schedules no stop. ADR-006 is usually a claim
    about a value; here it is a claim about a *code path*, which is the only form of it
    a test can actually pin — and one does, below.


- **REQ-14** (v9) — **A slot can cut another slot, or itself.**
  `sampler.t{i}.choke` puts a slot in one of four groups; two slots sharing a
  group cut each other, which is how an open hat stops when the closed one
  lands. `sampler.t{i}.poly` set to `mono` makes a slot cut its own previous
  hit, which is how an 808 slide behaves. Both default to the behaviour the
  machine already had (no group, poly), so no existing song changes.

  Deliberately unlike the drum machine's: `drum.choke` is one machine-wide switch
  keyed on **voice model** ([drum-machine](drum-machine.md) REQ-12), because any
  drum track can hold any voice and the closed/open hat pair is discoverable from
  the model alone. A slot holds arbitrary audio, so nothing can be inferred and
  the group has to be stated. The asymmetry is deliberate, not an oversight.

  **The cut is scheduled at the new hit's time, not at `currentTime`.** Hits are
  scheduled up to `SCHEDULE_AHEAD_S` ahead, so cutting at "now" would silence the
  old hit up to 100 ms before the new one arrives — an audible hole exactly where
  the choke is supposed to be seamless. `stopAll` (REQ-8) *does* cut at
  `currentTime`, because a transport stop genuinely is now; the two must not be
  made to share an implementation on the strength of looking alike.

  Reaching a hit's gain mid-envelope needs the value it will have at the cut, and
  `cancelAndHoldAtTime` is not available everywhere this app runs. Each in-flight
  hit therefore carries the shape it was scheduled with (`t0`, `atk`, `vel`, and
  the decay if any) and the value is computed. It is exact — the envelope is
  straight lines — and it needs nothing of the platform.

- **REQ-15** (v9) — **A slot's polyphony is bounded.** Every hit used to allocate
  a source with nothing ever capping the total: a fast ratchet on a long sample
  stacks without limit, and each layer adds gain. `MAX_SLOT_VOICES` caps the
  in-flight hits per slot, stealing the oldest first — the one nearest its end,
  and the one a listener is least likely to be following. The cap is set high
  enough that ordinary playing never reaches it: this is a guard rail, not a
  voicing decision, and a player who hears it working has already lost.

## Technical design

### Contract / public interface

```yaml
SamplerMachine:  # src/audio/transport/sampler-machine.ts
  slotGains: GainNode[]; buffers: (AudioBuffer | null)[]; muted: boolean[]
  setEnabled(on)
  setBuffer(slot, buf | null)
  setSlotMute(slot, muted)
  # v8 REQ-12 — ramped AudioParams on the slot's channel
  setSlotVol(slot, v) / setSlotPan(slot, v) / setSlotTone(slot, v) / setSlotRes(slot, v)
  # v8 REQ-13 — plain fields, read by play() at trigger time
  setSlotPitch(slot, semitones) / setSlotStart(slot, f) / setSlotEnd(slot, f)
  setSlotRev(slot, on) / setSlotAttack(slot, s) / setSlotDecay(slot, s)
  # v9 REQ-14 — 0 = no group; mono cuts the slot's own previous hit
  setSlotChokeGroup(slot, group) / setSlotMono(slot, on)
  triggerSlot(slot, velocity?)     # manual audition — same play(), so it reproduces
                                   # a voice bug with the transport stopped
  onStep(fn) -> unsubscribe
  onBufferChange(fn) -> unsubscribe   # slot's buffer replaced/cleared
  stopAll()                        # v4, REQ-8: fade + stop every in-flight hit
engine (init):                     # v4 — the POLICY, so the capture exception fits
  clock.onStop(() => { if (recorder.isCapturing() || bankRender.isRendering()) return;
                       sampler.stopAll(); })
  # canSeek() guards on isExporting(), NOT isCapturing() — different questions.
samplerSlotClearRow(engine, undo, slot): ClearRow   # v5, REQ-9
  # src/ui/panels/step-panel-scaffold.ts — beside the Clear menu wiring it feeds,
  # and out of the panel closure so it is reachable from a unit test.
  # Reads the name + buffer when the MENU OPENS (which is also the label, and
  # `hasContent`), so its own `undo` can put them back; `clear()` reports true if
  # steps, name or buffer went. sampler-panel.ts passes it as the lane's one row.
```

### Data shapes (registry + store)

```yaml
sampler.on:     { discrete, labels: [off, on], default: 0 }
sampler.master: { range: 0..1, default: 0.85 }
sampler.mute / sampler.solo:  # lane mixer (song-mode)
sampler.t{i}.mute:   { discrete, labels: [on, mute], default: 0 }   # per slot 0..7
# v8 — the per-slot channel (REQ-12) and voice window (REQ-13). Every default
# reproduces v7 exactly; see REQ-12 on why vol is 1 and not the drum machine's 0.85.
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
# v9 — REQ-14. Both default to what the machine already did.
sampler.t{i}.choke:  { discrete, labels: [off, 1, 2, 3, 4], default: 0 }
sampler.t{i}.poly:   { discrete, labels: [poly, mono], default: 0 }
store:
  PatternStore.samplerBanks: SamplerStep[bank][slot][step]   # 4 × 8 × 16
  PatternStore.sampleNames:  (string | null)[8]              # in the song; buffers are NOT
  SamplerMachine.buffers:    (AudioBuffer | null)[8]         # device-local (sample-persistence.md)
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  sampler.on -> setEnabled; sampler.master -> laneMixer.setSamplerVol
  sampler.t{i}.mute -> sampler.setSlotMute(i, ...)
  sampler.t{i}.{vol,pan,tone,res,pitch,start,end,rev,attack,decay} -> the v8 setters
  sampler.t{i}.{choke,poly} -> setSlotChokeGroup / setSlotMono (v9)
graph: perHitGain -> slotIn -> slotTone -> slotGain -> slotPan -> samplerBus
       (+ sampler dist/phaser/delay/reverb/duck) -> preMaster
ui: src/ui/panels/sampler-panel.ts
  sampler-step-<slot>-<s> grid; sampler-load/name/edit/file-<slot>; per-slot mute
  v8: a selected-slot strip below the grid, mirroring the drum panel's tuning strip
  (drum-panel.ts) — it rebinds on a row change, so it never widens the 210px row
  controls. Knobs PITCH START END ATK DECAY TONE RES PAN VOL, a REV switch and
  sampler-slot-reset. Knob/Switch testids derive from the paramId (testids.md).
  Each control that earns an explanation sits in a persistent `data-help` cell
  the strip never replaces, so the five info badges anchored there survive a slot
  change ([onboarding](onboarding.md) REQ-25).
  Load decode failure reports via the custom alertDialog (see dialog.md), not alert()
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

Scenario: A slot ramps up from zero rather than jumping to velocity (v7, REQ-11, regression)
  Given a sample whose first frame is not near silence
  When a slot fires it
  Then the per-hit gain starts at 0 and ramps to velocity over SAMPLER_ATTACK
  And the ramp is anchored at the same clamped time the source starts
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A clamped sampler hit keeps its gate length (v7, REQ-11, regression)
  Given a gated slot step whose scheduled time has already passed
  When the start is clamped forward to now
  Then the choke shifts by the same delta and the hit still sounds
# pinned by: tests/audio/transport/sampler-machine.test.ts


Scenario: Stopping the transport cuts a long tied sample (v4, REQ-8, regression)
  Given a tied step is playing a long sample, so no choke was ever scheduled
  When the transport stops
  Then the hit fades out over the choke fade and its source is stopped
  And the FX tails keep ringing, because the fade is upstream of the sampler bus
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A song export keeps its final one-shot (v4, REQ-8, edge)
  Given the last bar of a song triggers a long sample
  When the export's own clock.stop ends the rendered pass
  Then the one-shot is NOT cut, so the render tail captures it as it always did
# pinned by: engine.ts clock.onStop guard (recorder.isRecording / bankRender.isRendering)

Scenario: Clearing a slot that holds only a name empties it (v5, REQ-9, regression)
  Given slot 0 is named "kick.wav" with no steps anywhere in the edit bank
  When the user picks Clear ▾ → "Clear kick.wav"
  Then sampleNames[0] is null, the slot's buffer is null, and the label reverts
    to the "S1 …" placeholder
  And a toast reports it — the item is no longer silently inert
  And a song saved next carries sampleNames[0] = null, not the old filename
# pinned by: tests/ui/clear-menu-sampler.test.ts, e2e/sampler.spec.ts

Scenario: Undoing that clear restores name, audio and steps together (v5, REQ-9)
  Given slot 0 plays "kick.wav" and has steps in the edit bank
  When the user clears it and presses the toast's Undo
  Then the name, the same AudioBuffer and every step come back in one press
# pinned by: tests/ui/clear-menu-sampler.test.ts, e2e/sampler.spec.ts

Scenario: Undoing a name-only clear does not pop someone else's edit (v5, REQ-9, edge)
  Given an earlier sampler edit sits on the pattern-undo stack
  And slot 0 holds a name but no steps
  When the user clears the slot and presses Undo
  Then the name and buffer return and the earlier edit is still on the stack —
    the lane's pattern undo was never called, because no step mutation was pushed
# pinned by: tests/ui/clear-menu-sampler.test.ts

Scenario: Clear bank leaves the filenames alone (v5, REQ-9, edge)
  Given slots are named and banks A and B both trigger them
  When the user picks Clear ▾ → Clear bank A
  Then bank A's steps are cleared and every sampleName survives
  And bank B still plays the same audio — a bank-scoped clear never ejects a
    slot shared by the other three banks
# pinned by: tests/ui/clear-menu-sampler.test.ts

Scenario: A slot at its defaults takes the pre-v8 code path (v8, REQ-13, regression)
  Given every sampler.t0.* param is at its default
  When slot 0 fires
  Then play() writes no playbackRate, passes no start offset and schedules no stop
  And the scheduling is exactly v7's — the channel's own no-op cost is REQ-12's
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: Pitch is varispeed (v8, REQ-13)
  Given sampler.t0.pitch is -12
  When slot 0 fires
  Then playbackRate is 0.5, so the hit sounds an octave down and lasts twice as long
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A trimmed window starts and ends where it says (v8, REQ-13)
  Given start 0.25 and end 0.5 on a 2 s buffer
  When slot 0 fires at time t
  Then the source starts at offset 0.5 s and is faded out 0.5 s after t
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: Reverse keeps the window in forward coordinates (v8, REQ-13, edge)
  Given start 0 and end 0.25 on a 2 s buffer, with rev on
  When slot 0 fires
  Then the cached reversed buffer plays from offset 1.5 s for 0.5 s — the same
    half-second the forward window names, backwards
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: Replacing a slot's buffer drops its reversed copy (v8, REQ-13, edge)
  Given slot 0 has played reversed, so a reversed copy is cached
  When setBuffer(0, other) runs
  Then the cache is dropped, and the next reversed hit reverses the NEW buffer
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: The shortest reason wins (v8, REQ-13, edge)
  Given a 2 s decay, a 1 s window and a step gate that chokes 0.3 s in
  When slot 0 fires
  Then the hit is cut once, at 0.3 s — not three times, and not at the longest
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A crossed window clamps rather than dropping the hit (v8, REQ-13, edge)
  Given end is set below start
  When slot 0 fires
  Then the window clamps to MIN_WINDOW and the hit still sounds
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A mono sample is not quietened by the pan stage (v8, REQ-12, regression)
  Given a mono buffer in slot 0 and pan at its centre default
  When it plays
  Then the slot's volume stage declares an explicit stereo output, so the panner
    passes it through rather than applying equal-power gain and losing 3 dB
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A slot's volume default does not re-voice existing songs (v8, REQ-12, regression)
  Given a song written before v8, carrying no sampler.t*.vol
  When it is loaded
  Then every slot gain resolves to 1 — the unity the slot has always had, not 0.85
# pinned by: tests/state/params.test.ts

Scenario: A closed hat cuts the open hat sharing its group (v9, REQ-14)
  Given slots 0 and 1 are both in choke group 1, and slot 1 is sounding
  When slot 0 fires
  Then slot 1's hit is faded out and stopped
  And slot 0 sounds normally
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: The cut is scheduled at the new hit, not at "now" (v9, REQ-14, regression)
  Given a hit is scheduled 80 ms ahead of the audio clock
  When it chokes a sounding slot
  Then the fade is scheduled at the new hit's time, not at currentTime —
    cutting at "now" would open a hole up to a look-ahead wide
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A slot in a group does not cut slots outside it (v9, REQ-14, edge)
  Given slot 0 is in group 1 and slot 2 is in no group
  When slot 0 fires while slot 2 is sounding
  Then slot 2 keeps playing
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A mono slot cuts its own previous hit (v9, REQ-14)
  Given slot 0 is mono and is already sounding
  When slot 0 fires again
  Then the earlier hit is cut and only the new one continues
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A poly slot still layers (v9, REQ-14, regression)
  Given slot 0 is at its defaults
  When it fires twice in quick succession
  Then both hits sound — the pre-v9 behaviour is the default
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: A slot cannot stack without limit (v9, REQ-15)
  Given a slot has MAX_SLOT_VOICES hits in flight
  When it fires again
  Then the oldest hit is stolen rather than the total growing
# pinned by: tests/audio/transport/sampler-machine.test.ts

Scenario: Filling a slot notifies exactly once
  Given a listener registered via onBufferChange
  When setBuffer(3, buf) runs
  Then the listener fires once with slot 3
# pinned by: tests/audio/transport/sampler-machine.test.ts
```

## Tests & verification

- `tests/audio/transport/sampler-machine.test.ts`, `e2e/sampler.spec.ts`
  (WAV via `setInputFiles` + a Node-built fixture).
- `tests/ui/clear-menu-sampler.test.ts` — REQ-9's row clear, its undo, and the
  bank clear that must *not* eject.
- `npm test` / `npm run e2e`.

## Open questions / future

- **Per-*step* pitch / slice (p-locks)** — v8 put pitch and the window on the *slot*
  (REQ-13). Per-step versions need a field on `SamplerStep`, which today is exactly
  `TriggerCell`; splitting the two types costs `serialize.ts`, `song-validate.ts` and
  `song-author.ts` a sampler-only branch each. Keep any such field optional and no-op
  for [song](song-mode.md) backward-compat.
- **Loop mode / bar-synced varispeed** — `bindTempoLocked` + `TEMPO_LOCKS`
  ([tempo-lock](tempo-lock.md)) would make the sync half nearly free. True
  time-stretch stays out: it needs a granular engine
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)) and no dependency is
  available to supply one ([ADR-003](../decisions/adr-003-no-runtime-dependencies.md)).
- **Per-slot drive** — deliberately not added with the rest of REQ-12's channel: the
  sampler bus already has a distortion, and eight waveshapers is a real idle cost
  ([runtime-performance](runtime-performance.md)) for a duplicate capability.
- **Playing a slot by hand** — the only manual trigger is clicking the slot's name, at
  a fixed velocity of 0.9. Pads (QWERTY / MIDI, velocity-sensitive) would make the
  machine playable rather than only programmable; `src/audio/midi.ts` currently routes
  note-on to the synth alone.
