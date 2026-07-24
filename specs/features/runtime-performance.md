# Runtime performance

```yaml
id: runtime-performance
status: implemented
version: 1
owner: core
related:
  - architecture
  - performance-mode
  - ladder-filter
  - effects
  - motion-sequencer
  - session-autosave
  - step-settings
  - song-mode
source:
  - src/state/params.ts
  - src/state/song.ts
  - src/state/demos-index.json
  - src/audio/effects/reverb.ts
  - src/audio/effects/distortion.ts
  - src/audio/drive-curve.ts
  - src/audio/transport/drum-machine.ts
  - src/audio/transport/motion-machine.ts
  - src/audio/transport/motion-curve.ts
  - src/audio/transport/performance.ts
  - src/ui/components/knob.ts
  - src/ui/components/step-settings.ts
  - src/ui/panels/step-panel-scaffold.ts
  - src/ui/app.ts
  - scripts/clean-demos.ts
  - public/worklets/ladder-filter.js
```

The app-wide **cost contract**: the rules every feature obeys so the synth boots fast
and keeps the main thread out of the audio callback's way. Distinct from
[`performance-mode.md`](performance-mode.md), which is the user-facing quality *setting*
(how much cost the device opts into), and from [`performance.md`](performance.md), the
live DJ-FX module — three unrelated things sharing a word.

## Background / Why

This is a single-threaded audio app: the transport scheduler, every UI repaint and
every param write share one main thread with the `AudioContext`'s control path, and a
main-thread stall shows up as an audible glitch. Individual features were each locally
reasonable, but the costs compounded — boot parsed 835 kB of demo JSON and generated
2.65 M reverb-IR samples before the first frame; the motion sequencer's 60 fps writes
re-armed the autosave debounce so hard it **never fired**; nine stray `window`
pointer-move handlers ran on every mouse move anywhere on the page.

Each of those is an instance of a rule that was never written down. This spec writes
them down once, so the per-feature specs can reference it instead of restating it, and
so a reviewer has something concrete to hold a new feature against.

## Requirements

- **REQ-1 — Boot cost is proportional to what the user asked for.** Nothing whose size
  scales with *content* may be downloaded, parsed or generated eagerly at boot when the
  user will use at most one of it. Demo songs are fetched on click
  ([`song-mode.md`](song-mode.md)); reverb IRs are generated on first use of a size
  ([`effects.md`](effects.md)). Applies to bundle payload and to synchronous CPU alike.

- **REQ-2 — Expensive immutable artefacts are shared, not rebuilt per instance.** An
  artefact that is a pure function of its inputs and immutable in use (an
  `AudioBuffer` handed to a `ConvolverNode`, a `WaveShaperNode` curve) is cached by
  those inputs and shared across every consumer. The three FX chains share one IR bank.

- **REQ-3 — Global input listeners exist only for the duration of a gesture.** A
  component MUST NOT hold a `window`/`document` `pointermove` listener at rest. Attach
  on `pointerdown`, detach on `pointerup`/`pointercancel` and in `destroy()`.
  `Knob.onPointerDown`/`detachDragListeners` is the reference implementation; see
  [`add-a-ui-component.md`](../recipes/add-a-ui-component.md). Low-frequency global
  listeners (`keydown`, `click`, `visibilitychange`, `resize`) are exempt.

- **REQ-4 — No work for DOM that is not on screen.** `TabContainer` hides inactive
  panels with a class, so they stay live and subscribed. Any per-tick or per-bar repaint
  MUST be gated on visibility (`TabContainer.isVisible` via the panel's
  `VisibilityGate`) and MUST re-sync once on reveal, so a revealed panel shows the
  current state immediately rather than a stale one.

