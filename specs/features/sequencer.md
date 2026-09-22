# Step sequencer (synth)

```yaml
id: sequencer
status: implemented
version: 12  # v12: REQ-a-seq-track-carries-a-pan — a PAN knob beside each track's mute. The four
             #      tracks share one voice pool, so pan rides the note and is applied per
             #      voice by a spread stage that is only in circuit off centre (ADR-023)
             # v11: REQ-tracks-two-to-four-collapse's fold moved into the shared lane-fold
             #      component so motion's single-param lanes could use it. Same
             #      behaviour, same testids, same storage keys — the contract is
             #      unchanged and this bump only records where the code went
             # v10: REQ-a-seek-releases-every-tracks-note's seek release lands at each track's gate end, not
             #      now — a loop wrap otherwise hangs a tied voice (transport-loop)
             # v9: REQ-the-sequencer-triggers-the-active-step also honours per-step `micro` — and applies it here
             #     rather than inside stepHits, so the mono release moves with
             #     the attack (step-settings.md REQ-micro-is-one-pure-offset)
             # v8: the lane's length + step rate come from the meter (REQ-seq-lane-length-comes-from-the-meter)
             # v7: the transposed note is then quantized to the key (REQ-the-transposed-note-is-then-quantized)
             # v6: notes are shifted by the arrangement slot's transpose (REQ-every-note-is-shifted-by-the-slot-transpose)
             # v5: release held notes on a transport stop, too (REQ-a-stop-releases-every-tracks-note)
owner: core
related:
  - architecture
  - lfo                        # REQ-track-pan-places-and-the-auto-pan-moves — the bus auto-pan it composes with
  - voicing                    # REQ-two-tracks-on-one-pitch-share-a-pan — the shared pool's held-note map
  - transport
  - transport-position
  - step-settings
  - step-grid-editing
  - lane-fold                  # REQ-tracks-two-to-four-collapse's fold, shared with motion since v17
  - banks
  - arrangement
  - input-control
  - envelopes
  - scale-quantization
  - chord-tools
source:
  - src/audio/transport/sequencer.ts
  - src/audio/transport/scale-quantizer.ts   # REQ-the-transposed-note-is-then-quantized
  - src/audio/transport/note-output.ts       # REQ-a-seq-track-carries-a-pan — the opts bag pan rides in
  - src/audio/polyphony.ts                   # REQ-a-seq-track-carries-a-pan — threads pan to the picked voice
  - src/audio/voice.ts                       # REQ-a-seq-track-carries-a-pan — the per-voice pan + spread stage
  - src/audio/stereo.ts                      # REQ-a-seq-track-carries-a-pan — the forced up-mix (lfo.md REQ-the-auto-pan-reads-a-stereo-input)
  - src/state/patterns.ts
  - src/audio/engine.ts
  - src/ui/panels/seq-panel.ts
  - src/ui/app.ts                        # ties the arm to tab visibility (REQ-step-input-arms-only-on-screen)
  - src/ui/components/tabs.ts            # isVisible / onViewChange (REQ-step-input-arms-only-on-screen)
  - src/ui/components/collapse-toggle.ts # onChange, so a fold is a view change (REQ-step-input-arms-only-on-screen)
  - src/ui/components/lane-fold.ts       # the per-track fold itself (lane-fold.md)
  - src/ui/components/knob.ts            # REQ-the-pan-knob-costs-the-row-no-height — the inline layout
  - src/ui/styles/knob.module.css        # REQ-the-pan-knob-costs-the-row-no-height — its row rules + the 720px drop
  - src/ui/styles/seq.module.css         # REQ-the-pan-knob-costs-the-row-no-height — the matching cluster width
  - e2e/helpers.ts                       # REQ-the-pan-knob-costs-the-row-no-height — dragKnobUp aims at the dial
  - src/ui/components/bank-bar.ts        # setFollowing — the take is bank-pinned (REQ-a-take-is-bank-pinned)
```

The 16-step note sequencer that drives the synth voice on each active step —
**four independent tracks** (v3), so a bank can hold a chord or a counter-line
instead of one monophonic riff.

## Background / Why

A bread-and-butter step sequencer: 16 steps, each with a note and the shared
[per-step settings](step-settings.md), edited with the shared grid gestures
(tap toggles, drag paints, long-press selects without toggling —
[step-grid-editing](step-grid-editing.md)). It reads the **play bank** the
[arrangement](arrangement.md) selects (not necessarily the UI edit bank), so song
playback and editing can diverge. Live keyboard input still passes through and can
layer on top. The Song-tab DJ **mute** suppresses *triggering* while the playhead
keeps advancing — distinct from `seq.master`, which is the voice-bus volume.

