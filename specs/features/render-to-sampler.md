# Render sequencer bank to sampler ("Import into sampler")

```yaml
id: render-to-sampler
status: implemented
version: 4   # v4: a rendered bar is the song's bar, not always 16 steps (REQ-11)
             # v3: explicit start(0) + a render blocks a playhead seek (REQ-2/REQ-6)
             # v2: a `seq.render` help badge explains the section + the two-pass tail bake
owner: core
related:
  - architecture
  - audio-export        # extends the recorder facility (frame tagging)
  - sampler
  - sequencer
  - arrangement
  - lane-mixer
  - onboarding
source:
  - src/audio/recorder/bank-render.ts
  - src/audio/recorder/node.ts
  - public/worklets/recorder.js
  - src/audio/engine.ts
  - src/ui/panels/seq-panel.ts
  - src/ui/onboarding/help-content.ts   # `seq.render` help topic (v2)
  - src/ui/onboarding/info-badges.ts      # its badge anchor (v2)
```

## Background / Why

The synth is deliberately single-instance (performance). To layer harmonies, the
user *resamples*: render the sequencer's current edit bank (one bar, 16 steps)
through the live synth + FX chain and load the result into a sampler slot — the
sampler then replays it while the live synth plays something else. The capture
must be **exactly** one bar long and start **exactly** on the bar boundary, or
the loop drifts against the grid and is unusable.

## Requirements

- **REQ-1** (exact length) — The rendered buffer is exactly
  `round(16 × sixteenthDuration × sampleRate)` samples, where `sixteenthDuration`
  is read from the `Clock` when the render pass starts. Swing does not change
  this: the clock's grid accumulator is never offset by swing (swing only
  displaces the *emitted* time of odd 16ths within the bar).
- **REQ-2** (exact start) — The buffer's first sample corresponds exactly to a
  bar boundary of the transport grid. Achieved by frame-tagging capture: the
  recorder worklet posts `currentFrame` with each chunk;
  `startSample = round(step0Time × sampleRate) − firstCapturedFrame` maps the
  scheduled (sample-accurate) time of step 0 into the captured stream. The node
  is armed *before* `clock.start(0)`, whose 50 ms pre-roll guarantees
  `firstCapturedFrame ≤ startSample`. The `0` is **explicit**: since
  [transport](transport.md) REQ-7 a plain `start()` resumes from the user's cue,
  and this capture's origin is the absolute `step === 0`.
- **REQ-3** (two-pass loop bake) — The bank plays **twice**; the kept bar is the
  **second** (`[step0 + barSamples, step0 + 2·barSamples)`), so bar 1's
  delay/reverb/release tail is baked into the loop's start and the sample wraps
  seamlessly.
- **REQ-4** (synth-only, post-FX tap) — Capture taps the synth channel output at
  `synthPan` — post-reverb, post-pan, pre-`preMaster` — via a dedicated second
  zero-output `RecorderNode`. The chain is `reverb → synthPan → preMaster`, so
  the tap sits downstream of the whole insert chain *and* of the one shared
  stereo panner ([architecture](../architecture.md), [lfo](lfo.md) REQ-13):
  a rendered bank carries the same width the live synth has.
  Drums/sampler live on other buses and are never captured; they
  keep playing audibly during the render (monitoring).
- **REQ-5** (forced preconditions, restored after) — For the duration of the
  render the engine forces: sequencer enabled, seq lane audible (mute/solo
  overridden at the `LaneMixer`), and the **seq chain lane disabled** — an
  enabled chain advances banks per bar, which would make pass 2 a different
  bank; a disabled lane's play bank follows the edit bank, which is exactly the
  bank being rendered. All three are restored from live state (`ParamBus`
  values / saved chain) when the render ends, success or failure.
- **REQ-6** (guards) — A render is refused while another render or a
  `RecorderController` capture is in flight. The UI additionally disables the
  action when the edit bank has no active steps and when MIDI sync mode is
  `slave` (a slave does not own the clock, and estimator BPM writes would break
  REQ-1). Conversely a **playhead seek is refused while a render is in flight**
  ([transport-position](transport-position.md) REQ-6) — the crop is pure frame
  arithmetic off `step === 0` and `stopAtStep`, so a jump would truncate or
  unbound it.
- **REQ-7** (slot load contract) — On success the buffer lands in the chosen
  slot via the settled pair `SamplerMachine.setBuffer(slot, buf)` +
  `PatternStore.setSampleName(slot, name)`, name `seq-<bank letter>-<bpm>bpm`.
  Like every sampler buffer, the audio is **not** persisted — re-render (the
  seq bank *is* persisted in the song) or save a file from the slot's ✎ editor.
- **REQ-8** (anti-click fades) — A short fade (`RENDER_FADE_MS = 3`, ~128
  samples at 44.1 kHz) is applied at both crop boundaries via `buffer-dsp`'s
  `fadeIn`/`fadeOut`; it never changes the buffer length.
- **REQ-9** (UI) — The Sequencer tab gains an "Import into sampler" section: a
  slot dropdown (`S1…S8 — <name | empty>`, refreshed on sample-meta changes,
  testid `seq-import-slot`) and a Render button (testid `seq-import-render`)
  that shows a busy state while rendering. The transport is left stopped when
  the render completes (same convention as Export Song).
