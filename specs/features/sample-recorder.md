# Sample recorder & editor

```yaml
id: sample-recorder
status: implemented
version: 10
owner: core
related:
  - architecture
  - sampler
  - sample-chop            # the chop row this modal hosts
  - time-stretch           # the Fit / Shift rows this modal hosts
  - scratch                # the Scratch section this modal hosts
  - audio-export
  - onboarding             # the fold idiom is the About modal's
  - panel-tabs             # the `websynth.ui.collapsed.*` key convention
  - iconography            # the fold caret is UI_ICONS.caretDown
  - testids
source:
  - src/ui/components/record-sound-modal.ts
  - src/ui/components/collapse-toggle.ts
  - src/ui/styles/record-sound.module.css
  - src/ui/styles/modal.module.css        # .sec / .secFold / .secFoldLabel
  - src/audio/recorder/mic-capture.ts
  - src/audio/recorder/buffer-dsp.ts
  - src/audio/recorder/offline-render.ts
  - src/audio/recorder/time-stretch.ts
  - src/audio/recorder/audio-buffer.ts
  - src/audio/recorder/clip-preview.ts    # ClipPreview, the audition player (StudioApi.clipPreview)
  - src/audio/recorder/node.ts            # CapturedAudio
  - src/ui/onboarding/help-content.ts     # the `sampler` topic names the three sections
```

The Sampler's "Record a sound" modal: record from the mic (or re-edit a loaded
buffer), edit, then save a file or fill a [sampler](sampler.md) slot.

## Background / Why

Pure DSP (`buffer-dsp.ts`) is **AudioContext-free**, so it is unit-testable like
[encode.ts](audio-export.md). The only `CapturedAudio ↔ AudioBuffer` bridge is
`audio-buffer.ts`. Operations that need rendering (filter, octave shift) go
through an `OfflineAudioContext` in `offline-render.ts`. Mic capture needs a
**secure context**: `localhost` qualifies, while the LAN-over-HTTP dev server does
not, and the modal says so.

## Requirements

- **REQ-record-through-a-fresh-recorder-node** — Record the mic via a *fresh*
  `RecorderNode` + a muted-gain tap to `destination`, so the zero-output sink stays
  pulled.
- **REQ-edit-in-captured-audio-space** — Edit in `CapturedAudio` space: crop /
  reverse / normalize / gain / fade in-out, plus filter / octave via
  `OfflineAudioContext`.
- **REQ-the-recorder-modal-hosts-the-chop-row** — The modal hosts the **chop row**
  ([sample-chop](sample-chop.md)). The waveform, selection handles and preview it
  needs are this modal's, and duplicating them elsewhere is what would drift.
- **REQ-save-or-load-the-recorded-result** — Save the result (through
  [encode.ts](audio-export.md)) or load it into a sampler slot.
- **REQ-a-loaded-slot-reopens-for-editing** — A loaded slot's ✎ button reopens its
  buffer in the same editor.
- **REQ-an-insecure-context-says-so** — On an insecure context, show a clear
  message instead of failing.
- **REQ-the-recorder-node-is-released-with-the-session** — (v2)
  `MicSession.dispose()` owns the session's `RecorderNode`. It disconnects the node
  (whose processor lives on the render thread) **and** clears its `port.onmessage`
  (whose closure holds the captured chunks). Otherwise every open of the modal
  leaks one. `RecorderNode.dispose()` is the node's own teardown. Disposal is
  **idempotent and terminal**: it is reachable from cancel, save and re-open, a
  double dispose does not throw, and a disposed node accepts no `start`/`stop`.
- **REQ-the-editor-owns-its-teardown** — (v6) The editor destroys the controls it
  builds, not just the resources it opens. A `Dropdown` registers `document` and
  `window` listeners that only `destroy()` removes, and the editor builds seven. So
  the modal keeps **one list of what it owns** and empties it in the `cleanup()`
  that disposes the session, the scratch graph and the `ResizeObserver`. A control
  built and not registered is the only way to leak. **It also builds nothing after
  it has closed**: a take whose stop resolves after the close is disposed and
  dropped.
