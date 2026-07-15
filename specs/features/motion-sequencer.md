# Motion sequencer (XY Pad automation machine)

```yaml
id: motion-sequencer
status: implemented
version: 1
owner: core
related:
  - xy-pad
  - arrangement
  - song-mode
  - banks
  - song-authoring-dialect
source:
  - src/audio/transport/motion-curve.ts     # pure anchor/interpolation math
  - src/audio/transport/motion-machine.ts   # transport-driven param writer
  - src/audio/transport/arrangement.ts      # 4th chain lane
  - src/state/patterns.ts                   # motion banks + per-bank assigns
  - src/utils/taper.ts                      # norm<->value mapping (extracted from ui)
  - src/ui/panels/motion-panel.ts
  - src/ui/components/motion-step-pad.ts
  - src/state/song.ts                       # SongFile v4 fields
  - src/state/song-author.ts                # dialect `motion` key
```

## Background / Why

Songs vary notes and hits over time (banks + chains) but every *parameter* is static —
no filter sweeps, no delay throws, no per-bar sound scenes. Motion is a 4th machine
(16 steps × 4 banks, like the others) whose steps hold optional **XY coordinates**;
during playback it drives the two params assigned to the XY Pad through those
coordinates. "Motion sequencing" is the established hardware term (Korg Electribe).
The tab sits between Sampler and Song.

## Requirements

