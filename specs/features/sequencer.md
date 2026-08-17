# Step sequencer (synth)

```yaml
id: sequencer
status: implemented
version: 8   # v8: the lane's length + step rate come from the meter (REQ-18)
             # v7: the transposed note is then quantized to the key (REQ-17)
             # v6: notes are shifted by the arrangement slot's transpose (REQ-16)
             # v5: release held notes on a transport stop, too (REQ-15)
owner: core
related:
  - architecture
  - transport
  - transport-position
  - step-settings
  - step-grid-editing
  - banks
  - arrangement
  - input-control
  - envelopes
  - scale-quantization
  - chord-tools
source:
  - src/audio/transport/sequencer.ts
  - src/audio/transport/scale-quantizer.ts   # REQ-17
  - src/state/patterns.ts
  - src/audio/engine.ts
  - src/ui/panels/seq-panel.ts
  - src/ui/app.ts                        # ties the arm to tab visibility (REQ-5)
  - src/ui/components/tabs.ts            # isVisible / onViewChange (REQ-5)
  - src/ui/components/collapse-toggle.ts # onChange, so a fold is a view change (REQ-5)
  - src/ui/components/bank-bar.ts        # setFollowing — the take is bank-pinned (REQ-6)
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
([input-control](input-control.md) REQ-1) — so on its own it cannot tell a note meant
for the grid from one played anywhere else in the app. Left ungated it recorded while
the user was on another tab entirely (holding chords on the Arpeggiator silently
overwrote the bank, with the lit LED off-screen), and because `setSeqStep` writes to
the **edit** bank while [banks](banks.md) REQ-5 Follow drags that bank along with the
arrangement, a take during playback sprayed across all four banks. REQ-5..REQ-7 make
the arm a deliberate, visible, bank-pinned mode instead: it exists only while its own
grid is on screen, so "armed" and "visible" cannot disagree.

(v3) One track meant a bank could only ever be one line: harmony had to be
faked with the arpeggiator, ties or a second render into the sampler. Four
tracks is the smallest change that makes chords and counter-lines native, and it
costs nothing to existing songs — track 1 *is* the old sequencer, byte for byte,
and tracks 2–4 start empty and silent.

## Requirements

- **REQ-1** — On each tick, trigger the synth for the active step of the current
  play bank, honouring velocity/gate/prob/ratchet/tie.
- **REQ-2** — Release the held note at `gateEnd`; `tie` holds the last ratchet
  sub-hit into the next step.
- **REQ-3** — `setMuted` stops triggering but keeps the playhead advancing and
  leaves live-keyboard play + the voice bus untouched.
- **REQ-4** — `seq.master` sets the voice-bus volume (default 1 — a no-op for
  existing presets).
- **REQ-5** — **Step Input is armed only while its own grid is on screen.** The arm
  is scoped to the panel being *visible*: the Sequencer tab is the active tab **and**
  the pattern row is not collapsed. Losing either — switching tabs, folding the row —
  **disarms**: the LED goes dark and the grid's orange recording outline clears, and
  the user must re-arm deliberately on return. A whole-store overwrite (song/demo
  load, import, New, session-undo — `PatternStore.onBulkRestore`) disarms too; a fresh
  song never inherits an armed recorder. Deliberately **not** gated on DOM focus: the
  on-screen keyboard is built from plain `div`s, so clicking a key blurs the focused
  step button and a `document.activeElement` rule would kill mouse-played input.
- **REQ-6** — **A take is bank-pinned.** Arming turns the panel's [banks](banks.md)
  REQ-5 **Follow** toggle off, so the arrangement cannot swap the edit bank mid-take
  and recorded notes always land in the bank that was on screen when the user armed.
  Disarming leaves Follow off (the user re-enables it) — same editing-intent rule as a
  manual bank click. A *manual* bank click while armed is honoured normally: recording
  continues, in the newly picked bank.
- **REQ-7** — The armed flag is the **single source of truth** for the `bus.onNote`
  capture, and REQ-5 keeps it true only while visible — so the note handler needs no
  second visibility check. One function owns the flag and both its visual affordances
  (button LED + grid outline); nothing else writes them.

### v3 — four tracks

- **REQ-8** — **Four tracks per bank.** `seqBanks` becomes `[bank][track][step]`
  (`SEQ_TRACK_COUNT = 4`), mirroring the drum machine's shape. **Track 1 is the
  pre-v3 sequencer** — same data, same behaviour — and tracks 2–4 start empty.
  Each track is independently monophonic (its own held-note/tie state), so four
  active tracks sound up to a four-note chord through the shared voice pool.
- **REQ-9** — **Poly voicing gates the extra tracks.** While `voicing.mode` is
  mono only track 1 triggers; tracks 2–4 keep their data, render dimmed and say
  why ("mono voicing — switch to POLY"). Nothing is rewritten: flipping to poly
  brings them straight back. Four tracks fighting over one mono voice would be
  last-note-wins mush that reads as a bug, and silently forcing poly would
  overwrite a param the user (or their song) set.
- **REQ-10** — **Per-track mute** (`seq.t<i>.mute`, default 0 — a no-op per
  [ADR-006](../decisions/adr-006-no-op-param-defaults.md)), the drum machine's
  per-track mute rule: the track stops triggering while the playhead keeps
  advancing. Independent of the lane-wide `seq.mute` (REQ-3) and of `seq.master`.
- **REQ-11** — **Tracks 2–4 collapse, and start collapsed when empty.** A track
  row folds to its header; the fold is per track and persisted under
  `websynth.ui.collapsed.seqtrack.<i>`. With no stored preference an *empty*
  track 2–4 starts folded (nothing to show) and one carrying steps starts open —
  so loading a song that uses all four never hides its content, and a fresh
  session shows one track, as before v3. Track 1 never collapses.
- **REQ-12** — **Step Input targets the focused track** (REQ-5..7 otherwise
  unchanged): notes land in the track holding the selection cursor, so the arm
  stays the single source of truth and gains no second mode.
- **REQ-13** — **SongFile v6** adds optional `seqTracks`, additive per
  [ADR-007](../decisions/adr-007-songfile-additive-versioning.md).
  `seqBanks` keeps its exact v1–v5 shape and meaning (**track 1**), so every
  older file — and all committed demos — load and sound identical with three
  empty tracks. `seqTracks[bank][track]` is indexed by the *real* track number
  with **index 0 always null** (track 1 lives in `seqBanks`); that costs one
  `null` per bank and removes the off-by-one that an "extra tracks" array would
  invite. An empty track writes as `null`.
- **REQ-14** (v4) — **A transport seek releases every track's held note.** The
  per-track `SeqTrackState` carries `lastPlayedNote` and `prevTied` between steps
  (REQ-2), which are only meaningful for *adjacent* steps. When the playhead jumps
  ([transport-position](transport-position.md) REQ-4) a note tied at the old
  position would otherwise slur into the new one, or a held note would never be
  released at all. `StepSequencer` therefore subscribes `clock.onSeek` in its
  constructor and runs the same per-track release `setMuted(true)` uses — keeping
  `releaseAll`/`releaseTrack` private rather than widening the public surface for
  one caller.
- **REQ-15** (v5) — **A transport stop releases every track's held note.** A tied
  step deliberately schedules **no** `releaseNote` (REQ-2): the release is the
  *next* tick's job. After a stop that tick never comes, so the voice sustained
  until the user hit Panic. `StepSequencer` subscribes `clock.onStop` alongside
  REQ-14's `onSeek`, but releases at the track's **own last gate end**
  (`SeqTrackState.lastReleaseAt`), not at `now`:
    - the note-on may still be sitting in the transport look-ahead, and a release
      scheduled *before* its attack is overwritten by that attack — which would
      re-create the very hang this fixes;
    - the note then ends where its gate always said it would (at most one 16th
      later) instead of being truncated under the player;
    - a stale past value is harmless — `Envelope.anchor` clamps with
      `Math.max(when, now)` ([envelopes](envelopes.md) REQ-4).
  This is a **release**, not a kill: the amp envelope's release stage runs and the
  reverb/delay tails ([effects](effects.md)) are downstream, so a stop never cuts
  the tail off a song. It also fixes stop's silent partner — `Engine.panic()` calls
  `clock.stop()` first, so the stale `lastPlayedNote`/`prevTied` that used to
  survive a panic (and slur the first step after the next Play) is now cleared too.

- **REQ-16** (v6) — **Every triggered note is shifted by the arrangement slot's
  transpose.** `tickTrack` reads `arrangement.seqTranspose` once and adds it to
  `s.note`, clamped to `MIDI_NOTE_MIN..MAX`
  ([arrangement](arrangement.md) REQ-8/REQ-9). The shift applies to the note-on,
  to the per-sub-hit `releaseNote` of a ratchet, and to what is reported to
  `onNote` — so the keyboard highlight shows the pitch actually sounding.

  **The tie across a bar line is the trap.** A held note's release goes through
  `SeqTrackState.lastPlayedNote`, which stores the note that was *played*. Storing
  the **transposed** note there is what makes the release correct for free: when a
  step ties into a bar whose slot transposes differently, the ringing voice is
  released at its own pitch instead of at a pitch that was never started — which
  would leave a stuck voice. This is why the transpose is applied once at the top
  of `tickTrack` and the local is used everywhere `s.note` was, rather than being
  re-derived at each release site.

- **REQ-17** (v7) — **The transposed note is then quantized to the key.** `tickTrack`
  passes the transposed note through `ScaleQuantizer.get` before it is played
  ([scale-quantization](scale-quantization.md) REQ-4/REQ-5). The **order matters and is
  the point**: transposing first and quantizing second is what makes a `+5` bar land
  back in the key instead of leaving it, which is the musical defect REQ-16's chromatic
  shift otherwise creates. Quantizing first would preserve that drift.

  This inherits REQ-16's tie safety for free rather than re-earning it: the *quantized*
  note is what lands in `SeqTrackState.lastPlayedNote`, so a note started in one key or
  transpose is released at the pitch it actually started, exactly as above. While
  `scale.type` is `chromatic` the call is an early return and this REQ is invisible.

- **REQ-18** (v8) — **The lane's length and step rate come from the meter.**
  `seq.len` / `seq.rate` decide how many of the 16 cells play and how long each
  lasts ([meter](meter.md) REQ-10/REQ-14); the defaults follow the bar at one
  cell per tick, i.e. the pre-meter 16-step behaviour exactly. `onTick` resolves
  the cells through a `LaneMeter` and calls `tickCell` for each — usually one,
  none on a tick a coarser lane skips, two or three for a triplet rate. Gate and
  ratchet are fractions of the **cell**, not of a 16th, so a step at 1/8 holds
  for twice as long; at the default rate the two numbers are identical.
  This closes the "Open questions" note below.

## Technical design

### Contract / public interface

```yaml
StepSequencer:  # src/audio/transport/sequencer.ts
  setEnabled(on)
  setMuted(muted)        # DJ mute: stop triggering, keep advancing
  setTrackMuted(track, muted)   # v3, REQ-10
  setPolyphonic(poly)           # v3, REQ-9 — gates tracks 2..4
  onStep(fn) / onNote(fn) -> unsubscribe      # playhead + note viz
  # onNote's releaseAt is the LAST sub-hit's gate end (v5) — same value
  # lastReleaseAt carries, so a ratcheted step's key viz outlives its first sub-hit
  # reads patterns.seqBank(arrangement.seqPlayBank) each tick via clock.onTick
  # per-track held-note/tie state lives in one SeqTrackState[] (v3)
  # subscribes clock.onSeek to release held notes + clear prevTied (v4, REQ-14)
  # subscribes clock.onStop to release each track at its lastReleaseAt (v5, REQ-15)

