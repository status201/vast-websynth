# LFO & mod wheel

```yaml
id: lfo
status: implemented
version: 1
owner: core
related:
  - architecture
  - ladder-filter
  - envelopes
source:
  - src/audio/lfo.ts
  - src/state/params.ts
  - src/audio/engine.ts
  - src/ui/app.ts
```

One global low-frequency oscillator with a selectable destination, plus a mod
wheel that adds into its depth.

## Background / Why

The LFO provides cyclic modulation (vibrato, tremolo, filter wobble). It is a
single engine-level node (not per-voice), routed to one destination at a time. The
**mod wheel** sums into the LFO amount so a performance gesture can bring modulation
in on top of the patched base amount — clamped to `[0, 1]` so it never overshoots.

## Requirements

- **REQ-1** — LFO has rate / amount / waveform / destination.
- **REQ-2** — Effective amount = `min(1, lfo.amount + master.modWheel)`; **both**
  `lfo.amount` and `master.modWheel` recompute it.
- **REQ-3** — Destination is one of the `LFO_DEST_LABELS` (range `0..4`).

## Technical design

### Data shapes (registry)

```yaml
lfo.rate:        { range: 0.05..20, default: 4, format: Hz }
lfo.amount:      { range: 0..1, default: 0 }            # no-op default
lfo.wave:        { discrete, labels: WAVE_LABELS, range: 0..3, default: 0 }
lfo.dest:        { discrete, labels: LFO_DEST_LABELS, range: 0..4, default: 0 }
master.modWheel: { range: 0..1, default: 0 }            # sums into lfo amount
```

### Layer touchpoints

```yaml
engine (subscribeParams):
  updateLfoAmount = () => lfo.setAmount(min(1, get('lfo.amount') + get('master.modWheel')))
  lfo.rate           -> this.lfo.setRate(x)
  lfo.amount         -> updateLfoAmount()
  lfo.wave           -> this.lfo.setWave(x)
  lfo.dest           -> this.lfo.setDest(x)
  master.modWheel    -> updateLfoAmount()
ui: src/ui/app.ts (LFO panel) + mod-wheel control
```

When the destination is the filter, modulation is additive in **semitones** —
the same invariant as [ladder-filter](ladder-filter.md) and [envelopes](envelopes.md).

## Scenarios (BDD)

```gherkin
Scenario: Mod wheel adds to the patched LFO amount
  Given lfo.amount is 0.3
  When the user raises master.modWheel to 0.5
  Then the effective LFO amount becomes 0.8 (0.3 + 0.5, clamped to 1)
# pinned by: tests/state/params.test.ts (subscription wiring)

Scenario: Amount is clamped at full (edge)
  Given lfo.amount is 0.8 and master.modWheel is 0.5
  Then the effective LFO amount is 1.0, not 1.3
# pinned by: tests/state/params.test.ts
```

## Tests & verification

- `tests/state/params.test.ts`, `e2e/controls.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- The LFO is monophonic/global by design; a per-voice LFO would be a separate
  feature with its own params.
