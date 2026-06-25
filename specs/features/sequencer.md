# Step sequencer (synth)

```yaml
id: sequencer
status: implemented
version: 1
owner: core
related:
  - architecture
  - transport
  - step-settings
  - banks
  - arrangement
source:
  - src/audio/transport/sequencer.ts
  - src/state/patterns.ts
  - src/audio/engine.ts
  - src/ui/panels/seq-panel.ts
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

## Requirements

- **REQ-1** — On each tick, trigger the synth for the active step of the current
  play bank, honouring velocity/gate/prob/ratchet/tie.
- **REQ-2** — Release the held note at `gateEnd`; `tie` holds the last ratchet
  sub-hit into the next step.
- **REQ-3** — `setMuted` stops triggering but keeps the playhead advancing and
  leaves live-keyboard play + the voice bus untouched.
- **REQ-4** — `seq.master` sets the voice-bus volume (default 1 — a no-op for
  existing presets).

## Technical design

### Contract / public interface

```yaml
StepSequencer:  # src/audio/transport/sequencer.ts
  setEnabled(on)
  setMuted(muted)        # DJ mute: stop triggering, keep advancing
  onStep(fn) / onSeqNote(fn) -> unsubscribe   # playhead + note viz
  # reads patterns.seqBank(arrangement.seqPlayBank) each tick via clock.onTick
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
```

## Tests & verification

- `tests/audio/transport/sequencer.test.ts`, `e2e/patterns.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- Length is fixed at `SEQ_LENGTH` (16); a variable length would touch the bank
  shapes in [banks](banks.md) and the bar math in [arrangement](arrangement.md).
