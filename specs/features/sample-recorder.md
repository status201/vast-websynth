# Sample recorder & editor

```yaml
id: sample-recorder
status: implemented
version: 12
owner: core
related:
  - architecture
  - sampler
  - sample-chop            # the Chop tab this studio hosts
  - time-stretch           # the Fit & Shift tab this studio hosts
  - scratch                # the Scratch tab this studio hosts
  - vocoder                # the Vocoder tab this studio hosts
  - metronome              # the beat light, the click and the count-in
  - transport-window       # Play goes through the header's own button
  - panel-tabs             # the tab strip, reused unchanged
  - add-a-modal-dialog     # Modal's close guard and ✕
  - dialog                 # the discard confirmations
  - toast                  # the Load undo
  - audio-export
  - iconography            # mic / record / stop / download / close are inline SVG
  - responsive-machine-header  # where the Sampler's record button sits
  - testids
source:
  - src/ui/components/record-sound-modal.ts  # the frame, the guard, the material, the Edit screen
  - src/ui/components/record-screen.ts      # the Record screen: mic, meter, count-in, bound
  - src/ui/components/studio-waveform.ts    # the waveform, crop handles and boundary drags
  - src/ui/components/studio-tools.ts       # four of the tool pages, and the ToolContext they share
  - src/ui/components/studio-vocoder.ts     # the fifth page: the Vocoder and its voice take
  - src/ui/components/studio-kit.ts         # inks, canvas sizing, readouts the screens share
  - src/ui/components/studio-transport.ts  # the toolbar's Play / beat light / BPM / CLICK
  - src/state/edit-history.ts              # EditHistory, the undo stack
  - src/ui/panels/step-panel-scaffold.ts   # samplerSlotFilled / snapshotSamplerSlot / writeSamplerSlot
  - src/ui/styles/record-sound.module.css
  - src/ui/components/panel-tabs.ts
  - src/audio/recorder/mic-capture.ts
  - src/audio/recorder/buffer-dsp.ts
  - src/audio/recorder/offline-render.ts
  - src/audio/recorder/time-stretch.ts
  - src/audio/recorder/audio-buffer.ts
  - src/audio/recorder/clip-preview.ts    # ClipPreview, the audition player (StudioApi.clipPreview)
  - src/audio/recorder/node.ts            # CapturedAudio
  - src/ui/onboarding/help-content.ts     # the `sampler` topic describes the studio
```

The Sampler's **sample studio**: record from the mic (or re-edit a loaded
buffer), edit, then load the result into a [sampler](sampler.md) slot or download
it. It has two screens over one frame: **Record** and **Edit**.

## Background / Why

Pure DSP (`buffer-dsp.ts`) is **AudioContext-free**, so it is unit-testable like
[encode.ts](audio-export.md). The only `CapturedAudio ↔ AudioBuffer` bridge is
`audio-buffer.ts`. Operations that need rendering (filter, octave shift) go
through an `OfflineAudioContext` in `offline-render.ts`. Mic capture needs a
**secure context**: `localhost` qualifies, while the LAN-over-HTTP dev server does
not, and the studio says so.

The studio is the one place a user's own audio exists before it is in a slot, so
its first duty is not to lose it. Everything that can end the studio either
asks first or leaves a way back.

## Requirements

- **REQ-record-through-a-fresh-recorder-node** — Record the mic via a *fresh*
  `RecorderNode` + a muted-gain tap to `destination`, so the zero-output sink stays
  pulled.
- **REQ-edit-in-captured-audio-space** — Edit in `CapturedAudio` space: crop /
  reverse / normalize / gain / fade in-out, plus filter / octave via
  `OfflineAudioContext`.
- **REQ-the-recorder-modal-hosts-the-chop-row** — The studio hosts the **chop row**
  ([sample-chop](sample-chop.md)). The waveform, selection handles and preview it
  needs are this studio's, and duplicating them elsewhere is what would drift.
- **REQ-save-or-load-the-recorded-result** — Save the result (through
  [encode.ts](audio-export.md)) or load it into a sampler slot.
- **REQ-a-loaded-slot-reopens-for-editing** — A loaded slot's ✎ button reopens its
  buffer in the same studio, straight on the Edit screen.
