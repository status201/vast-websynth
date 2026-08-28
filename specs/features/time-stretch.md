# Sample time-stretch (pitch-preserving)

```yaml
id: time-stretch
status: implemented
version: 2 # v2: REQ-18 — the Fit and Shift rows share one titled fold
           # v1: Fit / Shift in the editor, and the slot-row FIT button
owner: core
related:
  - architecture
  - sampler              # owns the buffers this retimes, and the slot row the FIT button joins
  - sample-recorder      # the editor modal that hosts the Fit / Shift rows
  - sample-chop          # the sibling op in the same modal; "chop at the grid" is its open question
  - sample-persistence   # a retimed clip persists because it lands through setBuffer
  - render-to-sampler    # the existing bar-exact length arithmetic
  - meter                # barTicks x sixteenthDuration is what "one bar" means
  - untrusted-input      # the ratio and the output length are bounded in limits.ts
  - toast                # the quick-fit's Undo
  - dropdown
  - lazy-load-failure    # REQ-17: why the FIT load reports its own sentence
  - runtime-performance  # REQ-17: the DSP defers to the click that needs it
  - iconography          # REQ-18's caret is an inline SVG, not a character
  - testids
source:
  - src/audio/recorder/fft.ts
  - src/audio/recorder/time-stretch.ts
  - src/audio/recorder/offline-render.ts
  - src/ui/components/record-sound-modal.ts
  - src/ui/components/collapse-toggle.ts  # REQ-18's fold
  - src/ui/panels/sampler-panel.ts
  - src/state/limits.ts
  - src/ui/onboarding/help-content.ts   # the `sampler` / `sampler.pitch` copy
```

Retime a sampler clip to a musical length — one bar, or a count of sixteenths —
without moving its pitch. Offline, destructive, undoable.

## Background / Why

The [sampler](sampler.md) plays a clip at whatever length it was recorded. The
only control that changes that length is `sampler.t{i}.pitch`, which is varispeed
(REQ-13: `playbackRate = 2**(st/12)`, "a pitched hit also changes length"). So a
clip that has been made to fit the bar is a clip that is out of tune, and there
is no route from *"this break is 1.87 s"* to *"this break is one bar"*.

**This spec reverses a decision recorded in [sampler](sampler.md)'s open
questions**, which read: *"True time-stretch stays out: it needs a granular engine
(ADR-010) and no dependency is available to supply one (ADR-003)."* That
rejection is correct **for the audio thread**, which is what
[ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md) budgets: per-sample
work multiplied by every voice and every live instance. This feature is not on
the audio thread. It is an *offline buffer edit* — paid once, on a button press,
with the modal's controls disabled — in the same family as the existing
`reverse` / `normalize` / `renderEffect` ops, and answering to the same budget
they do. [ADR-003](../decisions/adr-003-no-runtime-dependencies.md) is satisfied
by writing the algorithms by hand rather than by adding a dependency. ADR-010's
*stable* priority is untouched and still non-negotiable: bounded, finite output
for any input at any setting. That reconciliation is recorded as a dated note on
ADR-010 itself.

Two algorithms ship, because one does not cover the material. **WSOLA** keeps
transients intact and is right for the breaks and loops people actually fit to a
bar; a **phase vocoder** is smoother on sustained tonal material and washes drums
out. The user picks, and the default is the rhythmic one.

## Requirements

- **REQ-1** — Time-stretching is **pure**: `src/audio/recorder/time-stretch.ts`
  takes and returns `CapturedAudio` with no `AudioContext` and no DOM, so it unit
  tests under vitest+jsdom exactly like `buffer-dsp.ts`. It is a sibling module
  rather than more of `buffer-dsp.ts`, whose helpers are all one-screen; the FFT
  it needs lives in `src/audio/recorder/fft.ts` and is exported so it is testable
  on its own.
- **REQ-2** — Two modes. `'rhythmic'` is **WSOLA** (waveform-similarity
  overlap-add) and is the default; `'tonal'` is a **phase vocoder**. Mode is an
  argument, never persisted state.
