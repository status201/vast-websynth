# Scratch (turntable warp)

```yaml
id: scratch
status: implemented
version: 2 # v2: REQ-15 — the header is the modal's shared fold (title left,
           #     caret right); the fold key joins the app's convention
           # v1: the scratch graph, the reader and the section
owner: core
related:
  - architecture
  - sampler              # owns the buffers this rewrites, and the row the editor is reached from
  - sample-recorder      # the editor modal that hosts the scratch section
  - sample-chop          # the sibling op in the same modal; same "applies to the selection" rule
  - time-stretch         # the sibling offline op, and the mid/side rule this inherits
  - sample-persistence   # a scratched clip persists because it lands through setBuffer
  - render-to-sampler    # the existing bar-exact length arithmetic, and the anti-click edge fade
  - meter                # barTicks x sixteenthDuration is what "one bar" means
  - untrusted-input      # the curve, the rate and the output length are bounded in limits.ts
  - toast
  - dropdown
  - iconography          # the dice button's glyph
  - typography           # REQ-3: the legend counts while a point is dragged
  - runtime-performance  # REQ-4: a folded section pays for no peak scan
  - panel-tabs           # REQ-15's `websynth.ui.collapsed.*` key convention
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

Draw a turntable gesture over a sampler clip and print it into the audio — speed,
pitch and direction moving together, with a crossfader that cuts. Offline,
destructive, undoable, and locked to a count of sixteenths at the current tempo.

## Background / Why

The [sampler](sampler.md) can already be cropped, reversed, filtered, chopped,
fitted to a bar and pitch-shifted. Every one of those is a *constant* operation:
one rate, one ratio, one length, applied uniformly. What a Hip Hop producer
reaches for and this instrument cannot express is a **scratch** — a hand moving
the record under the needle, where the playback rate is a *function of time*. It
speeds up, it stops, it reverses, it comes back, and the crossfader cuts the
sound out on the return stroke so the ear hears rhythm rather than a wobble.

Nothing in the app can do this today, and two obvious routes are both closed:

1. **Automating `playbackRate` on an `OfflineAudioContext`.** The graph accepts
   the automation, but no shipping browser plays an `AudioBufferSourceNode`
   backwards — the rate is clamped at zero. Reverse motion *is* the scratch, so
   this route fails at the first requirement.
2. **Segmenting at the control points and calling `fitToFrames` per segment.**
   [time-stretch](time-stretch.md) is pitch-*preserving* by construction. A
   scratch's pitch must ride its speed; a pitch-preserved scratch is a stutter
   edit, not a scratch.

So the reader is written by hand
([ADR-003](../decisions/adr-003-no-runtime-dependencies.md) — no dependency is
available and none is wanted). It is the generalisation of the linear resampler
`time-stretch.ts` already keeps privately for very short clips: feed it a
**position map** instead of a linear ramp.

**Why the cost is affordable.**
[ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md) ranks *musical >
stable > cheap*, and carries a dated note recording that its scope is the **audio
thread** — per-sample work multiplied by every voice and every live instance.
This is an offline buffer edit, paid once on a button press with the modal's
controls disabled, in the same family as `reverse` / `normalize` / `fitToFrames`.
*Cheap* therefore ranks far lower here, which is what buys the cubic
interpolation and the anti-alias taps. *Stable* is **not** relaxed: a curve the
user drew reaches a length calculation and an allocation, which is exactly the
case [ADR-015](../decisions/adr-015-untrusted-input-is-bounded.md) governs. No
new ADR is needed; that note already covers this feature.

**Why the user draws rate rather than position.** A turntablist thinks in
strokes — *push, pull, push long* — which is a speed gesture. Rate also makes the
vertical axis mean pitch, so dragging a point up is audibly "faster and higher",
one gesture with one outcome
([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 2). The cost is that
where the needle *is* becomes the integral of what is drawn, which is invisible —
so the editor draws the warped result above the curve, and that preview is what
makes the model legible (REQ-17).

## Requirements

- **REQ-1** — `scratch-curve.ts` and `scratch.ts` are **pure**: plain values in,
  plain values out, with no `AudioContext` and no DOM, so they unit-test under
  vitest+jsdom exactly like `buffer-dsp.ts` and `time-stretch.ts`. They are two
  modules and not one because the model is shared with the UI while the reader is
  not: the editor needs the position map on every pointer move and must never pull
  the resampler in to get it.
- **REQ-2** — A curve is a list of breakpoints carrying a **rate**, not a
  position. Between two points the rate either ramps linearly (a hand on the
  platter) or holds and then jumps (an instant change of pitch). The needle's
  position is the integral of that rate.
- **REQ-3** — The integral is evaluated **in closed form per segment** — a ramp
  integrates to `(v0+v1)/2 * dt`, a hold to `v0 * dt` — and never accumulated per
  output sample. A per-sample accumulator drifts, and drift here is a clip that
  misses the bar it was drawn against.
- **REQ-4** — `positionAt` is the **only** description of where the needle is.
  The renderer reads it, and so does the editor's preview drawing. Two derivations
  would let what is drawn diverge from what is heard, and the divergence would be
  silent.
- **REQ-5** — The result is **exactly** `outFrames` long, and `outFrames` is
  `round(steps * sixteenthDuration * sampleRate)` — the arithmetic
  [render-to-sampler](render-to-sampler.md) REQ-11 owns and
  [time-stretch](time-stretch.md) REQ-9 forbids re-deriving. A scratch that lands
  a frame off the bar is the whole failure this feature exists to avoid.
- **REQ-6** — **Pitch rides speed.** A segment held at rate 2 reads twice as fast
  and sounds an octave up; at -1 it plays backwards at pitch. This is what
  separates the feature from `fitToFrames`, and it is asserted, not assumed.
- **REQ-7** — Reads are interpolated with a 4-point **Hermite (Catmull-Rom)**
  cubic. Linear is audibly dull on the slow strokes, where the source is stretched
  up to four times; ADR-010 puts *musical* first once *cheap* is off the audio
  thread.
- **REQ-8** — Where the rate exceeds 1 in magnitude the read is **box-averaged
  over the span that output frame actually covers**, `ceil(|rate|)` taps. That box
  is a lowpass at `fs/|rate|`, which is the correct anti-alias cutoff, and it costs
  at most `MAX_SCRATCH_RATE` taps.
- **REQ-9** — A read outside the source returns **silence, never a held sample**.
  The position itself is not clamped, so a needle that runs off the record comes
  back when the curve brings it back; a clamped position would hold a DC value and
  thump.
- **REQ-10** — A segment may be marked **cut** (crossfader closed). The gate is a
  linear slew of `SCRATCH_GATE_MS`, not a hard multiply — a hard gate on a moving
  waveform clicks at both edges, and the click is what a listener hears instead of
  the rhythm.
- **REQ-11** — The result is edge-faded with `buffer-dsp`'s existing `fadeIn` /
  `fadeOut` at `SCRATCH_EDGE_MS`, the same anti-click move
  [render-to-sampler](render-to-sampler.md) REQ-8 makes, and for the same reason:
  it never changes the buffer length, so REQ-5 survives it.
- **REQ-12** — **Both channels read the identical position map.** The rule
  [time-stretch](time-stretch.md) REQ-5 records — decide from the mid, apply to
  both — is reached here trivially, because the map is derived from the curve
  alone and no per-channel decision exists. It is written down anyway: the obvious
  refactor is to run the reader per channel, that decorrelates them, and it is
  invisible in a per-channel level check.
- **REQ-13** — Every entry point is **total**. A non-finite or non-positive
  `outFrames`, an output past `MAX_STRETCH_OUTPUT_FRAMES`, an empty buffer or an
  empty curve returns a clone. Nothing throws, and **nothing is allocated before
  the bound is checked** (ADR-015). Non-finite is rejected explicitly and first,
  because the app-wide clamp idiom returns `NaN` for `NaN`
  ([untrusted-input](untrusted-input.md) REQ-6).
- **REQ-14** — Bounds live in `src/state/limits.ts` and nowhere else:
  `MAX_SCRATCH_POINTS`, `MAX_SCRATCH_RATE`, `MAX_SCRATCH_STEPS`. The output
  allocation reuses `MAX_STRETCH_OUTPUT_FRAMES`. `MIN_STRETCH_RATIO` /
  `MAX_STRETCH_RATIO` deliberately do **not** apply: the output length is chosen
  from a sixteenth count, not derived from the input length, so a two-second
  source and a one-bar scratch is an ordinary case rather than a ratio to refuse.
- **REQ-15** — The editor is a **section inside the Edit Sample modal**, revealed
  by a collapse toggle, not a second surface. It operates on the current selection
  ([sample-chop](sample-chop.md) REQ-2's rule), and a second modal owning its own
  selection, undo and preview is exactly what that spec warns drifts.

  (v2) The section is one of the modal's three, and its header follows the shape
  [sample-recorder](sample-recorder.md) REQ-9 owns: **title `Scratch` on the left,
  caret on the right**, the whole row a hit target. Until v2 the caret was appended
  *before* the title, and because the shared caret class carries `margin-left:
  auto` that pushed both to the right edge — against the visual aid below, which
  has always drawn it left. Folded, the section still pays for **no peak scan**
  ([runtime-performance](runtime-performance.md) REQ-1): the recompute is gated on
  the body's `.collapsed` class and re-run by the fold's `onChange`, so unfolding
  is what buys the scan.
- **REQ-16** — The graph is two lanes on one x-axis of **output time**, gridded in
  sixteenths with the beat accented from `engine.barTicks`
  ([meter](meter.md) REQ-7). The upper lane draws the warped result; the lower
  lane is the editable rate curve, zeroed on its centre with unity guide lines.
- **REQ-17** — The preview lane is a **remap of cached peaks, not an audio
  render**. `computePeaks` runs once per source; each output column takes the
  min/max over the source columns its position span covers. It is O(width) and
  repaints on every pointer move; audio is rendered only to audition and to apply.
- **REQ-18** — Gestures, per the inventory below: drag a point (x is timing and
  snaps to a 32nd, y is rate and snaps to quarter-rates), tap the lane to add a
  point, double-tap a point to delete it, tap a segment's band to cut the fader,
  drag the cue marker to move where the needle starts. **Shift is one decision for
  both axes** — off the time grid and off the rate steps together — so "fine"
  means the same thing whichever way the hand is moving. The rate snap is not
  cosmetic: the lane spans the model's full range, which puts unity about 15 px
  from the centre, and landing on exactly 1.00x or exactly 0 by eye would
  otherwise be luck.
- **REQ-19** — Presets are pure generators over a **normalised** time axis, so one
  definition works at any length: Baby (short-short-long, the default),
  Transformer, Chirp, Tear, Flare, Scribble, Stab, plus a random generator behind
  a dice button.
- **REQ-20** — The cue **auto-places from the curve's own excursion** so a preset
  that pulls backwards first still reads from inside the sample, and the graph
  shades any region where the needle is off the record. State the user needs is
  visible rather than remembered (ADR-014 law 5).
- **REQ-21** — Applying goes through the modal's existing `runOp`, so the busy
  latch, the one-level undo, the crop reset and the auto-play are **inherited**
  rather than reimplemented. The result lands through `SamplerMachine.setBuffer`
  ([sampler](sampler.md) REQ-6) when the user loads it into a slot, which is what
  gives it persistence and export for free.
- **REQ-22** — A scratched clip is **not renamed**. [sampler](sampler.md) REQ-7
  evicts a slot's buffer on rename, so renaming here would delete the audio just
  written — the same trap [time-stretch](time-stretch.md) REQ-13 avoids.
- **REQ-23** — Preview renders and plays **without committing**: no `working`
  mutation, no undo snapshot, no button flash.
- **REQ-24** — The feature registers **no `ParamBus` params** and persists
  **nothing** — not the curve, not the preset, not the length, and no record that
  a clip was ever scratched. [time-stretch](time-stretch.md) REQ-15 took the same
  route, and it is what keeps the song format, the validator, the published schema
  and the authoring dialect entirely out of scope.

## Technical design

### Contract / public interface

```ts
// src/audio/recorder/scratch-curve.ts — pure model + geometry
export interface ScratchPoint { t: number; v: number; cut: boolean; hold: boolean }
export interface ScratchCurve { steps: number; cue: number; points: ScratchPoint[] }
export type ScratchPresetName =
  | 'Baby' | 'Transformer' | 'Chirp' | 'Tear' | 'Flare' | 'Scribble' | 'Stab';