- **REQ-an-insecure-context-says-so** — On an insecure context, show a clear
  message instead of failing.
- **REQ-the-recorder-node-is-released-with-the-session** — (v2)
  `MicSession.dispose()` owns the session's `RecorderNode` and its level tap. It
  disconnects the node (whose processor lives on the render thread) **and** clears
  its `port.onmessage` (whose closure holds the captured chunks). Otherwise every
  open of the studio leaks one. `RecorderNode.dispose()` is the node's own
  teardown. Disposal is **idempotent and terminal**: it is reachable from cancel,
  save and re-open, a double dispose does not throw, and a disposed node accepts
  no `start`/`stop`.
- **REQ-the-editor-owns-its-teardown** — (v6) The studio destroys what it builds,
  not just the resources it opens. A `Dropdown` registers `document` and `window`
  listeners that only `destroy()` removes, and the tab strip owns a listener set,
  so the studio keeps **one list of what it owns** and empties it in the
  `cleanup()` that also disposes the session, the scratch graph, the
  `ResizeObserver`, the metronome hold, the clock subscriptions, the meter's
  animation frame and the studio's key handler. A control built and not
  registered is the only way to leak. **It also builds nothing after it has
  closed**: a take whose stop resolves after the close is disposed and dropped.
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
- **REQ-the-recorder-modal-hosts-fit-and-shift** — (v3) The studio hosts the Fit and
  Shift rows ([time-stretch](time-stretch.md)
  REQ-the-editor-gains-a-fit-row/REQ-the-fit-row-preselects-the-nearest-target).
  Both go through the same `runOp()` path, so busy latch, undo and marks reset are
  inherited.
- **REQ-the-recorder-modal-hosts-scratch** — (v4) The studio hosts the Scratch
  tab ([scratch](scratch.md)
  REQ-the-scratch-editor-is-a-modal-section/REQ-applying-goes-through-run-op),
  applied through `runOp`. Its 210 px canvas makes it the costliest tab, and its
  visibility gates work (the peak scan), as the Vocoder's does
  (REQ-the-recorder-modal-hosts-the-vocoder). The sixteenth-count
  arithmetic is shared by Fit and Scratch, and `playClip` auditions an uncommitted
  render.
- **REQ-the-recorder-modal-hosts-the-vocoder** — (v12) The studio hosts the
  Vocoder tab ([vocoder](vocoder.md) REQ-the-studio-hosts-a-vocoder-tab). Apply
  goes through `runOp`. The page's voice take plays its cue through the same
  `playClip`, and moves the waveform's playhead through `ToolContext.setPlayhead`,
  because the cue pass is longer than the selection it sweeps. The take's mic
  session is the page's own, released in `teardownScreen` like the scratch graph
  (REQ-the-editor-owns-its-teardown). Its voice lane scans peaks, so it paints
  only while the tab shows, and waits `LANE_SETTLE_MS` for a crop drag to settle:
  a Stretch to fit voice is re-stretched whenever the selection's length moves.
- **REQ-the-tools-are-tabs** — (v12) Under the waveform, the tools are **five
  tabs**: **Effects** (cutoff, the effect buttons, auto-play), **Chop**, **Fit &
  Shift**, **Scratch** and **Vocoder**, from `createPanelTabs` with prefix `sample`
  ([panel-tabs](panel-tabs.md)). One page shows at a time, so opening a tool
  never pushes the waveform, the edit bar or the footer out of view. **Effects**
  is selected on a first open, and the selected tab is remembered for the session
  only, never persisted ([panel-tabs](panel-tabs.md)
  REQ-selected-page-is-session-only). A tab change re-runs that page's `sync`
  (`ToolPage.sync`, studio-tools.ts), so a page is never shown with a stale hint. The `sampler` help topic names the five tabs.
