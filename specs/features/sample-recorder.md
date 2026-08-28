# Sample recorder & editor

```yaml
id: sample-recorder
status: implemented
version: 5   # v5: REQ-9 — every editor section is a titled fold: Chop and
             #     Fit & Shift join Scratch, title left, caret right
             # v4: REQ-8 — the Scratch section (scratch.md)
             # v3: REQ-7 — the Fit and Shift rows (time-stretch.md)
             # v2: REQ-6 — a session's RecorderNode is disconnected and its port
             #     handler cleared on dispose; every modal open leaked one
owner: core
related:
  - architecture
  - sampler
  - sample-chop            # the chop row this modal hosts
  - time-stretch           # the Fit / Shift rows this modal hosts
  - scratch                # the Scratch section this modal hosts
  - audio-export
  - onboarding             # REQ-9 borrows the About modal's fold idiom
  - panel-tabs             # REQ-9's `websynth.ui.collapsed.*` key convention
  - iconography            # REQ-9's caret is UI_ICONS.caretDown, not a character
  - testids
source:
  - src/ui/components/record-sound-modal.ts
  - src/ui/components/collapse-toggle.ts  # REQ-9's fold
  - src/ui/styles/record-sound.module.css
  - src/ui/styles/modal.module.css        # .sec / .secFold / .secFoldLabel
  - src/audio/recorder/mic-capture.ts
  - src/audio/recorder/buffer-dsp.ts
  - src/audio/recorder/offline-render.ts
  - src/audio/recorder/time-stretch.ts
  - src/audio/recorder/audio-buffer.ts
  - src/audio/recorder/node.ts            # CapturedAudio
  - src/ui/onboarding/help-content.ts     # the `sampler` topic names REQ-9's three headings
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
- **REQ-8** — (v4) **The modal hosts a Scratch section**, below the Shift row and
  folded away until asked for. It applies through the same `runOp` path for the
  same reason REQ-7 gives. Its editor is a 210 px canvas — too much modal to spend
  on a section most sessions never open — which makes it the most expensive of the
  three folds REQ-9 now defines, and the only one whose fold state also gates work
  (the peak scan, [scratch](scratch.md) REQ-15). Its behaviour and bounds are
  [scratch](scratch.md) REQ-15/REQ-21; what this spec owns is that it lives here.
  Two shared pieces move to serve it: the sixteenth-count arithmetic the Fit row
  used privately is hoisted above both rows, and `playSelection` splits into a
  `playClip` that can audition an uncommitted render.
- **REQ-9** — (v5) **Every section below the waveform is a titled fold**, built by
  one local factory rather than three hand-rolled headers: **Chop** (REQ-2a),
  **Fit & Shift** (REQ-7) and **Scratch** (REQ-8). Each is a wrapper holding a
  header and a body, and each obeys the same four rules:

  1. **The title is on the left, the caret on the right.** The caret is the shared
     `createCollapseToggle` chevron, whose class carries `margin-left: auto` — so
     the title is appended **first** and the caret **last**. Appending them the
     other way round is what pushed the Scratch title to the right edge before v5,
     against [scratch](scratch.md) REQ-15's own visual aid.
  2. **The whole header row is the hit target**, not the 18 px caret
     (ADR-014 law 6). The caret is the affordance; the header is the button.
  3. **All three are folded on a first open.** The editor's job at that moment is
     the waveform and the trim; every section below it is a thing the user goes
     looking for. Each remembers its own choice afterwards, under
     `websynth.ui.collapsed.sample-<chop|stretch|scratch>` — the convention
     [panel-tabs](panel-tabs.md) REQ-2 names, and the only view state in this app
     that survives a reload.
  4. **One fold idiom per modal.** The header is the About modal's
     ([onboarding](onboarding.md) REQ-17b) — `.sec` + `.secFold` + `.secFoldLabel`
     from `modal.module.css` — because a second lookalike fold in a second modal is
     how two idioms start.

  A section's `onChange` re-runs its own sync (`syncChop` / `syncFit` /
  `syncScratch`), so an unfold never reveals a stale hint, and a folded Scratch
  still pays for no peak scan.

  Because the tools are now behind a heading rather than on the page, the
  `sampler` help topic ([onboarding](onboarding.md)) names all three and says a
  heading opens them — help that describes controls the reader cannot see is worse
  than none.

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

Scenario: The editor opens with all three sections folded (v5, REQ-9)
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
- `e2e/sample-editor-folds.spec.ts` (REQ-9) — parameterised over the three
  sections: folded on a first open, title left of caret, one header toggles one
  body. The alignment is asserted by geometry, not by DOM order alone, because the
  bug it regresses was a CSS auto margin acting on an append order that *looked*
  right in the source.
- `npm test` / `npm run e2e`.

## Open questions / future

- New edit operations belong in `buffer-dsp.ts` (pure) when possible, falling back
  to `offline-render.ts` only when rendering is unavoidable.
