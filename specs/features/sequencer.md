# Step sequencer (synth)

```yaml
id: sequencer
status: implemented
version: 16
owner: core
related:
  - architecture
  - lfo                        # the bus auto-pan per-track pan composes with
  - voicing                    # the shared pool's held-note map
  - transport
  - transport-position
  - step-settings
  - step-grid-editing
  - lane-fold
  - banks
  - arrangement
  - meter
  - input-control
  - envelopes
  - scale-quantization
  - chord-tools
  - ../decisions/adr-023-the-synth-channel-goes-stereo-on-demand
  - ../decisions/adr-028-a-tie-never-re-strikes
source:
  - src/audio/transport/sequencer.ts
  - src/audio/transport/scale-quantizer.ts   # the transposed note is then quantized
  - src/audio/transport/note-output.ts       # the opts bag pan rides in
  - src/audio/polyphony.ts                   # threads pan to the picked voice
  - src/audio/voice.ts                       # the per-voice pan + spread stage
  - src/audio/stereo.ts                      # the forced up-mix (lfo.md REQ-the-auto-pan-reads-a-stereo-input)
  - src/state/patterns.ts
  - src/audio/engine.ts
  - src/ui/panels/seq-panel.ts
  - src/ui/shell/pattern-row.ts          # ties the arm to tab visibility
  - src/ui/components/tabs.ts            # isVisible / onViewChange
  - src/ui/components/collapse-toggle.ts # onChange, so a fold is a view change
  - src/ui/components/lane-fold.ts       # the per-track fold (lane-fold.md)
  - src/ui/components/knob.ts            # the inline pan-knob layout
  - src/ui/styles/knob.module.css        # its row rules + the 720px drop
  - src/ui/styles/seq.module.css         # the matching cluster width
  - e2e/helpers.ts                       # dragKnobUp aims at the dial
  - src/ui/components/bank-bar.ts        # setFollowing — the take is bank-pinned
```

The synth's note sequencer: **four independent tracks** per bank on a 16-cell grid,
each playing the lane's own length and rate ([meter](meter.md)), so a bank can hold
a chord or a counter-line.

## Background / Why

Steps carry a note and the shared [per-step settings](step-settings.md), edited with
the shared grid gestures ([step-grid-editing](step-grid-editing.md)). It reads the
**play bank** the [arrangement](arrangement.md) selects, so playback and editing can
diverge. Live keyboard input passes through and layers on top. The Song-tab **mute**
suppresses triggering while the playhead keeps advancing, distinct from
`seq.master`, the voice-bus volume. Track 1 is the original single-track sequencer,
byte for byte, so the extra tracks cost existing songs nothing. **Step Input** fills
the grid from played notes. It listens on the *global* `bus.onNote`
([input-control](input-control.md) REQ-all-input-goes-through-the-bus), so it is
scoped to its own visible grid and pinned to one bank.

## Requirements

### Playing

- **REQ-the-sequencer-triggers-the-active-step** — On each tick, trigger the synth for
  the active step of the play bank, honouring velocity/gate/prob/ratchet/tie/micro and
  the seq-only bend ([step-settings](step-settings.md) REQ-a-seq-step-carries-a-bend).
  `micro` is applied here rather than inside `stepHits`.
- **REQ-the-note-releases-at-gate-end** — Release the held note at `gateEnd`; `tie`
  holds the last ratchet sub-hit into the next step, which then decides how the held
  note goes on (REQ-a-tie-continues-the-note-without-retriggering).