- **REQ-5 — Automation is not an edit.** A param write made by the machine
  (motion-sequencer automation, a Tape Stop pitch ramp) MUST fire the per-param
  listeners — knobs and the XY pad still track it — but MUST NOT reach
  `ParamBus.onChange`. That signal means "the user changed the sound", and it drives
  the autosave debounce and the preset dirty marker. A user gesture that happens to
  animate (the XY pad's spring-back) is an edit and stays on the normal path.

- **REQ-6 — No allocation in a per-frame or per-sample loop.** Loops that run at frame
  rate (`MotionMachine.frame`) or sample rate (worklet `process`) allocate nothing per
  iteration: hoist derived values out, cache pure derivations keyed by the state that
  produces them, and invalidate from the store's existing change streams.

- **REQ-7 — DOM writes are guarded on the rendered representation.** A repaint driven
  by a continuous value compares what it is about to *write* (a rounded angle, a
  formatted string) against the last written value and skips the unchanged ones —
  guarding each write independently so the DOM never lags the latest value.
  `Scope.mirrorPeak` and `StepButton.setViz` are the reference implementations.

- **REQ-8 — A worklet optimisation is bit-exact or it is a sound change.** Rewrites of
  per-sample DSP for speed MUST produce identical output for identical input (same
  operands, same order) and be pinned by an equivalence test. Anything that alters the
  output is a sound change and needs its own spec + ADR-010 justification.

## Technical design

### Contract / public interface

```ts
// state/params.ts — REQ-5. Per-param listeners still fire; onChange does not.
ParamBus.withoutChangeSignal(fn: () => void): void

// ui/panels/step-panel-scaffold.ts — REQ-4. One per machine panel.
class VisibilityGate {
  readonly shown: boolean;
  set(visible: boolean): void;     // driven by TabContainer.onViewChange
  whenShown(fn: () => void): () => void;  // re-sync hook, fires on hidden -> shown
}
```

`withoutChangeSignal` re-entrantly brackets the existing `suppressChange` counter that
`ParamBus.restore`/`resetDefaults` already use for bulk applies — the same idea ("this
is not a user edit"), now reachable by the audio layer. Callers on a per-frame path
pass a **pre-bound** closure rather than an inline arrow (REQ-6).

### Layer touchpoints & ordering

| Rule | Enforced at |
|---|---|
| REQ-1 | `state/song.ts` (`?url` demo glob + build-time index), `audio/effects/reverb.ts` |
| REQ-2 | `audio/effects/reverb.ts` (IR bank), `audio/effects/distortion.ts` + `audio/transport/drum-machine.ts` (drive curves) |
| REQ-3 | `ui/components/step-settings.ts`, `knob.ts`, `strip.ts`, `floating-window.ts` |
| REQ-4 | `ui/panels/step-panel-scaffold.ts` (`wirePlayhead`), the four machine panels, `ui/app.ts` |
| REQ-5 | `state/params.ts`, `audio/transport/motion-machine.ts`, `audio/transport/performance.ts` |
| REQ-6 | `audio/transport/motion-machine.ts`, `audio/transport/motion-curve.ts` |
| REQ-7 | `ui/components/knob.ts` |
| REQ-8 | `public/worklets/*.js` |

The `VisibilityGate` is created by each panel builder and returned on its
`MachinePanel`; `buildPatternRow` wires every gate from one `tabs.onViewChange`, which
already fires on both tab switches and folds. Panels are built *before* the
`TabContainer` exists, so the gate starts `shown` and is corrected on the first view
change — a panel can never be stuck dark.

## Scenarios (BDD)

```gherkin
Scenario: automation does not starve the session autosave
  Given the motion sequencer is enabled in slide mode with anchors
  And the transport is playing
  When the motion machine writes its params every frame
  Then ParamBus.onChange does not fire for those writes
  And the autosave debounce elapses and the session is written
  And the header preset selector stays clean (no dirty marker)
# pinned by: tests/state/session-autosave.test.ts, tests/audio/transport/motion-machine.test.ts

Scenario: a slider holds no global listener at rest
  Given the per-step settings editor is mounted
  When no pointer gesture is in progress
  Then no pointermove listener is registered on window by it
  And a pointerdown on the slider track attaches one, released on pointerup
# pinned by: tests/ui/step-settings.test.ts

Scenario: a hidden panel does no per-tick repaint
  Given the Drum Machine tab is not the active tab
  And the transport is playing
  Then the drum grid's playhead highlight is not updated on each tick
  When the Drum Machine tab is revealed
  Then the playhead shows the current step immediately
# pinned by: tests/ui/step-panel-scaffold.test.ts, e2e/patterns.spec.ts

Scenario: the reverb IR bank is shared and lazily built
  Given three FX chains each own a Reverb
  When the engine is constructed
  Then only the default IR duration has been generated, once, for all three
  When a reverb size is selected for the first time
  Then that IR is generated once and reused by every reverb thereafter
# pinned by: tests/audio/effects/reverb.test.ts

Scenario: a worklet speed rewrite changes no samples
  Given a block of noisy input and a swept cutoff
  When it is processed by the optimised recurrence
  Then every output sample is bit-identical to the reference recurrence
# pinned by: tests/audio/ladder-filter-worklet.test.ts
```

## Tests & verification

- Unit: `tests/state/session-autosave.test.ts`, `tests/audio/ladder-filter-worklet.test.ts`,
  `tests/audio/effects/reverb.test.ts`, `tests/ui/step-settings.test.ts` — `npm test`
- E2E: `e2e/session.spec.ts`, `e2e/motion.spec.ts`, `e2e/patterns.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Boot payload: `npm run build` — the entry + `demos` chunk sizes are the REQ-1 metric.
- Profiling: a DevTools Performance trace of boot (REQ-1/REQ-2) and a 10 s trace of a
  motion-heavy demo playing (REQ-5/REQ-6/REQ-7 — watch the GC sawtooth).

## Open questions / future

- REQ-3 has no automated repo-wide gate; a lint rule banning constructor-scope
  `window.addEventListener('pointermove', …)` would make it self-enforcing.
- The oscillators of a fully idle voice still run (only the ladder filter is
  idle-gated). Gating them would need a per-voice start/stop model — worth measuring
  before attempting.
