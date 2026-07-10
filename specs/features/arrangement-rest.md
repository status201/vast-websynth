# Arrangement rest slot ("empty bar")

```yaml
id: arrangement-rest
status: implemented
version: 1
owner: core
related:
  - architecture
  - arrangement
  - banks
  - song-mode
source:
  - src/state/patterns.ts                        # REST sentinel + clampChainStep
  - src/audio/transport/arrangement.ts           # rest-aware chain steps + *Resting flags
  - src/audio/transport/sequencer.ts             # resting guard (release tied voice)
  - src/audio/transport/drum-machine.ts          # resting guard
  - src/audio/transport/sampler-machine.ts       # resting guard
  - src/state/song-validate.ts                   # accept REST in chain steps
  - src/ui/components/rest-glyph.ts              # shared inline-SVG rest icon
  - src/ui/components/rest-overlay.ts            # machine-tab "resting" overlay
  - src/ui/panels/song-panel.ts                  # rest add-button + rest chip
  - src/ui/panels/seq-panel.ts                   # rest overlay wiring
  - src/ui/panels/drum-panel.ts                  # rest overlay wiring
  - src/ui/panels/sampler-panel.ts               # rest overlay wiring
```

A fifth arrangement-chain option that is **always an empty bar** ("rest"), so a
composer can make a lane sit out a bar without spending one of the four
[banks](banks.md). It exists only in the Song-tab [arrangement](arrangement.md)
builder.

## Background / Why

