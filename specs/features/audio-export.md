# Audio export (WAV / MP3 capture)

```yaml
id: audio-export
status: implemented
version: 16
owner: core
related:
  - architecture
  - song-mode
  - sample-recorder
  - record-window        # the manual-capture surface built on the capture phases
  - transport-position   # only an EXPORT blocks a seek
  - pwa-install
  - progress-bar
source:
  - public/worklets/recorder.js
  - src/audio/recorder/node.ts
  - src/audio/recorder/recorder-controller.ts
  - src/audio/recorder/encode.ts
  - src/ui/components/export-audio-modal.ts
  - src/ui/panels/song-panel.ts
  - src/main.ts
```

Capturing the master output to a downloadable WAV or MP3, either as an automatic
song pass or a free-form manual take.

## Background / Why

Export taps a **zero-output `recorder` AudioWorklet** off `master` (post
master-volume) as a pure sink. Encoding is **pure and AudioContext-free**
(`encode.ts`), so it is jsdom-testable: `encodeWav` has no dependencies and
`encodeMp3` uses the vendored `lamejs`. The [sample recorder](sample-recorder.md)
reuses it. `lamejs` is large and pre-minified, so it is a lazy chunk
(REQ-the-mp3-encoder-loads-lazily), and that is why `encodeMp3` is async.

## Requirements

- **REQ-a-zero-output-recorder-worklet** — A zero-output recorder worklet,
  tapped off `master` post-volume.
- **REQ-export-song-renders-from-the-top** — `exportSong(fmt, opts?)` calls
  **`clock.start(0)` explicitly** (a plain `start()` begins at the cue,
  [transport](transport.md) REQ-the-cue-is-where-start-begins). It renders `runs`
  passes of the longest enabled [arrangement](arrangement.md) chain
  (`FALLBACK_BARS` = 4 when none is enabled), auto-stops and downloads.
  `stopAtStep = bars × runs × barTicks`. `runs` is clamped to 1..`MAX_RUNS` (10)
  and defaults to 1. Repeats need no arrangement support, since every lane wraps
  its slot index. The end condition counts **steps elapsed since the export
  started** (`elapsedSteps`), not the clock's absolute step. So an imported song's
  `bars` cannot make the bound unreachable. A **seek is refused while an export
  is in flight** ([transport-position](transport-position.md)
  REQ-seeking-is-refused-in-three-states); `isExporting()` is what that guard
  reads. A manual take is unbounded and does not take the guard.
- **REQ-the-capture-keeps-a-tail** — After the final step the transport stops and
  the capture runs on for `TAIL_MS` (350 ms), or **one whole bar** with
  `opts.tailBar`, so a reverb tail decays. The tail bar is silence from the
  stopped transport, not an extra arrangement bar (bar N+1 would replay slot 0).
  `Engine`'s capture-aware `clock.onStop` skips `sampler.stopAll()` so one-shots
  ring on. **The API defaults `tailBar` to `false`; the UI checkbox defaults to
  checked.** `npm run bench:audio` calls `exportSong` with no options and needs
  bar-exact, repeatable takes ([verify-audio-by-ear](../recipes/verify-audio-by-ear.md)).
- **REQ-capture-is-a-five-phase-machine** — `idle → recording ⇄ paused → review →
  encoding → idle`. An export skips `review`.
  - Manual verbs: `startManual` / `pauseManual` / `resumeManual` / `stopManual`,
    then `saveTake(fmt)` or `discardTake()`. `startManual` starts a stopped
    transport, and stopping the capture leaves the transport running.
  - **`stopManual` writes no file.** It parks the `CapturedAudio` in `review`, and
    only `saveTake` encodes and downloads. `discardTake` nulls the buffer (a minute
    of stereo 48 k float is ~23 MB).
  - **`encoding` is a real phase**, held across the await, so a UI can say
    *"preparing your download"* (ADR-014 law 5). `isExporting()` stays true across
    it, so a second export cannot start mid-encode.
  - Two predicates: `isCapturing()` (`recording`/`paused`: the sampler choke and
    bank render stand off) and `isExporting()` (the seek guard).
  - **Pause pauses the recorder, not the transport, and splices.**
    `RecorderNode.pause()/resume()` post the worklet's `stop`/`start` **without
    clearing the chunk list**, so the paused stretch is simply absent.
    `firstFrame` arithmetic is therefore only meaningful for an un-paused capture,
    which is why only [render-to-sampler](render-to-sampler.md) relies on it.
  - `capturedSeconds()` reads `RecorderNode.capturedFrames`, the true length with
    paused time excluded.