- **REQ-the-waveform-redraw-is-cheap** — (v7) `redraw()` runs per frame while a
  preview plays, to move the playhead. So the peaks (a pure function of buffer and
  column count) are memoised with `createPeakCache()` in `buffer-dsp.ts`, rather
  than re-scanning the whole buffer every frame
  ([runtime-performance](runtime-performance.md) REQ-immutable-artefacts-are-shared).
  It is keyed by buffer **identity**, which is sound because every `buffer-dsp` op
  returns a NEW `CapturedAudio`; that property has its own test. It holds one entry,
  since a map would keep every intermediate edit alive.
- **REQ-the-preview-fades-like-the-slot** — The editor's preview plays a clip with
  the sampler's own edges: in over `SAMPLER_ATTACK` and out over `CHOKE_FADE`,
  finishing as the buffer runs out ([sampler](sampler.md)
  REQ-a-slot-starts-from-zero, REQ-a-slot-ends-at-zero), and a Stop mid-clip fades
  the same `CHOKE_FADE` from the level it had reached instead of cutting. The
  player is the audio layer's `ClipPreview`, reached as `StudioApi.clipPreview`, so
  the editor builds no audio graph of its own; it plays to `ctx.destination`,
  outside the master bus.
  Started and stopped raw, a selection cut mid-waveform clicked at both ends in
  the preview while the same selection played clean from its slot.
  `clipFades` in `src/audio/clip-fades.ts` is the one place the shape is written.
- **REQ-the-recorder-modal-hosts-fit-and-shift** — (v3) The modal hosts the Fit and
  Shift rows below the chop row ([time-stretch](time-stretch.md)
  REQ-the-editor-gains-a-fit-row/REQ-the-fit-row-preselects-the-nearest-target).
  Both go through the same `apply()` path, so busy latch, one-level undo and marks
  reset are inherited.
- **REQ-the-recorder-modal-hosts-scratch** — (v4) The modal hosts the Scratch
  section ([scratch](scratch.md)
  REQ-the-scratch-editor-is-a-modal-section/REQ-applying-goes-through-run-op),
  applied through `runOp`. Its 210 px canvas makes it the costliest fold, and the
  only one whose fold state also gates work (the peak scan). The sixteenth-count
  arithmetic is shared by Fit and Scratch, and `playClip` auditions an uncommitted
  render.
- **REQ-every-section-below-the-waveform-folds** — (v5) **Chop**, **Fit & Shift** and
  **Scratch** are each a titled fold from one local factory, with four rules:
  1. **Title left, caret right.** The `createCollapseToggle` chevron carries
     `margin-left: auto`, so the title is appended **first**.
  2. **The whole header row is the hit target** (ADR-014 law 6).
  3. **All three are folded on a first open**, and each remembers its choice under
     `websynth.ui.collapsed.sample-<chop|stretch|scratch>`
     ([panel-tabs](panel-tabs.md) REQ-selected-page-is-session-only's convention).
  4. **One fold idiom**: the About modal's `.sec` + `.secFold` + `.secFoldLabel`
     from `modal.module.css` ([onboarding](onboarding.md)
     REQ-the-key-list-folds-to-six-rows).

  A section's `onChange` re-runs its own sync (`syncChop` / `syncFit` /
  `syncScratch`), so an unfold never shows a stale hint. The `sampler` help topic
  names all three and says a heading opens them.

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
  createPeakCache()                        # one-entry identity memo over computePeaks
  peakDb(a): number
offline-render.ts:
  renderEffect(a, fx: RenderEffect): Promise<CapturedAudio>   # filter / octave / resample
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
Scenario: The preview fades in and out like the slot it is auditioning (REQ-the-preview-fades-like-the-slot, regression)
  Given a selection cut mid-waveform
  When it is previewed
  Then its gain ramps from 0 over SAMPLER_ATTACK and down to 0 as the buffer ends
  And a Stop mid-clip ramps to 0 over CHOKE_FADE from the level then reached