- **REQ-3** — `fitToFrames(a, targetFrames, mode)` is the primary entry and its
  output length is **exactly** `targetFrames`. Deriving the length from a float
  ratio instead would put a clip one or two frames off the bar, which is the
  whole point of the feature.
- **REQ-4** — A ratio of exactly 1 returns a clone and runs **no analysis**. Like
  [sampler](sampler.md) REQ-13, this is a claim about a *code path*, not about a
  value, and it is pinned by a test.
- **REQ-5** — **Both algorithms decide from the mid and apply to both channels.**
  WSOLA searches for its splice offset once, on a mono mixdown, and splices both
  channels at it; the phase vocoder derives its phase from the mid (L+R) spectrum
  and applies the *same rotation* to each channel, so per-channel magnitudes and
  the phase difference between the channels — the stereo image — both survive.
  Deciding per channel is the obvious shape and it silently decorrelates them.
  **No per-channel assertion catches it**: the version that got this wrong
  measured −0.2 dB on each channel alone and **−5.7 dB in mono** on a rendered
  bar, which is also how `bench:metrics` measures a take. It is pinned by a
  mono-down-mix test on broadband material — pure tones do not reproduce it,
  because both channels then carry the same phase in every bin.
- **REQ-6** — Every entry point is **total**: a non-finite, zero or negative
  ratio, an empty buffer, or a target that would exceed the bounds of REQ-7
  returns a clone. Nothing throws, and nothing allocates before the bound is
  checked. The app-wide `max(min, min(max, v))` idiom returns `NaN` for `NaN`
  ([untrusted-input](untrusted-input.md) REQ-6), so non-finite input is rejected
  explicitly first.
- **REQ-7** — The ratio and the output frame count are bounded in
  `src/state/limits.ts` (`MIN_STRETCH_RATIO`, `MAX_STRETCH_RATIO`,
  `MAX_STRETCH_OUTPUT_FRAMES`, `MAX_PITCH_SHIFT_SEMITONES`) and nowhere else —
  [ADR-015](../decisions/adr-015-untrusted-input-is-bounded.md)'s rule that a
  bound is written down once. The frame cap is checked **before** the output is
  allocated: a ratio alone does not bound an allocation when the input is already
  long.
- **REQ-8** — Pitch-shift keeps length: `renderPitchShift(a, semitones, mode)`
  stretches by `2**(st/12)` and resamples by `2**(-st/12)`, so the result is the
  input's length to within a frame. The resample half reuses
  `offline-render.ts`'s existing `OfflineAudioContext` + `playbackRate` path
  through a generalised `{ kind: 'resample'; ratio }` effect, rather than a
  hand-rolled interpolator — `octaveUp` / `octaveDown` are already that effect at
  ratio 2 and 0.5 and keep working unchanged.
- **REQ-9** — The [editor modal](sample-recorder.md) gains a **Fit row** and a
  **Shift row** below the chop row. The Fit row offers target lengths as
  **sixteenth counts** (1–32, plus 48 and 64), each annotated with its bar
  equivalent where it lands on one (`16 · 1 bar`), derived from the live
  `barTicks` so a 3/4 or 7/8 song labels correctly. A target's length in frames
  is `round(count × sixteenthDuration() × sampleRate)` — the same arithmetic
  [render-to-sampler](render-to-sampler.md) REQ-1 uses, never a re-derivation.
- **REQ-10** — The Fit row **preselects the target nearest the clip's current
  length**, so the offered action is almost always the wanted one and the ratio
  stays near 1. Its hint states the transformation in full
  (`1.87 s → 2.00 s · 1.07×`), and when a target falls outside REQ-7's bounds the
  button is disabled with a `title` that says why — the house rule that a
  disabled control always states its reason.
- **REQ-11** — Every sampler slot row carries a **FIT** button, shown under the
  same condition as the ✎ button (a buffer exists). One click fits the clip to
  the **nearest** musical length among ¼ / ½ / 1 / 2 / 4 bars — never literally
  one bar, which on a 3.9-bar clip would be a 0.26× smear — in `'rhythmic'` mode.
  Its `title` states the outcome it will produce (`Fit to 2 bars — 1.03×`).