- **REQ-a-tie-continues-the-note-without-retriggering** — While `seq.tieMode` is
  **Legato** (0, the default), a step that sounds after a tied step on the same track
  **continues** that track's held note instead of striking a new one. Its first
  sub-hit is played with `legatoFrom: lastPlayedNote`, and the voice pool hands the
  held voices over without retriggering either envelope ([voicing](voicing.md)
  REQ-a-legato-note-takes-over-the-held-voices):
  - **the same pitch** sounds as one note, so the amp and filter envelopes run on
    through decay into sustain. A short-decay pluck tied over four steps is one
    pluck, not four.
  - **a different pitch** moves the voices to it, gliding as `glide.mode` /
    `mixer.glide` say. Each track is monophonic, so this holds in **Poly** too: tie
    plus glide slides one track's line without Mono voicing.
  - the step's own **velocity** is followed, not struck: the continued note
    glides its level **across the time it sounds in the step** to the level the new
    velocity would give it — the amp envelope, the filter envelope's velocity-scaled
    depth and the mod-matrix velocity source alike, each reaching ~95% by then
    ([envelopes](envelopes.md) REQ-a-continued-note-rescales-without-restarting).
    The sequencer passes that time as `legatoGlide` with `legatoFrom`: the step's
    length (`cellDur`, so a 1/8 lane glides over its longer step) when it ties on,
    its gate when it releases inside the step, and the first sub-hit's span when it
    ratchets (the next sub-hit strikes anyway). A velocity ramp across a tied
    run is therefore a crescendo, and an unchanged velocity schedules nothing. Its **bend** still
    applies, because the step that sounds defines the pitch ([step-settings](step-settings.md)
    REQ-every-sub-hit-re-bends).
  - only the **first** sub-hit continues. A ratcheted step's later sub-hits strike as
    they always did.
  - if the held voices are gone (stolen by another track's note), the step plays a
    normal note-on and the pool releases what is left of the old note. A tie never
    strands a voice.

  The old tie re-struck: it skipped the release, then sent a full note-on, so
  `Envelope.trigger` re-attacked from wherever the curve had fallen. That was
  inaudible at sustain 1 and a new pluck on a short decay, and the filter envelope
  re-swept on every tied step ([ADR-028](../decisions/adr-028-a-tie-never-re-strikes.md)).
- **REQ-re-strike-keeps-the-old-tie** — `seq.tieMode` **Re-strike** (1) keeps that
  behaviour **exactly**, for the songs whose sound depends on it: no `legatoFrom` is
  passed, every tied-into step strikes a note-on, and a tie into a different pitch
  releases the tied note at the new step's attack (after it, so it is a no-op in mono
  and races no glide; in poly the new pitch took its own voice and nothing else would
  release the old one). It is a song-level `seq.*` scalar, so presets never carry it
  and no `SongFile` bump is needed. The demos built on the re-pluck set it in their
  params. A trigger switch at Single still applies under it in Mono, per envelope
  ([voicing](voicing.md) REQ-single-trigger-legatos-a-mono-line): overlapping notes on
  a single-trigger mono synth do not re-strike that envelope.
- **REQ-mute-keeps-the-playhead-advancing** — `setMuted` stops triggering but keeps
  the playhead advancing, and leaves live play and the voice bus untouched.
- **REQ-seq-master-sets-the-voice-bus-volume** — `seq.master` is the voice-bus volume
  (default 1, a no-op).
- **REQ-seq-lane-length-comes-from-the-meter** — `seq.len` / `seq.rate` decide how
  many of the 16 cells play and how long each lasts ([meter](meter.md)
  REQ-each-machine-has-a-loop-length/REQ-each-machine-has-a-step-rate). `onTick`
  resolves cells through a `LaneMeter` and calls `tickCell` for each: none on a
  skipped tick, two or three at a triplet rate. Gate and ratchet are fractions of the
  **cell**. The defaults are one cell per tick. The bank shape stays 16 cells; only
  the played window moves.
- **REQ-every-note-is-shifted-by-the-slot-transpose** — `tickTrack` reads
  `arrangement.seqTranspose` once and adds it to `s.note`, clamped to
  `MIDI_NOTE_MIN..MAX` ([arrangement](arrangement.md)
  REQ-a-seq-slot-carries-a-transpose/REQ-transposition-is-applied-at-trigger). The
  shift reaches the note-on, every ratchet sub-hit's release and `onNote`. The
  **shifted** note is stored in `SeqTrackState.lastPlayedNote`, so a tie across a bar
  with a different transpose releases at the pitch it started. That is why the shift
  is applied once at the top, never re-derived at each release.