**Step Input** (the panel's arm toggle) fills the grid from played notes. It listens
on `bus.onNote` — the *global* note funnel every source converges on
([input-control](input-control.md) REQ-all-input-goes-through-the-bus) — so on its own it cannot tell a note meant
for the grid from one played anywhere else in the app. Left ungated it recorded while
the user was on another tab entirely (holding chords on the Arpeggiator silently
overwrote the bank, with the lit LED off-screen), and because `setSeqStep` writes to
the **edit** bank while [banks](banks.md) REQ-follow-tracks-the-play-bank Follow drags that bank along with the
arrangement, a take during playback sprayed across every bank it touched. REQ-5..REQ-7 make
the arm a deliberate, visible, bank-pinned mode instead: it exists only while its own
grid is on screen, so "armed" and "visible" cannot disagree.

(v3) One track meant a bank could only ever be one line: harmony had to be
faked with the arpeggiator, ties or a second render into the sampler. Four
tracks is the smallest change that makes chords and counter-lines native, and it
costs nothing to existing songs — track 1 *is* the old sequencer, byte for byte,
and tracks 2–4 start empty and silent.

## Requirements

- **REQ-the-sequencer-triggers-the-active-step** — On each tick, trigger the
  synth for the active step of the current play bank, honouring
  velocity/gate/prob/ratchet/tie/micro ([step-settings](step-settings.md);
  `micro` nudges the step off the grid and is applied here rather than inside
  `stepHits`, REQ-four-tracks-per-bank).
- **REQ-the-note-releases-at-gate-end** — Release the held note at `gateEnd`;
  `tie` holds the last ratchet sub-hit into the next step.
- **REQ-mute-keeps-the-playhead-advancing** — `setMuted` stops triggering but
  keeps the playhead advancing and leaves live-keyboard play + the voice bus
  untouched.
- **REQ-seq-master-sets-the-voice-bus-volume** — `seq.master` sets the voice-bus
  volume (default 1 — a no-op for existing presets).
- **REQ-step-input-arms-only-on-screen** — **Step Input is armed only while its
  own grid is on screen.** The arm is scoped to the panel being *visible*: the
  Sequencer tab is the active tab **and** the pattern row is not collapsed.
  Losing either — switching tabs, folding the row — **disarms**: the LED goes
  dark and the grid's orange recording outline clears, and the user must re-arm
  deliberately on return. A whole-store overwrite (song/demo load, import, New,
  session-undo — `PatternStore.onBulkRestore`) disarms too; a fresh song never
  inherits an armed recorder. Deliberately **not** gated on DOM focus: the
  on-screen keyboard is built from plain `div`s, so clicking a key blurs the
  focused step button and a `document.activeElement` rule would kill
  mouse-played input.
- **REQ-a-take-is-bank-pinned** — **A take is bank-pinned.** Arming turns the
  panel's [banks](banks.md) REQ-follow-tracks-the-play-bank **Follow** toggle
  off, so the arrangement cannot swap the edit bank mid-take and recorded notes
  always land in the bank that was on screen when the user armed. Disarming
  leaves Follow off (the user re-enables it) — same editing-intent rule as a
  manual bank click. A *manual* bank click while armed is honoured normally:
  recording continues, in the newly picked bank.
- **REQ-the-armed-flag-is-the-single-truth** — The armed flag is the **single
  source of truth** for the `bus.onNote` capture, and
  REQ-step-input-arms-only-on-screen keeps it true only while visible — so the
  note handler needs no second visibility check. One function owns the flag and
  both its visual affordances (button LED + grid outline); nothing else writes
  them.

### v3 — four tracks

- **REQ-four-tracks-per-bank** — **Four tracks per bank.** `seqBanks` becomes
  `[bank][track][step]` (`SEQ_TRACK_COUNT = 4`), mirroring the drum machine's
  shape. **Track 1 is the pre-v3 sequencer** — same data, same behaviour — and
  tracks 2–4 start empty. Each track is independently monophonic (its own
  held-note/tie state), so four active tracks sound up to a four-note chord
  through the shared voice pool.
- **REQ-poly-voicing-gates-the-extra-tracks** — **Poly voicing gates the extra
  tracks.** While `voicing.mode` is mono only track 1 triggers; tracks 2–4 keep
  their data, render dimmed and say why ("mono voicing — switch to POLY").
  Nothing is rewritten: flipping to poly brings them straight back. Four tracks
  fighting over one mono voice would be last-note-wins mush that reads as a bug,
  and silently forcing poly would overwrite a param the user (or their song)
  set.
- **REQ-per-track-mute** — **Per-track mute** (`seq.t<i>.mute`, default 0 — a
  no-op per [ADR-006](../decisions/adr-006-no-op-param-defaults.md)), the drum
  machine's per-track mute rule: the track stops triggering while the playhead
  keeps advancing. Independent of the lane-wide `seq.mute`
  (REQ-mute-keeps-the-playhead-advancing) and of `seq.master`.
- **REQ-tracks-two-to-four-collapse** — **Tracks 2–4 collapse, and start
  collapsed when empty.** A track row folds to its header; the fold is per track
  and persisted under `websynth.ui.collapsed.seqtrack.<i>`. With no stored
  preference an *empty* track 2–4 starts folded (nothing to show) and one
  carrying steps starts open — so loading a song that uses all four never hides
  its content, and a fresh session shows one track, as before v3. Track 1 never
  collapses. The mechanism is [lane-fold](lane-fold.md), extracted from this
  panel when the motion sequencer needed the same behaviour for its single-param
  lanes ([motion-sequencer](motion-sequencer.md) REQ-an-empty-motion-lane-starts-folded);
  nothing about this requirement's behaviour, testids or storage keys changed in
  the move.
- **REQ-step-input-targets-the-focused-track** — **Step Input targets the
  focused track** (REQ-step-input-arms-only-on-screen..7 otherwise unchanged):
  notes land in the track holding the selection cursor, so the arm stays the
  single source of truth and gains no second mode.
- **REQ-song-file-v6-adds-seq-tracks** — **SongFile v6** adds optional
  `seqTracks`, additive per
  [ADR-007](../decisions/adr-007-songfile-additive-versioning.md). `seqBanks`
  keeps its exact v1–v5 shape and meaning (**track 1**), so every older file —
  and all committed demos — load and sound identical with three empty tracks.
  `seqTracks[bank][track]` is indexed by the *real* track number with **index 0
  always null** (track 1 lives in `seqBanks`); that costs one `null` per bank
  and removes the off-by-one that an "extra tracks" array would invite. An empty
  track writes as `null`.
- **REQ-a-seek-releases-every-tracks-note** (v4) — **A transport seek releases
  every track's held note.** The per-track `SeqTrackState` carries
  `lastPlayedNote` and `prevTied` between steps
  (REQ-the-note-releases-at-gate-end), which are only meaningful for *adjacent*
  steps. When the playhead jumps ([transport-position](transport-position.md)
  REQ-every-relative-consumer-reacts-to-a-seek) a note tied at the old position would otherwise slur into the new one,
  or a held note would never be released at all. `StepSequencer` therefore
  subscribes `clock.onSeek` in its constructor and runs the per-track release —
  keeping `releaseTrack` private rather than widening the public surface for one
  caller. (v10) **It releases at each track's own last gate end**, exactly as
  REQ-a-stop-releases-every-tracks-note's stop does, not at `now`. A seek can
  arrive while the last step's note-on is still in the look-ahead; a release at
  `now` lands *before* that attack and is overwritten by it, leaving the voice
  hanging. A user's click rarely hits that window, but a
  [loop](transport-loop.md) wrap is a jump issued from *inside* the drain,
  straight after the last step was scheduled ([transport](transport.md)
  REQ-a-step-router-can-redirect-the-next-step) — so a tied last step hit it
  every single wrap. REQ-a-stop-releases-every-tracks-note's three reasons all
  carry over unchanged.
- **REQ-a-stop-releases-every-tracks-note** (v5) — **A transport stop releases
  every track's held note.** A tied step deliberately schedules **no**
  `releaseNote` (REQ-the-note-releases-at-gate-end): the release is the *next*
  tick's job. After a stop that tick never comes, so the voice sustained until
  the user hit Panic. `StepSequencer` subscribes `clock.onStop` alongside
  REQ-a-seek-releases-every-tracks-note's `onSeek`, but releases at the track's
  **own last gate end** (`SeqTrackState.lastReleaseAt`), not at `now`:
    - the note-on may still be sitting in the transport look-ahead, and a release
      scheduled *before* its attack is overwritten by that attack — which would
      re-create the very hang this fixes;
    - the note then ends where its gate always said it would (at most one 16th
      later) instead of being truncated under the player;
    - a stale past value is harmless — `Envelope.anchor` clamps with
      `Math.max(when, now)` ([envelopes](envelopes.md) REQ-envelope-scheduling-is-future-time-safe).
  This is a **release**, not a kill: the amp envelope's release stage runs and the
  reverb/delay tails ([effects](effects.md)) are downstream, so a stop never cuts
  the tail off a song. It also fixes stop's silent partner — `Engine.panic()` calls
  `clock.stop()` first, so the stale `lastPlayedNote`/`prevTied` that used to
  survive a panic (and slur the first step after the next Play) is now cleared too.

- **REQ-every-note-is-shifted-by-the-slot-transpose** (v6) — **Every triggered
  note is shifted by the arrangement slot's transpose.** `tickTrack` reads
  `arrangement.seqTranspose` once and adds it to `s.note`, clamped to
  `MIDI_NOTE_MIN..MAX` ([arrangement](arrangement.md)
  REQ-a-seq-slot-carries-a-transpose/REQ-transposition-is-applied-at-trigger).
  The shift applies to the note-on, to the per-sub-hit `releaseNote` of a
  ratchet, and to what is reported to `onNote` — so the keyboard highlight shows
  the pitch actually sounding.

  **The tie across a bar line is the trap.** A held note's release goes through
  `SeqTrackState.lastPlayedNote`, which stores the note that was *played*. Storing
  the **transposed** note there is what makes the release correct for free: when a
  step ties into a bar whose slot transposes differently, the ringing voice is
  released at its own pitch instead of at a pitch that was never started — which
  would leave a stuck voice. This is why the transpose is applied once at the top
  of `tickTrack` and the local is used everywhere `s.note` was, rather than being
  re-derived at each release site.

- **REQ-the-transposed-note-is-then-quantized** (v7) — **The transposed note is
  then quantized to the key.** `tickTrack` passes the transposed note through
  `ScaleQuantizer.get` before it is played
  ([scale-quantization](scale-quantization.md)
  REQ-exactly-three-quantize-trigger-sites/REQ-transpose-first-then-quantize).
  The **order matters and is the point**: transposing first and quantizing
  second is what makes a `+5` bar land back in the key instead of leaving it,
  which is the musical defect REQ-every-note-is-shifted-by-the-slot-transpose's
  chromatic shift otherwise creates. Quantizing first would preserve that drift.

  This inherits REQ-every-note-is-shifted-by-the-slot-transpose's tie safety for free rather than re-earning it: the *quantized*
  note is what lands in `SeqTrackState.lastPlayedNote`, so a note started in one key or
  transpose is released at the pitch it actually started, exactly as above. While
  `scale.type` is `chromatic` the call is an early return and this REQ is invisible.

- **REQ-seq-lane-length-comes-from-the-meter** (v8) — **The lane's length and
  step rate come from the meter.** `seq.len` / `seq.rate` decide how many of the
  16 cells play and how long each lasts ([meter](meter.md) REQ-each-machine-has-a-loop-length/REQ-each-machine-has-a-step-rate); the
  defaults follow the bar at one cell per tick, i.e. the pre-meter 16-step
  behaviour exactly. `onTick` resolves the cells through a `LaneMeter` and calls
  `tickCell` for each — usually one, none on a tick a coarser lane skips, two or
  three for a triplet rate. Gate and ratchet are fractions of the **cell**, not
  of a 16th, so a step at 1/8 holds for twice as long; at the default rate the
  two numbers are identical. This closes the "Open questions" note below.

### v12 — per-track pan

- **REQ-a-seq-track-carries-a-pan** — **Each track carries a pan**
  (`seq.t<i>.pan`, range `-1..1`, default `0` — centre, a no-op per
  [ADR-006](../decisions/adr-006-no-op-param-defaults.md)), the same `ParamDef`
  shape and the same `fmtPan` readout as `drum.t<i>.pan` and
  `sampler.t<i>.pan`. It is a registered scalar, so it rides `bus.snapshot()` in
  the flat `params` map and needs **no** `SongFile` version bump: every v1–v8
  song and every preset lacking the key loads centred and sounds identical
  ([ADR-007](../decisions/adr-007-songfile-additive-versioning.md)).

  Unlike those two machines, the sequencer does **not** own a per-track channel
  to hang a panner on: all four tracks call the track-agnostic
  `SynthOutput.playNote` into one shared voice pool. The pan therefore **rides
  the note** — `playNote(note, velocity, when, { pan, panGroup })` — and is
  applied by a `StereoPannerNode` inside the voice that plays it, written at the
  note's own start time. `panGroup` names the knob, so a voice keeps following it
  while it sounds: turning a pan over a held or tied note moves that note rather
  than waiting for the next one. Live keyboard, MIDI and the
  [arpeggiator](arpeggiator.md) pass neither and stay centred. See
  [ADR-023](../decisions/adr-023-the-synth-channel-goes-stereo-on-demand.md).

- **REQ-panning-a-track-does-not-change-its-level** — **Panning is constant
  power.** The voice panner is fed **mono**, which is what selects
  `StereoPannerNode`'s equal-power `cos/sin` law; the panned edge then carries a
  fixed `sqrt(2)` to undo that law's 3.01 dB centre dip, so centre delivers
  exactly what the dry edge does and a hard-panned track keeps the power it had
  centred. Measured over a demo pass: hard left moved the synth 4.55 dB across
  the channels for **-0.19 dB** of total power.

  Feeding the panner *stereo* instead — as `synthPan` deliberately is — is the
  trap, and it was caught by rendering rather than by any test: a stereo input
  selects the **fold** law, where hard left is `L + R` on one side, and the same
  take gained **+1.34 dB** of mix power. The two nodes want opposite treatment
  because they do opposite jobs: one *places* a mono source, the other *moves* an
  already-stereo bus (lfo.md REQ-the-auto-pan-reads-a-stereo-input).

- **REQ-the-spread-stage-engages-off-centre** — **The spread stage is only in
  circuit while a track is off centre.** The synth voice path is 1-channel end to
  end, and the insert chain upstream of the reverb is 1-channel with it
  ([architecture](../architecture.md), [ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)
  *cheap*) — a per-voice panner ends that, because a `StereoPannerNode` always
  outputs two channels. So each voice carries a dry edge and a panned edge, and
  `Engine` splices the panned one in only while some `seq.t<i>.pan` is non-zero,
  using the [true-bypass](../decisions/adr-012-true-bypass-disconnects.md) idiom:
  reconnect *before* ramping on the way in; ramp, then disconnect after the
  crossfade has settled on the way out. Disconnecting is the point — a channel
  count follows *connections*, not gains, so an edge left attached at gain 0
  would hold the chain at two channels and keep paying for them.

  The crossfade is transparent by construction: at centre the panned edge
  delivers `0.7071x * sqrt(2) = x` per channel
  (REQ-panning-a-track-does-not-change-its-level) and the dry edge delivers the
  same `x`, so the two paths are identical there and two complementary
  `setTargetAtTime` ramps of equal time constant sum to the input the whole way
  across. **A song that never pans therefore
  keeps the pre-v12 graph, its mono inserts and its CPU exactly.** The graph is
  never edited per note or per tick ([ADR-017](../decisions/adr-017-modulation-in-graph.md)),
  and it cannot be edited per frame either: `seq.t<i>.pan` is a registered param,
  so a [motion lane](motion-sequencer.md) can sweep it like any other, and a lane
  crossing centre every frame must not tear the graph down and back up at frame
  rate. It does not — engaging is idempotent while the edge is attached, and
  disengaging only *schedules* the disconnect, which a re-engage cancels. A
  sustained return to centre is therefore the only thing that drops it, and the
  per-frame cost of an automated pan is eight ramps, the same shape as any other
  per-voice param.

- **REQ-track-pan-places-and-the-auto-pan-moves** — **Track pan places; the bus
  auto-pan moves.** Per-track pan sits *upstream* of the insert chain and the LFO
  `pan` destination's `synthPan` sits *downstream* of it ([lfo](lfo.md)
  REQ-pan-sweeps-a-stereo-panner), so the two compose rather than compete: the
  tracks are placed across the field and the sweep then moves that whole field.
  Because `synthPan` reads a stereo input (lfo.md REQ-the-auto-pan-reads-a-stereo-input)
  it applies the stereo law, which **folds** toward one side at the extremes
  instead of rotating — a full-depth sweep collapses the spread at the ends of
  its travel and restores it in the middle. Per-voice pan is **not** a
  [mod-matrix](mod-matrix.md) destination and does not change
  REQ-per-voice-sources-cannot-drive-bus-destinations: `synthPan` is still the
  only bus-wide one.

