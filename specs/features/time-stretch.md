# Sample time-stretch (pitch-preserving)

```yaml
id: time-stretch
status: implemented
version: 3
owner: core
related:
  - architecture
  - sampler              # owns the buffers this retimes, and the slot row the FIT button joins
  - sample-recorder      # the editor modal that hosts the Fit / Shift rows
  - sample-chop          # the sibling op in the same modal
  - sample-persistence   # a retimed clip persists because it lands through setBuffer
  - render-to-sampler    # the bar-exact length arithmetic
  - meter                # barTicks x sixteenthDuration is what "one bar" means
  - untrusted-input      # the ratio and the output length are bounded in limits.ts
  - toast                # the quick-fit's Undo
  - dropdown
  - lazy-load-failure    # why the FIT load reports its own sentence
  - runtime-performance  # the DSP defers to the click that needs it
  - iconography
  - testids
source:
  - src/audio/recorder/fft.ts
  - src/audio/recorder/time-stretch.ts
  - src/audio/recorder/offline-render.ts
  - src/ui/components/record-sound-modal.ts
  - src/state/fit-targets.ts           # FIT_TARGETS, fitLabel, nearestTarget — the pure half of the Fit row
  - src/ui/components/collapse-toggle.ts
  - src/ui/panels/sampler-panel.ts
  - src/state/limits.ts
  - src/ui/onboarding/help-content.ts   # the `sampler` / `sampler.pitch` copy
```

Retime a sampler clip to a musical length (one bar, or a count of sixteenths)
without moving its pitch. Offline, destructive, undoable.

## Background / Why

The [sampler](sampler.md)'s only length control is `sampler.t{i}.pitch`, which is
varispeed (`playbackRate = 2**(st/12)`). So a clip made to fit the bar is out of
tune. A granular engine on the **audio thread** is what ADR-010 budgets against.
This is an *offline buffer edit*, paid once on a button press like `reverse` /
`normalize` / `renderEffect`, and hand-written (ADR-003). *Stable* stays
non-negotiable: bounded, finite output for any input. ADR-010 carries a dated note
recording this scope. Two algorithms ship: **WSOLA** keeps transients (breaks and
loops, the default), and a **phase vocoder** is smoother on sustained tonal
material.

## Requirements

- **REQ-time-stretching-is-pure** — `src/audio/recorder/time-stretch.ts` takes and
  returns `CapturedAudio` with no `AudioContext` and no DOM. The FFT is in
  `src/audio/recorder/fft.ts`, exported and testable alone.
- **REQ-two-stretch-modes** — `'rhythmic'` is **WSOLA** (the default); `'tonal'` is
  a **phase vocoder**. Mode is an argument, never persisted.
- **REQ-fit-to-frames-is-the-primary-entry** — `fitToFrames(a, targetFrames,
  mode)` returns **exactly** `targetFrames`. A float ratio would land a frame or
  two off the bar.
- **REQ-a-ratio-of-one-does-no-analysis** — A ratio of exactly 1 returns a clone
  and runs **no analysis**. This is a claim about a code path, pinned by a test.
- **REQ-both-algorithms-decide-from-the-mid** — WSOLA finds its splice offset once,
  on a mono mixdown, and splices both channels there. The vocoder derives phase
  from the mid (L+R) spectrum and applies the *same rotation* to each channel. That
  keeps per-channel magnitude and the inter-channel phase (the image). Deciding per
  channel silently decorrelates, and **no per-channel check catches it**: it
  measures fine per channel and −5.7 dB in mono. So it is pinned by a mono
  down-mix test on broadband material (pure tones do not reproduce it).
- **REQ-every-stretch-entry-point-is-total** — A non-finite, zero or negative
  ratio, an empty buffer, or a target past REQ-the-stretch-ratio-is-bounded
  returns a clone. Nothing throws, and nothing allocates before the bound is
  checked. Non-finite is rejected first, because the clamp idiom passes `NaN`
  ([untrusted-input](untrusted-input.md) REQ-no-subscriber-can-wedge-the-clock).
- **REQ-the-stretch-ratio-is-bounded** — `MIN_STRETCH_RATIO`, `MAX_STRETCH_RATIO`,
  `MAX_STRETCH_OUTPUT_FRAMES` and `MAX_PITCH_SHIFT_SEMITONES` live in
  `src/state/limits.ts` only (ADR-015). The frame cap is checked **before**
  allocating, since a ratio alone does not bound a long input.