- **REQ-the-transposed-note-is-then-quantized** — The transposed note then goes
  through `ScaleQuantizer.get` ([scale-quantization](scale-quantization.md)
  REQ-exactly-three-quantize-trigger-sites/REQ-transpose-first-then-quantize). The
  order is the point: transposing first lands a `+5` bar back in the key. The
  *quantized* note is what `lastPlayedNote` stores. While `scale.type` is
  `chromatic` the call returns early.
- **REQ-a-stop-releases-every-tracks-note** — A tied step schedules **no** release,
  since the next tick does that, and after a stop that tick never comes.
  `StepSequencer` subscribes `clock.onStop` and releases each track at its **own last
  gate end** (`SeqTrackState.lastReleaseAt`), not at `now`:
  - a note-on may still be in the look-ahead, and a release before its attack is
    overwritten by it;
  - the note ends where its gate said it would;
  - a stale past value is harmless, since `Envelope.anchor` clamps with
    `Math.max(when, now)` ([envelopes](envelopes.md)
    REQ-envelope-scheduling-is-future-time-safe).

  It is a **release**, not a kill: tails ring out. `Engine.panic()` calls
  `clock.stop()` first, so panic clears stale tie state too.
- **REQ-a-seek-releases-every-tracks-note** — `lastPlayedNote` / `prevTied` mean
  something only for *adjacent* steps. So `StepSequencer` subscribes `clock.onSeek`
  and runs the same per-track release, **at each track's last gate end**
  ([transport-position](transport-position.md)
  REQ-every-relative-consumer-reacts-to-a-seek). A [loop](transport-loop.md) wrap
  is a jump issued from inside the drain, straight after the last step was scheduled
  ([transport](transport.md) REQ-a-step-router-can-redirect-the-next-step), so a
  release at `now` would hang a tied last step every wrap. `releaseTrack` stays
  private.

### Tracks

- **REQ-four-tracks-per-bank** — `seqBanks` is `[bank][track][step]`
  (`SEQ_TRACK_COUNT = 4`), like the drum machine. Track 1 is the original
  single-track data and tracks 2–4 start empty. Each track is independently
  monophonic (its own held-note/tie state), so four tracks sound up to a four-note
  chord through the shared voice pool.
- **REQ-poly-voicing-gates-the-extra-tracks** — In mono only track 1 triggers. Tracks
  2–4 keep their data, render dimmed and say why ("mono voicing — switch to POLY").
  Nothing is rewritten. Four tracks on one mono voice would be last-note mush, and
  forcing poly would overwrite a param the user set.
- **REQ-per-track-mute** — `seq.t<i>.mute` (default 0, ADR-006): the track stops
  triggering while the playhead advances. It is independent of `seq.mute` and
  `seq.master`.
- **REQ-tracks-two-to-four-collapse** — Tracks 2–4 fold to their header, per track,
  persisted under `websynth.ui.collapsed.seqtrack.<i>`. With no stored preference an
  empty track starts folded and one with steps starts open, so a loaded song never
  hides content. Track 1 never folds. The mechanism is [lane-fold](lane-fold.md),
  shared with the motion lanes.
- **REQ-step-input-targets-the-focused-track** — Notes land in the track holding the
  selection cursor; the arm gains no second mode.
- **REQ-song-file-v6-adds-seq-tracks** — SongFile **v6** adds optional `seqTracks`
  (ADR-007). `seqBanks` keeps its v1–v5 shape and meaning (**track 1**), so older
  files and demos load with three empty tracks. `seqTracks[bank][track]` is indexed by
  the *real* track number with **index 0 always null**, which removes an off-by-one.
  An empty track writes `null`.

### Step Input

- **REQ-step-input-arms-only-on-screen** — Step Input is armed only while the
  Sequencer tab is active **and** the pattern row is not collapsed. Losing either
  **disarms** (LED dark, recording outline cleared), and the user re-arms on return.
  A whole-store overwrite (`PatternStore.onBulkRestore`: song/demo load, import, New,
  session-undo) disarms too. Deliberately **not** gated on DOM focus: the on-screen
  keyboard's keys are plain `div`s, so clicking one blurs the step button.