- **REQ-10** (help badge, v2) — The Render button carries an info badge
  ([onboarding](onboarding.md) REQ-3/REQ-15): topic `seq.render`, anchored to
  `seq-import-render`. Nothing on screen explains the section, and the button's
  most surprising behaviour — the **two-pass** bake of REQ-3 — makes it look
  hung for ~2 bars, so the copy must state in user words: what it does (records
  the bank you can see through the live synth + FX into the chosen sampler
  slot, freeing the synth to play something else), that it **plays the bar
  twice and keeps the second pass** so the reverb/delay tails are already
  ringing at the loop's start, what to expect afterwards (the derived slot name
  of REQ-7, transport left stopped), both disabled reasons (REQ-6: empty bank /
  slaved to MIDI clock) and that the audio is not persisted with the song
  (REQ-7).

- **REQ-11** (v4) — **"One bar" means the song's bar.** The render length and the
  crop window are `barTicks × sixteenthDuration()`, not `16 ×`
  ([meter](meter.md) REQ-7), so resampling a bank in 7/8 yields a 7/8 bar that
  loops seamlessly instead of a 4/4 one that does not. Swing still never moves a
  bar boundary — the clock's grid accumulator is unswung — so the crop stays
  frame-exact at any swing.

## Technical design

### Contract / public interface

```yaml
bank-render.ts:  # src/audio/recorder/bank-render.ts
  bankCropRange(step0Time, sixteenthS, sampleRate, firstFrame):  # pure
    -> { start, end }        # bar-2 window; end - start === barSamples
  BankRenderController:
    render(): Promise<CapturedAudio>   # rejects on re-entry / missing frame tag / short capture
    isRendering(): boolean
    onState(fn(rendering: boolean)) -> unsubscribe
    constructor(clock, node: RecorderNode, prepare: () => (() => void), blocked?: () => boolean)
      # prepare = Engine closure forcing REQ-5, returns the restore fn
      # blocked = refuse while the song recorder captures (both restart the clock)
RecorderNode additions:  # src/audio/recorder/node.ts (see audio-export.md)
  firstFrame: number | null   # frame index of the first captured sample, reset by start()
constants: RENDER_BARS = 2, RENDER_TAIL_MS = 350, RENDER_FADE_MS = 3
```

### Layer touchpoints & ordering

```yaml
graph: synthPan -> bankRender RecorderNode (zero-output sink; fan-out alongside
  the existing synthPan -> preMaster edge). Chain: voiceBus -> synthFx -> reverb
  -> synthPan -> preMaster, so the tap is post-FX AND post-pan.
engine: Engine.init() creates the node + controller after the transport modules;
  the prepare() closure lives in Engine so LaneMixer / private state never leaks
  into the controller (ADR-008/009)
ui: seq-panel section calls engine.bankRender.render(), then setBuffer +
  setSampleName (record-sound-modal precedent); exposed via StudioApi.bankRender
```

### Worklet message contract

Chunk messages gain a frame tag (backward-compatible; see audio-export.md):
`{ l: Float32Array, r: Float32Array, f: number }` where `f` = `currentFrame` of
the chunk's first sample. Consumers that ignore `f` are unaffected.

### Persistence

None. Rendered audio is in-memory only (REQ-7); the slot *name* persists via
`PatternStore.sampleNames` as for any sample.

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

Scenario: Import lands in the chosen slot with a derived name
  Given the user picked slot S3
  When the render completes
  Then sampler slot 3 holds the buffer and its name is seq-<bank>-<bpm>bpm
# pinned by: e2e/render-to-sampler.spec.ts

Scenario: The Render button explains itself (v2)
  Given the info badges are on and the Sequencer tab is open
  When the user clicks the badge on the Render button
  Then the modal says what the import does and why the bar plays twice
    (the reverb/delay tail bake of REQ-3)
# pinned by: tests/ui/help-content.test.ts (topic copy), e2e/onboarding.spec.ts
```

## Tests & verification

- Unit: `tests/audio/recorder/bank-render.test.ts`,
  `tests/ui/help-content.test.ts` (REQ-10 copy) — `npm test`
- E2E: `e2e/render-to-sampler.spec.ts` (real audio graph; asserts the exact
  sample count via `window.__synth`) — `npm run e2e`
- Typecheck: `npm run typecheck`

## Open questions / future

- **Per-step micro-timing is not accounted for in the crop.** REQ-1's reasoning —
  the grid accumulator is never offset, only the emitted time is — applies to
  [step-settings](step-settings.md) REQ-6's `micro` exactly as it does to swing, so
  the bar length stays exact. The consequence is the same as swing's and is
  accepted for the same reason: a micro-timed **first** cell nudged early sounds
  before the crop start, and a **last** cell nudged late after its end, so either
  can be clipped from the rendered loop. Moving the crop to follow them would make
  the bar length depend on pattern content, which REQ-1 exists to prevent. Nudge
  the interior cells, or leave the edges straight.
- A "render drum bank" sibling would reuse `BankRenderController` with a tap on
  `drumReverb.output` and a drum-lane prepare closure.
- Optional normalize / trim-silence post-steps could reuse `buffer-dsp.ts`.