- **REQ-encoding-needs-no-audio-context** — Encoding is pure. MP3 is
  **`MP3_KBPS` = 192 kbps CBR**, through the one `encodeMp3` every MP3 surface
  uses. A sample rate lamejs cannot handle falls back to WAV with a console
  warning, without loading lamejs.
- **REQ-each-chunk-is-frame-tagged** — Each chunk carries `f = currentFrame`.
  `RecorderNode` keeps the first as `firstFrame` (reset by `start()`), so a
  consumer maps a scheduled time to an offset: `offset = round(when × sampleRate)
  − firstFrame`. Consumed by [render-to-sampler](render-to-sampler.md).
- **REQ-a-silent-quantum-is-captured-as-silence** — A quantum whose input
  arrives with **no channels** is captured as one quantum of zeros, not skipped.
  The spec gives an input zero channels when nothing upstream is actively
  processing, and Gecko does exactly that for silence (a closed VCA is a gain-0
  node, which emits a null chunk). Skipping it dropped every such quantum from
  the take: a Firefox recording started at the first sound instead of at Record,
  and the frames that `firstFrame` maps to no longer followed one another. Blink hands
  the recorder a silent channel instead, so it never took this path.
- **REQ-chunks-are-batched-then-flushed** (v10) — The worklet accumulates
  `RECORD_BATCH_QUANTA` (16) quanta per message, about 43 ms at 48 kHz. That cuts
  ~375 messages/s to ~23, so a main-thread stall no longer queues hundreds of held
  buffers. A full batch is **transferred**, not copied; only the final short flush
  trims. Transferring detaches the accumulator, so `process()` still allocates two
  fresh 8 KB arrays per flush. That is a **known, standing violation** of
  [runtime-performance](runtime-performance.md) REQ-no-allocation-in-a-hot-loop.
  The fix is a small pool the main thread transfers back.
  **Batching is only correct with a flush, so `stop()` is async**: it posts
  `{cmd:'stop'}`, awaits the worklet's flush of the partial batch, then
  concatenates. The take is frame-identical to an unbatched capture
  ([runtime-performance](runtime-performance.md)
  REQ-a-worklet-optimisation-is-bit-exact). `pause()`/`resume()` flush the same
  way. A disposed or never-started node resolves at once with an empty take.
- **REQ-the-mp3-encoder-loads-lazily** (v4) — `encodeMp3` loads lamejs via
  `import()`, so it ships as its own chunk, fetched on the first MP3 encode.
  `encodeWav` stays synchronous. `main.ts` warms the chunk on idle
  (`requestIdleCallback`, with a 2 s `setTimeout` fallback for older Safari). The
  service worker caches only what a visit fetched, so without the warm the encoder
  would be missing offline ([pwa-install](pwa-install.md)
  REQ-service-worker-is-registered, [play-offline](play-offline.md)). A failed
  warm is swallowed; the real `import()` retries.
- **REQ-labels-echo-the-chosen-format** (v5) — A control that leads to a file names
  its format and relabels when the format changes. **`Export Song as
  <WAV|MP3>…`** is the Song tab button; "as WAV" tells it apart from the
  neighbouring `.json` Export. **`Export as <WAV|MP3>`** is the modal's confirm,
  and **`Save as <WAV|MP3>`** is the Record window's save; each names its own
  override. **`Record…`** names no format. The testids are the stable handles;
  the labels are not.