- **REQ-a-take-is-bank-pinned** — Arming turns the panel's **Follow** off
  ([banks](banks.md) REQ-follow-tracks-the-play-bank), so the arrangement cannot swap
  the edit bank mid-take. Disarming leaves Follow off. A *manual* bank click while
  armed is honoured, and recording continues in the new bank.
- **REQ-the-armed-flag-is-the-single-truth** — The armed flag alone gates the
  `bus.onNote` capture, and REQ-step-input-arms-only-on-screen keeps it true only
  while visible. One function owns the flag, the LED and the grid outline.

### Per-track pan

- **REQ-a-seq-track-carries-a-pan** — `seq.t<i>.pan` (`-1..1`, default 0, ADR-006),
  the same def shape and `fmtPan` as `drum.t<i>.pan` / `sampler.t<i>.pan`. It is a
  scalar, so no `SongFile` bump. All four tracks share one voice pool through the
  track-agnostic `SynthOutput.playNote`, so the pan **rides the note**: `playNote(note,
  velocity, when, { pan, panGroup })`, applied by a `StereoPannerNode` in the voice at
  the note's start. `panGroup` names the knob, so a sounding voice follows it. Live
  keys, MIDI and the [arpeggiator](arpeggiator.md) pass neither and stay centred
  (ADR-023).
- **REQ-panning-a-track-does-not-change-its-level** — The voice panner is fed **mono**,
  which selects the equal-power law. The panned edge carries a fixed `sqrt(2)` to undo
  its 3.01 dB centre dip, so hard pan keeps the power it had centred (measured −0.19
  dB). Feeding it **stereo** selects the fold law (+1.34 dB). `synthPan` is fed stereo
  on purpose: it *moves* an already-stereo bus, while this *places* a mono source
  (lfo.md REQ-the-auto-pan-reads-a-stereo-input).
- **REQ-the-spread-stage-engages-off-centre** — A `StereoPannerNode` always outputs
  two channels, and the voice path is otherwise 1-channel. So each voice has a dry
  edge and a panned edge, and `Engine` splices the panned one in only while some
  `seq.t<i>.pan` is non-zero, with the true-bypass idiom (ADR-012): reconnect before
  ramping in; ramp, then disconnect after the crossfade on the way out. A channel
  count follows *connections*, not gains. At centre both edges deliver `x`, so
  complementary equal-time `setTargetAtTime` ramps are transparent. **A song that
  never pans keeps the mono graph and its CPU exactly.** Engaging is idempotent and a
  disengage only schedules the disconnect, which a re-engage cancels, so a motion lane
  crossing centre every frame costs eight ramps, not graph edits (ADR-017).
- **REQ-track-pan-places-and-the-auto-pan-moves** — Track pan is upstream of the
  insert chain, and the LFO `pan` destination's `synthPan` is downstream
  ([lfo](lfo.md) REQ-pan-sweeps-a-stereo-panner). The tracks are placed and the sweep
  moves the whole field; it **folds** toward one side at its extremes. Per-voice pan is
  not a [mod-matrix](mod-matrix.md) destination
  (REQ-per-voice-sources-cannot-drive-bus-destinations is unchanged).
- **REQ-two-tracks-on-one-pitch-share-a-pan** — `Polyphony` keys held notes by note
  number ([voicing](voicing.md)), so a second track on the same pitch re-triggers that
  voice and the later pan wins. Different pitches are unaffected. This is recorded,
  not fixed: keying per track would spend a voice per duplicated pitch out of eight.
  A voice stolen between tracks takes the new pan at `when` with the per-voice ramp.
- **REQ-the-pan-knob-costs-the-row-no-height** — `KnobOptions.inline` lays the knob out
  as a row (`PAN ( ) C`), so the track row stays as tall as its 32 px step buttons.
  Below the 720 px breakpoint the word `PAN` drops (the readout `C`/`L40`/`R75` and
  `title` carry it), and the cluster narrows at the same breakpoint (the two rules are
  commented as a pair). The cluster width stays a **constant**, never `auto`: the
  [transport-position](transport-position.md) ruler shares `.trackCtrls`, and sizing
  to content misaligns the ruler and the grids. In the row layout the dial must not
  shrink to 0 px (flex default) and `.root`'s column `width`/`min-height` must not
  apply.