export function normalizeCurve(c: ScratchCurve): ScratchCurve;

// The plan is the curve with its per-segment integral already summed. Built
// once and walked, because the reader asks for a position a hundred thousand
// times and re-summing the prefix each time would be quadratic.
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

// Convenience wrappers over exactly those three, so REQ-4 holds: the reader
// walks with a segment hint, a one-off lookup does not, and both run the same
// arithmetic.
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
  t: number        # 0..1 along the scratch. Normalised so a preset works at any length.
  v: number        # playback rate. 1 = forward at pitch, 0 = stopped, negative = backwards.
  cut: boolean     # crossfader closed from this point until the next
  hold: boolean    # segment shape to the next point: false = ramp, true = hold then jump

ScratchCurve:
  steps: number    # length in sixteenths — what locks the gesture to the tempo
  cue: number      # 0..1 of the source: where the needle starts
  points: ScratchPoint[]   # sorted by t, first pinned at t = 0

reader:
  interpolation: 4-point Hermite (Catmull-Rom)
  antiAlias: box average of ceil(|rate|) taps above unity rate
  offRecord: silence, position not clamped        # REQ-9
  gateSlewMs: 1.5                                 # REQ-10
  edgeFadeMs: 3                                   # REQ-11, via buffer-dsp fadeIn/fadeOut