- **REQ-pitch-shift-keeps-length** — `renderPitchShift(a, semitones, mode)`
  stretches by `2**(st/12)` and resamples by `2**(-st/12)`, so the length holds to
  within a frame. The resample reuses `offline-render.ts`'s `OfflineAudioContext` +
  `playbackRate` path through `{ kind: 'resample'; ratio }`; `octaveUp` /
  `octaveDown` are that effect at 2 and 0.5.
- **REQ-the-editor-gains-a-fit-row** — The [editor modal](sample-recorder.md) has a
  **Fit row** and a **Shift row** below the chop row. Fit targets are **sixteenth
  counts** (1–32, 48, 64), annotated with bars where they land on one (`16 · 1
  bar`), from the live `barTicks`. A target's frames are `round(count ×
  sixteenthDuration() × sampleRate)`, the [render-to-sampler](render-to-sampler.md)
  REQ-the-rendered-buffer-has-exact-length arithmetic.
- **REQ-the-fit-row-preselects-the-nearest-target** — The nearest target is
  preselected, so the ratio stays near 1. The hint states the change in full
  (`1.87 s → 2.00 s · 1.07×`). A target out of bounds disables the button with a
  `title` saying why.
- **REQ-the-slot-fit-button-is-a-quick-fit** — Each slot row with a buffer has a
  **FIT** button. One click fits to the **nearest** of ¼ / ½ / 1 / 2 / 4 bars in
  `'rhythmic'` mode. Its `title` states the outcome (`Fit to 2 bars — 1.03×`).
- **REQ-the-quick-fit-is-reversible** — A [toast](toast.md) (`fit-toast`) offers
  Undo, holding the previous `AudioBuffer` in a closure
  ([sample-chop](sample-chop.md) REQ-spreading-is-confirmed-then-reversible), with
  no confirm. **Undo reverts only the fit it offers**: it restores only while the
  slot still holds exactly the clip the fit wrote. Otherwise it would overwrite a
  newer file under that file's name ([sampler](sampler.md)
  REQ-a-slots-audio-matches-its-label). Inside the modal the one-level
  `undoSnapshot` covers it and no toast is raised.
- **REQ-a-fitted-clip-is-not-renamed** — It is the same sound at a new length, and a
  rename evicts a slot's audio ([sampler](sampler.md)
  REQ-a-slots-audio-matches-its-label).
- **REQ-the-fit-result-lands-through-set-buffer** — Through
  `SamplerMachine.setBuffer` ([sampler](sampler.md) REQ-set-buffer-is-the-one-door),
  so persistence, project export and `.needs-reload` follow unaided.
- **REQ-time-stretch-registers-no-params** — No `ParamBus` params. Target, mode
  and shift are per-operation state, so nothing reaches a file or
  `public/params.json`.
- **REQ-a-clip-is-fitted-to-one-tempo** — Nothing re-stretches on a BPM change,
  and no slot remembers a musical length.
- **REQ-the-stretch-dsp-loads-on-click** — The DSP is loaded by the click that
  needs it ([runtime-performance](runtime-performance.md)
  REQ-boot-cost-matches-the-request). A rejected import from the slot row raises a
  plain [toast](toast.md) (`fit-load-failed-toast`) with **Retry**, not
  `showLazyLoadFailure`. This is an operation, and an operation keeps its own
  sentence ("Couldn't fit the clip"; [lazy-load-failure](lazy-load-failure.md)
  REQ-lazy-scope-is-surfaces-not-operations). Inside the editor the DSP came with
  the modal.
- **REQ-fit-and-shift-share-a-folded-section** — (v2) Both rows share **one** folded
  section, `Fit & Shift` ([sample-recorder](sample-recorder.md)
  REQ-every-section-below-the-waveform-folds owns the shape). They are one question
  asked two ways: retime and keep the pitch, or repitch and keep the time. It is
  folded on a first open. The slot row's FIT stays the no-clicks path.

## Technical design

### Contract / public interface

```ts
// src/audio/recorder/fft.ts — iterative in-place radix-2, length must be a power of 2
export function fftInPlace(re: Float32Array, im: Float32Array, inverse?: boolean): void;