- **REQ-12** — The quick fit is **reversible without a confirm**: a
  [toast](toast.md) (`fit-toast`) offers Undo holding the previous `AudioBuffer`
  in a closure, as [sample-chop](sample-chop.md) REQ-6's spread does. A confirm
  dialog would defeat a one-click action; the pattern-undo stack carries steps
  and never audio, so the action owns its own reversal. Inside the modal the
  existing one-level `undoSnapshot` covers it and no toast is raised.
- **REQ-13** — A fitted clip is **not renamed**. It is the same sound at a new
  length, and [sampler](sampler.md) REQ-7 makes a rename evict the slot's audio.
- **REQ-14** — The result lands through `SamplerMachine.setBuffer`
  ([sampler](sampler.md) REQ-6), so IndexedDB persistence, project-zip export and
  the `.needs-reload` bookkeeping all follow with no knowledge of stretching.
- **REQ-15** — The feature registers **no `ParamBus` params**. Target, mode and
  shift amount are per-operation state owned by the surface that offers them.
  Nothing reaches a preset, a song, a share link or `public/params.json`, so
  [ADR-006](../decisions/adr-006-no-op-param-defaults.md) has no surface here and
  `npm run check:params` is unaffected.
- **REQ-16** — A fitted clip is fitted **to the tempo it was fitted at**. Nothing
  re-stretches when the BPM changes, and no slot remembers a musical length.
- **REQ-17** — The DSP is **loaded by the click that needs it**
  ([runtime-performance](runtime-performance.md) REQ-1) — most players never press
  FIT, and the two algorithms plus the FFT are not boot cost anyone should pay.
  A rejected import reports through a plain [toast](toast.md)
  (`fit-load-failed-toast`) with a **Retry**, **not** through
  `showLazyLoadFailure`: this import sits inside an *operation*, and
  [lazy-load-failure](lazy-load-failure.md) REQ-5 scopes that helper to imports
  that **open a surface**, keeping operations with their own feature and their own
  sentence. "Couldn't open the time-stretcher" names nothing the user asked for;
  "Couldn't fit the clip" does. The same split `lamejs` and `jsqr` already take.
  Inside the editor no such branch exists — the modal is already loaded, and the
  DSP came with it.

- **REQ-18** — (v2) **The Fit and Shift rows share one folded, titled section**
  headed `Fit & Shift`. The shape and its rules are
  [sample-recorder](sample-recorder.md) REQ-9, which owns them for all three of the
  modal's sections. What this spec owns is that the two rows are **one** fold and
  not two: they are the same question asked twice — retime and keep the pitch, or
  repitch and keep the time — and splitting them would make the user open two
  sections to find out which one they wanted. The section is **folded on a first
  open**; the slot row's FIT button (REQ-11) is unaffected and remains the
  no-clicks-at-all path for the common case.

## Technical design

### Contract / public interface

```ts
// src/audio/recorder/fft.ts — iterative in-place radix-2, length must be a power of 2
export function fftInPlace(re: Float32Array, im: Float32Array, inverse?: boolean): void;

// src/audio/recorder/time-stretch.ts
export type StretchMode = 'rhythmic' | 'tonal';
export function timeStretch(a: CapturedAudio, ratio: number, mode?: StretchMode): CapturedAudio;
export function fitToFrames(a: CapturedAudio, targetFrames: number, mode?: StretchMode): CapturedAudio;

// src/audio/recorder/offline-render.ts (added)
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
  correlation: normalised cross-correlation on a MONO MIXDOWN (REQ-5)
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
src/audio/recorder/offline-render.ts: adds 'resample' + renderPitchShift (async, OfflineAudioContext)
src/ui/components/record-sound-modal.ts:
  one `Fit & Shift` fold (sample-recorder.md REQ-9) holding BOTH rows (REQ-18)
  fit row + shift row, built AFTER the chop row (they read `working` and the crop the same way)
  both go through the existing apply()/setBusy()/afterMutate() path, so undo,
  the busy latch and the marks reset are inherited rather than reimplemented
src/ui/panels/sampler-panel.ts:
  FIT button per slot row, visibility driven by the existing refreshLabel(slot)
  alongside the edit button; title recomputed there and on clock tempo change
```