limits (src/state/limits.ts):
  MAX_SCRATCH_POINTS: 64
  MAX_SCRATCH_RATE: 4          # two octaves either way; also the anti-alias tap ceiling
  MAX_SCRATCH_STEPS: 64        # 4 bars in 4/4, matching the Fit row's own ceiling
  MAX_STRETCH_OUTPUT_FRAMES: reused as the output allocation bound
```

### Layer touchpoints & ordering

```yaml
src/audio/recorder/scratch-curve.ts: pure; imports limits.ts only
src/audio/recorder/scratch.ts:       pure; imports scratch-curve.ts, buffer-dsp.ts, limits.ts,
                                     node.ts (type only)
src/ui/components/scratch-graph.ts:  canvas + pointer only; takes peaks and a curve, holds no
                                     engine reference, so it tests in jsdom with a stubbed rect
src/ui/components/record-sound-modal.ts:
  scratch panel + scratch row, built AFTER the shift row (they read `working` and the
  crop the same way). Two DRY moves land with it:
    - FIT_TARGETS / framesFor / fitLabel / stepsFor hoist above the chop row so the
      Fit row and the scratch length share one sixteenth arithmetic (REQ-5)
    - playSelection() splits into playClip(clip) so Preview can audition an
      uncommitted render (REQ-23)
  apply goes through runOp(), so undo / busy / crop reset are inherited (REQ-21)
  syncScratch joins syncChop / syncFit and is called from setBusy and afterMutate
