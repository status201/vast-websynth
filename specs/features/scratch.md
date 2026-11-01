# Scratch (turntable warp)

```yaml
id: scratch
status: implemented
version: 2
owner: core
related:
  - architecture
  - sampler              # owns the buffers this rewrites, and the row the editor is reached from
  - sample-recorder      # the editor modal that hosts the scratch section
  - sample-chop          # the sibling op in the same modal; same "applies to the selection" rule
  - time-stretch         # the sibling offline op, and the mid/side rule this inherits
  - sample-persistence   # a scratched clip persists because it lands through setBuffer
  - render-to-sampler    # the bar-exact length arithmetic, and the anti-click edge fade
  - meter                # barTicks x sixteenthDuration is what "one bar" means
  - untrusted-input      # the curve, the rate and the output length are bounded in limits.ts
  - toast
  - dropdown
  - iconography          # the dice button's glyph
  - typography
  - runtime-performance  # a folded section pays for no peak scan
  - panel-tabs           # the `websynth.ui.collapsed.*` key convention
  - testids
source:
  - src/audio/recorder/scratch-curve.ts
  - src/audio/recorder/scratch.ts
  - src/ui/components/scratch-graph.ts
  - src/ui/components/record-sound-modal.ts
  - src/ui/styles/scratch-graph.module.css
  - src/state/limits.ts
  - src/ui/onboarding/help-content.ts
```

Draw a turntable gesture over a sampler clip and print it into the audio: speed,
pitch and direction move together, with a crossfader that cuts. The edit is
offline, destructive, undoable, and locked to a count of sixteenths at the
current tempo.

## Background / Why

Every other [sampler](sampler.md) op is constant: one rate, one ratio, one
length. A scratch's playback rate is a *function of time*: it speeds up, stops,
reverses and comes back, with the crossfader cutting the return stroke. Two
obvious routes are closed. No browser plays an `AudioBufferSourceNode`
backwards, so automating `playbackRate` offline fails. [time-stretch](time-stretch.md)
is pitch-preserving, which makes a stutter, not a scratch. So the reader is
hand-written (ADR-003): the linear resampler `time-stretch.ts` keeps privately,
generalised to a **position map**. This is an offline edit paid once on a button
press, so ADR-010's *cheap* ranks low here. That buys cubic interpolation and
anti-alias taps. *Stable* is not relaxed (ADR-015). The user draws **rate**, not
position, because a turntablist thinks in strokes and up then means "faster and
higher" (ADR-014 law 2). The resulting position is drawn as a preview
(REQ-the-preview-lane-remaps-cached-peaks).

## Requirements

- **REQ-scratch-modules-are-pure** — `scratch-curve.ts` and `scratch.ts` are pure
  (no `AudioContext`, no DOM). There are two modules because the editor needs the
  position map on every pointer move and must never pull in the resampler.
- **REQ-a-curve-carries-rate-not-position** — A curve is breakpoints carrying a
  **rate**. Between points the rate ramps linearly or holds then jumps. Position is
  its integral.
- **REQ-the-integral-is-closed-form-per-segment** — Evaluated **in closed form per
  segment**: a ramp is `(v0+v1)/2 * dt` and a hold is `v0 * dt`. It is never
  accumulated per sample, since drift would miss the bar.
- **REQ-position-at-is-the-only-description** — `positionAt` is the **only**
  description of where the needle is. The renderer and the preview both read it.
- **REQ-the-result-is-exactly-out-frames** — The result is **exactly** `outFrames =
  round(steps * sixteenthDuration * sampleRate)`, the arithmetic
  [render-to-sampler](render-to-sampler.md) REQ-one-bar-means-the-songs-bar owns
  and [time-stretch](time-stretch.md) REQ-the-editor-gains-a-fit-row forbids
  re-deriving.
- **REQ-pitch-rides-speed** — Rate 2 reads twice as fast and sounds an octave up;
  rate −1 plays backwards at pitch. This is asserted, not assumed.
- **REQ-reads-are-hermite-interpolated** — 4-point **Hermite (Catmull-Rom)**. Linear
  is audibly dull on slow strokes.
- **REQ-fast-reads-are-box-averaged** — Above |rate| 1 the read is box-averaged over
  the span the output frame covers, `ceil(|rate|)` taps. That is a lowpass at
  `fs/|rate|`, the correct anti-alias cutoff, and costs at most `MAX_SCRATCH_RATE`
  taps.
- **REQ-a-read-outside-the-source-is-silence** — Off the record is silence, never a
  held sample. The position is not clamped, so the needle comes back when the
  curve does.