PatternStore (v3):     # src/state/patterns.ts
  seqBanks[bank][track][step]        # was [bank][step]
  seq -> SeqStep[][]                 # edit bank, track-major (like `drum`)
  seqTrack(track) -> SeqStep[]       # one track of the edit bank
  seqBank(i) -> SeqStep[][]
  setSeqStep(track, index, patch)    # leading track arg (like setDrumCell)
  clearSeqTrack(track)               # REQ-6 of step-grid-editing

buildSeqPanel(bus, engine, undo): { el, disarmStepInput() }   # src/ui/panels/seq-panel.ts
  # el is the panel root (was the bare return); disarmStepInput is REQ-5's hook

TabContainer:  # src/ui/components/tabs.ts — the visibility surface REQ-5 needs
  isVisible(id): boolean          # active tab AND the row is not collapsed
  onViewChange(fn): () => void    # fires on activate() and on a collapse toggle

CollapseToggleOptions.onChange?(collapsed): void   # src/ui/components/collapse-toggle.ts
  # called from the one place the `.collapsed` class is written, so the chevron,
  # the bar-click trigger and expand() all report through it

BankBar.setFollowing(on): void   # src/ui/components/bank-bar.ts — public (REQ-6)
```

### Data shapes (registry)

```yaml
seq.on:     { discrete, labels: [off, on], default: 0 }
seq.t<i>.mute: { discrete, labels: [on, mute], default: 0 }   # v3, i = 0..3
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
  seq.mute/solo -> laneMixer.setMute/setSolo (-> seq.setMuted), see song-mode.md