- **REQ-two-tracks-on-one-pitch-share-a-pan** — **Two tracks sounding the same
  pitch share one pan, and the later one wins.** `Polyphony` keys held notes by
  MIDI note number ([voicing](voicing.md)), so a second track playing a note the
  first is already holding **re-triggers that voice** rather than taking one of
  its own — there is one voice, so there is one pan. Tracks on different pitches
  are unaffected, which is every ordinary chord or counter-line. This is recorded
  rather than fixed: keying the held map per track would burn a voice per
  duplicated pitch out of a pool of eight and rewrite the stealing invariant
  ([voicing](voicing.md) REQ-a-stolen-voice-leaves-the-held-list) to spread a
  unison that is better arranged an octave apart.

  For the same reason a voice **stolen** between tracks takes the new track's pan
  at the moment the new note starts — the pan is written at `when`, with the
  short ramp every per-voice write uses, so the hand-off glides rather than
  clicks.

- **REQ-the-pan-knob-costs-the-row-no-height** — **The knob sits in the track
  row without making it taller.** A `Knob` is a column — label above the dial,
  readout below — and is ~50px tall whatever `size` says, so four of them would
  have added ~104px to the track grid and pushed the panel's neighbours down.
  `KnobOptions.inline` lays it out as a **row** instead (`PAN ( ) C`), which
  leaves the row exactly as tall as the 32px step buttons already make it. It
  costs width rather than height, so below the app's 720px breakpoint the word
  `PAN` is dropped and the dial and its readout carry the control — the readout
  already reads `C` / `L40` / `R75`, and `title` keeps the name reachable by
  hover and by a screen reader. The cluster's width narrows at the same
  breakpoint, and the two rules are commented as a pair.

  The cluster's width stays a **constant** and must not become `auto`: the
  [transport-position](transport-position.md) ruler's row wears the same
  `.trackCtrls` class with entirely different content, so sizing to content puts
  the ruler and the step grids on different left edges — measured 162px apart,
  and seen only by `npm run e2e`.

  Three traps this hit, all invisible to a screenshot and worth the record:
  `.root` sizes a *column* — a fixed `width` of one dial and a `min-height` with
  room for the stacked text — and in a row that width left the readout painting
  42px over the first step buttons while the `min-height` put back the very row
  height the layout exists to save. And a flex item shrinks by default, so the
  **dial** collapsed to 0px wide while its absolutely-positioned arc went on
  looking perfect, leaving the drag target with nothing to hit; an e2e drag that
  moved nothing is what found it.