// src/audio/recorder/time-stretch.ts
export type StretchMode = 'rhythmic' | 'tonal';
export function timeStretch(a: CapturedAudio, ratio: number, mode?: StretchMode): CapturedAudio;
export function fitToFrames(a: CapturedAudio, targetFrames: number, mode?: StretchMode): CapturedAudio;

// src/audio/recorder/offline-render.ts
export type RenderEffect = /* … */ | { kind: 'resample'; ratio: number };
export async function renderPitchShift(
  a: CapturedAudio, semitones: number, mode?: StretchMode,
): Promise<CapturedAudio>;
```

### Data shapes

```yaml
StretchMode: rhythmic | tonal        # WSOLA | phase vocoder; rhythmic is the default

WSOLA:
  grain: 2048        # analysis window, samples
  hop: 512           # synthesis hop
  search: 512        # +/- lags scanned for the best correlation
  correlation: normalised cross-correlation on a MONO MIXDOWN
  window: Hann crossfade at each splice

PhaseVocoder:
  fftSize: 2048
  hop: 512           # 4x overlap
  window: Hann, analysis and synthesis, with the matching overlap normalisation
  phase: gradient integration per bin

limits (src/state/limits.ts):
  MIN_STRETCH_RATIO: 0.25
  MAX_STRETCH_RATIO: 4
  MAX_STRETCH_OUTPUT_FRAMES: 5760000    # 2 min at 48 kHz
  MAX_PITCH_SHIFT_SEMITONES: 12
```

### Layer touchpoints & ordering

```yaml
src/audio/recorder/fft.ts:           pure; no imports
src/audio/recorder/time-stretch.ts:  pure; imports fft.ts, limits.ts, node.ts (type only)
src/audio/recorder/offline-render.ts: 'resample' + renderPitchShift (async, OfflineAudioContext)
src/ui/components/record-sound-modal.ts:
  one `Fit & Shift` fold holding both rows, built AFTER the chop row
  both go through apply()/setBusy()/afterMutate(), so undo, the busy latch and the marks reset are inherited
src/ui/panels/sampler-panel.ts:
  FIT button per slot row, shown by refreshLabel(slot) beside the edit button;
  title recomputed there and on tempo change
```

### Persistence

The retimed audio persists like any clip ([sample-persistence](sample-persistence.md)
REQ-clip-writes-are-debounced-through-one-hook). Not persisted: target, mode, shift,
or any record that a clip was stretched.

## Visual aids

```
editor modal, below the chop section — folded on a first open
+-----------------------------------------------------------------+
| FIT & SHIFT                                                   v  |
|.................................................................|
| Fit: 1.87 s -> 2.00 s · 1.07x   [16 · 1 bar v] [Rhythmic v] [Fit]|
| Shift: pitch only, length kept  [+0 st v]                [Shift] |
+-----------------------------------------------------------------+

sampler slot row
[ Load ][ break.wav        ][FIT][*][mute]
```

### Gesture inventory (ADR-014)

| Control | Tap / click | Drag | Long press | Double | Keyboard |
| --- | --- | --- | --- | --- | --- |
| `stretch-head` (the whole title row) | folds / unfolds both rows | — | — | — | — |
| `stretch-toggle` (the caret) | the same, and only that | — | — | — | Enter/Space when focused |
| `fit-target` | opens the list | — | — | — | inherited from [dropdown](dropdown.md) |
| `fit-mode` | opens the list | — | — | — | inherited from [dropdown](dropdown.md) |
| `fit-apply` | fits the selection to the target | — | — | — | Enter/Space when focused |
| `shift-amount` | opens the list | — | — | — | inherited from [dropdown](dropdown.md) |
| `shift-apply` | shifts pitch, keeps length | — | — | — | Enter/Space when focused |
| `sampler-fit-<slot>` | fits to the nearest bar length, raises the Undo toast | — | — | — | Enter/Space when focused |

A `—` is a decision: nothing here is continuous, and a second press is a second
undoable edit. The fold is the app's `createCollapseToggle`, unchanged.

## Scenarios (BDD)

```gherkin
Scenario: Fit and Shift open together, and start closed (REQ-fit-and-shift-share-a-folded-section)
  Given a slot holding audio
  When the user opens it in the editor for the first time
  Then the Fit & Shift header is visible and neither row is
  When the user clicks the header
  Then both the Fit row and the Shift row appear
# pinned by: e2e/sample-editor-folds.spec.ts, e2e/time-stretch.spec.ts

