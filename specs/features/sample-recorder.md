# Sample recorder & editor

```yaml
id: sample-recorder
status: implemented
version: 3   # v3: REQ-7 — the Fit and Shift rows (time-stretch.md)
             # v2: REQ-6 — a session's RecorderNode is disconnected and its port
             #     handler cleared on dispose; every modal open leaked one
owner: core
related:
  - architecture
  - sampler
  - sample-chop            # the chop row this modal hosts
  - time-stretch           # the Fit / Shift rows this modal hosts
  - audio-export
source:
  - src/ui/components/record-sound-modal.ts
  - src/audio/recorder/mic-capture.ts
  - src/audio/recorder/buffer-dsp.ts
  - src/audio/recorder/offline-render.ts
  - src/audio/recorder/time-stretch.ts
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
- **REQ-2a** — The same modal hosts the **chop row** ([sample-chop](sample-chop.md)):
  cut the current selection into slices, drag the boundaries on the waveform this
  spec already draws, and spread them across the sampler's slots. It lives here
  rather than on the panel because the waveform, the selection handles and the
  preview it needs are all REQ-2's, and duplicating them elsewhere is the thing
  that would drift.

- **REQ-3** — Save the result (reusing [encode.ts](audio-export.md)) or load it
  into a sampler slot.
- **REQ-4** — A loaded slot exposes a ✎ button that reopens its buffer in the same
  editor.
- **REQ-5** — On an insecure context, surface a clear message instead of failing.
- **REQ-6** — (v2) **A session's `RecorderNode` is released with the session.**
  REQ-1's node is *fresh per session*, so unlike the engine's two permanently
  tapped recorders it has an end — and `MicSession.dispose()` owns it. Disposing
  disconnects the node **and** clears its `port.onmessage`, because the two leak
  different things: the `AudioWorkletNode` keeps its processor alive on the render
  thread, and the message handler keeps the closure holding the captured chunk
  arrays alive on the main thread.

  Until v2 `dispose()` released the `MediaStreamAudioSourceNode`, the muted gain
  and the OS mic tracks but not the recorder, so **every open of the modal left one
  behind** — the leak grows with how often the player records, which is exactly the
  usage the feature invites. `RecorderNode.dispose()` is the node's own teardown so
  the knowledge of what it holds stays with it rather than at the call site.
- **REQ-7** — (v3) **The modal hosts a Fit row and a Shift row**, below the chop
  row: retime the selection to a musical length with its pitch preserved, and
  shift its pitch with its length preserved. Both go through the same `apply()`
  path as every other effect button, so the busy latch, the one-level undo and
  the marks reset that follow an edit are inherited rather than reimplemented.
  The behaviour and its bounds are [time-stretch](time-stretch.md)
  REQ-9/REQ-10; what this spec owns is that this modal is where they live — for
  the reason the [chop row](sample-chop.md) is here too: the waveform, the crop
  handles, the preview and the undo already exist in this modal, and a second
  surface that rebuilt them is a second surface that drifts from them.

  Disposal is **idempotent and terminal**: it is reachable from a cancel, a save
  and a re-open, and a double dispose must not throw. A disposed node accepts no
  further `start`/`stop`.

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

Scenario: Closing a session releases its recorder (v2, REQ-6, regression)
  Given a mic session is open
  When it is disposed
  Then its RecorderNode is disconnected and its port handler cleared
  And the mic tracks are stopped
  # otherwise each modal open strands a worklet node + its captured chunks
# pinned by: tests/audio/recorder/mic-capture.test.ts (the session releases it),
#            tests/audio/recorder/node.test.ts (what releasing it does)

Scenario: Disposing twice is harmless (v2, REQ-6, edge)
  Given a mic session that has already been disposed
  When dispose runs again from a different exit path
  Then nothing throws and nothing is torn down twice
  And a disposed recorder posts nothing further to its port
# pinned by: tests/audio/recorder/mic-capture.test.ts, tests/audio/recorder/node.test.ts

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