- **REQ-export-opens-an-options-modal** (v7) — `song-export-audio` opens a modal
  with **Format**, **Runs** (1..`MAX_RUNS`) and **Add an empty bar at the end**
  (checked). It shows a live length (`bars × runs [+ 1 tail bar] ≈ N s`). The
  Song tab's WAV/MP3 segmented is the **global default**: the modal and the Record
  window seed from it and override **without writing back**. `Export` is disabled
  with an explanatory `title` while the recorder is busy.
- **REQ-the-modal-is-the-renders-own-surface** — **Confirming does not close the
  modal**, because export renders in real time:
  - **`rendering`**: a determinate [progress bar](progress-bar.md)
    (`export-audio-progress`) and `bar n of N`, from `exportProgress()`
    (`elapsedSteps / stopAtStep`) on `clock.onTick`;
  - **`encoding`**: *"Preparing your download…"*, indeterminate;
  - **done**: a short confirmation, then the modal closes itself;
  - **Cancel is real or absent**: while rendering, a single Cancel →
    `cancelExport()` unhooks the tick, stops the transport and drops the buffer.
    While encoding there is no action;
  - the backdrop does not dismiss (`dismissOnBackdrop: false`). Escape, and
    anything else that closes the modal mid-render, cancels it.
- **REQ-an-outside-stop-ends-the-export** (v15) — A transport stop the export did
  not issue (a Media Session pause, Panic) takes the `cancelExport()` path:
  nothing is written, the phase returns to `idle`, and `lastExportInterrupted()`
  is true. The modal says the render was stopped. A stopped clock fires no
  `onTick`, so without this the export would capture forever.
- **REQ-a-capture-waits-for-a-bank-render** (v14) — An export or manual take is
  **refused while a render to the sampler is in flight**. Both own the transport,
  and the render's restore would never run
  ([render-to-sampler](render-to-sampler.md) REQ-a-render-is-refused-while-busy
  guards the other direction). `RecorderController` takes a `blocked()`
  predicate, wired to `bankRender.isRendering()`. `exportSong` / `startManual`
  return `false`. The modal's Export and the Record window's Record are disabled
  with the reason as a tooltip.
- **REQ-a-failed-encode-keeps-the-take** (v14) — `saveTake` keeps the take until
  the download is written. On failure (e.g. the lazy MP3 chunk unavailable
  offline) it returns to `review` and resolves `false`. An export's failure sets
  `lastExportFailed()`, and the modal says what went wrong and stays open. There
  are no unhandled rejections. The wording follows
  [lazy-load-failure](lazy-load-failure.md)'s operation shape.
- **REQ-a-discarded-take-stays-discarded** (v14) — Every take has a generation,
  bumped by `begin` and `discardTake`. A stop that resolves for an older
  generation is dropped, so a Discard during the final flush sticks.
- **REQ-the-capture-bound-is-the-songs-bar** (v11) — The bound and the tail bar
  measure in `barTicks` ([meter](meter.md)
  REQ-bar-exact-capture-follows-bar-ticks), so a 7/8 song exports 7/8 bars.

## Technical design

### Contract / public interface