```

### Persistence

The scratched audio persists exactly as any other clip does — 16-bit WAV bytes in
IndexedDB via `setBuffer` and `onBufferChange`
([sample-persistence](sample-persistence.md) REQ-2) — once the user loads it into
a slot. Deliberately **not** persisted (REQ-24): the curve, the chosen preset, the
length, the cue, and any record that a clip was ever scratched. The curve lives
for as long as the modal is open and no longer.

The one thing stored is whether the *section is folded*, under
`websynth.ui.collapsed.sample-scratch`, because that is what the shared collapse
toggle does for every panel in the app and a scratch-heavy player should not have
to open it twice. It is a view preference, not feature state: it says nothing about
any clip and losing it costs one click.

(v2) The key was `websynth.scratch.open` in v1 — renamed when its two siblings
arrived, both to join the `websynth.ui.collapsed.*` convention
([panel-tabs](panel-tabs.md) REQ-2) and because it stored the opposite of what it
said (`'1'` meant *collapsed*). No migration: one stored `true` reverts to the
default the section had anyway, which is the cost the paragraph above already
accepts.

## Visual aids

```
editor modal, below the Fit & Shift section, folded on a first open (REQ-15)
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

folded — the resting state, and how the editor opens:
| SCRATCH                                                          >   |
```

### Gesture inventory (ADR-014)

| Control | Tap / click | Drag | Long press | Double | Keyboard |
| --- | --- | --- | --- | --- | --- |
| `scratch-head` (the whole title row) | folds / unfolds the section | — | — | — | — |
| `scratch-toggle` (the caret) | the same, and only that | — | — | — | Enter/Space when focused |
| a curve point | selects it | x = timing (snaps to a 32nd), y = rate (snaps to quarters); **Shift** frees both | — | deletes the point | — |
| empty rate lane | adds a point there | adds a point, then drags it | — | — | — |
| a segment's cut band | toggles the crossfader closed / open | — | — | — | — |
| the cue marker | — | moves where the needle starts in the source | — | returns it to auto (REQ-20) | — |
| the preview lane | auditions the current curve | — | — | — | — |
| `scratch-length` | opens the list | — | — | — | inherited from [dropdown](dropdown.md) |
| `scratch-preset` | opens the list | — | — | — | inherited from [dropdown](dropdown.md) |
| `scratch-random` | rolls a new curve | — | — | — | Enter/Space when focused |
| `scratch-preview` | renders and plays, commits nothing | — | — | — | Enter/Space when focused |
| `scratch-apply` | prints the scratch into the selection | — | — | — | Enter/Space when focused |

A `—` is a decision, not an omission. Nothing here is momentary, so nothing takes
a long press; and no control is a mode, so no gesture's outcome depends on
invisible state (ADR-014 law 2) — which is also why the header and its caret do
the same one thing rather than splitting the row into two live zones. Precedent: turntablist scratch notation for the
graph itself, and this app's own `motion-step-pad.ts` for the Shift-fine drag.
Touch-first (law 6): the point hit radius is 22 px — a 44 px target — against a
6 px drawn dot; `touchAction` is set imperatively, because `preventDefault()`
alone does not stop touch panning; and the double-tap is hand-rolled off
`pointerdown` timestamps at the 300 ms `knob.ts` already uses, because `dblclick`
is unreliable on touch.

## Scenarios (BDD)

```gherkin
Scenario: a scratch is exactly as long as the bar it was drawn against
  Given a clip of an arbitrary length and a curve of N sixteenths
  When the scratch is rendered at the current tempo
  Then the result is exactly round(N * sixteenthDuration * sampleRate) frames long