- **REQ-a-segment-may-be-cut** — A **cut** segment closes the crossfader through a
  linear slew of `SCRATCH_GATE_MS`, never a hard multiply, which would click.
- **REQ-the-scratch-result-is-edge-faded** — Edge-faded with `buffer-dsp`'s
  `fadeIn` / `fadeOut` at `SCRATCH_EDGE_MS`
  ([render-to-sampler](render-to-sampler.md) REQ-anti-click-fades-on-the-render).
  The length never changes.
- **REQ-both-channels-read-one-position-map** — Both channels read the identical
  map ([time-stretch](time-stretch.md) REQ-both-algorithms-decide-from-the-mid).
  Running the reader per channel would decorrelate them, invisibly to a
  per-channel level check.
- **REQ-every-scratch-entry-point-is-total** — A non-finite or non-positive
  `outFrames`, an output past `MAX_STRETCH_OUTPUT_FRAMES`, an empty buffer or an
  empty curve returns a clone. Nothing throws, and **nothing is allocated before
  the bound is checked** (ADR-015). Non-finite is rejected first, because the
  clamp idiom passes `NaN` through ([untrusted-input](untrusted-input.md)
  REQ-no-subscriber-can-wedge-the-clock).
- **REQ-scratch-bounds-live-in-limits** — `MAX_SCRATCH_POINTS`, `MAX_SCRATCH_RATE`
  and `MAX_SCRATCH_STEPS` live in `src/state/limits.ts`, and the output allocation
  reuses `MAX_STRETCH_OUTPUT_FRAMES`. The stretch ratio bounds do **not** apply:
  the output length comes from a sixteenth count, not from the input length.
- **REQ-the-scratch-editor-is-a-modal-section** (v2) — A folded section of the Edit
  Sample modal, operating on the current selection ([sample-chop](sample-chop.md)
  REQ-chop-divides-the-selection), not a second surface. Its header follows
  [sample-recorder](sample-recorder.md) REQ-every-section-below-the-waveform-folds:
  **title `Scratch` left, caret right**, with the whole row a hit target. Folded,
  it pays for **no peak scan**: the recompute is gated on the body's `.collapsed`
  class and re-run by the fold's `onChange`.
- **REQ-the-graph-is-two-lanes-on-output-time** — Two lanes on one x-axis of
  **output time**, gridded in sixteenths with the beat accented from
  `engine.barTicks` ([meter](meter.md) REQ-bar-exact-capture-follows-bar-ticks).
  The upper lane draws the warped result; the lower lane is the editable rate
  curve, zeroed on its centre with unity guides.
- **REQ-the-preview-lane-remaps-cached-peaks** — `computePeaks` runs once per
  source. Each output column takes the min/max over the source columns its
  position span covers. It is O(width) and repaints on every pointer move. Audio is
  rendered only to audition and to apply.
- **REQ-the-scratch-gesture-inventory** — See the inventory. A drag's x snaps to a
  32nd and y to quarter-rates. **Shift frees both axes together**, so "fine" means
  one thing. The rate snap matters because unity sits ~15 px from the centre.
- **REQ-scratch-presets-are-pure-generators** — Generators over a **normalised**
  time axis: Baby (short-short-long, the default), Transformer, Chirp, Tear,
  Flare, Scribble, Stab, plus a random generator behind a dice button.
- **REQ-the-cue-auto-places-from-the-excursion** — The cue auto-places from the
  curve's own excursion, so a preset that pulls back first still reads inside the
  sample. Any off-record region is shaded (ADR-014 law 5).
- **REQ-applying-goes-through-run-op** — Applying uses the modal's `runOp`, which
  brings the busy latch, the one-level undo, the crop reset and the auto-play with
  it. The result lands through `SamplerMachine.setBuffer`
  ([sampler](sampler.md) REQ-set-buffer-is-the-one-door) on load into a slot.
- **REQ-a-scratched-clip-is-not-renamed** — A rename evicts the buffer
  ([sampler](sampler.md) REQ-a-slots-audio-matches-its-label;
  [time-stretch](time-stretch.md) REQ-a-fitted-clip-is-not-renamed).
- **REQ-preview-plays-without-committing** — Preview renders and plays with no
  `working` mutation, no undo snapshot and no button flash.
- **REQ-scratch-registers-no-params** — No `ParamBus` params and nothing persisted
  (curve, preset, length, or the fact that a clip was scratched)
  ([time-stretch](time-stretch.md) REQ-time-stretch-registers-no-params). That
  keeps the song format, validator, schema and dialect out of scope.

## Technical design

### Contract / public interface