```yaml
RecorderController:  # src/audio/recorder/recorder-controller.ts
  ExportFormat = 'wav' | 'mp3'
  RecorderPhase = 'idle' | 'recording' | 'paused' | 'review' | 'encoding'
  ExportOptions    = { runs?: number, tailBar?: boolean }   # runs 1..MAX_RUNS, default 1/false

  exportSong(fmt, opts?): void      # runs passes from step 0, auto-stop, download
  cancelExport(): void              # abort a render in flight -> idle, no file
  lastExportInterrupted(): boolean  # ended by an outside stop
  lastExportFailed(): boolean       # ended by an encode/download failure
  exportProgress(): number          # 0..1 through the pass; 0 when not exporting
  startManual() ; pauseManual() ; resumeManual() ; stopManual()
  saveTake(fmt): Promise<boolean>   # encode + download the reviewed take -> idle
  discardTake(): void               # drop the held buffer -> idle
  get phase: RecorderPhase
  isCapturing(): boolean            # recording | paused
  isExporting(): boolean            # an automatic pass owns the transport (seek guard)
  capturedSeconds(): number         # true length, paused time excluded
  onPhase(fn) -> unsubscribe
RecorderNode:  # src/audio/recorder/node.ts (wraps recorder.js)
  start() ; stop(): Promise<{ left, right, sampleRate }>   # awaits the flush
  pause(): Promise<void> ; resume()   # worklet stop/start WITHOUT clearing chunks
  dispose()                   # sample-recorder REQ-the-recorder-node-is-released-with-the-session; terminal, idempotent
  firstFrame: number | null   # null until the first chunk arrives
  capturedFrames: number      # running frame count; reset by start(), survives pause
worklet chunk message: { l: Float32Array, r: Float32Array, f: number }  # f = batch's first frame
worklet flush reply:   { l, r, f, done: true }   # the partial batch at stop/pause
encode.ts (pure):
  encodeWav(left, right, sampleRate): Blob            # sync — takes are always stereo
  encodeMp3(left, right, sampleRate): Promise<Blob>   # lazy lamejs, MP3_KBPS CBR; unsupported rate -> WAV
  encodeWavChannels / encodeMp3Channels(PcmChannels, sampleRate)   # the one- or two-channel cores
  encodeClipWav / encodeClipMp3(left, right, sampleRate)  # sampler clips only: mono when L == R
                                                        # (project-export.md REQ-a-mono-clip-exports-as-mono)
download.ts (src/utils):
  triggerDownload(blob, filename): void   # shared by every file download
constants: FALLBACK_BARS = 4, TAIL_MS = 350, MAX_RUNS = 10, MP3_KBPS = 192, RECORD_BATCH_QUANTA = 16
```

The worklet understands two commands, `start` and `stop`. Pause needs no third:
clearing the chunk lists lives on the node side, so `pause()`/`resume()` are the
same two messages without the clear. `node.stop()` and the phase transition run
**before** any await in `saveTake()`.

### Layer touchpoints

```yaml
graph: master -> recorder worklet (zero-output sink; does not alter playback)
guards keyed off the recorder — two predicates, never one:
  engine.canSeek()              -> !isExporting()
  engine.clock.onStop choke     -> !isCapturing()   # don't cut a take's samples
  bankRender.blocked()          -> isCapturing()    # don't fight over the transport
ui: src/ui/panels/song-panel.ts — the Audio row's Format segmented is the GLOBAL DEFAULT;
  song-export-audio -> export-audio-modal.ts ; song-record -> the Record window (record-window.md)
  testids: song-export-audio, song-export-fmt-<wav|mp3>, song-record,
    export-audio-modal, export-audio-fmt-<wav|mp3>, export-audio-runs,
    export-audio-tail, export-audio-length, export-audio-confirm, -cancel,
    export-audio-progress + -status, -abort
build: vendor/lamejs is dynamic-import-only -> its own chunk (vite.config.ts group `lamejs`)
bench: scripts/audio-bench.mjs calls exportSong(fmt) with NO opts and must keep working
```

## Scenarios (BDD)

