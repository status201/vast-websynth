# Render sequencer bank to sampler ("Import into sampler")

```yaml
id: render-to-sampler
status: implemented
version: 7
owner: core
related:
  - architecture
  - audio-export        # extends the recorder facility (frame tagging)
  - sampler
  - sequencer
  - arrangement
  - song-mode           # the LaneMixer
  - meter
  - onboarding
source:
  - src/audio/recorder/bank-render.ts
  - src/audio/recorder/node.ts
  - public/worklets/recorder.js
  - src/audio/engine.ts
  - src/ui/panels/seq-panel.ts
  - src/ui/onboarding/help-content.ts
  - src/ui/onboarding/info-badges.ts
```

## Background / Why

The synth is deliberately single-instance. To layer, the user *resamples*: render
the sequencer's current edit bank (one bar) through the live synth + FX and load
it into a sampler slot, which replays it while the synth plays something else. The
capture must be **exactly** one bar long and start **exactly** on the bar, or the
loop drifts against the grid.

## Requirements

- **REQ-the-rendered-buffer-has-exact-length** — The buffer is exactly
  `round(barTicks × sixteenthDuration × sampleRate)` samples, with
  `sixteenthDuration` read from the `Clock` when the pass starts
  (REQ-one-bar-means-the-songs-bar). Swing and per-step `micro` do not change it:
  the clock's grid accumulator is never offset; only the *emitted* time moves.
- **REQ-the-buffer-starts-exactly-on-a-bar** — The first sample is a bar boundary.
  The recorder posts `currentFrame` with each chunk
  ([audio-export](audio-export.md) REQ-each-chunk-is-frame-tagged), and
  `startSample = round(step0Time × sampleRate) − firstCapturedFrame`. The node is
  armed *before* `clock.start(0)`, whose 50 ms pre-roll guarantees
  `firstCapturedFrame ≤ startSample`. The `0` is explicit, because a plain
  `start()` begins at the cue ([transport](transport.md)
  REQ-the-cue-is-where-start-begins).
- **REQ-a-two-pass-loop-bake** — The bank plays **twice**, and the **second** bar
  is kept, so bar 1's delay/reverb/release tail is baked into the loop's start and
  the sample wraps seamlessly. **Exactly two passes:** the clock's step limit
  ends the render ([transport](transport.md) REQ-a-step-limit-halts-before-the-step).
  It halts in place of step `RENDER_BARS × barTicks`, so no lane is handed the
  third pass's first step. The crop never reached that step, but every lane
  played it live, including the drums and sampler that keep monitoring.
- **REQ-capture-is-synth-only-post-fx** — A dedicated second zero-output
  `RecorderNode` taps `synthPan`: downstream of the whole insert chain (duck
  included, [effects](effects.md) REQ-the-synth-chain-order) and of the shared
  stereo panner ([lfo](lfo.md) REQ-pan-sweeps-a-stereo-panner), pre-`preMaster`.
  So a rendered bank carries the live width. Drums and sampler are never captured
  and keep playing (monitoring).
- **REQ-render-preconditions-are-forced-then-restored** — For the render the
  engine forces the sequencer enabled, the seq lane audible (mute/solo overridden
  at the `LaneMixer`) and the **seq chain lane disabled**, so pass 2 is the same
  bank (a disabled lane plays the edit bank). All three are restored from live
  state when the render ends, on success or failure.
- **REQ-a-render-is-refused-while-busy** — A render is refused while another render
  or a `RecorderController` capture is in flight. The UI also disables it for an
  empty edit bank and in MIDI `slave` mode, since a slave does not own the clock.
  A **seek is refused while a render runs** ([transport-position](transport-position.md)
  REQ-seeking-is-refused-in-three-states), because the crop is frame arithmetic
  off `step === 0`. In the other direction, an export or manual take is refused
  mid-render ([audio-export](audio-export.md) REQ-a-capture-waits-for-a-bank-render).
- **REQ-an-outside-stop-aborts-the-render** (v6) — A transport stop the render did
  not issue (Esc, Panic, a Media Session pause, the space bar) discards the
  capture, rejects `render()` with *render interrupted*, and restores the
  preconditions. A stopped clock never reaches the step limit, so without this
  the render would never end.
- **REQ-the-slot-load-contract** — On success the buffer lands via
  `SamplerMachine.setBuffer(slot, buf)` + `PatternStore.setSampleName(slot, name)`,
  named `seq-<bank letter>-<bpm>bpm`. The audio is then an ordinary clip: kept on
  the device ([sample-persistence](sample-persistence.md)), carried by a project
  `.zip` ([project-export](project-export.md)), and absent from a song `.json`,
  which stores only the name (and the seq bank, so it can be re-rendered).
- **REQ-anti-click-fades-on-the-render** — `RENDER_FADE_MS = 3` fades at both crop
  edges via `buffer-dsp`'s `fadeIn`/`fadeOut`. The length never changes.
- **REQ-the-sequencer-tab-hosts-import** — The Sequencer tab's "Import into
  sampler" section holds a slot dropdown (`S1…S8 — <name | empty>`, refreshed on
  sample-meta changes, `seq-import-slot`) and a Render button (`seq-import-render`)
  with a busy state. The transport is left stopped afterwards.
- **REQ-the-render-button-carries-a-badge** (v2) — Topic `seq.render` on
  `seq-import-render` ([onboarding](onboarding.md)
  REQ-info-badges-show-per-control-help/REQ-seq-render-has-a-help-badge). In user
  words it says: what it does; that it **plays the bar twice and keeps the second**
  (so it looks busy for ~2 bars); the derived slot name and the stopped transport;
  and both disabled reasons.