## Technical design

### Contract / public interface

```yaml
StepSequencer:  # src/audio/transport/sequencer.ts
  setEnabled(on)
  setMuted(muted)        # DJ mute: stop triggering, keep advancing
  setTrackMuted(track, muted)   # v3, REQ-per-track-mute
  setTrackPan(track, p)         # v12, REQ-a-seq-track-carries-a-pan — -1..1, rides the next note
  setPolyphonic(poly)           # v3, REQ-poly-voicing-gates-the-extra-tracks — gates tracks 2..4
  onStep(fn) / onNote(fn) -> unsubscribe      # playhead + note viz
  # onNote's releaseAt is the LAST sub-hit's gate end (v5) — same value
  # lastReleaseAt carries, so a ratcheted step's key viz outlives its first sub-hit
  # reads patterns.seqBank(arrangement.seqPlayBank) each tick via clock.onTick
  # per-track held-note/tie state lives in one SeqTrackState[] (v3)
  # subscribes clock.onSeek to release held notes + clear prevTied (v4, REQ-a-seek-releases-every-tracks-note)
  # subscribes clock.onStop to release each track at its lastReleaseAt (v5, REQ-a-stop-releases-every-tracks-note)

PatternStore (v3):     # src/state/patterns.ts
  seqBanks[bank][track][step]        # was [bank][step]
  seq -> SeqStep[][]                 # edit bank, track-major (like `drum`)
  seqTrack(track) -> SeqStep[]       # one track of the edit bank
  seqBank(i) -> SeqStep[][]
  setSeqStep(track, index, patch)    # leading track arg (like setDrumCell)
  clearSeqTrack(track)               # REQ-a-take-is-bank-pinned of step-grid-editing

buildSeqPanel(bus, engine, undo): { el, disarmStepInput() }   # src/ui/panels/seq-panel.ts
  # el is the panel root (was the bare return); disarmStepInput is REQ-step-input-arms-only-on-screen's hook

TabContainer:  # src/ui/components/tabs.ts — the visibility surface REQ-step-input-arms-only-on-screen needs
  isVisible(id): boolean          # active tab AND the row is not collapsed
  onViewChange(fn): () => void    # fires on activate() and on a collapse toggle

CollapseToggleOptions.onChange?(collapsed): void   # src/ui/components/collapse-toggle.ts
  # called from the one place the `.collapsed` class is written, so the chevron,
  # the bar-click trigger and expand() all report through it

BankBar.setFollowing(on): void   # src/ui/components/bank-bar.ts — public (REQ-a-take-is-bank-pinned)

SynthOutput (v12):     # src/audio/transport/note-output.ts
  playNote(note, velocity, when?, opts?)   # opts.pan -1..1, REQ-a-seq-track-carries-a-pan
  releaseNote(note, when?)
  # opts is optional at every layer, so the arp and live keys stay centred
  # unchanged

Polyphony.playNote(note, velocity, when?, opts?)   # src/audio/polyphony.ts — threads opts.pan
Voice (v12):           # src/audio/voice.ts
  noteOn(note, velocity, when, opts?)   # opts.pan joins detuneCents/glide
  connectTo(dest)                       # wires BOTH output edges (dry + panned)
  setSpread(on)                         # REQ-the-spread-stage-engages-off-centre
forceStereo(node)      # src/audio/stereo.ts — the 2-channel up-mix a panner needs
```