```ts
// src/audio/recorder/scratch-curve.ts — pure model + geometry
export interface ScratchPoint { t: number; v: number; cut: boolean; hold: boolean }
export interface ScratchCurve { steps: number; cue: number; points: ScratchPoint[] }
export type ScratchPresetName =
  | 'Baby' | 'Transformer' | 'Chirp' | 'Tear' | 'Flare' | 'Scribble' | 'Stab';

export function normalizeCurve(c: ScratchCurve): ScratchCurve;

// The curve with its per-segment integral summed, built once and walked
// (re-summing the prefix per read would be quadratic).
export interface ScratchPlan {
  readonly steps: number; readonly cue: number;
  readonly t: Float64Array;   // segment boundaries, length n+1, ending at 1
  readonly v0: Float64Array; readonly v1: Float64Array;
  readonly p: Float64Array;   // position at each boundary — the prefix integral
  readonly cut: Uint8Array; readonly n: number;
}
export function scratchPlan(c: ScratchCurve): ScratchPlan;
export function segmentAt(plan: ScratchPlan, t: number, hint?: number): number;
export function rateIn(plan: ScratchPlan, seg: number, t: number): number;
export function positionIn(plan: ScratchPlan, seg: number, t: number): number;
export function cutIn(plan: ScratchPlan, seg: number): boolean;

// One-off wrappers over exactly those, so both paths run the same arithmetic.
export function rateAt(c: ScratchCurve, t: number): number;
export function positionAt(c: ScratchCurve, t: number): number;
export function gainAt(c: ScratchCurve, t: number): number;

export function curveExtent(c: ScratchCurve): { min: number; max: number };
export function autoCue(c: ScratchCurve, srcFrames: number, outFrames: number): number;
export function warpPeaks(
  peaks: Float32Array, c: ScratchCurve, srcFrames: number, outFrames: number, cols: number,
): Float32Array;
export function scratchPreset(name: ScratchPresetName, steps: number): ScratchCurve;
export function randomScratch(steps: number, rnd?: () => number): ScratchCurve;
export const SCRATCH_PRESETS: readonly ScratchPresetName[];
export const DEFAULT_SCRATCH_STEPS: number;

// src/audio/recorder/scratch.ts — the variable-rate reader
export function renderScratch(
  a: CapturedAudio, curve: ScratchCurve, outFrames: number,
): CapturedAudio;

// src/ui/components/scratch-graph.ts
export class ScratchGraph {
  readonly el: HTMLElement;
  constructor(opts: ScratchGraphOptions);
  setCurve(c: ScratchCurve): void;
  setSource(peaks: Float32Array, srcFrames: number): void;
  /** `barTicks`, not a beat: a sixteenth count alone cannot tell 3/4 from 6/8. */
  setGrid(steps: number, barTicks: number, outFrames: number): void;
  redraw(): void;
  destroy(): void;
}
export function rateLabel(v: number): string;   // "1.50x · +7.0 st"
```

### Data shapes

```yaml
ScratchPoint:
  t: number        # 0..1 along the scratch (normalised, so a preset works at any length)
  v: number        # playback rate. 1 = forward at pitch, 0 = stopped, negative = backwards
  cut: boolean     # crossfader closed from this point until the next
  hold: boolean    # segment shape to the next point: false = ramp, true = hold then jump

ScratchCurve:
  steps: number    # length in sixteenths — what locks the gesture to the tempo
  cue: number      # 0..1 of the source: where the needle starts
  points: ScratchPoint[]   # sorted by t, first pinned at t = 0

reader:
  interpolation: 4-point Hermite (Catmull-Rom)
  antiAlias: box average of ceil(|rate|) taps above unity rate
  offRecord: silence, position not clamped
  gateSlewMs: 1.5
  edgeFadeMs: 3

limits (src/state/limits.ts):
  MAX_SCRATCH_POINTS: 64
  MAX_SCRATCH_RATE: 4          # two octaves either way; also the anti-alias tap ceiling
  MAX_SCRATCH_STEPS: 64        # 4 bars in 4/4, matching the Fit row's ceiling
  MAX_STRETCH_OUTPUT_FRAMES: reused as the output allocation bound
```

### Layer touchpoints & ordering

```yaml
src/audio/recorder/scratch-curve.ts: pure; imports limits.ts only
src/audio/recorder/scratch.ts:       pure; imports scratch-curve.ts, buffer-dsp.ts, limits.ts,
                                     node.ts (type only)
src/ui/components/scratch-graph.ts:  canvas + pointer only; no engine reference (jsdom with a stubbed rect)
src/ui/components/record-sound-modal.ts:
  scratch panel + row built AFTER the shift row (they read `working` and the crop the same way)
  FIT_TARGETS / framesFor / fitLabel / stepsFor are shared by the Fit row and the scratch length
  playClip(clip) lets Preview audition an uncommitted render
  apply goes through runOp(); syncScratch joins syncChop / syncFit (called from setBusy and afterMutate)
```