```gherkin
Scenario: Export Song writes a valid WAV
  Given a song with an enabled chain
  When the user opens the export modal and confirms with Format = WAV
  Then a .wav blob downloads whose RIFF/WAVE header is valid
# pinned by: e2e/song.spec.ts, tests/audio/wav-encode.test.ts

Scenario: No enabled chain falls back to 4 bars (edge)
  Given no arrangement lane is enabled
  When Export Song runs
  Then it renders FALLBACK_BARS (4) bars + the tail, then auto-stops
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: Runs multiply the rendered length (REQ-export-song-renders-from-the-top)
  Given a two-bar enabled chain
  When the user exports with Runs = 3
  Then the capture ends at step 2 × 3 × 16 and the chain replays from slot 0 twice
  And Runs is clamped to 1..MAX_RUNS, so 0 and 99 render 1 and 10 passes
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: The tail bar lets a reverb decay instead of cutting it (REQ-the-capture-keeps-a-tail)
  Given a song whose reverb rings longer than TAIL_MS
  When the user exports with the tail bar checked
  Then the capture continues for one bar of silence after the transport stops
  And no further step is triggered during it — the transport is already stopped
# pinned by: tests/audio/recorder/recorder-controller.test.ts (timing),
#            npm run bench:audio A/B (the only check that it SOUNDS right — ADR-010)

Scenario: An omitted opts renders one bar-exact pass (regression, REQ-the-capture-keeps-a-tail)
  When exportSong(fmt) is called with no options — as scripts/audio-bench.mjs does
  Then it renders one pass and waits TAIL_MS, bar-exact and repeatable
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: The export modal stays open and reports the render (REQ-the-modal-is-the-renders-own-surface)
  Given the export options modal with a multi-bar song
  When the user confirms
  Then the modal STAYS OPEN, the options are replaced by a progress bar reading
    "bar n of N", and it advances as the transport does
  When the render finishes
  Then the status reads that it is preparing the download
  And once the file is written the modal closes itself
# pinned by: tests/ui/export-audio-modal.test.ts, e2e/song.spec.ts

Scenario: Cancelling a render in flight leaves no file (REQ-the-modal-is-the-renders-own-surface)
  Given a render in progress
  When the user clicks Cancel
  Then the transport stops, the recorder returns to idle and nothing downloads
  And closing the modal mid-render does the same — the modal cannot outlive it
# pinned by: tests/audio/recorder/recorder-controller.test.ts,
#            tests/ui/export-audio-modal.test.ts

Scenario: Encoding is reported, not silence (REQ-capture-is-a-five-phase-machine regression)
  Given a take being saved as MP3, where lamejs takes seconds
  Then the phase is `encoding` for the whole encode — not `idle`
  And every surface says so instead of going inert and looking stalled
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: A manual take is reviewed before it is written (REQ-capture-is-a-five-phase-machine)
  Given a manual capture is running
  When the user stops it
  Then the phase is `review`, playback continues, and NOTHING has downloaded
  When the user saves it
  Then one file downloads and the phase returns to idle
  And discarding instead downloads nothing and drops the buffer
# pinned by: tests/audio/recorder/recorder-controller.test.ts, e2e/record-window.spec.ts

Scenario: Pausing splices the take rather than padding it (REQ-capture-is-a-five-phase-machine)
  Given a manual capture that has taken 2 s of audio
  When the user pauses, waits, and resumes for another 2 s
  Then the take is one continuous 4 s buffer — the paused stretch is absent
  And capturedSeconds() never advanced while paused
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: A batched capture is frame-identical to a per-quantum one (REQ-chunks-are-batched-then-flushed)
  Given a run of render quanta with known samples
  When the worklet batches them and the node concatenates the result
  Then every captured sample matches the unbatched capture, in the same order
  And no gap appears at a batch boundary
# pinned by: tests/audio/recorder/node.test.ts

Scenario: A silent stretch is captured, not skipped (REQ-a-silent-quantum-is-captured-as-silence, regression)
  Given a capture whose input arrives with no channels for some quanta
  When the worklet processes them
  Then each one adds a quantum of zeros to the take
  And the frames around them stay contiguous, the batch tags following on
# pinned by: tests/audio/recorder/recorder-worklet.test.ts

Scenario: Stopping mid-batch keeps the tail (REQ-chunks-are-batched-then-flushed, regression)
  Given a capture stopped part-way through a batch
  When stop() resolves
  Then the frames buffered in the worklet are in the take
# pinned by: tests/audio/recorder/node.test.ts

Scenario: A node with nothing to flush still resolves (REQ-chunks-are-batched-then-flushed, edge)
  Given a recorder that was never started, or has been disposed
  When stop() is called
  Then it resolves with an empty take rather than waiting for a flush
# pinned by: tests/audio/recorder/node.test.ts

Scenario: A manual take does not lock the playhead (REQ-export-song-renders-from-the-top/REQ-capture-is-a-five-phase-machine)
  Given a manual capture is running
  Then seeking is still allowed — only an export bounds itself by absolute step
  When an export pass is running instead
  Then seeking is refused
# pinned by: tests/audio/recorder/recorder-controller.test.ts (predicates),
#            e2e/record-window.spec.ts

Scenario: MP3 encodes at the high-quality bitrate (REQ-encoding-needs-no-audio-context)
  When encodeMp3 runs at a supported sample rate
  Then the first MP3 frame header carries the 192 kbps bitrate index (0xB)
# pinned by: tests/audio/wav-encode.test.ts

Scenario: The lazily-loaded encoder still produces a valid MP3 (REQ-the-mp3-encoder-loads-lazily)
  Given lamejs has never been imported in this session
  When encodeMp3 is awaited at a supported sample rate
  Then it resolves to an audio/mpeg blob at 192 kbps
# pinned by: tests/audio/wav-encode.test.ts (a fresh module graph per test file)
#   + e2e/song.spec.ts — the only check that the dynamic import resolves in a
#   real browser (byte inspection, so it runs on CI Chromium without an MP3 decoder)

Scenario: Everything that leads to a file names the format (REQ-labels-echo-the-chosen-format)
  Given the Song tab default is WAV
  Then its button reads "Export Song as WAV…"
  And the modal's confirm reads "Export as WAV" and the Record window's save
    reads "Save as WAV"
  When the user picks MP3 inside the modal
  Then its confirm reads "Export as MP3"
  And the Song tab button STILL reads WAV — an override does not write back (REQ-export-opens-an-options-modal)
# pinned by: tests/ui/export-audio-modal.test.ts, tests/ui/record-window.test.ts,
#            e2e/song.spec.ts

Scenario: An unsupported rate never loads the encoder (edge)
  When encodeMp3 is awaited at a sample rate lamejs cannot handle
  Then it resolves to an audio/wav blob with a console warning
  And the lamejs chunk is never fetched
# pinned by: tests/audio/wav-encode.test.ts

Scenario: An export waits for a render to the sampler (REQ-a-capture-waits-for-a-bank-render, regression)
  Given a render to the sampler in flight
  When an export or a manual take is started
  Then it is refused, the render finishes and restores the engine state as always
   And the export modal's Export and the Record window's Record are disabled until it does
# pinned by: tests/audio/recorder/recorder-controller.test.ts, tests/ui/record-window.test.ts

Scenario: A stop from outside ends the export (REQ-an-outside-stop-ends-the-export, regression)
  Given an export rendering
  When something other than the export stops the transport (a media-key pause, Panic)
  Then the recorder returns to idle, nothing downloads, lastExportInterrupted() is true
   And the modal says the render was stopped rather than Done, and a new export is accepted
# pinned by: tests/audio/recorder/recorder-controller.test.ts, tests/ui/export-audio-modal.test.ts

Scenario: A failed MP3 save keeps the take (REQ-a-failed-encode-keeps-the-take, regression)
  Given a take in review and an MP3 encoder that fails to load
  When the user saves it as MP3
  Then saveTake resolves false, the phase is review again and the take is still there
   And saving it as WAV then writes it
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: A failed export is not reported as done (REQ-a-failed-encode-keeps-the-take)
  Given an export whose MP3 encode fails
  When the recorder returns to idle
  Then lastExportFailed() is true and the modal says what went wrong
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: A take discarded mid-stop stays discarded (REQ-a-discarded-take-stays-discarded, edge)
  Given a stop awaiting its final batch
  When the user discards before it resolves
  Then the phase stays idle and no take is held
# pinned by: tests/audio/recorder/recorder-controller.test.ts
```

## Tests & verification

- `tests/audio/wav-encode.test.ts`, `tests/audio/recorder/recorder-controller.test.ts`,
  `tests/audio/recorder/node.test.ts`, `tests/ui/export-audio-modal.test.ts`,
  `e2e/song.spec.ts`, `e2e/record-window.spec.ts` — `npm test` / `npm run e2e`.
- **By ear** for REQ-the-capture-keeps-a-tail (ADR-010): render tail off and tail
  on, and confirm the reverb decays ([verify-audio-by-ear](../recipes/verify-audio-by-ear.md)).

## Open questions / future

- A new format adds an `ExportFormat` value + an `encode*` function, kept
  AudioContext-free.
- `MAX_RUNS` is 10 because export is real-time (it drives the live graph). An
  `OfflineAudioContext` render would lift the ceiling but needs the whole graph
  rebuilt offline.