### Data shapes (registry)

```yaml
seq.on:     { discrete, labels: [off, on], default: 0 }
seq.t<i>.mute: { discrete, labels: [on, mute], default: 0 }   # v3, i = 0..3
seq.t<i>.pan:  { range: -1..1, default: 0, format: fmtPan }   # v12, i = 0..3 (REQ-a-seq-track-carries-a-pan)
seq.master: { range: 0..1, default: 1 }      # voice-bus volume (no-op default)
seq.mute:   { discrete, labels: [on, mute], default: 0 }   # lane mixer (song-mode)
seq.solo:   { discrete, labels: [off, solo], default: 0 }
# step data: SeqStep[] in PatternStore (not the bus) — see step-settings.md
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  seq.on     -> this.seq.setEnabled(v >= 0.5)
  seq.master -> rampTo(voiceBus.gain, v)      # independent of mute
  seq.t<i>.pan -> this.seq.setTrackPan(i, v)  # v12; Engine also holds the four
    # values and drives voice.setSpread(some non-zero) (REQ-the-spread-stage-engages-off-centre)
  seq.mute/solo -> laneMixer.setMute/setSolo (-> seq.setMuted), see song-mode.md
hit math: stepHits / rollProb (step-hits.ts); releases voice at gateEnd
ui: src/ui/panels/seq-panel.ts (16 seq-step-<i> buttons + StepSettingsEditor)
step input (REQ-step-input-arms-only-on-screen..7):
  seq-panel: one setArmed(on) owns `armed` + recBtn '.on' + stepRow '.recording';
    arming also calls bankBar.setFollowing(false) (REQ-a-take-is-bank-pinned);
    patterns.onBulkRestore(() => setArmed(false))       # song load / New (REQ-step-input-arms-only-on-screen)
  app.ts buildPatternRow: tabs.onViewChange(() =>
    { if (!tabs.isVisible('seq')) seq.disarmStepInput(); })   # tab + fold (REQ-step-input-arms-only-on-screen)
    # sits beside the existing bridge.undoActiveMachine / bridge.showTab wiring —
    # the late-binding seam, since the panel is built before the TabContainer exists
```