# pinned by: tests/audio/scratch.test.ts

Scenario: the section's title sits left of its caret (v2, REQ-15, regression)
  Given the editor is open on a clip
  Then the Scratch header shows "Scratch" to the LEFT of its caret
  # the caret's class carries `margin-left: auto`, so appending it first pushed
  # the title to the right edge — the whole header read as right-aligned
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

- Unit: `tests/audio/scratch-curve.test.ts`, `tests/audio/scratch.test.ts` —
  `npm test`. Pure `CapturedAudio` in and out, no `AudioContext`, borrowing the
  autocorrelation pitch estimator `tests/audio/time-stretch.test.ts` already
  justifies: zero-crossing counting rides on DC and on ripple, while
  autocorrelation measures the period the signal actually repeats at — which is
  what a claim about pitch is a claim about.
- Unit: `tests/ui/scratch-graph.test.ts` — jsdom with `getBoundingClientRect`
  stubbed (jsdom has no layout) and `setPointerCapture` optional-chained.
- In-app copy: `tests/ui/help-content.test.ts`.
- E2E: `e2e/scratch.spec.ts` — `npm run e2e`; `e2e/sample-editor-folds.spec.ts`
  for the header's alignment and its fold (REQ-15), asserted by geometry rather
  than DOM order, because the bug it regresses was an auto margin acting on an
  append order that read correctly in the source.
- Typecheck: `npm run typecheck`.
- Dev-bridge assertions: `window.__synth.engine.sampler.buffers[0].duration`
  against `engine.barTicks * engine.clock.sixteenthDuration()`.
- **By ear — the acceptance test, not the suite**
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md),
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)). Nothing automated can
  say whether this sounds like a scratch. Render an A/B through the real graph
  with the transport stopped, then compare:

  ```
  npm run bench:audio   -- --name scr-off --sample <break.wav>         --slot 0 --hits 4
  npm run bench:audio   -- --name scr-on  --sample <break-scratch.wav> --slot 0 --hits 4
  npm run bench:metrics -- --compare bench/scr-off.wav bench/scr-on.wav
  ```

  **bursts** is the metric that bears on this feature: every failure mode here is
  a discontinuity — a fader edge whose slew is too short, a direction reversal
  where position continuity broke, an off-record read that held a sample instead
  of going silent. Listen for aliasing buzz on the fast strokes and for dullness
  on the slow ones, then play it against a drum loop and check it lands on the
  bar. Then the honest test: press it twice. If the default preset does not make
  you want to press it again, the preset is wrong, not the reader.

## Open questions / future

- **A slot-row one-click scratch**, in the shape of the FIT button
  ([time-stretch](time-stretch.md) REQ-11). Blocked on the slot row's control
  cluster: its width is a constant shared with the ruler so the playhead ticks sit
  over the steps they mark, and a sixth control squeezes the filename back to a
  few characters. Wants a rethink of that cluster, not another button in it.
- **Saving a scratch.** A named curve the user can recall across sessions needs a
  song-format field, a validator range, the published JSON Schema and the
  authoring dialect ([ADR-007](../decisions/adr-007-songfile-additive-versioning.md),
  ADR-015) — four places that cannot import each other. Out of scope by REQ-24.
- **A realtime scratch** — a performance gesture on a live slot, the thing
  [sampler](sampler.md)'s open questions still name. It stays out for the reason
  that has not changed: back on the audio thread, ADR-010's *cheap* is in force
  again, and a per-voice variable-rate reader with anti-aliasing is exactly what
  that budget refuses.