## Technical design

### Contract / public interface

```yaml
StepSequencer:  # src/audio/transport/sequencer.ts
  setEnabled(on)
  setMuted(muted)        # DJ mute: stop triggering, keep advancing
  setTrackMuted(track, muted)
  setTrackPan(track, p)         # -1..1, rides the next note
  setPolyphonic(poly)           # gates tracks 2..4
  setRestrikeTies(on)           # seq.tieMode: false legato (default) · true re-strike
  onStep(fn) / onNote(fn) -> unsubscribe      # playhead + note viz
  # onNote's releaseAt is the LAST sub-hit's gate end (= lastReleaseAt)
  # reads patterns.seqBank(arrangement.seqPlayBank) each tick via clock.onTick
  # per-track held-note/tie state lives in one SeqTrackState[]
  # subscribes clock.onSeek and clock.onStop to release each track at its lastReleaseAt

PatternStore:          # src/state/patterns.ts
  seqBanks[bank][track][step]
  seq -> SeqStep[][]                 # edit bank, track-major (like `drum`)
  seqTrack(track) -> SeqStep[]       # one track of the edit bank
  seqBank(i) -> SeqStep[][]
  setSeqStep(track, index, patch)    # leading track arg (like setDrumCell)
  clearSeqTrack(track)

buildSeqPanel(bus, engine, undo): { el, disarmStepInput() }   # src/ui/panels/seq-panel.ts

TabContainer:  # src/ui/components/tabs.ts
  isVisible(id): boolean          # active tab AND the row is not collapsed
  onViewChange(fn): () => void    # fires on activate() and on a collapse toggle

CollapseToggleOptions.onChange?(collapsed): void   # from the one place `.collapsed` is written

BankBar.setFollowing(on): void   # src/ui/components/bank-bar.ts

SynthOutput:           # src/audio/transport/note-output.ts
  playNote(note, velocity, when?, opts?)   # opts.pan -1..1, opts.panGroup,
                                           # opts.legatoFrom (the held note it continues)
  releaseNote(note, when?)
  # opts is optional at every layer, so the arp and live keys stay centred

Polyphony.playNote(note, velocity, when?, opts?)   # threads opts.pan
Voice:                 # src/audio/voice.ts
  noteOn(note, velocity, when, opts?)
  connectTo(dest)                       # names the bus; BOTH output edges (dry + panned) plug in with a note (voicing.md REQ-an-idle-voice-is-unplugged)
  setSpread(on)
forceStereo(node)      # src/audio/stereo.ts
```

### Data shapes (registry)

```yaml
seq.on:     { discrete, labels: [off, on], default: 0 }
seq.t<i>.mute: { discrete, labels: [on, mute], default: 0 }   # i = 0..3
seq.t<i>.pan:  { range: -1..1, default: 0, format: fmtPan }   # i = 0..3
seq.master: { range: 0..1, default: 1 }      # voice-bus volume (no-op default)
seq.mute:   { discrete, labels: [on, mute], default: 0 }   # lane mixer (song-mode)
seq.solo:   { discrete, labels: [off, solo], default: 0 }
seq.tieMode: { discrete, labels: [legato, re-strike], default: 0 }   # ADR-028: the default is the fix
seq.len / seq.rate                           # meter.md
# step data: SeqStep[] in PatternStore (not the bus) — see step-settings.md
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  seq.on     -> this.seq.setEnabled(v >= 0.5)
  seq.master -> rampTo(voiceBus.gain, v)      # independent of mute
  seq.t<i>.pan -> this.seq.setTrackPan(i, v)  # Engine holds the four values and drives
    # voice.setSpread(some non-zero)
  seq.mute/solo -> laneMixer.setMute/setSolo (-> seq.setMuted), see song-mode.md
  seq.tieMode -> this.seq.setRestrikeTies(v >= 0.5)
hit math: stepHits / rollProb (step-hits.ts); releases voice at gateEnd
ui: src/ui/panels/seq-panel.ts (seq-step-<i> buttons + StepSettingsEditor)
  the edit row carries a TIES Segmented (seg-seq.tieMode) right after the
  step's Tie button: the per-step switch and the song-wide meaning sit together
  gestures (ADR-014): click a segment = set the mode for the whole song; no drag,
  no wheel, no long-press. Keyboard: Tab focus + Enter/Space, as every Segmented.
step input:
  seq-panel: one setArmed(on) owns `armed` + recBtn '.on' + stepRow '.recording';
    arming also calls bankBar.setFollowing(false);
    patterns.onBulkRestore(() => setArmed(false))
  pattern-row.ts buildPatternRow: tabs.onViewChange(() =>
    { if (!tabs.isVisible('seq')) seq.disarmStepInput(); })
    # the late-binding seam: the panel is built before the TabContainer exists
```