## Scenarios (BDD)

```gherkin
Scenario: Active steps trigger the synth on the beat
  Given seq.on is 1 and step 0 is active with a note
  When the transport reaches step 0
  Then the synth plays that note and releases it at gateEnd
# pinned by: tests/audio/transport/sequencer.test.ts, e2e/patterns.spec.ts

Scenario: Four tracks layer into a chord (v3)
  Given tracks 1-3 each hold a note on step 0 and voicing is poly
  When the transport reaches step 0
  Then all three notes sound together
  And each track holds and releases its own note, so one track's rest never
    cuts another's tied note short
# pinned by: tests/audio/transport/sequencer.test.ts, e2e/patterns.spec.ts

Scenario: Mono voicing gates tracks 2-4 without losing them (v3)
  Given tracks 1 and 2 both hold notes
  When voicing.mode is mono
  Then only track 1 sounds, and track 2 dims with "mono voicing — switch to POLY"
  When voicing.mode returns to poly
  Then track 2 sounds again, its steps untouched throughout
# pinned by: tests/audio/transport/sequencer.test.ts, e2e/patterns.spec.ts

Scenario: A per-track mute silences one track only (v3)
  Given tracks 1 and 2 both hold notes on the same step
  When track 2 is muted
  Then track 1 still sounds and the playhead keeps advancing
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Empty extra tracks start folded, used ones do not (v3)
  Given a fresh session
  Then tracks 2-4 are folded and track 1 is open
  When a song using track 3 is loaded
  Then track 3 unfolds, so its content is never hidden behind a chevron
# pinned by: e2e/patterns.spec.ts

Scenario: A one-track song is byte-identical to pre-v6 (v3, back-compat)
  Given only track 1 holds steps
  When the song is captured
  Then no seqTracks key is written at all and the version stays as it was
# pinned by: tests/state/song.test.ts, tests/state/song-author.test.ts

Scenario: A v1-v5 file loads with three empty tracks (v3)
  Given an older SongFile and a session that had dirtied tracks 2-4
  When it is applied
  Then tracks 2-4 are blank and track 1 sounds exactly as before
# pinned by: tests/state/song.test.ts

Scenario: DJ mute stops notes but the playhead keeps moving (edge)
  Given the sequencer is muted via the lane mixer
  Then no sequenced notes sound, the playhead still advances, and live keys still play
# pinned by: tests/audio/transport/sequencer.test.ts, e2e/song-mixer.spec.ts

Scenario: A tied note does not slur across a transport seek (v4, REQ-a-seek-releases-every-tracks-note)
  Given a step tied into the next one is currently sounding
  When the playhead is seeked elsewhere
  Then the held note is released and prevTied is cleared on every track
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A seek releases a tie at its gate end, not before its attack (v10, REQ-a-seek-releases-every-tracks-note, regression)
  Given a tied step whose note-on is still in the look-ahead (when > now)
  When onSeek fires — a loop wrap straight after that step was scheduled
  Then releaseNote is called with that step's gate end, not with `now`
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Stopping the song ends a tied note instead of hanging it (v5, REQ-a-stop-releases-every-tracks-note, regression)
  Given a step tied into the next one is currently sounding
  When the transport stops
  Then the note is released at that step's own gate end, not left ringing
  And the reverb/delay tail keeps ringing out, because a release is not a kill
  And the user never has to reach for Panic to silence it
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: The stop release is never scheduled before the note-on (v5, edge)
  Given a note-on is still sitting in the transport look-ahead when the user stops
  Then the release is scheduled at the step's gate end, which is at or after that
    note-on — a release anchored at `now` would be overwritten by the attack and
    the note would hang exactly as before
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Step Input fills steps from played notes and advances
  Given the Sequencer tab is open and Step Input is armed with the cursor at step 0
  When the user plays two notes
  Then they land in steps 0 and 1 and the cursor advances one step per note
# pinned by: e2e/patterns.spec.ts

Scenario: Leaving the tab disarms Step Input (regression, REQ-step-input-arms-only-on-screen)
  Given the Sequencer tab is open and Step Input is armed
  When the user switches to the Arpeggiator tab and plays notes
  Then no step is written, and Step Input is no longer armed (LED dark)
  And returning to the Sequencer tab leaves it disarmed until re-armed
# pinned by: e2e/patterns.spec.ts

Scenario: Folding the pattern row disarms Step Input (edge, REQ-step-input-arms-only-on-screen)
  Given Step Input is armed on the visible Sequencer tab
  When the pattern row is collapsed with the fold chevron
  Then Step Input disarms, because its grid is no longer on screen
# pinned by: tests/ui/tabs.test.ts (isVisible/onViewChange), tests/ui/collapse-toggle.test.ts

Scenario: A song load disarms Step Input (edge, REQ-step-input-arms-only-on-screen)
  Given Step Input is armed
  When a song, demo or project import replaces the whole store (onBulkRestore)
  Then Step Input disarms — a fresh song never inherits an armed recorder
# pinned by: seq-panel patterns.onBulkRestore hook; tests/state/pattern-undo.test.ts (same hook)

Scenario: Arming pins the take to the visible bank (REQ-a-take-is-bank-pinned)
  Given the transport plays an enabled seq chain and Follow is on
  When the user arms Step Input
  Then Follow turns off, so recorded notes cannot spray across banks as bars advance
  And disarming leaves Follow off for the user to re-enable
# pinned by: e2e/patterns.spec.ts, tests/ui/bank-bar.test.ts

Scenario: Transpose is applied before quantization, not after (v7, REQ-the-transposed-note-is-then-quantized)
  Given an active key and an arrangement slot that transposes +5
  When a step fires
  Then the note is transposed first and the sum is quantized into the key
  And reversing the order would leave the bar out of key
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A chromatic key leaves every triggered note untouched (v7, REQ-the-transposed-note-is-then-quantized, back-compat)
  Given scale.type is 0
  When any step fires
  Then the note sounding is exactly the pre-v7 note
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A track's pan reaches only that track's notes (v12, REQ-a-seq-track-carries-a-pan)
  Given tracks 1 and 2 both hold notes on the same step at different pitches
  When track 2 is panned hard right
  Then track 2's note plays with pan 1 and track 1's with pan 0
  And a live keyboard note played over them is still centred
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: An old song loads centred (v12, REQ-a-seq-track-carries-a-pan, back-compat)
  Given a song file that predates the param and carries no seq.t<i>.pan key
  When it loads
  Then all four pans sit at 0 and the song sounds exactly as it did
  And the spread stage never engages, so the graph is the pre-v12 one
# pinned by: tests/state/params.test.ts, tests/audio/transport/sequencer.test.ts

Scenario: The spread stage stays out of circuit while every track is centred (v12, REQ-the-spread-stage-engages-off-centre)
  Given a fresh engine with all four pans at 0
  Then no voice's panned edge is connected, and the insert chain is 1-channel
  When one track is panned off centre
  Then the panned edges connect and the pan takes effect
  And returning every track to centre disconnects them again after the crossfade
# pinned by: tests/audio/voice-spread.test.ts

Scenario: The bus auto-pan moves the spread field rather than flattening it (v12, REQ-track-pan-places-and-the-auto-pan-moves)
  Given track 1 panned left and track 2 panned right
  When an LFO sweeps the `pan` destination
  Then the pair moves together across the field, keeping its relative placement
  And at the extremes of the sweep the image folds toward one side
# pinned by: no automated test — verified by ear (ADR-010), specs/recipes/verify-audio-by-ear.md

Scenario: Two tracks on one pitch collapse to one pan (v12, REQ-two-tracks-on-one-pitch-share-a-pan, known limit)
  Given track 1 panned hard left and track 2 panned hard right
  When both fire the SAME note on the same step
  Then one voice sounds, carrying the pan of whichever track fired last
  And nothing is dropped or doubled — this is the shared pool, documented not fixed
# pinned by: tests/audio/transport/sequencer.test.ts
```

