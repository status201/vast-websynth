# Sample recorder & editor

```yaml
id: sample-recorder
status: implemented
version: 1
owner: core
related:
  - architecture
  - sampler
  - audio-export
source:
  - src/ui/components/record-sound-modal.ts
  - src/audio/recorder/mic-capture.ts
  - src/audio/recorder/buffer-dsp.ts
  - src/audio/recorder/offline-render.ts
  - src/audio/recorder/audio-buffer.ts
  - src/audio/recorder/node.ts            # CapturedAudio
```

The Sampler's "Record a sound" modal: record from the mic (or re-edit a loaded
buffer), edit non-destructively, then save a file or fill a [sampler](sampler.md)
slot.

## Background / Why

Pure DSP (`buffer-dsp.ts`) is kept **AudioContext-free** so it is unit-testable
exactly like [encode.ts](audio-export.md); the only `CapturedAudio ↔ AudioBuffer`
bridge is `audio-buffer.ts`, which keeps `buffer-dsp` independent of Web Audio.
Operations that genuinely need rendering (filter, octave shift) go through an
`OfflineAudioContext` in `offline-render.ts`. Mic capture needs a **secure
context** — `localhost` qualifies; the LAN-over-HTTP dev server does not, and the
modal says so.

## Requirements

- **REQ-1** — Record the mic via a *fresh* `RecorderNode` + a muted-gain tap to
  `destination` (so the zero-output sink stays pulled).
- **REQ-2** — Edit in `CapturedAudio` space: crop / reverse / normalize / gain /
  fade in-out, plus filter / octave via `OfflineAudioContext`.
- **REQ-3** — Save the result (reusing [encode.ts](audio-export.md)) or load it
  into a sampler slot.
- **REQ-4** — A loaded slot exposes a ✎ button that reopens its buffer in the same
  editor.
- **REQ-5** — On an insecure context, surface a clear message instead of failing.

## Technical design

### Contract / public interface

```yaml
mic-capture.ts:
  openMicSession(ctx): Promise<MicSession>
  MicError = 'insecure-context' | 'unsupported' | 'denied' | 'no-device' | 'unknown'
  MicCaptureError extends Error
buffer-dsp.ts (pure, CapturedAudio in/out):
  cloneCaptured / crop / reverse / normalize / gain / fadeIn / fadeOut
  computePeaks(a, width): Float32Array     # waveform viz
  peakDb(a): number
offline-render.ts:
  renderEffect(a, fx: RenderEffect): Promise<CapturedAudio>   # filter / octave
audio-buffer.ts (the ONLY bridge):
  capturedToAudioBuffer(ctx, a) / audioBufferToCaptured(buf)
node.ts: CapturedAudio { ... }            # the editor's audio value type
```

### Layer touchpoints

```yaml
ui: src/ui/components/record-sound-modal.ts (built on the shared Modal)
flow: openMicSession -> record into CapturedAudio -> buffer-dsp/offline edits
      -> save (encode.ts) OR capturedToAudioBuffer -> SamplerMachine.setBuffer(slot)
re-edit: a loaded slot's ✎ -> audioBufferToCaptured -> same editor
secure context: openMicSession returns MicCaptureError('insecure-context') off HTTPS/localhost
```

## Scenarios (BDD)

```gherkin
Scenario: Record from the mic and load into a slot
  Given microphone permission is granted on a secure context
  When the user records, trims, and loads the result into slot 0
  Then slot 0 plays the captured audio
# pinned by: e2e/mic.spec.ts (fake device + grantPermissions)

Scenario: Pure DSP is deterministic and AudioContext-free
  Given a CapturedAudio buffer
  When normalize/reverse/crop are applied
  Then the output samples match expectations with no AudioContext
# pinned by: tests/audio/buffer-dsp.test.ts

Scenario: A rendered effect changes the length it should, and only then (REQ-2)
  Given a captured take
  When renderEffect applies a filter
  Then the output is the same length, through a biquad at Q 0.707
  When it applies Octave Up (or Down) instead
  Then the take is resampled: half the length (or double), no filter in the graph
  And an empty take short-circuits rather than building a 0-frame context
# pinned by: tests/audio/recorder/offline-render.test.ts

Scenario: Insecure context is reported, not crashed (edge)
  Given the page is served over plain HTTP on the LAN
  When the user opens the record modal
  Then it shows an insecure-context message instead of throwing
# pinned by: tests/audio/recorder/mic-capture.test.ts (openMicSession refusals)
```

## Tests & verification

- `tests/audio/buffer-dsp.test.ts` (pure DSP),
  `tests/audio/recorder/offline-render.test.ts` (the `OfflineAudioContext`
  effects — length math and graph shape, against a stubbed context; the filter's
  response itself is the browser's), `tests/audio/recorder/mic-capture.test.ts`
  (the `MicError` contract and the session's teardown), `e2e/mic.spec.ts`
  (`--use-fake-device-for-media-stream` + `grantPermissions(['microphone'])`).
- `npm test` / `npm run e2e`.

## Open questions / future

- New edit operations belong in `buffer-dsp.ts` (pure) when possible, falling back
  to `offline-render.ts` only when rendering is unavoidable.