- **REQ-1** — A Motion step is an optional anchor `{ on, x, y }`, x/y **normalized
  0..1** in taper space (the XY Pad surface's space). Dead step = `{on:false}`.
  4 banks (A–D) × 16 steps, stored in `PatternStore` beside the other machines.
- **REQ-2** — Set steps are **anchors**. In **Slide** mode the driven value ramps
  linearly between consecutive anchors, *across* unset gaps, wrapping last→first
  anchor over the bar boundary (within the current play bank). In **Step** mode the
  value jumps at each anchor's tick and holds. Mode = `motion.slide` param
  (0=step, 1=slide, default 1); it persists in songs/presets like any param.
- **REQ-3** — A bank with **zero anchors writes nothing** (params stay put). This is
  the "no automation" state: to localize a one-step peak the user anchors the
  neighbouring steps at the base value.
- **REQ-4** — The driven params are the XY Pad's assignment (`XyPadStore`), resolved
  **per play bank, per axis**: a bank may carry an optional override
  `MotionAssign = { x?: string; y?: string } | null`; each unset axis falls back to
  `xyStore.get()` (which itself defaults to `XY_DEFAULT_ASSIGN`). Norm→value mapping
  is taper-correct via `fromNorm(def, n)` (`src/utils/taper.ts`).
- **REQ-5** — Writes go through `bus.set` (generic path; knobs and the XY-pad dot
  track automatically). **Baseline discipline**: the machine records a param's value
  the first time it writes it in a play session (`Map<paramId, baseline>`) and
  restores *all* recorded baselines on transport stop and on `motion.on → 0`. It
  never subscribes to the params it writes (no feedback loop).
- **REQ-6** — Motion has the 4th `Arrangement` chain lane (`motionPlayBank`,
  `motionResting`, `setMotionChain`); it respects rests (no writes) and a disabled
  lane follows the edit bank. It is **not** an audio lane: excluded from
  `LaneId`/`LaneMixer`/`audibleLanes`; its Song-panel card is chain-only (no
  mute/solo/volume).
- **REQ-7** — Both modes evaluate on **one rAF frame loop** (active only while
  playing ∧ enabled, throttled to the perf-tier fps) against the **audio clock's
  now** — clock ticks arrive with `when` scheduled ahead, so tick-time writes would
  run early relative to the heard step. Slide moves every frame; step mode's curve
  only changes value at anchor boundaries and `bus.set` early-returns unchanged
  values, so its idle frames cost nothing. The pure curve math is
  `motion-curve.ts` (`valueAt(bank, barPos, mode)`), fully unit-testable.
- **REQ-8** — UI: each step is a **mini XY pad** square — drag sets `(x,y)` in one
  gesture, double-click/double-tap clears; the dot sits at the literal coordinate.
  An SVG polyline overlay connects the **selected axis** across the 16 squares
  (view toggle Y/X, default Y — a local view state, not a param; dots never move).
  Header: `motion.on` switch, Slide/Step segmented, view toggle, BankBar
  (`bank-motion-*`), and an axes row showing the edit bank's *effective* assignment
  with override dropdowns + an inherit/reset button.
- **REQ-9** — SongFile **v4** adds optional `motionBanks` (4×16 `MotionStep`),
  `motionAssigns` (4 × `MotionAssign|null`) and `motionChain` (`ChainData`) —
  additive per ADR-007; old files load with empty motion state. Export is
  default-sparse (dead step → `{on:false}`, x/y rounded to 4 sig-figs, ADR-011).
  The authoring dialect gains a `motion` key (anchor lists per bank, optionally
  `{assign, steps}`) + `motionChain`; both public schemas and the authoring guide
  document it; `motion.on` auto-enables when anchors are present.
- **REQ-10** — Restore/`apply` spreads defaults under incoming cells so sparse and
  legacy files sound identical (mirrors the other machines).

## Technical design

### Contract / public interface

- `MotionMachine` (`src/audio/transport/motion-machine.ts`):
  `setEnabled(on)`, `setSlide(on)`, `onStep(cb)` (playhead), `stop()` restore hook
  via `clock.onStop`. Constructed by `Engine.init()` after the sampler (Arrangement
  first, as for all machines); exposed on `StudioApi` as `motion`.
- `motion-curve.ts` (pure): `anchorIndices(bank)`, `valueAt(bank, barPos, mode)
  → {x,y} | null` — all interpolation/wrap math, no AudioContext.
- `PatternStore`: `motionEditBank`, `motion`, `motionBank(i)`, `setMotionEditBank`,
  `setMotionStep(step, cell)`, `copyMotionBank(from,to)`, `motionAssign(i)`,
  `setMotionAssign(i, a|null)`, `onMotionChange`, `onMotionBankChange`.
- `Arrangement`: `motionPlayBank`, `motionResting`, `setMotionChain(steps, enabled)`,
  `motionChainPos`.
- `src/utils/taper.ts`: `toNorm(def, v)`, `fromNorm(def, n)` — moved out of
  `ui/components/taper.ts` (which re-exports) so the audio layer can map
  taper-correctly without importing UI code.

### Data shapes

```yaml
MotionStep:
  on: boolean
  x: number   # 0..1 normalized (taper space)
  y: number   # 0..1
MotionAssign:        # per-bank override, each axis optional
  x: string | absent # ParamBus id
  y: string | absent
SongFile v4 (additive):
  motionBanks: MotionStep[4][16] | absent
  motionAssigns: (MotionAssign | null)[4] | absent
  motionChain: ChainData | absent
Author dialect:
  motion: [ MotionBank, ... up to 4 ]
  # MotionBank = [ {step, x, y}, ... ]  |  { assign?: {x?, y?}, steps: [ {step,x,y}, ... ] }
  motionChain: Chain
```

### Layer touchpoints & ordering

- `main.ts` creates `XyPadStore` and now passes it into `Engine.init()` (previously
  UI-only) so `MotionMachine` can resolve assignments; the same instance still flows
  to the UI (song-panel capture/apply is unchanged).
- Engine construction order unchanged: Arrangement → Performance → machines; Motion
  is created after the sampler. Engine subscribes `motion.on` → `setEnabled`,
  `motion.slide` → `setSlide`.
- The Song panel's Motion card reuses `buildChainLane` with a `{ mixer: false }`
  opt (chain + enable only).

### Persistence

- Song: the v4 fields above; save slots/share links/project zips pass them through
  (opaque). Presets are untouched (motion state is pattern data, not params —
  except `motion.on`/`motion.slide`, which are ordinary params).
- Deliberately NOT persisted: the Y/X view toggle (local UI state), the baseline
  map (runtime-only).

## Scenarios (BDD)

```gherkin
Scenario: A one-bar cutoff sweep (slide)
  Given the XY Pad assigns x=filter.resonance, y=filter.cutoff
  And motion bank A has anchors step0 y=0, step8 y=1, step15 y=0 and slide mode
  When the transport plays bar after bar
  Then filter.cutoff ramps min→max→min continuously each bar
# pinned by: tests/audio/transport/motion-curve.test.ts, tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: Step mode jumps and holds
  Given anchors at steps 0 and 8 and step mode
  When the bar plays
  Then the param jumps at step 0, holds, jumps at step 8, holds
# pinned by: tests/audio/transport/motion-curve.test.ts

Scenario: Empty bank writes nothing
  Given the play bank has no anchors
  When the transport runs
  Then the assigned params never change
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: Baselines restore on stop
  Given motion drove filter.cutoff away from its saved value
  When the transport stops
  Then filter.cutoff returns to its pre-play value
# pinned by: tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: Per-bank assignment override with fallback
  Given bank B overrides x=fx.delay.time and leaves y unset
  When the chain reaches bank B
  Then motion writes fx.delay.time for x and the XY Pad's y param for y
# pinned by: tests/audio/transport/motion-machine.test.ts

Scenario: Old songs load unchanged
  Given a v1/v2/v3 SongFile without motion fields
  When it is applied
  Then motion banks are empty, the chain is disabled and nothing is written
# pinned by: tests/state/song-validate.test.ts, tests/state/song.test.ts

Scenario: Dialect motion bank expands
  Given an author song with motion anchors and a per-bank assign
  When expandAuthorSong runs
  Then a canonical v4 file with motionBanks/motionAssigns and motion.on=1 results
# pinned by: tests/state/song-author.test.ts
```

## Tests & verification

- Unit: `tests/audio/transport/motion-curve.test.ts`,
  `tests/audio/transport/motion-machine.test.ts`, `tests/audio/transport/arrangement.test.ts`,
  `tests/state/{patterns,song-validate,serialize,song-author,authoring-docs}.test.ts`,
  `tests/ui/motion-step-pad.test.ts` — `npm test`
- E2E: `e2e/motion.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.bus.get('<assigned id>')` while playing.

## Pitfalls (documented behaviour)

- Saving a song/preset **while playing** captures the momentary automated values
  (same as saving mid-knob-drag); stop first for the baseline sound.
- Dragging an automated knob mid-play: motion wins on its next write.
- Assigning `transport.bpm` is allowed (tempo automation); slave-sync gating already
  prevents clock conflicts.
- When the chain leaves a bank whose override drove other params, those params hold
  their last written value until stop (then baselines restore).

## Open questions / future

- Cross-bar interpolation toward the *next* bank's first anchor (v1 wraps within the
  current bank).
- More than two axes / free per-step param choice (would decouple from the XY Pad).
