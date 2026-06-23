# Arrangement (chain lanes)

```yaml
id: arrangement
status: implemented
version: 1
owner: core
related:
  - architecture
  - transport
  - banks
  - song-mode
source:
  - src/audio/transport/arrangement.ts
  - src/state/patterns.ts
  - src/ui/panels/song-panel.ts
```

Three independent chain lanes (sequencer / drums / sampler) that sequence
[banks](banks.md) into a song, one bank per bar.

## Background / Why

A song is built by ordering banks: e.g. `A A B A` → `[0,0,1,0]`. Each machine has
its own lane, advancing one slot per bar so the three can have different lengths
and phrasings. The lane chooses the **play bank** the machine reads; a *disabled*
lane simply tracks that machine's UI edit bank (bar-quantised), so turning a chain
off falls back to live editing. It is constructed **before** the machines so its
tick listener settles the play banks first.

## Requirements

- **REQ-1** — Lanes `seq`/`drum`/`sampler`, each `{ enabled, steps: bankIndex[] }`.
- **REQ-2** — Advance one slot per bar (`step % SEQ_LENGTH === 0`); wrap on the
  lane length.
- **REQ-3** — A disabled lane's play bank follows that machine's edit bank.
- **REQ-4** — Reset positions on `clock.onStart`; the first bar plays slot 0.
- **REQ-5** — Constructed before the step machines so play banks are settled before
  the machines read them on the same tick.

## Technical design

### Contract / public interface

```yaml
Arrangement:  # src/audio/transport/arrangement.ts
  seq / drum / sampler: ChainLane { enabled, steps: number[] }
  seqPlayBank / drumPlayBank / samplerPlayBank: number   # read by the machines
  setSeqChain(steps, enabled) / setDrumChain(...) / setSamplerChain(...)
  onChange(fn) -> unsubscribe
  # subscribes clock.onStart (reset) + clock.onTick (advance per bar)
ChainLane: { enabled: boolean, steps: number[] }
```

### Layer touchpoints & ordering

```yaml
construction (engine): new Arrangement(patterns, clock) BEFORE
  new StepSequencer/DrumMachine/SamplerMachine
why: Arrangement.clock.onTick runs first -> *PlayBank settled before machines read
machines read: patterns.seqBank(arrangement.seqPlayBank) etc. each tick
bank clamp: clampBank -> 0..BANK_COUNT-1
ui: src/ui/panels/song-panel.ts buildChainLane(...) -> setSeqChain/ setDrumChain/ setSamplerChain
persistence: captured/applied as ChainData in the SongFile (see song-mode.md)
```

## Scenarios (BDD)

```gherkin
Scenario: A chain plays banks bar by bar
  Given seqChain = { enabled: true, steps: [0,0,1,0] }
  When the transport plays 4 bars from the top
  Then the seq play bank is A, A, B, A across the four bars
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: A disabled lane follows the edit bank (edge)
  Given drumChain.enabled is false and the user edits drum bank C
  Then drumPlayBank tracks C (bar-quantised)
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: Positions reset on start
  When the transport restarts
  Then every lane plays its slot 0 on the first bar
# pinned by: tests/audio/transport/arrangement.test.ts
```

## Tests & verification

- `tests/audio/transport/arrangement.test.ts`, `e2e/song.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- Lanes share one bar grid (`SEQ_LENGTH`); per-lane bar lengths would change the
  advance math.