## Scenarios (BDD)

```gherkin
Scenario: Active steps trigger the synth on the beat
  Given seq.on is 1 and step 0 is active with a note
  When the transport reaches step 0
  Then the synth plays that note and releases it at gateEnd
# pinned by: tests/audio/transport/sequencer.test.ts, e2e/patterns.spec.ts

Scenario: Four tracks layer into a chord (REQ-four-tracks-per-bank)
  Given tracks 1-3 each hold a note on step 0 and voicing is poly
  When the transport reaches step 0
  Then all three notes sound together
  And each track holds and releases its own note, so one track's rest never
    cuts another's tied note short
# pinned by: tests/audio/transport/sequencer.test.ts, e2e/patterns.spec.ts

Scenario: Mono voicing gates tracks 2-4 without losing them (REQ-poly-voicing-gates-the-extra-tracks)
  Given tracks 1 and 2 both hold notes
  When voicing.mode is mono
  Then only track 1 sounds, and track 2 dims with "mono voicing — switch to POLY"
  When voicing.mode returns to poly
  Then track 2 sounds again, its steps untouched throughout
# pinned by: tests/audio/transport/sequencer.test.ts, e2e/patterns.spec.ts

Scenario: A per-track mute silences one track only (REQ-per-track-mute)
  Given tracks 1 and 2 both hold notes on the same step
  When track 2 is muted
  Then track 1 still sounds and the playhead keeps advancing
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Empty extra tracks start folded, used ones do not (REQ-tracks-two-to-four-collapse)
  Given a fresh session
  Then tracks 2-4 are folded and track 1 is open
  When a song using track 3 is loaded
  Then track 3 unfolds, so its content is never hidden behind a chevron
# pinned by: e2e/patterns.spec.ts

Scenario: A one-track song writes no seqTracks (REQ-song-file-v6-adds-seq-tracks, back-compat)
  Given only track 1 holds steps
  When the song is captured
  Then no seqTracks key is written at all and the version stays as it was
# pinned by: tests/state/song.test.ts, tests/state/song-author.test.ts

Scenario: A v1-v5 file loads with three empty tracks (REQ-song-file-v6-adds-seq-tracks)
  Given an older SongFile and a session that had dirtied tracks 2-4
  When it is applied
  Then tracks 2-4 are blank and track 1 sounds exactly as before
# pinned by: tests/state/song.test.ts

Scenario: DJ mute stops notes but the playhead keeps moving (edge)
  Given the sequencer is muted via the lane mixer
  Then no sequenced notes sound, the playhead still advances, and live keys still play
# pinned by: tests/audio/transport/sequencer.test.ts, e2e/song-mixer.spec.ts

Scenario: A tied note does not slur across a transport seek (REQ-a-seek-releases-every-tracks-note)
  Given a step tied into the next one is currently sounding
  When the playhead is seeked elsewhere
  Then the held note is released and prevTied is cleared on every track
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A seek releases a tie at its gate end, not before its attack (REQ-a-seek-releases-every-tracks-note, regression)
  Given a tied step whose note-on is still in the look-ahead (when > now)
  When onSeek fires — a loop wrap straight after that step was scheduled
  Then releaseNote is called with that step's gate end, not with `now`
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Stopping the song ends a tied note instead of hanging it (REQ-a-stop-releases-every-tracks-note, regression)
  Given a step tied into the next one is currently sounding
  When the transport stops
  Then the note is released at that step's own gate end, not left ringing
  And the reverb/delay tail keeps ringing out, because a release is not a kill
  And the user never has to reach for Panic to silence it
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A tie into the same pitch is one note, not a re-pluck (REQ-a-tie-continues-the-note-without-retriggering, regression)
  Given seq.tieMode is Legato and a step holding note 60 ties into a step holding note 60
  When the second step fires
  Then it is played with legatoFrom 60 and nothing releases 60 between the two
  And through the real pool the voice is not re-struck, so neither envelope retriggers
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A tie into a different pitch hands its voice over, in Poly too (REQ-a-tie-continues-the-note-without-retriggering)
  Given seq.tieMode is Legato, voicing is poly and a step holding note 60 ties into a step holding note 64
  When the second step fires
  Then 60's voice moves to 64 without a retrigger and no second voice is taken
  And nothing releases 60, because 60 no longer holds a voice
  And after a stop no voice is left sounding
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Only the first sub-hit of a ratcheted step continues the tie (REQ-a-tie-continues-the-note-without-retriggering, edge)
  Given seq.tieMode is Legato and a tied step runs into a step with ratchet 3
  When that step fires
  Then its first sub-hit carries legatoFrom and the other two strike as plain note-ons
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A tie whose voice was stolen still sounds and strands nothing (REQ-a-tie-continues-the-note-without-retriggering, edge)
  Given a tied note whose voices another track's note has stolen
  When the tied-into step fires
  Then it plays as a normal note-on and no voice is left claiming the old note
# pinned by: tests/audio/polyphony.test.ts

Scenario: A tied crescendo swells under Legato (REQ-a-tie-continues-the-note-without-retriggering, regression)
  Given seq.tieMode is Legato and a run of same-pitch tied steps whose velocities rise
  When the run plays
  Then every tied-into step passes legatoGlide equal to the time it sounds in the step with its legatoFrom
  And a run's last step, released at gate 0.25, glides over that quarter step, not the whole one
  And through the real voice the amp level moves toward each new velocity without a new attack
# Bug: a velocity ramp across ties stayed at its first step's level — the swell a
# song wrote in velocities was only heard under Re-strike.
# pinned by: tests/audio/transport/sequencer.test.ts, tests/audio/voice.test.ts

Scenario: An unchanged velocity across a tie writes no level change (REQ-a-tie-continues-the-note-without-retriggering)
  Given seq.tieMode is Legato and a tie between two steps at the same velocity
  When the second step fires
  Then neither envelope nor the velocity source is written by it
# pinned by: tests/audio/voice.test.ts

Scenario: Re-strike keeps the old tie exactly (REQ-re-strike-keeps-the-old-tie, back-compat)
  Given seq.tieMode is Re-strike and a step holding note 60 ties into a step holding note 64
  When the second step fires
  Then 64 is played with no legatoFrom and no legatoGlide, and note 60 is released at 64's attack, after it
  And a tie into the SAME pitch re-strikes its voice without releasing it
  And in mono the release is a no-op, because 64 already took 60's voices
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: An old song with no tieMode plays Legato (REQ-re-strike-keeps-the-old-tie, ADR-028)
  Given a song file that carries no seq.tieMode key
  When it loads
  Then seq.tieMode is 0 and its ties continue their notes
  And only a song that names seq.tieMode 1 re-strikes
# pinned by: tests/state/params.test.ts

Scenario: The stop release is never scheduled before the note-on (edge)
  Given a note-on is still sitting in the transport look-ahead when the user stops
  Then the release is scheduled at the step's gate end, which is at or after that
    note-on — a release anchored at `now` would be overwritten by the attack
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

Scenario: Transpose is applied before quantization, not after (REQ-the-transposed-note-is-then-quantized)
  Given an active key and an arrangement slot that transposes +5
  When a step fires
  Then the note is transposed first and the sum is quantized into the key
  And reversing the order would leave the bar out of key
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A chromatic key leaves every triggered note untouched (REQ-the-transposed-note-is-then-quantized, back-compat)
  Given scale.type is 0
  When any step fires
  Then the note sounding is exactly the unquantized note
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A track's pan reaches only that track's notes (REQ-a-seq-track-carries-a-pan)
  Given tracks 1 and 2 both hold notes on the same step at different pitches
  When track 2 is panned hard right
  Then track 2's note plays with pan 1 and track 1's with pan 0
  And a live keyboard note played over them is still centred
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: An old song loads centred (REQ-a-seq-track-carries-a-pan, back-compat)
  Given a song file that carries no seq.t<i>.pan key
  When it loads
  Then all four pans sit at 0 and the song sounds exactly as it did
  And the spread stage never engages, so the graph stays mono
# pinned by: tests/state/params.test.ts, tests/audio/transport/sequencer.test.ts

Scenario: The spread stage stays out of circuit while every track is centred (REQ-the-spread-stage-engages-off-centre)
  Given a fresh engine with all four pans at 0
  Then no voice's panned edge is connected, and the insert chain is 1-channel
  When one track is panned off centre
  Then the panned edges connect and the pan takes effect
  And returning every track to centre disconnects them again after the crossfade
# pinned by: tests/audio/voice-spread.test.ts

Scenario: The bus auto-pan moves the spread field rather than flattening it (REQ-track-pan-places-and-the-auto-pan-moves)
  Given track 1 panned left and track 2 panned right
  When an LFO sweeps the `pan` destination
  Then the pair moves together across the field, keeping its relative placement
  And at the extremes of the sweep the image folds toward one side
# pinned by: no automated test — verified by ear (ADR-010), specs/recipes/verify-audio-by-ear.md

Scenario: Two tracks on one pitch collapse to one pan (REQ-two-tracks-on-one-pitch-share-a-pan, known limit)
  Given track 1 panned hard left and track 2 panned hard right
  When both fire the SAME note on the same step
  Then one voice sounds, carrying the pan of whichever track fired last
  And nothing is dropped or doubled — this is the shared pool, documented not fixed
# pinned by: tests/audio/transport/sequencer.test.ts
```