In Song mode each machine lane arranges just **4 banks (A B C D)**. The only way
to make a lane play nothing for a bar was to sacrifice a bank and fill it with an
empty pattern — leaving 3 usable banks. Expanding `BANK_COUNT` is out of scope (it
would enlarge every machine tab's `BankBar` and every bank array). Instead a rest
is a **sentinel value carried in the chain**, confined to the Song tab, so the four
banks stay fully usable and existing songs are unaffected.

## Requirements

- **REQ-1** — `PatternStore` exports `REST` (a sentinel `< 0`, distinct from any
  bank index) and `clampChainStep(i)` which returns `REST` when `i === REST` and
  otherwise clamps to `0..BANK_COUNT-1`. `clampBank` (edit/play-bank access) is
  unchanged — an *edit* bank can never be a rest.
- **REQ-2** — `Arrangement` chain steps may hold `REST`; `setSeqChain` /
  `setDrumChain` / `setSamplerChain` map incoming steps through `clampChainStep`
  (preserving `REST`), so `Song.apply` round-trips a rest.
- **REQ-3** — `Arrangement` exposes `seqResting` / `drumResting` / `samplerResting`
  booleans recomputed each bar in `recompute()`. A lane is resting **iff** it is
  enabled and its current chain step is `REST`. A disabled lane is never resting;
  when resting the lane's `*PlayBank` is a safe real index (0) that is never read
  for triggering.
- **REQ-4** — When a lane is resting, its machine (`StepSequencer` / `DrumMachine`
  / `SamplerMachine`) triggers nothing for that bar; the sequencer additionally
  releases any note tied into the rest. The transport clock advances normally
  (positions still step, the playhead still moves).
- **REQ-5** — The Song-tab chain builder has a rest add-button that appends `REST`
  and renders a `REST` chip with a rest glyph (`.rest` style, not a letter).
  Move / delete / clear operate on rest chips like any other slot.
- **REQ-6** — While a lane is resting, its machine tab (Seq / Drum / Sampler)
  overlays the step grid with a dimming backdrop + a large centered rest glyph; the
  overlay hides when the lane stops resting or its chain is disabled. The grid stays
  clickable underneath (overlay is `pointer-events: none`).
- **REQ-7** — A `REST` in a chain persists through save / load and passes import
  validation. Legacy songs (no `REST`) load unchanged; an older build that predates
  this feature clamps `REST` → bank A (graceful degradation, ADR-007).

## Technical design

### Contract / public interface

```yaml
patterns.ts:
  REST: number                       # sentinel, = -1
  clampChainStep(i: number): number  # REST passes through; else clampBank
Arrangement:                         # src/audio/transport/arrangement.ts
  seqResting / drumResting / samplerResting: boolean   # read by the machines + UI
  # set*Chain now map through clampChainStep; recompute() sets *Resting alongside *PlayBank
rest-glyph.ts:
  restIcon(): string                 # inline <svg>, colour via currentColor (like wave-icons.ts)
rest-overlay.ts:
  buildRestOverlay(api: StudioApi, lane: 'seq'|'drum'|'sampler'):
    { el: HTMLElement; refresh(): void }   # el placed over a position:relative grid wrapper
```

### Data shapes

The chain-step domain widens; the on-disk shape (`ChainData.steps: number[]`) is
unchanged, so no `SongFile.version` bump is needed.

```yaml
ChainData.steps: number[]   # each entry ∈ { REST(-1), 0, 1, 2, 3 }   (was 0..3)
```

Back-compat (ADR-007 additive rule): new builds may write `-1`; an older build
reading it clamps `-1` → `0` (plays bank A instead of a rest) — a graceful, silent
degradation, never a crash. `song-validate` accepts `REST` alongside `0..BANK_COUNT-1`.

### Layer touchpoints & ordering

```yaml
recompute (per bar): enabled lane -> raw = steps[pos]; if raw===REST { resting=true; playBank=0 }
                     else { resting=false; playBank=clampChainStep(raw) }
                     disabled lane -> resting=false; playBank = editBank   (unchanged)
machines: each onTick checks arrangement.<lane>Resting FIRST -> (seq releases tied voice) return
ui (song tab): buildChainLane add-row appends REST; renderStructure draws restIcon() + .rest chip
ui (machine tabs): step grid wrapped position:relative; buildRestOverlay(api, lane) appended;
                   refresh() driven by arrangement.onChange + the machine's onStep
persistence: Song.capture/apply + serialize.cloneChain copy steps verbatim (no change)
```

## Visual aids

```
Song tab chain:   [ A ][ 𝄽 ][ B ]      ← middle slot is a rest chip
Machine tab while that rest bar plays:
   [ step grid, dimmed ]
   [        𝄽         ]   ← centered glyph, grid still editable underneath
```

## Scenarios (BDD)

```gherkin
Scenario: A rest bar plays silence but the transport keeps moving
  Given seqChain = { enabled: true, steps: [0, REST, 1] }
  When the transport plays bar 2 (the rest slot)
  Then seqResting is true and the sequencer triggers no note that bar
  And on bar 3 seqResting is false and bank B plays
# pinned by: tests/audio/transport/arrangement.test.ts, tests/audio/transport/sequencer.test.ts

Scenario: clampChainStep preserves the rest sentinel
  Given a chain step value of REST
  Then clampChainStep(REST) === REST
  And clampChainStep(9) === BANK_COUNT - 1
# pinned by: tests/state/patterns.test.ts

Scenario: A rest round-trips through save/load and validation
  Given a song whose drumChain.steps contains REST
  When it is serialized and re-parsed via Song.fromJSON(Song.toJSON(song))
  Then the drumChain still contains REST and import validation passes
# pinned by: tests/state/song.test.ts, tests/state/song-validate.test.ts

Scenario: A disabled lane is never resting (edge)
  Given seqChain.enabled is false and steps contains REST
  Then seqResting is false and seqPlayBank follows the seq edit bank
# pinned by: tests/audio/transport/arrangement.test.ts

Scenario: The Song tab adds and shows a rest chip
  Given the Song tab is open
  When the user clicks the seq rest add-button
  Then a rest chip (.rest) is appended to the seq chain
# pinned by: e2e/arrangement-rest.spec.ts

Scenario: The machine tab shows the rest overlay while resting
  Given a seq chain [A, rest] is enabled and playing
  When the rest bar plays and the Seq tab is open
  Then the rest overlay is visible over the step grid
# pinned by: e2e/arrangement-rest.spec.ts
```

## Tests & verification

- Unit: `tests/state/patterns.test.ts`, `tests/audio/transport/arrangement.test.ts`,
  `tests/audio/transport/sequencer.test.ts` (+ drum/sampler),
  `tests/state/song.test.ts`, `tests/state/song-validate.test.ts` — `npm test`
- E2E: `e2e/arrangement-rest.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.engine.arrangement.seqResting` (DEV only)

## Open questions / future

- A rest currently applies per lane per bar. A global "all lanes rest" shortcut
  could be added later but is out of scope.