# pinned by: tests/audio/clip-fades.test.ts

Scenario: Closing the editor leaves no listeners behind (regression)
  Given the sample editor has been opened and closed twenty times
  Then the number of document-level listeners is the same as before the first open
  And no detached dropdown menu is still reachable
# pinned by: tests/ui/record-sound-modal.test.ts

Scenario: Record from the mic and load into a slot
  Given microphone permission is granted on a secure context
  When the user records, trims, and loads the result into slot 0
  Then slot 0 plays the captured audio
# pinned by: e2e/mic.spec.ts (fake device + grantPermissions)

Scenario: Closing a session releases its recorder (REQ-the-recorder-node-is-released-with-the-session, regression)
  Given a mic session is open
  When it is disposed
  Then its RecorderNode is disconnected and its port handler cleared
  And the mic tracks are stopped
# pinned by: tests/audio/recorder/mic-capture.test.ts (the session releases it),
#            tests/audio/recorder/node.test.ts (what releasing it does)

Scenario: Disposing twice is harmless (REQ-the-recorder-node-is-released-with-the-session, edge)
  Given a mic session that has already been disposed
  When dispose runs again from a different exit path
  Then nothing throws and nothing is torn down twice
  And a disposed recorder posts nothing further to its port
# pinned by: tests/audio/recorder/mic-capture.test.ts, tests/audio/recorder/node.test.ts

Scenario: The editor opens with all three sections folded (REQ-every-section-below-the-waveform-folds)
  Given a slot holding audio
  When the user opens it in the editor for the first time
  Then Chop, Fit & Shift and Scratch each show a header and no body
  And each header's title is drawn to the left of its caret
  When the user clicks one header anywhere along its row
  Then that section's body appears and the other two stay folded
# pinned by: e2e/sample-editor-folds.spec.ts

Scenario: Pure DSP is deterministic and AudioContext-free
  Given a CapturedAudio buffer
  When normalize/reverse/crop are applied
  Then the output samples match expectations with no AudioContext
# pinned by: tests/audio/buffer-dsp.test.ts

Scenario: A rendered effect changes the length it should, and only then (REQ-edit-in-captured-audio-space)
  Given a captured take
  When renderEffect applies a filter
  Then the output is the same length, through a Butterworth biquad (Q BUTTERWORTH_Q_DB)
  When it applies Octave Up (or Down) instead
  Then the take is resampled: half the length (or double), no filter in the graph
  And an empty take short-circuits rather than building a 0-frame context
# pinned by: tests/audio/recorder/offline-render.test.ts

Scenario: Insecure context is reported, not crashed (edge)
  Given the page is served over plain HTTP on the LAN
  When the user opens the record modal
  Then it shows an insecure-context message instead of throwing
# pinned by: tests/audio/recorder/mic-capture.test.ts (openMicSession refusals)

Scenario: A take that finishes after the modal closed builds no editor (REQ-the-editor-owns-its-teardown, regression)
  Given a take being stopped, its final batch still in flight
  When the modal is closed before the stop resolves
  Then the session is disposed and no editor or dropdown is built
# pinned by: tests/ui/record-sound-modal.test.ts
```

## Tests & verification

- `tests/audio/buffer-dsp.test.ts`, `tests/audio/recorder/offline-render.test.ts`
  (length math and graph shape against a stubbed context),
  `tests/audio/recorder/mic-capture.test.ts`, `tests/ui/record-sound-modal.test.ts`,
  `e2e/mic.spec.ts` (`--use-fake-device-for-media-stream` +
  `grantPermissions(['microphone'])`), `e2e/sample-editor-folds.spec.ts` (title
  position by geometry, not DOM order) — `npm test` / `npm run e2e`.

## Open questions / future

- New edit operations belong in `buffer-dsp.ts` (pure) when possible, falling back
  to `offline-render.ts` only when rendering is unavoidable.