- **REQ-one-bar-means-the-songs-bar** (v4) — The render length and crop are
  `barTicks × sixteenthDuration()` ([meter](meter.md)
  REQ-bar-exact-capture-follows-bar-ticks), so a 7/8 bank yields a 7/8 loop.

## Technical design

### Contract / public interface

```yaml
bank-render.ts:  # src/audio/recorder/bank-render.ts
  bankCropRange(step0Time, sixteenthS, sampleRate, firstFrame, barTicks?):  # pure
    -> { start, end }        # bar-2 window; end - start === barSamples
  BankRenderController:
    render(): Promise<CapturedAudio>   # rejects on re-entry / missing frame tag / short capture / outside stop
    isRendering(): boolean
    onState(fn(rendering: boolean)) -> unsubscribe
    constructor(clock, node: RecorderNode, prepare: () => (() => void), blocked?: () => boolean)
      # prepare = Engine closure forcing the preconditions, returns the restore fn
      # blocked = refuse while the song recorder captures
RecorderNode.firstFrame: number | null   # see audio-export.md
constants: RENDER_BARS = 2, RENDER_TAIL_MS = 350, RENDER_FADE_MS = 3
```

### Layer touchpoints & ordering

```yaml
graph: synthPan -> bankRender RecorderNode (zero-output sink, beside synthPan -> preMaster)
engine: Engine.init() creates the node + controller after the transport modules;
  prepare() lives in Engine so LaneMixer / private state never leaks (ADR-008/009)
ui: seq-panel calls engine.bankRender.render(), then setBuffer + setSampleName;
  exposed via StudioApi.bankRender
```

## Scenarios (BDD)

```gherkin
Scenario: Rendered buffer has the exact bar length
  Given a seq bank with active steps and BPM b
  When the user renders it into slot S1
  Then the slot's AudioBuffer length is exactly round(240 / b * sampleRate) samples
# pinned by: tests/audio/recorder/bank-render.test.ts, e2e/render-to-sampler.spec.ts

Scenario: Crop starts exactly at the second bar boundary
  Given capture began firstFrame samples into the context timeline
  When bankCropRange maps step0Time into the captured stream
  Then start = round(step0Time * sampleRate) - firstFrame + barSamples
# pinned by: tests/audio/recorder/bank-render.test.ts

Scenario: Swing does not change the render length
  Given transport.swing > 0
  When a bank is rendered
  Then the buffer length equals the unswung bar length
# pinned by: tests/audio/recorder/bank-render.test.ts (crop math is swing-blind)

Scenario: Forced state is restored after the render (edge)
  Given the seq lane is muted and its chain lane is enabled
  When a render completes (or fails)
  Then seq mute and the chain lane are back to their pre-render state
# pinned by: tests/audio/recorder/bank-render.test.ts (prepare/restore)

Scenario: Re-entry is refused (edge)
  Given a render is in flight
  When render() is called again
  Then it rejects and the in-flight render is unaffected
# pinned by: tests/audio/recorder/bank-render.test.ts

Scenario: The render does not play a third pass's first step (regression, REQ-a-two-pass-loop-bake)
  Given a lane registered before the render, as every machine is at boot
  When a bank is rendered
  Then the lane receives exactly the steps 0 .. 2 × barTicks − 1
  And the transport is left stopped
# Bug: the render stopped the clock from its own tick listener, the last one
# registered, so every lane had already scheduled step 2 × barTicks. The crop
# excluded it, but it sounded live in the render's tail. Same cause as the song
# export's (audio-export.md REQ-the-capture-keeps-a-tail).
# pinned by: tests/audio/recorder/bank-render.test.ts

Scenario: A stop from outside aborts the render (regression, REQ-an-outside-stop-aborts-the-render)
  Given a render is in flight
  When something else stops the transport before the second bar ends
  Then render() rejects, the forced state is restored, and a new render is accepted
# pinned by: tests/audio/recorder/bank-render.test.ts

Scenario: Import lands in the chosen slot with a derived name
  Given the user picked slot S3
  When the render completes
  Then sampler slot 3 holds the buffer and its name is seq-<bank>-<bpm>bpm
# pinned by: e2e/render-to-sampler.spec.ts

Scenario: The Render button explains itself (REQ-the-render-button-carries-a-badge)
  Given the info badges are on and the Sequencer tab is open
  When the user clicks the badge on the Render button
  Then the modal says what the import does and why the bar plays twice
# pinned by: tests/ui/help-content.test.ts (topic copy), e2e/onboarding.spec.ts
```

## Tests & verification

- Unit: `tests/audio/recorder/bank-render.test.ts`, `tests/ui/help-content.test.ts`
  — `npm test`. E2E: `e2e/render-to-sampler.spec.ts` (real graph; exact sample
  count via `window.__synth`).

## Open questions / future

- **Micro-timed edge cells can be clipped.** A first cell nudged early (or a last
  nudged late, [step-settings](step-settings.md) REQ-a-step-carries-a-micro-offset)
  falls outside the crop. Following them would make the length depend on content,
  which REQ-the-rendered-buffer-has-exact-length forbids. Nudge interior cells.
- A "render drum bank" sibling would reuse `BankRenderController` with a tap on the
  drum chain's output and a drum-lane prepare closure.