### Persistence

Nothing new is persisted. The retimed audio persists exactly as any other clip
does — 16-bit WAV bytes in IndexedDB via `setBuffer` → `onBufferChange`
([sample-persistence](sample-persistence.md) REQ-2). Deliberately **not**
persisted: the chosen target, the mode, the shift amount, and any record that a
clip was ever stretched (REQ-16).

## Visual aids

```
editor modal, below the chop section — folded on a first open (REQ-18)
+-----------------------------------------------------------------+
| FIT & SHIFT                                                   v  |
|.................................................................|
| Fit: 1.87 s -> 2.00 s · 1.07x   [16 · 1 bar v] [Rhythmic v] [Fit]|
| Shift: pitch only, length kept  [+0 st v]                [Shift] |
+-----------------------------------------------------------------+

folded:
| FIT & SHIFT                                                   >  |

sampler slot row (210px control cluster)
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

A `—` here is a decision, not an omission: none of these controls is continuous,
so none takes a drag, and a second press is simply a second edit (each one
undoable in turn) rather than a distinct gesture. The header and its caret are
**one gesture, one outcome** (ADR-014 law 2) — the caret does nothing the header
does not — and the fold's precedent (law 4) is the app's own
`createCollapseToggle`, used unchanged.

## Scenarios (BDD)

```gherkin
Scenario: Fit and Shift open together, and start closed (v2, REQ-18)
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
```

## Tests & verification

- Unit: `tests/audio/fft.test.ts`, `tests/audio/time-stretch.test.ts`,
  `tests/audio/recorder/offline-render.test.ts` — `npm test`
- In-app copy: `tests/ui/help-content.test.ts` — the `sampler` and
  `sampler.pitch` topics. Help text has no other gate, so what the app *claims*
  about this feature is pinned like any other contract.
- E2E: `e2e/time-stretch.spec.ts` — `npm run e2e`. Its editor tests unfold the
  section first (REQ-18); `e2e/sample-editor-folds.spec.ts` is what asserts the
  fold itself.
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.engine.sampler.buffers[0].duration`
- **By ear — the acceptance test, not the suite**
  ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md),
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md)). A cycle-based
  process is precisely the class of change that measures clean and sounds wrong.
  Render an A/B through the real graph with the transport stopped, then compare:

  ```
  npm run bench:audio  -- --name fit-off --sample <break.wav>        --slot 0 --hits 4
  npm run bench:audio  -- --name fit-on  --sample <break-fitted.wav> --slot 0 --hits 4
  npm run bench:metrics -- --compare bench/fit-off.wav bench/fit-on.wav
  ```

  The two metrics that bear on this feature are **bursts** (splice
  discontinuities — the overlap-add failure) and **harmonic-comb dominance**,
  which detects diffuse material being forced onto a pitch: the classic failure
  of any grain-based process. Listen on a drum break, a sustained pad and a
  voice, at ratios near 1 and at both bounds.

## Open questions / future

- **Tempo-following slots** — a slot that remembers its musical length and
  re-stretches when the BPM changes. Needs a persisted param, the pristine buffer
  kept beside the stretched one, and the re-stretch moved off the main thread:
  [ADR-018](../decisions/adr-018-audio-graph-memory-is-committed-not-reclaimed.md)
  warns that a main-thread rebuild is an audible stall mid-song. Deliberately out
  of scope here (REQ-16).
- **Chop at the grid** — [sample-chop](sample-chop.md)'s own open question. Once a
  break can be fitted to a bar, chopping it into 16 equal sixteenths *is* the
  grid chop, so the two features now meet; a dedicated control may no longer be
  worth its own surface.
- **Transient-aware WSOLA** — pinning splices to the onsets `detectOnsets`
  already finds, instead of to correlation peaks, would sharpen drum stretches at
  large ratios. Only worth it if the by-ear pass says the ratios people actually
  use are not already clean.
