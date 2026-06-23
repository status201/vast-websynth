# Per-step settings & hit math (shared)

```yaml
id: step-settings
status: implemented
version: 1
owner: core
related:
  - architecture
  - sequencer
  - drum-machine
  - sampler
source:
  - src/audio/transport/step-hits.ts     # pure hit math
  - src/state/patterns.ts                # StepSettings shapes + defaults
  - src/audio/drums/drum-synths.ts       # chokeRoute (one-shot choke)
  - src/ui/components/step-settings.ts    # shared edit-row UI
```

The velocity/gate/prob/ratchet/tie model and the pure hit math shared by all three
step machines ([sequencer](sequencer.md), [drum machine](drum-machine.md),
[sampler](sampler.md)).

## Background / Why

Putting the per-step expressive controls and the probability/ratchet math in **one
pure module** means the three machines stay consistent and the tricky timing is
unit-testable without an `AudioContext`. The seq and the one-shot machines differ
only in how they *end* a hit: the sequencer releases its voice at `gateEnd`; the
one-shot machines use the **choke model** (a downstream gain cut), so the envelope
already scheduled inside the hit is never disturbed.

## Requirements

- **REQ-1** — Every step carries `velocity, gate, prob, ratchet, tie`.
- **REQ-2** — `prob < 1` rolls per pass (`rollProb`); `ratchet` 1..4 evenly
  subdivides the step (`stepHits`).
- **REQ-3** — Seq: release the voice at `gateEnd`. One-shot: `gate < 1` cuts the
  hit at `gateEnd` via a downstream gain (`chokeAt`/`chokeRoute`); `gate == 1` is
  natural decay; `tie` on the last sub-hit rings into the next step (`holds`).
- **REQ-4** — Defaults (`TRIGGER_CELL_DEFAULTS`) make a plain `{on}` cell behave as
  before per-step settings existed (`gate 1`, `prob 1`, `ratchet 1`, `tie false`).

## Technical design

### Contract / public interface (pure)

```yaml
step-hits.ts:
  StepHit: { t: number, gateEnd: number, holds: boolean }
  rollProb(prob, rng = Math.random): boolean         # true = fire this pass
  stepHits(s: {gate,ratchet,tie}, when, stepDur): StepHit[]
  chokeAt(s: {gate}, hit): number | undefined        # cut time, or undefined
drum-synths.ts:
  chokeRoute(ctx, output, chokeAt?): { dest, stopAt }  # downstream choke gain
```

### Data shapes

```yaml
StepSettings: { velocity, gate, prob, ratchet, tie }
SeqStep:      StepSettings + { on, note }
TriggerCell:  StepSettings + { on }       # DrumCell / SamplerStep
TRIGGER_CELL_DEFAULTS: { on:false, velocity:.., gate:1, prob:1, ratchet:1, tie:false }
```

### Layer touchpoints

```yaml
consumers: sequencer.ts, drum-machine.ts, sampler-machine.ts all import step-hits
ui: src/ui/components/step-settings.ts (StepSettingsEditor) — shared edit row;
    each panel owns its own selection cursor. Step buttons visualise settings via
    StepButton.setViz() (gate width, velocity brightness, ratchet ticks, tie/prob).
migration: PatternStore.restore spreads TRIGGER_CELL_DEFAULTS UNDER incoming cells
    so legacy {on, velocity} cells gain the new fields (see song-mode.md)
```

## Scenarios (BDD)

```gherkin
Scenario: Ratchet subdivides a step into evenly spaced hits
  Given a step with ratchet 4 over stepDur d
  Then stepHits returns 4 hits at when + r*(d/4)
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: Probability gates a step (edge)
  Given prob 0.5 and an rng returning 0.7
  Then rollProb returns false and the step is skipped this pass
# pinned by: tests/audio/transport/step-hits.test.ts

Scenario: gate 1 means no choke, gate < 1 cuts early
  Given a one-shot hit with gate 1 -> chokeAt returns undefined (natural decay)
  And a hit with gate 0.5 and no tie -> chokeAt returns gateEnd
# pinned by: tests/audio/transport/step-hits.test.ts
```

## Tests & verification

- `tests/audio/transport/step-hits.test.ts` (pure), `tests/ui/step-button.test.ts`
  (viz), `e2e/patterns.spec.ts` (grid + viz + clock advance).
- `npm test` / `npm run e2e`.

## Open questions / future

- New per-step fields go in `StepSettings` + `TRIGGER_CELL_DEFAULTS`; the
  defaults-spread-under migration keeps old songs valid.