hit math: stepHits / rollProb (step-hits.ts); releases voice at gateEnd
ui: src/ui/panels/seq-panel.ts (16 seq-step-<i> buttons + StepSettingsEditor)
step input (REQ-5..7):
  seq-panel: one setArmed(on) owns `armed` + recBtn '.on' + stepRow '.recording';
    arming also calls bankBar.setFollowing(false) (REQ-6);
    patterns.onBulkRestore(() => setArmed(false))       # song load / New (REQ-5)
  app.ts buildPatternRow: tabs.onViewChange(() =>
    { if (!tabs.isVisible('seq')) seq.disarmStepInput(); })   # tab + fold (REQ-5)
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

Scenario: A tied note does not slur across a transport seek (v4, REQ-14)
  Given a step tied into the next one is currently sounding
  When the playhead is seeked elsewhere
  Then the held note is released and prevTied is cleared on every track
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: Stopping the song ends a tied note instead of hanging it (v5, REQ-15, regression)
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

Scenario: Leaving the tab disarms Step Input (regression, REQ-5)
  Given the Sequencer tab is open and Step Input is armed
  When the user switches to the Arpeggiator tab and plays notes
  Then no step is written, and Step Input is no longer armed (LED dark)
  And returning to the Sequencer tab leaves it disarmed until re-armed
