# Runtime performance

```yaml
id: runtime-performance
status: implemented
version: 8   # v8: REQ-4 — a folded section counts as off screen (scratch.md)
             # v7: REQ-1 — the time-stretch DSP defers behind the FIT button
             # v6: REQ-1 — deferring a surface makes its load fallible; the
             #     trigger owes the user a report when the import rejects
             # v5: REQ-2 — a bank of expensive artefacts is built per entry on
             #     first use, not whole; the PWM duty bank charged every patch
             #     ~86 MB of native memory for the one wave it actually used
             # v4: REQ-10 — no viewport-scaled compositing effect on a persistent
             #     overlay; the modal backdrop's blur cost a third of the frame
             #     rate whenever any dialog was open
             # v3: REQ-1 — the onboarding layer and the Help & About modal load
             #     on demand; the eager button factory and the late-bound Debug
             #     setters split out so nothing drags the bodies back in
             # v2: visibility gating is for pixels, not for sound (REQ-9);
             #     REQ-4 scoped explicitly to repaints
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
  - transport            # REQ-9 — the worker-timer guarantee it generalises
  - oscillators          # REQ-2 — the PWM duty bank, the worked example
  - lazy-load-failure    # REQ-1 — what a deferred surface says when its load fails
  - scratch              # REQ-4 — a folded section counts as off screen
source:
  - src/state/params.ts
  - src/state/song.ts
  - src/state/demos-index.json
  - src/audio/effects/reverb.ts
  - src/audio/effects/distortion.ts
  - src/audio/drive-curve.ts
  - src/audio/oscillator.ts                 # REQ-2 — the PWM duty bank, per-entry
  - src/audio/transport/drum-machine.ts
  - src/audio/transport/motion-machine.ts
  - src/audio/transport/motion-curve.ts
  - src/audio/transport/performance.ts
  - src/audio/transport/tick-timer.ts        # the worker-backed wakeup REQ-9 mandates
  - src/ui/components/knob.ts
  - src/ui/components/step-settings.ts
  - src/ui/panels/step-panel-scaffold.ts
  - src/ui/app.ts
  - src/main.ts                             # REQ-1 — the idle warms (lamejs,
                                            #         onboarding, About)
  - src/ui/onboarding/index.ts              # REQ-1 — the synchronous facade
  - src/ui/onboarding/onboarding-impl.ts    # REQ-1 — the lazy body behind it
  - src/ui/components/about-button.ts       # REQ-1 — eager factory, lazy modal body
  - src/state/debug-sources.ts              # REQ-1 — late-bound rows, so main.ts
                                            #         never imports the modal
  - src/ui/styles/modal.module.css          # REQ-10 — the shared .backdrop
  - src/ui/styles/tour.module.css           # REQ-10 — the tour's centred steps
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

- **REQ-1** — **Boot cost is proportional to what the user asked for.** Nothing whose size
  scales with *content* may be downloaded, parsed or generated eagerly at boot when the
  user will use at most one of it. Demo songs are fetched on click
  ([`song-mode.md`](song-mode.md)); reverb IRs are generated on first use of a size
  ([`effects.md`](effects.md)). Applies to bundle payload and to synchronous CPU alike.

  **A surface reached only by a deliberate click is loaded by that click.** A modal the
  player may never open still costs every visitor its parse time when it is imported
  statically, and the instrument is playable without any of them. So the on-demand
  surfaces are behind `import()` at their trigger: the sample recorder/editor, the
  preset manager, the audio-export dialog, the WiFi pair modal (which also defers
  `jsqr`), the MP3 encoder (`lamejs`), the authoring-guide prompt text behind the
  AI Prompt button, the time-stretch DSP behind a slot row's FIT button
  ([time-stretch](time-stretch.md) REQ-11), and the Help & About modal. The onboarding layer — the tour, the
  info badges and the ~54 kB of help copy they read — loads on the first `startTour()`
  or badge toggle, behind the synchronous `Onboarding` facade so no caller learns that
  it is lazy.

  A **synchronous facade over a lazy body** is the pattern wherever callers already
  hold the surface at boot. `Onboarding`'s five methods keep their exact signatures:
  the two commands (`startTour`, `toggleInfoBadges`) return `void` and start the load
  internally, and the two readers answer from facade-held state — `shouldAutoLaunch()`
  reads only `localStorage`, and `isInfoBadgesActive()` is `false` until the body
  exists, which is not an approximation because the badges cannot be showing before
  they are loaded. Unlike the on-demand modals, the facade **memoizes its import
  promise**: those modals re-`import()` freely because opening one twice is
  idempotent, whereas resolving this one *constructs state*, and two triggers (the ⓘ
  button and the `?` key) must not build two `InfoBadges`.

  The rule is about *reachability, not size*: a small module on a click path is fine to
  defer, and a large one on the boot path (the engine, the panels) is not deferrable at
  all. Where a heavy module also exports the **button** that opens it, the button
  factory moves to its own module so the body stays behind the click — importing a
  factory eagerly to get a lazy body defeats the split. About is the worked example:
  `about-button.ts` keeps the factory and the open/close lifecycle and `import()`s
  `about-modal.ts` on the click, while the three late-bound Debug row setters that
  `main.ts` calls at boot move to `state/debug-sources.ts`. **Both** edges had to go —
  cutting only the button would have left `main.ts` holding the modal in the entry
  chunk. A deferred surface the user can reach *offline* is warmed on idle
  ([`pwa-install.md`](pwa-install.md) REQ-6).

  **Deferring makes a surface's load fallible, and that cost is the trigger's to pay**
  (v6). A static import cannot fail after boot; an `import()` can, and the default —
  `void open()` on a click handler — turns that failure into a control that does
  nothing, which reads as a broken app rather than a missing chunk. So a trigger added
  under this REQ is not finished until it also handles the rejection: the failure
  path, its wording and its retry rule are
  [`lazy-load-failure.md`](lazy-load-failure.md), which every deferred surface in the
  app now routes through. (A *warm* is the exception that proves it — it swallows its
  error precisely because it is not a gesture.)

  **The gate is `npm run build`:** the entry chunk stays under Vite's 500 kB warning
  threshold, and the warning firing is the signal that something joined the boot path
  that should not have.

- **REQ-2** — **Expensive immutable artefacts are shared, not rebuilt per instance.** An
  artefact that is a pure function of its inputs and immutable in use (an
  `AudioBuffer` handed to a `ConvolverNode`, a `WaveShaperNode` curve) is cached by
  those inputs and shared across every consumer. The three FX chains share one IR bank.

  **Sharing is half the rule; the other half is *when*** (v5). Where such artefacts
  form a **bank** — a set indexed by a discrete control — the entry is built **on
  first use of that index**, never the bank on first use of any index. `reverb.ts`'s
  `irFor` is the reference: five IR durations exist, and only the size actually
  selected is ever generated.

  A bank built eagerly charges every patch for the whole index space, and the bill
  scales with the *resolution* of a control rather than with what the player
  touched. The PWM duty bank ([`oscillators.md`](oscillators.md) REQ-6b) is the
  worked example: 128 `PeriodicWave`s at ~670 KB of native memory each cost **~86 MB
  in one synchronous burst** the first time any width left `0.5` — for a patch that
  typically needs *one* of them.

  Two properties make this class of cost worth its own sentence in the rule:
  - It hides from the usual tools. Blink's wave tables, a `ConvolverNode`'s
    internal FFT state and decoded `AudioBuffer`s are **native**, so they never
    appear in a JS heap snapshot and the JS heap does not move. A tab's total
    memory is the only place they show.
  - It is not reachable by the other rules here. REQ-1 governs the boot path and
    REQ-6 governs loops; a bank built lazily-but-wholly on a mid-session gesture
    is outside both, and was the gap this rule now closes.

  **Building lazily is the whole of the rule — nothing is released again.** Once a
  shared artefact exists it is kept for the session, because reacquiring it is
  synchronous main-thread work: a `ConvolverNode` kernel costs 7.7–42 ms to
  rebuild, which is an audible glitch if it lands on a user gesture mid-song.
  [ADR-018](../decisions/adr-018-audio-graph-memory-is-committed-not-reclaimed.md)
  records that trade — a bypassed effect gives back its CPU
  ([ADR-012](../decisions/adr-012-true-bypass-disconnects.md)), not its memory —
  and gives it back after one bounded **drain**, not instantly, since it has to
  render itself empty before it can be detached ([effects](effects.md) REQ-2c) —
  and answers any future "free it while it is off" proposal, including the ~30 MB
  of reverb kernels the three FX chains hold from boot.

  It also records the **measurement** rule learned alongside it: renderer
  working-set deltas during active audio are too noisy to attribute anything
  (28–205 MB spread for identical work). Isolated micro-benchmarks — one node
  type, one page — are the instrument; ablation on the running app is not.

- **REQ-3** — **Global input listeners exist only for the duration of a gesture.** A
  component MUST NOT hold a `window`/`document` `pointermove` listener at rest. Attach
  on `pointerdown`, detach on `pointerup`/`pointercancel` and in `destroy()`.
  `Knob.onPointerDown`/`detachDragListeners` is the reference implementation; see
  [`add-a-ui-component.md`](../recipes/add-a-ui-component.md). Low-frequency global
  listeners (`keydown`, `click`, `visibilitychange`, `resize`) are exempt.

- **REQ-4** — **No work for DOM that is not on screen.** `TabContainer` hides inactive
  panels with a class, so they stay live and subscribed. Any per-tick or per-bar repaint
  MUST be gated on visibility (`TabContainer.isVisible` via the panel's
  `VisibilityGate`) and MUST re-sync once on reveal, so a revealed panel shows the
  current state immediately rather than a stale one. The rule governs **repaints
  only** — see REQ-9 for the loops it must never be applied to.

  A **folded** section counts as off screen. The sample editor's scratch graph
  ([scratch](scratch.md) REQ-17) re-derives its source peaks from the selection,
  which a crop drag would otherwise pay for on every pointermove with the section
  closed; it is gated on the fold and re-synced from the collapse toggle's own
  change callback, which fires on reveal.

- **REQ-5** — **Automation is not an edit.** A param write made by the machine
  (motion-sequencer automation, a Tape Stop pitch ramp) MUST fire the per-param
  listeners — knobs and the XY pad still track it — but MUST NOT reach
  `ParamBus.onChange`. That signal means "the user changed the sound", and it drives
  the autosave debounce and the preset dirty marker. A user gesture that happens to
  animate (the XY pad's spring-back) is an edit and stays on the normal path.

- **REQ-6** — **No allocation in a per-frame or per-sample loop.** Loops that run at frame
  rate (`MotionMachine.frame`) or sample rate (worklet `process`) allocate nothing per
  iteration: hoist derived values out, cache pure derivations keyed by the state that
  produces them, and invalidate from the store's existing change streams.

  Where a helper's natural signature is to *return* a small record, the frame path gets
  a **fill-a-caller's-holder twin** beside it rather than a rewrite of the shared one:
  `motionAxesFor` → `motionAxesInto`, `valueAt` → `valueAtInto`, `XyPadStore.get` →
  `readAssignInto`. The returning form stays the default for every non-hot caller,
  because a shared mutable holder is a real aliasing hazard and worth paying an
  allocation to avoid **everywhere it is not measured to matter**. This is the same
  pattern `motionAxesMatch` already established as the non-allocating twin of
  `motionAxesFor`.

  The bar is the *loop*, not the object count. Frame and sample loops are held to zero
  because they are unbounded in time — the cost is per-iteration forever. A per-tick
  path (a 16th note, ~8 Hz) is **not** covered: `stepHits` allocates its sub-hit records
  per active lane per tick and is deliberately left alone, because the API change would
  push a shared mutable buffer through the one piece of hit math the sequencer, drum
  machine and sampler are required to agree on.

- **REQ-7** — **DOM writes are guarded on the rendered representation.** A repaint driven
  by a continuous value compares what it is about to *write* (a rounded angle, a
  formatted string) against the last written value and skips the unchanged ones —
  guarding each write independently so the DOM never lags the latest value.
  `Scope.mirrorPeak` and `StepButton.setViz` are the reference implementations.

- **REQ-8** — **A worklet optimisation is bit-exact or it is a sound change.** Rewrites of
  per-sample DSP for speed MUST produce identical output for identical input (same
  operands, same order) and be pinned by an equivalence test. Anything that alters the
  output is a sound change and needs its own spec + ADR-010 justification.

- **REQ-9** — **Visibility gating is for pixels, not for sound** (v2). A loop that only
  *draws* SHOULD stop while the document is hidden (`Scope` is the reference: it
  pauses its redraw on `visibilitychange`). A loop that changes **what is heard** MUST
  NOT — and therefore MUST NOT be driven by `requestAnimationFrame` alone, because
  browsers suspend rAF entirely for a hidden document. Such a loop drives itself from
  the worker-backed `TickTimer` (`audio/transport/tick-timer.ts`) while
  `document.hidden`, at the same rate it uses when visible; rAF may drive it only
  while visible, for the vsync alignment the knobs get for free. This is the same
  guarantee [`transport.md`](transport.md) REQ-4 gives the clock, generalised: the
  transport survived backgrounding while the motion sequencer — the one machine on a
  bare rAF loop — froze mid-sweep and left its params stuck until the tab came back.
  Deactivating on hide is doubly wrong for an automation loop: it would also have to
  decide what to do with the values it wrote, and restoring them is an audible jump.
  Gesture-scoped ramps (Tape Stop, the XY pad's spring-back) are exempt — they last
  well under a second with the user watching.

- **REQ-10** — **No compositing effect whose cost scales with the viewport may sit on a
  persistent overlay** (v4). A `backdrop-filter` on a full-screen, long-lived element
  makes the compositor re-render the whole viewport every frame for as long as it is
  mounted. Unlike every other rule here, that cost is **independent of what the overlay
  contains and of whether anything beneath it changed** — so it cannot be gated away by
  REQ-4's visibility rule or reduced by making the overlay's own contents cheaper.

  Measured on the shared modal backdrop, with a demo playing: **60 → 34 fps** under GPU
  compositing (103 of 138 frames over the 24 ms budget) and **60 → 4.5 fps** under
  software rasterization. A bare `<div>` carrying only
  `position: fixed; inset: 0; backdrop-filter: blur(2px)`, with no modal code loaded at
  all, reproduces it exactly; disabling every CSS animation and stopping the transport
  do not help. One declaration in `modal.module.css` was inherited by every `Modal`
  (confirms, preset manager, export, record-sound, WiFi pair), the About and AI-prompt
  modals and the start screen, with a second copy on the tour's centred steps — so the
  whole instrument ran at a third of its frame rate whenever any dialog was open, which
  is when the Debug panel's own cost gates (see [`debug-panel.md`](debug-panel.md)
  REQ-3/REQ-11) were being carefully paid for elsewhere in the same modal.

  The dim alone (`rgba(8, 6, 3, 0.82)`) is what separates the card from the faceplate;
  a 2 px blur behind 82 % opacity was buying almost no visible difference for that
  price. An overlay that genuinely needs one must be small, or transient and
  gesture-scoped — not the full viewport for as long as a dialog is open.

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
| REQ-1 | `state/song.ts` (`?url` demo glob + build-time index), `audio/effects/reverb.ts`, `ui/onboarding/index.ts` (facade → `onboarding-impl.ts`), `ui/components/about-button.ts` (→ `about-modal.ts`), `state/debug-sources.ts`, `main.ts` (idle warms); the rejection report is `lazy-load-failure.md` |
| REQ-2 | `audio/effects/reverb.ts` (IR bank), `audio/effects/distortion.ts` + `audio/transport/drum-machine.ts` (drive curves), `audio/oscillator.ts` (the PWM duty bank — per entry, v5) |
| REQ-3 | `ui/components/step-settings.ts`, `knob.ts`, `strip.ts`, `floating-window.ts` |
| REQ-4 | `ui/panels/step-panel-scaffold.ts` (`wirePlayhead`), the four machine panels, `ui/app.ts` |
| REQ-5 | `state/params.ts`, `audio/transport/motion-machine.ts`, `audio/transport/performance.ts` |
| REQ-6 | `audio/transport/motion-machine.ts`, `audio/transport/motion-curve.ts` (`valueAtInto`), `state/xy-effective.ts` (`motionAxesInto`/`motionAxesMatch`), `state/xy-pad.ts` (`readAssignInto`) |
| REQ-7 | `ui/components/knob.ts` |
| REQ-8 | `public/worklets/*.js` |
| REQ-9 | `audio/transport/motion-machine.ts` (worker timer while hidden), `ui/components/scope.ts` (pauses while hidden) |
| REQ-10 | `ui/styles/modal.module.css` (`.backdrop`), `ui/styles/tour.module.css` (`.centered`) — pinned repo-wide by `tests/ui/overlay-cost.test.ts` |

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

Scenario: a bank of artefacts is built per entry, not whole (REQ-2, v5, regression)
  Given no pulse width has been used yet
  When one width is selected
  Then exactly one PeriodicWave is built, not the whole duty bank
  # 128 entries x ~670 KB of native memory is ~86 MB, invisible to a heap snapshot
# pinned by: tests/audio/oscillator-pwm.test.ts

Scenario: an audio-affecting loop survives a hidden document (REQ-9, regression)
  Given the motion sequencer is enabled with anchors and the transport is playing
  When the document becomes hidden and rAF stops being delivered
  Then the loop is driven by the worker-backed timer at the same perf-tier fps
  And the automated params keep moving
  And no baseline is restored (nothing is deactivated)
  When the document becomes visible again
  Then the timer stops and rAF drives the loop again
# pinned by: tests/audio/transport/motion-machine.test.ts, e2e/motion.spec.ts

Scenario: the onboarding facade answers before its body is loaded
  Given a fresh page where nothing has started the tour or the badges
  When the header reads isInfoBadgesActive() and shouldAutoLaunch()
  Then both answer synchronously
  And no onboarding-impl module has been imported
# pinned by: tests/ui/onboarding-facade.test.ts

Scenario: two badge triggers share one lazily-loaded body
  Given the onboarding body has not loaded yet
  When the ⓘ button and the ? key both toggle the badges before it resolves
  Then exactly one InfoBadges instance is constructed
  And every onInfoBadgesChange subscriber sees each resulting state
# pinned by: tests/ui/onboarding-facade.test.ts

Scenario: opening About twice while the body loads builds one modal
  Given the About modal body has not loaded yet
  When the button is clicked twice before the import resolves
  Then one backdrop is created and appended
# pinned by: tests/ui/about.test.ts

Scenario: a deferred surface whose import rejects reports instead of doing nothing (v6, REQ-1)
  Given a trigger whose import() rejects (offline, chunk never cached)
  When the user activates it
  Then a toast names the surface and offers Retry
  And a memoizing trigger has dropped its cached rejection, so Retry can succeed
# pinned by: tests/ui/lazy-load-failure.test.ts
#            (behaviour spec'd in full at lazy-load-failure.md)

Scenario: an open dialog does not cost the app its frame rate (REQ-10, regression)
  Given the transport is playing
  When the About modal — or any other Modal, the tour's centred step, or the
    start screen — is open over the faceplate
  Then no overlay in the app declares a backdrop-filter
  And the app holds its frame rate for as long as the overlay is mounted
# pinned by: tests/ui/overlay-cost.test.ts

Scenario: a worklet speed rewrite changes no samples
  Given a block of noisy input and a swept cutoff
  When it is processed by the optimised recurrence
  Then every output sample is bit-identical to the reference recurrence
# pinned by: tests/audio/ladder-filter-worklet.test.ts
```

## Tests & verification

- Unit: `tests/state/session-autosave.test.ts`, `tests/audio/ladder-filter-worklet.test.ts`,
  `tests/audio/effects/reverb.test.ts`, `tests/ui/step-settings.test.ts`,
  `tests/audio/transport/motion-machine.test.ts` (REQ-9's driver swap),
  `tests/ui/onboarding-facade.test.ts` + `tests/ui/about.test.ts` (REQ-1's lazy
  surfaces), `tests/ui/overlay-cost.test.ts` (REQ-10's drift pin) — `npm test`
- E2E: `e2e/session.spec.ts`, `e2e/motion.spec.ts`, `e2e/patterns.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Boot payload: `npm run build` — the entry + `demos` chunk sizes are the REQ-1 metric.
  Nothing in CI runs it, so REQ-1 regressions are caught only by a human reading the
  500 kB warning; that is how the onboarding layer stayed eager for a release after
  this spec said it was lazy. A `dist/assets/index-*.js` that grows without a
  deliberate reason is the signal to re-check what joined the boot path.
- Profiling: a DevTools Performance trace of boot (REQ-1/REQ-2) and a 10 s trace of a
  motion-heavy demo playing (REQ-5/REQ-6/REQ-7 — watch the GC sawtooth).
- REQ-10 is a *frame-rate* rule that its unit test can only pin by proxy (the absence
  of the declaration). To measure it for real, sample `requestAnimationFrame` deltas
  over a few seconds with a demo playing, first with nothing open and then with a
  dialog open, and compare the count of frames over 24 ms. Run it **headed** —
  headless Chromium rasterizes on the CPU and overstates any compositing cost by
  roughly an order of magnitude.

## Open questions / future

- REQ-1 has no automated gate either — CI never runs `npm run build`, so the entry
  chunk can grow silently between releases. A `scripts/check-bundle.mjs` asserting a
  ceiling on `dist/assets/index-*.js`, plus a CI `build` job, would make the 500 kB
  rule self-enforcing instead of a thing a reviewer has to remember.
- REQ-3 has no automated repo-wide gate; a lint rule banning constructor-scope
  `window.addEventListener('pointermove', …)` would make it self-enforcing.
- The oscillators of a fully idle voice still run (only the ladder filter is
  idle-gated). Gating them would need a per-voice start/stop model — worth measuring
  before attempting.