## Tests & verification

- `tests/audio/transport/sequencer.test.ts`, `e2e/patterns.spec.ts`.
- Step Input scoping (REQ-step-input-arms-only-on-screen..7): `e2e/patterns.spec.ts` (the cross-tab regression +
  the bank pin), `tests/ui/tabs.test.ts` (`isVisible`/`onViewChange`),
  `tests/ui/collapse-toggle.test.ts` (`onChange`), `tests/ui/bank-bar.test.ts`
  (public `setFollowing`).
- Per-track pan (v12): `tests/audio/transport/sequencer.test.ts` (the pan rides
  the note), `tests/audio/voice-spread.test.ts` (the stage engages and
  disconnects, and the hand-off to the voice pool), `tests/audio/engine-stereo.test.ts`
  (the two channel-count rules and the adapter's arity),
  `tests/state/params.test.ts` (registration + clamp), `e2e/patterns.spec.ts`
  (a knob per row, writing only its own param).
- **Per-track pan is a sound change, so the gate is listening, not the suite**
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md),
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)). Three takes:
  everything centred against a pre-v12 build (must be identical — that is the
  whole claim of REQ-the-spread-stage-engages-off-centre), tracks spread hard
  L/R, and the same pattern with an LFO on `pan`. Render Firefox too: this writes
  an `AudioParam` at note-on and relies on channel up-mixing, and the engines
  disagree on both. `audio-metrics` reads the **mono down-mix** and is blind to
  exactly the damage this feature can do — check per channel.
- `npm test` / `npm run e2e`.

## Open questions / future

- ~~Length is fixed at `SEQ_LENGTH` (16)~~ — answered by REQ-seq-lane-length-comes-from-the-meter / [meter](meter.md).
  The bank shapes did **not** have to change: the grid is still 16 cells and only
  the played *window* moves, which is what kept [banks](banks.md), the validators
  and every shipped demo untouched.
