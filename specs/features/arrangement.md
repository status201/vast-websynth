# Arrangement (chain lanes)

```yaml
id: arrangement
status: implemented
version: 3
owner: core
related:
  - architecture
  - transport
  - banks
  - song-mode
  - arrangement-rest
  - midi-clock-sync
source:
  - src/audio/transport/arrangement.ts
  - src/state/patterns.ts
  - src/ui/panels/song-panel.ts
```

Four independent chain lanes (sequencer / drums / sampler / motion) that sequence
[banks](banks.md) into a song, one bank per bar. The motion lane drives the
[motion sequencer](motion-sequencer.md) (param automation, not audio) and behaves
identically to the audio lanes here.

## Background / Why

A song is built by ordering banks: e.g. `A A B A` → `[0,0,1,0]`. Each machine has
its own lane, advancing one slot per bar so the three can have different lengths
and phrasings. The lane chooses the **play bank** the machine reads; a *disabled*
lane simply tracks that machine's UI edit bank (bar-quantised), so turning a chain
off falls back to live editing. It is constructed **before** the machines so its
tick listener settles the play banks first.

## Requirements

- **REQ-1** — Lanes `seq`/`drum`/`sampler`/`motion`, each `{ enabled, steps: bankIndex[] }`.
- **REQ-2** — Advance one slot per bar (`step % SEQ_LENGTH === 0`); wrap on the
  lane length.
- **REQ-3** — A disabled lane's play bank follows that machine's edit bank.
- **REQ-4** (v3) — On `clock.onStart`, **seek** each lane to the bar implied by
  `clock.step` rather than always zeroing: `bar = floor(clock.step /
  SEQ_LENGTH)`, `pos = enabled && steps.length ? bar % steps.length : 0`, and
  `expectFirstBar = clock.step % SEQ_LENGTH === 0` (so a bar-aligned start
  suppresses the first boundary's increment, and a mid-bar start lets the next
  boundary — genuinely the next bar — increment). The `expectFirstBar` branch in
  `onTick` no longer re-zeros positions (onStart already set them). With a plain
  `start()` (`clock.step === 0`) this is **bit-identical to v2**: bar 0, pos 0,
  first bar plays slot 0. The nonzero case supports MIDI/WiFi clock-sync's
  Song-Position seek ([midi-clock-sync.md](midi-clock-sync.md) REQ-10). The
  Arrangement stores its ctor's `clock` to read `clock.step` in `onStart`.
- **REQ-5** — Constructed before the step machines so play banks are settled before
  the machines read them on the same tick.
- **REQ-6** — A chain step may be the `REST` sentinel (an always-empty bar); an
  enabled lane whose current step is `REST` exposes `*Resting = true` and its machine
  plays silence for that bar. See [arrangement-rest.md](arrangement-rest.md).

## Technical design

### Contract / public interface

```yaml
Arrangement:  # src/audio/transport/arrangement.ts
  seq / drum / sampler / motion: ChainLane { enabled, steps: number[] }
  seqPlayBank / drumPlayBank / samplerPlayBank / motionPlayBank: number   # read by the machines
  seqResting / drumResting / samplerResting / motionResting: boolean      # rest slot -> silence (arrangement-rest.md)
  setSeqChain(steps, enabled) / setDrumChain(...) / setSamplerChain(...) / setMotionChain(...)
  onChange(fn) -> unsubscribe
  # subscribes clock.onStart (reset) + clock.onTick (advance per bar)
ChainLane: { enabled: boolean, steps: number[] }   # steps ∈ { REST, 0..BANK_COUNT-1 }
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

Scenario: Positions reset on a plain start (v3 regression)
  When the transport restarts from step 0
  Then every lane plays its slot 0 on the first bar (bit-identical to v2)
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: A nonzero start seeks to the implied bar (v3)
  Given seqChain = { enabled: true, steps: [0,1,2] }
  When the clock starts from a bar-aligned nonzero step (bar 2)
  Then the seq lane plays slot 2 immediately and advances to slot 0 (wrap) next bar
  And a mid-bar nonzero start seeks to that bar and increments on the next boundary
# pinned by: tests/audio/transport/arrangement.test.ts
```

## Tests & verification

- `tests/audio/transport/arrangement.test.ts`, `e2e/song.spec.ts`.
- `npm test` / `npm run e2e`.

## Open questions / future

- Lanes share one bar grid (`SEQ_LENGTH`); per-lane bar lengths would change the
  advance math.