# pinned by: e2e/patterns.spec.ts

Scenario: Folding the pattern row disarms Step Input (edge, REQ-5)
  Given Step Input is armed on the visible Sequencer tab
  When the pattern row is collapsed with the fold chevron
  Then Step Input disarms, because its grid is no longer on screen
# pinned by: tests/ui/tabs.test.ts (isVisible/onViewChange), tests/ui/collapse-toggle.test.ts

Scenario: A song load disarms Step Input (edge, REQ-5)
  Given Step Input is armed
  When a song, demo or project import replaces the whole store (onBulkRestore)
  Then Step Input disarms — a fresh song never inherits an armed recorder
# pinned by: seq-panel patterns.onBulkRestore hook; tests/state/pattern-undo.test.ts (same hook)

Scenario: Arming pins the take to the visible bank (REQ-6)
  Given the transport plays an enabled seq chain and Follow is on
  When the user arms Step Input
  Then Follow turns off, so recorded notes cannot spray across banks as bars advance
  And disarming leaves Follow off for the user to re-enable
# pinned by: e2e/patterns.spec.ts, tests/ui/bank-bar.test.ts

Scenario: Transpose is applied before quantization, not after (v7, REQ-17)
  Given an active key and an arrangement slot that transposes +5
  When a step fires
  Then the note is transposed first and the sum is quantized into the key
  And reversing the order would leave the bar out of key
# pinned by: tests/audio/transport/sequencer.test.ts

Scenario: A chromatic key leaves every triggered note untouched (v7, REQ-17, back-compat)
  Given scale.type is 0
  When any step fires
  Then the note sounding is exactly the pre-v7 note
# pinned by: tests/audio/transport/sequencer.test.ts
```

## Tests & verification

- `tests/audio/transport/sequencer.test.ts`, `e2e/patterns.spec.ts`.
- Step Input scoping (REQ-5..7): `e2e/patterns.spec.ts` (the cross-tab regression +
  the bank pin), `tests/ui/tabs.test.ts` (`isVisible`/`onViewChange`),
  `tests/ui/collapse-toggle.test.ts` (`onChange`), `tests/ui/bank-bar.test.ts`
  (public `setFollowing`).
- `npm test` / `npm run e2e`.

## Open questions / future

- ~~Length is fixed at `SEQ_LENGTH` (16)~~ — answered by REQ-18 / [meter](meter.md).
  The bank shapes did **not** have to change: the grid is still 16 cells and only
  the played *window* moves, which is what kept [banks](banks.md), the validators
  and every shipped demo untouched.
