# Step sequencer (synth)

```yaml
id: sequencer
status: implemented
version: 2
owner: core
related:
  - architecture
  - transport
  - step-settings
  - banks
  - arrangement
  - input-control
source:
  - src/audio/transport/sequencer.ts
  - src/state/patterns.ts
  - src/audio/engine.ts
  - src/ui/panels/seq-panel.ts
  - src/ui/app.ts                        # ties the arm to tab visibility (REQ-5)
  - src/ui/components/tabs.ts            # isVisible / onViewChange (REQ-5)
  - src/ui/components/collapse-toggle.ts # onChange, so a fold is a view change (REQ-5)
  - src/ui/components/bank-bar.ts        # setFollowing — the take is bank-pinned (REQ-6)
```

The monophonic 16-step note sequencer that drives the synth voice on each active
step.

## Background / Why

A bread-and-butter step sequencer: 16 steps, each with a note and the shared
[per-step settings](step-settings.md). It reads the **play bank** the
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

## Technical design

### Contract / public interface

```yaml
StepSequencer:  # src/audio/transport/sequencer.ts
  setEnabled(on)
  setMuted(muted)        # DJ mute: stop triggering, keep advancing
  onStep(fn) / onSeqNote(fn) -> unsubscribe   # playhead + note viz
  # reads patterns.seqBank(arrangement.seqPlayBank) each tick via clock.onTick

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

Scenario: DJ mute stops notes but the playhead keeps moving (edge)
  Given the sequencer is muted via the lane mixer
  Then no sequenced notes sound, the playhead still advances, and live keys still play
# pinned by: tests/audio/transport/sequencer.test.ts, e2e/song-mixer.spec.ts

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
```

## Tests & verification

- `tests/audio/transport/sequencer.test.ts`, `e2e/patterns.spec.ts`.
- Step Input scoping (REQ-5..7): `e2e/patterns.spec.ts` (the cross-tab regression +
  the bank pin), `tests/ui/tabs.test.ts` (`isVisible`/`onViewChange`),
  `tests/ui/collapse-toggle.test.ts` (`onChange`), `tests/ui/bank-bar.test.ts`
  (public `setFollowing`).
- `npm test` / `npm run e2e`.

## Open questions / future

- Length is fixed at `SEQ_LENGTH` (16); a variable length would touch the bank
  shapes in [banks](banks.md) and the bar math in [arrangement](arrangement.md).