### Persistence

The scratched audio persists like any clip, via `setBuffer` and `onBufferChange`
([sample-persistence](sample-persistence.md)
REQ-clip-writes-are-debounced-through-one-hook), once loaded into a slot. The
curve lives only while the modal is open. The one stored thing is the fold state,
`websynth.ui.collapsed.sample-scratch`, a view preference
([panel-tabs](panel-tabs.md) REQ-selected-page-is-session-only's convention).

## Visual aids

```
editor modal, below the Fit & Shift section, folded on a first open
+---------------------------------------------------------------------+
| SCRATCH                                                          v   |
|.....................................................................|
| cut  ####        ######        ####          16 · 1 bar at 92 BPM    |
| +-------------- warped result preview (read-only) ----------------+  |
| |    .:iII|Ii:.    .:iI|Ii:.:iI|Ii:.        .:iiIIIIIIIii:.       |  |
| +-----------------------------------------------------------------+  |
| +-------------- rate curve (draggable points) --------------------+  |
| |+2x                                                              |  |
| |+1x --\      /---\      /--------------------------------------- |  |
| | 0  ---\----/-----\----/---------------------------------------- |  |
| |-1x     \--/       \--/                                          |  |
| +--|--|--|--|--|--|--|--|--|--|--|--|--|--|--|--|-----------------+  |
|    1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16   (sixteenths)     |
|                                                                      |
| Scratch: selection is ~13.4 sixteenths  [16 · 1 bar v] [Baby v]      |
|                                          [dice] [Preview] [Scratch]  |
+---------------------------------------------------------------------+
```

### Gesture inventory (ADR-014)

| Control | Tap / click | Drag | Long press | Double | Keyboard |
| --- | --- | --- | --- | --- | --- |
| `scratch-head` (the whole title row) | folds / unfolds the section | — | — | — | — |
| `scratch-toggle` (the caret) | the same, and only that | — | — | — | Enter/Space when focused |
| a curve point | selects it | x = timing (snaps to a 32nd), y = rate (snaps to quarters); **Shift** frees both | — | deletes the point | — |
| empty rate lane | adds a point there | adds a point, then drags it | — | — | — |
| a segment's cut band | toggles the crossfader closed / open | — | — | — | — |
| the cue marker | — | moves where the needle starts in the source | — | returns it to auto | — |
| the preview lane | auditions the current curve | — | — | — | — |
| `scratch-length` | opens the list | — | — | — | inherited from [dropdown](dropdown.md) |
| `scratch-preset` | opens the list | — | — | — | inherited from [dropdown](dropdown.md) |
| `scratch-random` | rolls a new curve | — | — | — | Enter/Space when focused |
| `scratch-preview` | renders and plays, commits nothing | — | — | — | Enter/Space when focused |
| `scratch-apply` | prints the scratch into the selection | — | — | — | Enter/Space when focused |

A `—` is a decision. Nothing is momentary or a mode (ADR-014 law 2). Precedent:
turntablist scratch notation, and `motion-step-pad.ts` for the Shift-fine drag.
Touch (law 6): a 22 px hit radius (44 px target) around a 6 px dot, `touchAction`
set imperatively, and a hand-rolled 300 ms double-tap off `pointerdown`
(`dblclick` is unreliable on touch).

## Scenarios (BDD)

```gherkin
Scenario: a scratch is exactly as long as the bar it was drawn against
  Given a clip of an arbitrary length and a curve of N sixteenths
  When the scratch is rendered at the current tempo
  Then the result is exactly round(N * sixteenthDuration * sampleRate) frames long
# pinned by: tests/audio/scratch.test.ts

Scenario: the section's title sits left of its caret (REQ-the-scratch-editor-is-a-modal-section, regression)
  Given the editor is open on a clip
  Then the Scratch header shows "Scratch" to the LEFT of its caret
# pinned by: e2e/sample-editor-folds.spec.ts

Scenario: pitch rides the speed
  Given a 440 Hz sine
  When a curve held at rate 2 is rendered over it
  Then the result measures 880 Hz — an octave up, not a preserved pitch
# pinned by: tests/audio/scratch.test.ts

Scenario: a flat curve at unity rate reproduces the source
  Given any clip and a curve of a single point at rate 1
  When it is rendered to the source's own length from cue 0
  Then the result matches the source within interpolation error
# pinned by: tests/audio/scratch.test.ts

Scenario: a flat negative curve plays it backwards
  Given any clip and a curve held at rate -1, cued at the end
  When it is rendered to the source's own length
  Then the result matches reverse() within interpolation error
# pinned by: tests/audio/scratch.test.ts

Scenario: the needle position is the exact integral of the rate (edge)
  Given a curve of ramp and hold segments with hand-computable integrals
  When the position is sampled at the segment boundaries
  Then it equals the closed-form integral, with no accumulated drift
# pinned by: tests/audio/scratch-curve.test.ts

Scenario: a cut segment is silent and does not click (edge)
  Given a curve with a cut segment in the middle of loud material
  When it is rendered
  Then that span is silent, and no sample-to-sample step at either edge exceeds the slew
# pinned by: tests/audio/scratch.test.ts

Scenario: a needle that runs off the record is silent, not stuck (edge)
  Given a curve whose integral leaves the source and returns
  When it is rendered
  Then the off-record span is silence rather than a held sample, and audio resumes on return
# pinned by: tests/audio/scratch.test.ts

Scenario: the stereo image survives (edge)
  Given a clip whose channels are correlated but not identical
  When it is scratched
  Then the mono down-mix keeps its level — both channels read one position map
# pinned by: tests/audio/scratch.test.ts

Scenario: hostile input is refused, not thrown (failure)
  Given a clip
  When it is scratched with a non-finite, zero or negative length, past the frame bound,
       with an empty curve, or with rates and point counts past the limits
  Then a clone comes back, nothing throws, and no oversized buffer is allocated
# pinned by: tests/audio/scratch.test.ts, tests/audio/scratch-curve.test.ts

Scenario: presets and the dice stay inside the model
  Given every named preset and a hundred random rolls at assorted lengths
  When each is normalised
  Then every point is ordered, in range, and within the point and rate limits
# pinned by: tests/audio/scratch-curve.test.ts

Scenario: the preview lane follows the curve without rendering audio
  Given cached source peaks and a curve
  When a warped column is asked for where the needle sits over a known transient
  Then that column carries the transient's amplitude
# pinned by: tests/audio/scratch-curve.test.ts

Scenario: a point is dragged, added, deleted and cut
  Given the graph over a stubbed rect
  When the lane is tapped, a point dragged, a point double-tapped and a cut band tapped
  Then the curve gains a point, moves it on the 32nd grid, loses it, and toggles the cut
# pinned by: tests/ui/scratch-graph.test.ts

Scenario: a scratch is applied to a slot and taken back
  Given a clip loaded in a sampler slot and opened in the editor
  When a preset and a length are chosen, Scratch is pressed and the clip is loaded
  Then the slot's buffer is exactly that many sixteenths long, and Undo restores the original
# pinned by: e2e/scratch.spec.ts

Scenario: the editor explains itself (docs)
  Given the in-app help
  When the sampler topic is read
  Then it describes the scratch section and what the two lanes mean
# pinned by: tests/ui/help-content.test.ts
```

## Tests & verification

- Unit: `tests/audio/scratch-curve.test.ts`, `tests/audio/scratch.test.ts` (pitch
  by autocorrelation, as in `tests/audio/time-stretch.test.ts`),
  `tests/ui/scratch-graph.test.ts`, `tests/ui/help-content.test.ts` — `npm test`.
- E2E: `e2e/scratch.spec.ts`; `e2e/sample-editor-folds.spec.ts` asserts the header
  by geometry, not DOM order.
- **By ear — the acceptance test** (ADR-010,
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)), transport stopped:

  ```
  npm run bench:audio   -- --name scr-off --sample <break.wav>         --slot 0 --hits 4
  npm run bench:audio   -- --name scr-on  --sample <break-scratch.wav> --slot 0 --hits 4
  npm run bench:metrics -- --compare bench/scr-off.wav bench/scr-on.wav
  ```

  **bursts** is the metric: every failure mode here is a discontinuity. Listen for
  aliasing on fast strokes, dullness on slow ones, and landing on the bar against a
  loop.

## Open questions / future

- **A slot-row one-click scratch** like FIT ([time-stretch](time-stretch.md)
  REQ-the-slot-fit-button-is-a-quick-fit) is blocked on the slot row's fixed-width
  control cluster.
- **Saving a scratch** needs a song field, a validator range, the schema and the
  dialect (ADR-007, ADR-015). It is out of scope by REQ-scratch-registers-no-params.
- **A realtime scratch** is back on the audio thread, where ADR-010's *cheap*
  refuses a per-voice anti-aliased variable-rate reader.