Scenario: a clip is fitted to an exact target length
  Given a captured clip of an arbitrary length
  When it is fitted to N sixteenths at the current tempo
  Then the result is exactly round(N * sixteenthDuration * sampleRate) frames long
# pinned by: tests/audio/time-stretch.test.ts

Scenario: pitch survives the stretch
  Given a 440 Hz sine
  When it is stretched to twice its length in either mode
  Then the result is twice as long and still measures 440 Hz
# pinned by: tests/audio/time-stretch.test.ts

Scenario: a ratio of 1 runs no analysis
  Given any clip
  When it is stretched by exactly 1
  Then the result is a clone, sample for sample
# pinned by: tests/audio/time-stretch.test.ts

Scenario: the stereo image survives (edge)
  Given a broadband clip whose channels are correlated but not identical
  When it is stretched in either mode
  Then the mono down-mix keeps its level — the channels stayed coherent
# pinned by: tests/audio/time-stretch.test.ts

Scenario: hostile ratios are refused, not thrown (failure)
  Given a clip
  When it is stretched by NaN, 0, a negative, or a ratio past the limits
  Then a clone comes back, nothing throws, and no oversized buffer is allocated
# pinned by: tests/audio/time-stretch.test.ts

Scenario: pitch-shift keeps the length
  Given a clip
  When it is shifted by +7 semitones
  Then the result is the same length to within a frame
# pinned by: tests/audio/recorder/offline-render.test.ts

Scenario: a quick fit is one click and undoable
  Given a sampler slot holding a clip
  When FIT is pressed on its row and then Undo on the toast
  Then the slot's buffer is retimed and then restored, and its name never changed
# pinned by: e2e/time-stretch.spec.ts

Scenario: fitting from the editor lands a bar-exact clip in the slot
  Given a clip open in the editor
  When it is fitted to one bar and loaded into a slot
  Then the slot's buffer duration equals barTicks * sixteenthDuration
# pinned by: e2e/time-stretch.spec.ts

Scenario: the app explains the feature it shipped (docs)
  Given the Sampler help topic
  Then it names FIT, both modes, and that the pitch does not move
  And the slot PITCH topic points at Fit and Shift for one without the other
# pinned by: tests/ui/help-content.test.ts

Scenario: The fit's Undo does not overwrite a newer clip (REQ-the-quick-fit-is-reversible, regression)
  Given a slot that was just fitted, its Undo toast still showing
  When another file is loaded into that slot and then Undo is pressed
  Then the new file's audio stays, and Undo changes nothing
   And with the fitted clip still in place, Undo restores the pre-fit audio as before
# pinned by: tests/ui/sampler-panel.test.ts
```

## Tests & verification

- Unit: `tests/audio/fft.test.ts`, `tests/audio/time-stretch.test.ts`,
  `tests/audio/recorder/offline-render.test.ts`, `tests/ui/sampler-panel.test.ts`,
  `tests/ui/help-content.test.ts` (help text has no other gate) — `npm test`.
- E2E: `e2e/time-stretch.spec.ts` (unfolds the section first),
  `e2e/sample-editor-folds.spec.ts` (the fold itself).
- **By ear — the acceptance test** (ADR-010,
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)), transport stopped:

  ```
  npm run bench:audio  -- --name fit-off --sample <break.wav>        --slot 0 --hits 4
  npm run bench:audio  -- --name fit-on  --sample <break-fitted.wav> --slot 0 --hits 4
  npm run bench:metrics -- --compare bench/fit-off.wav bench/fit-on.wav
  ```

  **bursts** (splice discontinuities) and **harmonic-comb dominance** (diffuse
  material forced onto a pitch) are the metrics. Listen on a break, a pad and a
  voice, near 1 and at both bounds.

## Open questions / future

- **Tempo-following slots** need a persisted param, the pristine buffer kept beside
  the stretched one, and the re-stretch off the main thread (ADR-018: a main-thread
  rebuild stalls mid-song). Out of scope (REQ-a-clip-is-fitted-to-one-tempo).
- **Chop at the grid**: fit to a bar, then chop into 16 equal slices, which may make
  a dedicated control unnecessary ([sample-chop](sample-chop.md)).
- **Transient-aware WSOLA** (splices pinned to `detectOnsets`), only if the by-ear
  pass finds large-ratio drum stretches unclean.