## Tests & verification

- `tests/audio/transport/sequencer.test.ts`, `tests/audio/voice-spread.test.ts`,
  `tests/audio/engine-stereo.test.ts`, `tests/state/params.test.ts`,
  `tests/ui/{tabs,collapse-toggle,bank-bar}.test.ts`, `e2e/patterns.spec.ts` —
  `npm test` / `npm run e2e`.
- **Per-track pan is signed off by ear** (ADR-010,
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)): all centred against a
  build without the stage (must be identical), tracks spread hard L/R, and the same
  with an LFO on `pan`. Render Firefox too: this writes an `AudioParam` at note-on and
  relies on up-mixing. `audio-metrics` reads the mono down-mix, so check per channel.
- **The tie is signed off by ear** (ADR-010): Re-strike runs the pre-v15 code path
  unchanged (no `legatoFrom` reaches the pool), which the suite pins call for call.
  Rendered takes cannot confirm it: two renders of one demo at the same commit
  differ as much as Re-strike and Legato do (10 ms envelope correlation ~0.84 either
  way, even with one oscillator and no unison or drift). So the comparison is a
  listen: a re-pluck demo at Re-strike against the build before, and at Legato
  against Re-strike.
- **A tied crescendo is signed off the same way**: a velocity ramp across ties at
  Legato against Re-strike, on both engines, with every lane but the swelling tracks
  muted (`bench:audio --set drum.mute=1 --set seq.t0.mute=1`-style). Measured
  through the whole mix the swell drowns in the other parts. Isolated, the
  two modes' per-step level is the comparison: Legato should climb with Re-strike,
  minus its re-attack.