- **REQ-the-studio-fills-the-screen** — (v11) The studio is a near-full-screen
  card: 16 px inside the viewport on desktop, edge to edge at ≤720 px. It is a
  column of three bands:
  - the **toolbar** (screen breadcrumb `Record › Edit` + the transport strip,
    REQ-the-transport-is-in-reach),
  - the **screen**, which alone scrolls, and only vertically: what overhangs
    its sides (the crop handles, centred on the waveform's edges) is clipped,
    never a sideways scroll,
  - the **footer**, which holds the screen's actions.

  The waveform grows with the card instead of being a fixed 160 px.
- **REQ-nothing-closes-the-studio-by-accident** — (v11) A backdrop click does
  nothing (`dismissOnBackdrop: false`). Escape and the title's ✕ go through
  `Modal`'s `beforeClose` guard:
  - **Unsaved audio** asks first: *Discard this recording?* [Keep editing]
    [Discard]. In edit mode it asks *Discard your changes?*, and the slot keeps
    its sound.
  - **A take in progress** asks *Stop and discard this recording?*.
  - **Otherwise** it closes at once.

  "Unsaved" is set by a take, a restore or any applied edit (Reset included). It
  is cleared by a download or a Load. There is no Close button beside Record; the
  Record screen's footer holds only **Cancel**, which is the same guarded close.
- **REQ-a-discarded-take-can-be-restored** — (v11) Audio thrown away through that
  guard is kept for the rest of the session: one clip, the newest, held in the
  studio's chunk and never persisted. The next Record screen opens with a banner,
  *Your last recording (3.2 s) was discarded — [Restore]*. Restoring opens it on
  the Edit screen as unsaved audio, aimed at the slot it was aimed at before.
- **REQ-the-mic-opens-with-the-studio** — (v11) Opening the Record screen
  opens the mic, so the **input meter** (peak level, with a clip light at
  ≥ −0.5 dBFS) is live before anything is recorded, and Record starts the take
  immediately. The level is read from `MicSession.level()`, an `AnalyserNode` on
  the mic source, once per animation frame, and only while the Record screen is
  showing. The session is disposed when a take ends, so the OS mic indicator is
  off on the Edit screen; Re-record opens a new one.
- **REQ-the-record-screen-shows-every-state** — (v11) The Record screen names
  the state it is in, with one big round button whose face follows it:
  - **Opening mic**: "Allow microphone access…", the button disabled.
  - **Ready**: a red dot, "Record". `R` presses it while the screen shows and no
    text field has focus.
  - **Counting in**: the beats left, large.
  - **Recording**: a square, "Stop". A pulsing red frame and `● REC m:ss.s`, and
    the take's envelope drawn growing live.
  - **Error**: the `errorText()` message plus **Try again**.

  Stop goes straight to the Edit screen.
- **REQ-a-take-is-bounded** — (v11) A take stops itself at `MAX_TAKE_SECONDS`
  (120 s), says so in the status line, and goes to Edit like a manual stop. The
  timer shows the remaining time over the last 10 s. The bound sizes memory, not
  trust: a 2-minute stereo float take is ~46 MB.
- **REQ-count-in-lands-the-take-on-a-downbeat** — (v11) With **Count-in** on,
  Record first counts one bar on the [metronome](metronome.md) (the click sounds
  for that bar even with CLICK off):
  - **Stopped**: the bar starts now.
  - **Playing**: capture begins on the next bar's downbeat, and the beats left
    are counted down to it.

  Capture actually starts at the press. On stop, the frames before the downbeat's
  context time (`MicSession.startedAt` subtracted) are cropped, so no worklet
  needs to know about bars. Pressing the button during the count cancels it and
  keeps no take. Alignment is exact to the context clock, but not to the
  device's input latency, which the crop handles absorb.
- **REQ-the-transport-is-in-reach** — (v11) The toolbar carries:
  - **Play / Stop** (`bridge.toggleTransport`, the header's own button —
    [transport-window](transport-window.md) REQ-play-pause-is-not-a-second-truth)
  - the **beat light** (painted when each beat is heard)
  - the **BPM** (read-only)
  - **CLICK** (the metronome's sound, off by default)

  It is its own component, `createStudioTransport`, which owns its subscriptions
  and hands each heard beat on (`onHeardBeat`), so the count-in display paints
  with the light. `toggleTransport` is a **required** option: the studio has no
  other way to move the clock.

  So a song playing under a take can be stopped without leaving the studio. While
  playing, the beat light follows the transport in the accent colour; while
  stopped, it follows the free-running metronome in the secondary colour. The
  downbeat is brighter. The metronome is held only while the studio is open
  ([metronome](metronome.md) REQ-a-metronome-runs-only-while-held).
- **REQ-undo-is-a-stack** — (v11) Every applied edit, Reset included, pushes the
  previous audio onto an undo stack. Undo and Redo walk it. A new edit clears
  Redo. The stack keeps at most `UNDO_DEPTH` (10) entries and drops the oldest
  while it holds more than `UNDO_FRAME_BUDGET` frames, so a long take cannot pin
  hundreds of MB; the newest entry always stays. Undo and Redo are disabled when
  they have nothing to do. The stack is `EditHistory` (`src/state/edit-history.ts`),
  pure and generic, so its bounds are tested without a studio.
- **REQ-one-primary-action-per-screen** — (v11) The Edit screen's footer has one
  primary button, **Load into S3** (or **Replace S3** when the slot is filled),
  beside its slot picker. Beside them sit **WAV** and **MP3** downloads and
  **Re-record**.
  - A fresh recording aims at the **first empty slot** (the given slot, or S1,
    when none is empty). An edit aims at its own slot.
  - Loading closes the studio and raises a toast, *Loaded into S3* [Undo], which
    puts the slot's previous buffer and name back (`snapshotSamplerSlot`, the
    reversal the chop spread and the sampler's Del share).
  - A fresh recording is named `recording-S3`; an edit keeps its source's name.
    A new take recorded from an opened slot is a fresh recording.
  - Re-record goes back to the Record screen through the same guard as Close.

## Technical design

### Gesture inventory (ADR-014)

| Control | Tap / click | Drag | Long press | Double | Keyboard |
| --- | --- | --- | --- | --- | --- |
| `mic-record-toggle` | Ready: record (or count in); counting: cancel; recording: stop | — | — | — | `R` on the Record screen; Enter/Space when focused |
| `mic-countin` | toggles the 1-bar count-in | — | — | — | Space when focused |
| `rec-restore` | opens the discarded take on the Edit screen | — | — | — | Enter/Space when focused |
| `rec-transport-toggle` | the header's Play / Stop | — | — | — | Enter/Space when focused |
| `rec-click` | toggles the metronome's click | — | — | — | Enter/Space when focused |
| `mic-close` (✕) / `mic-cancel` | the guarded close | — | — | — | Escape (the guarded close) |
| crop handles | — | move the selection edge | — | — | — |
| a chop boundary on the waveform | — | moves it ([sample-chop](sample-chop.md)) | — | — | — |
| `ptab-sample-<page>` | shows that tool | — | — | — | Enter/Space when focused |
| `mic-play` | plays / stops the selection | — | — | — | Enter/Space when focused |
| `mic-undo` / `mic-redo` / `mic-reset` | one step back / forward / to the original | — | — | — | Enter/Space when focused |
| `mic-load` | loads into the picked slot, closes, toast | — | — | — | Enter/Space when focused |
| `mic-save-<wav\|mp3>` | downloads the selection | — | — | — | Enter/Space when focused |
| `mic-rerecord` | the guarded return to Record | — | — | — | Enter/Space when focused |

A `—` is a decision. Nothing is momentary: the button toggles, and
`R` is a press, not a hold (ADR-014 law 2).

### Contract / public interface

```yaml
mic-capture.ts:
  openMicSession(ctx): Promise<MicSession>
  MicSession: start() · stop(): Promise<CapturedAudio> · dispose() · level(): {peak, rms} · startedAt: number
    · firstFrame: number | null · inputLatency(): number   # the vocoder's frame-exact crop
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
record-sound-modal.ts:
  openRecordSoundModal(engine, { slot?, source?, toggleTransport })   # toggleTransport required
  UNDO_DEPTH = 10 · UNDO_FRAME_BUDGET · MAX_TAKE_SECONDS (re-exported from record-screen.ts)
record-screen.ts:
  buildRecordScreen(deps) -> { state: RecState, press(), destroy() }   # owns the mic session
studio-tools.ts:
  buildEffectsPage / buildChopPage / buildStretchPage / buildScratchPage (ctx: ToolContext)
    # ToolContext: the material, the selection, the marks, runOp, playClip / stopPreview,
    #   setPlayhead — no page holds the audio
studio-vocoder.ts:
  buildVocoderPage(ctx, opts) -> ToolPage & { destroy() }   # vocoder.md
studio-waveform.ts:
  createWaveform(deps) -> { el, redraw(), destroy() }   # writes a dragged crop back via setCrop
studio-transport.ts:
  createStudioTransport({ engine, metronome, toggleTransport, onClickChange? })
    -> { el, onHeardBeat(fn) -> unsubscribe, destroy() }
edit-history.ts:
  new EditHistory<T>({ depth, budget, size }) · record(prev) · undo(cur) · redo(cur) · canUndo · canRedo · clear()
```

### Layer touchpoints

```yaml
ui: src/ui/components/record-sound-modal.ts (built on the shared Modal, lazy chunk)
flow: openMicSession -> record into CapturedAudio -> buffer-dsp/offline edits
      -> save (encode.ts) OR capturedToAudioBuffer -> SamplerMachine.setBuffer(slot)
re-edit: a loaded slot's ✎ -> audioBufferToCaptured -> same studio, Edit screen
transport: toggleTransport is the sampler panel's bridge.toggleTransport
metronome: createMetronome(engine) from src/audio/metronome.ts, imported by this chunk only
secure context: openMicSession returns MicCaptureError('insecure-context') off HTTPS/localhost
```

## Visual aids

```
┌ RECORD A SOUND ──────────────────────────────────────────────────── ✕ ┐
│ RECORD › edit                     [▶ PLAY] ● 120 BPM [CLICK]           │
│ ┌──────────── the take, growing live ───────────────────────────────┐ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ INPUT ▕██████████████░░░░░░░▏ −12 dB [CLIP]                            │
│                         ( ● )  Record                                  │
│                    ● REC 0:04.2 / 2:00                                 │
│       [✓] Count-in 1 bar     Tip: headphones, if the song plays        │
│                                                          [Cancel]      │
└────────────────────────────────────────────────────────────────────────┘

┌ EDIT SAMPLE ─────────────────────────────────────────────────────── ✕ ┐
│ record › EDIT                     [■ STOP] ● 120 BPM [CLICK]           │
│ ┌─────────────── waveform (grows with the card) ────────────────────┐ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ [▶ Play] [Undo] [Redo] [Reset]        Recorded — selection 0.82 s · …  │
│  EFFECTS ┆ chop ┆ fit & shift ┆ scratch ┆ vocoder                      │
│  …the one page that is selected…                                       │
│ [Re-record] [↓ WAV] [↓ MP3]               Slot [S3 ▾] [LOAD INTO S3]  │
└────────────────────────────────────────────────────────────────────────┘
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
  Given the studio has been opened and closed repeatedly
  Then the number of document- and window-level listeners is the same as before the first open
  And no detached dropdown menu is still reachable
# pinned by: tests/ui/record-sound-modal.test.ts

Scenario: A take that finishes after the studio closed builds no editor (REQ-the-editor-owns-its-teardown, regression)
  Given a take being stopped, its final batch still in flight
  When the studio is closed before the stop resolves
  Then the session is disposed and no editor or dropdown is built
# pinned by: tests/ui/record-sound-modal.test.ts

Scenario: Unsaved audio is never discarded without asking (REQ-nothing-closes-the-studio-by-accident)
  Given a recorded take that has not been loaded or downloaded
  When the user clicks the backdrop
  Then the studio stays open
  When the user presses Escape
  Then a confirmation asks to discard the recording
  When the user keeps editing
  Then the studio and its take are still there
# pinned by: tests/ui/record-sound-modal.test.ts

Scenario: Untouched audio closes straight away (REQ-nothing-closes-the-studio-by-accident, edge)
  Given a slot opened in the editor with no edit applied
  When the user presses Escape
  Then the studio closes with no confirmation
# pinned by: tests/ui/record-sound-modal.test.ts

Scenario: A discarded take comes back (REQ-a-discarded-take-can-be-restored)
  Given a take discarded through the confirmation
  When the user opens Record a sound again
  Then a banner offers the discarded take
  When the user restores it
  Then the Edit screen shows it as unsaved audio
# pinned by: tests/ui/record-sound-modal.test.ts

Scenario: Undo walks back several edits and Redo walks forward (REQ-undo-is-a-stack)
  Given three edits applied in turn
  When the user presses Undo three times
  Then the audio is the original take
  When the user presses Redo once
  Then the first edit is back
  And the stack never holds more than UNDO_DEPTH entries, nor more than its frame budget
# pinned by: tests/ui/record-sound-modal.test.ts, tests/state/edit-history.test.ts

Scenario: A take stops itself at the bound (REQ-a-take-is-bounded, edge)
  Given a take that has run for MAX_TAKE_SECONDS
  Then the take stops by itself and the Edit screen opens
# pinned by: tests/ui/record-sound-modal.test.ts

Scenario: A count-in drops the pre-roll (REQ-count-in-lands-the-take-on-a-downbeat)
  Given count-in is on and the transport is stopped
  When the user records and stops after the count
  Then the take begins at the downbeat the count ended on, not at the press
# pinned by: tests/ui/record-sound-modal.test.ts
#            (by ear, ADR-010: the take lands on the click — not automated)

Scenario: Record from the mic and load into a slot
  Given microphone permission is granted on a secure context
  When the user records, trims, and loads the result into slot 0
  Then slot 0 plays the captured audio, under a recording-S1 name
  And a toast offers to undo the load
# pinned by: e2e/mic.spec.ts (fake device + grantPermissions)

Scenario: The song can be stopped from inside the studio (REQ-the-transport-is-in-reach)
  Given the transport is playing and the studio is open
  When the user presses the studio's Stop
  Then the transport stops and the studio is still open
  And the press went through the header's Play, never straight to the clock
# pinned by: e2e/mic.spec.ts, tests/ui/studio-transport.test.ts

Scenario: The edit screen never scrolls sideways (REQ-the-studio-fills-the-screen, regression)
  Given a slot holding audio, opened in the editor
  When the viewport is 900px or 1400px wide
  Then the edit screen is no wider than its box, so no horizontal scrollbar shows
# pinned by: e2e/sample-editor-tabs.spec.ts

Scenario: One tool page at a time, Effects first (REQ-the-tools-are-tabs)
  Given a slot holding audio
  When the user opens it in the editor
  Then the Effects page is showing and Chop, Fit & Shift, Scratch and Vocoder are not
  When the user picks the Fit & Shift tab
  Then the Fit row and the Shift row show and the waveform is still in view
# pinned by: e2e/sample-editor-tabs.spec.ts

Scenario: Closing a session releases its recorder (REQ-the-recorder-node-is-released-with-the-session, regression)
  Given a mic session is open
  When it is disposed
  Then its RecorderNode and level tap are disconnected and its port handler cleared
  And the mic tracks are stopped
# pinned by: tests/audio/recorder/mic-capture.test.ts (the session releases it),
#            tests/audio/recorder/node.test.ts (what releasing it does)

Scenario: Disposing twice is harmless (REQ-the-recorder-node-is-released-with-the-session, edge)
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
  When the user opens the record studio
  Then it shows an insecure-context message instead of throwing
# pinned by: tests/audio/recorder/mic-capture.test.ts (openMicSession refusals)
```

## Tests & verification

- `tests/audio/buffer-dsp.test.ts`, `tests/audio/recorder/offline-render.test.ts`
  (length math and graph shape against a stubbed context),
  `tests/audio/recorder/mic-capture.test.ts`, `tests/ui/record-sound-modal.test.ts`,
  `e2e/mic.spec.ts` (`--use-fake-device-for-media-stream` +
  `grantPermissions(['microphone'])`), `e2e/sample-editor-tabs.spec.ts` —
  `npm test` / `npm run e2e`.
- By ear (ADR-010), Firefox then Chrome: the count-in lands the take on the
  click; recording over a playing song and stopping it from the studio keeps
  the take.

## Open questions / future

- New edit operations belong in `buffer-dsp.ts` (pure) when possible, falling back
  to `offline-render.ts` only when rendering is unavoidable.
- Input-latency compensation for the count-in crop (`MediaStreamTrack` settings
  `latency` where a browser reports it).
