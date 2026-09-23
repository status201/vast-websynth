# Audio export (WAV / MP3 capture)

```yaml
id: audio-export
status: implemented
version: 14  # v14: a capture waits for a bank render (REQ-a-capture-waits-for-a-bank-render — an export mid-render
             #      stranded it), a failed encode keeps the take (REQ-a-failed-encode-keeps-the-take), and a
             #      discarded take stays discarded (REQ-a-discarded-take-stays-discarded)
             # v13: correction only — v12 saved the copy, not the allocation: a transferred
             #      batch still costs a fresh pair of arrays in process()
             # v12: a full batch is TRANSFERRED, not copied — the trim allocated two 8 KB
             #      arrays per flush inside process() (REQ-chunks-are-batched-then-flushed)
             # v11: a captured bar is the song's bar, not always 16 steps (REQ-the-capture-bound-is-the-songs-bar)
             # v10: the worklet batches quanta into one message and stop() awaits
             #      the flush, so a take stays frame-identical (REQ-chunks-are-batched-then-flushed)
             # v9: the stop condition counts steps elapsed since the export began —
             #     the old absolute test was unreachable past the 16-bit step wrap
             # v8 (was 7.1): `encoding` is a real phase, and the export modal stays
             #     open as the render's progress surface with a working Cancel (REQ-the-modal-is-the-renders-own-surface)
             # v7: a phase machine replaces the armed bool (REQ-capture-is-a-five-phase-machine), export takes
             #     runs + a tail bar behind an options modal (REQ-2/3/9), and the
             #     format-echoing labels extend to the buttons that write (REQ-labels-echo-the-chosen-format)
owner: core
related:
  - architecture
  - song-mode
  - sample-recorder
  - record-window        # the manual-capture surface built on REQ-capture-is-a-five-phase-machine's phases
  - transport-position   # REQ-each-chunk-is-frame-tagged there: only an EXPORT blocks a seek
  - pwa-install
  - progress-bar         # REQ-the-modal-is-the-renders-own-surface's bar is the shared component
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
master-volume) as a pure sink — it pulls audio without affecting playback. Encoding
is kept **pure and AudioContext-free** (`encode.ts`) so it is unit-testable under
jsdom: `encodeWav` is dependency-free; `encodeMp3` uses the vendored `lamejs`.
The same `encode.ts` is reused by the [sample recorder](sample-recorder.md).

`lamejs` is **pre-minified and 153 kB** — 30% of what used to be a single
505 kB entry chunk, downloaded and parsed by every visitor whether or not they
ever export MP3. It is therefore loaded with a dynamic `import()` (v4, REQ-the-mp3-encoder-loads-lazily),
which is why `encodeMp3` is async. MP3 encoding is a rare, deliberate,
already-slow action, so the fetch is invisible next to the encode itself.

## Requirements

- **REQ-a-zero-output-recorder-worklet** — A zero-output recorder worklet,
  tapped off `master` post-volume.
- **REQ-export-song-renders-from-the-top** — `exportSong(fmt, opts?)` restarts
  from the top, renders `runs` passes of the longest enabled
  [arrangement](arrangement.md) chain (or `FALLBACK_BARS` = 4 when none
  enabled), auto-stops, and downloads. `stopAtStep = bars × runs × barTicks`
  (v11 — the song's own bar, see REQ-the-capture-bound-is-the-songs-bar);
  **`runs` is clamped to 1..`MAX_RUNS` (10)** and defaults to 1, so an omitted
  `opts` renders exactly what v6 did. Repeats need no arrangement support: every
  lane already wraps its slot index (`pos % steps.length`), so a longer capture
  simply replays the chains. The end condition counts **steps elapsed since the
  export started** (v9), not the clock's absolute step: `Clock._step` wrapped at
  `& 0xffff` until [transport](transport.md) REQ-the-step-counter-is-bounded-at-ingress removed it, so a `step >=
  stopAtStep` test against an absolute number became **unreachable** once `bars
  × runs > 4096` — the export then never auto-stopped and recorded into memory
  indefinitely. Counting elapsed steps is kept now the wrap is gone: the capture
  always starts at step 0 but a cued clock need not, so it still says what it
  means. An imported song can set `bars` (it is the arrangement chain length),
  so this was reachable from a shared file; counting elapsed steps removes the
  ceiling rather than merely capping it. "From the top" means **`clock.start(0)`
  explicitly**: the capture's end is a step count from that origin, and since
  [transport](transport.md) REQ-the-cue-is-where-start-begins a plain `start()` begins from the user's cue
  rather than 0 — so a cued transport would silently truncate the export. For
  the same reason a **playhead seek is refused while an export is in flight**
  ([transport-position](transport-position.md) REQ-seeking-is-refused-in-three-states) — an *export*, not any
  capture: a manual take is bounded by nothing, so it does not take the guard
  (REQ-capture-is-a-five-phase-machine). `isExporting()` is what that guard
  reads.
- **REQ-the-capture-keeps-a-tail** (the tail) — After the final step the
  transport stops and the capture keeps running for a grace period before the
  buffer is read: `TAIL_MS` (350 ms) by default, or **one whole bar** when
  `opts.tailBar` is set, so a reverb or delay tail decays instead of being cut
  off mid-tail. The tail bar is deliberately **not** an extra arrangement bar.
  Bar `N+1` would replay chain slot 0 (`laneSeek` wraps), which is music, not
  silence. Extending the existing `clock.stop()` → `setTimeout(finish, …)` seam
  instead gives real silence for free: the transport is already stopped, so
  nothing new triggers, and `Engine`'s capture-aware `clock.onStop` already
  suppresses `sampler.stopAll()` so one-shot tails ring on. **The API defaults
  `tailBar` to `false` while the UI checkbox defaults to checked.** That split
  is intentional: `npm run bench:audio` calls `exportSong` with no options and
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md) depends on its takes
  being **bar-exact and repeatable**, which a variable-length tail would break.
  Humans want the tail; the bench wants the grid.
- **REQ-capture-is-a-five-phase-machine** (capture phases) — The recorder is an
  explicit five-phase machine, not a boolean: **`idle → recording ⇄ paused →
  review → encoding → idle`** (an export skips `review`: `idle → recording →
  encoding → idle`).
  - Manual capture is driven by verbs, one per transition —
    `startManual` / `pauseManual` / `resumeManual` / `stopManual`, then
    `saveTake(fmt)` or `discardTake()`. `startManual` starts the transport if it
    is stopped; **stopping the capture leaves the transport running** (v6's
    behaviour, preserved).
  - **`stopManual` does not write a file.** It parks the take in `review`,
    holding the `CapturedAudio`, and only `saveTake` encodes and downloads.
    v6's `toggleManual` downloaded unconditionally the moment you stopped, so a
    bad take was already on disk with no way to refuse it. `discardTake` drops
    the buffer (it must null it — a minute of stereo 48 k float is ~23 MB).
  - An **export pass never enters `review`**: it is automatic, so it chains
    stop→encode→download itself and returns to `idle`.
  - **`encoding` is a real phase, not a gap.** v7.0 flipped straight to `idle`
    and *then* awaited the encode, so the seconds an MP3 spends in lamejs were
    reported as "nothing is happening" — every surface went inert and the app
    read as stalled. The phase is now held across the await, so a UI can say
    *"preparing your download"* instead of going quiet
    ([ADR-014](../decisions/adr-014-dont-make-me-think.md) law 5: state is
    visible). `isExporting()` stays true across it, so the operation is atomic
    from the outside and a second export cannot start mid-encode.
  - Two predicates, because two guards mean different things:
    `isCapturing()` (`recording` or `paused` — audio is being taken, so the
    sampler choke and bank render must stand off) and `isExporting()` (an
    automatic pass owns the transport, so a seek is refused — REQ-export-song-renders-from-the-top).
    `onPhase(fn)` replaces v6's `onState(fn)`.
  - **Pause pauses the recorder, not the transport**, and **splices**: the paused
    stretch is simply absent from the take. That falls out of the design rather
    than being built — `RecorderNode.pause()/resume()` post the worklet's
    existing `stop`/`start` commands **without clearing the chunk list**, so the
    accumulated buffer survives the gap. Consequence to respect:
    `firstFrame` arithmetic (REQ-each-chunk-is-frame-tagged) is only meaningful for an *un-paused*
    capture, which is why only [render-to-sampler](render-to-sampler.md) — which
    never pauses — may rely on it.
  - `capturedSeconds()` reports the take's true length from
    `RecorderNode.capturedFrames` (a running count, reset by `start()`), i.e. what
    will actually be written, paused time excluded — not a wall-clock stopwatch.
- **REQ-encoding-needs-no-audio-context** — Encoding is pure (no
  `AudioContext`): WAV dependency-free, MP3 via vendored lamejs. MP3 encodes at
  **`MP3_KBPS` = 192 kbps CBR** (v3; the LAME "high quality" sweet spot, ≈
  `-V2`) — every MP3 surface (song export, project clips, sample-editor saves)
  goes through this one `encodeMp3`, so they all inherit the bitrate. A sample
  rate lamejs cannot handle still falls back to WAV with a console warning — on
  that path `encodeMp3` returns **without** loading lamejs at all.
- **REQ-each-chunk-is-frame-tagged** (frame tagging) — Each chunk the worklet
  posts carries `f = currentFrame` (the absolute sample index of the chunk's
  first frame in the context timeline). `RecorderNode` records the first chunk's
  tag as `firstFrame` (reset by `start()`), letting consumers map a scheduled
  `AudioContext` time to an exact offset in the captured stream — `offset =
  round(when × sampleRate) − firstFrame`. Consumers that ignore the tag (this
  spec's own controller) are unaffected. Consumed by
  [render-to-sampler](render-to-sampler.md).
- **REQ-chunks-are-batched-then-flushed** (batched chunks, and the flush that
  makes them safe; v10) — The worklet **accumulates `RECORD_BATCH_QUANTA` render
  quanta into one message** rather than posting every quantum. At 48 kHz that is
  ~375 messages/s reduced to ~23: the per-quantum rate meant the main thread had
  to drain 375 transfers a second, and any stall (a big repaint, a demo load,
  the export modal opening) queued them with their backing `ArrayBuffer`s held
  alive.

  **(v12) A full batch is transferred, not copied.** The flush trimmed with
  `subarray(0, filled).slice()` unconditionally — but `filled` rises by exactly
  one quantum per call, so the *periodic* flush always lands on the
  accumulator's own length and the trim copied the whole thing only to throw the
  original away. Only the final short flush on `stop` now trims.

  Worth stating the size honestly: the CPU saved is **~0.014% of a core**
  (measured, 11/11 paired reps — 45% of this worklet's own cost, which is
  itself small), and the copy is **all** it saves. (v13) v12 also claimed it
  ended the allocation, and it does not: transferring the accumulator detaches
  it, so the next `process()` allocates a fresh pair of 8 KB `Float32Array`s —
  two per flush, ~23 flushes/s, exactly the count the `slice()` made. That is
  still an allocation **inside `process()`**, which
  [runtime-performance](runtime-performance.md) REQ-no-allocation-in-a-hot-loop
  forbids, where a GC pause is a dropout rather than a hitch. It is a known,
  standing violation, not a fixed one; ending it takes a small pool of batch
  buffers that the main thread transfers back once it has read them.

  **Batching is only correct with a flush, and the flush is what makes `stop()`
  async.** The worklet holds a partial batch, so on `stop` it must post the
  remainder — and `RecorderNode.stop()` used to read its chunk list *synchronously*
  right after posting the command, which would silently drop up to
  `RECORD_BATCH_QUANTA` quanta (~40 ms) off the end of every take. So `stop()`
  posts `{cmd:'stop'}`, **awaits the worklet's flush**, and only then concatenates:
  `stop(): Promise<CapturedAudio>`.

  The take is therefore **frame-identical to the unbatched capture** — same
  samples, same order, no gap at a batch boundary and none at the end. That is
  [runtime-performance](runtime-performance.md) REQ-a-worklet-optimisation-is-bit-exact's rule applied to a capture
  path: the samples are the output here, so "bit-exact or it is a sound change"
  governs what is *recorded*, not what is heard.

  `f` still tags the **first frame of the message** (REQ-each-chunk-is-frame-tagged), which is now the first
  frame of the batch — the arithmetic `offset = round(when × sampleRate) −
  firstFrame` is unchanged because `firstFrame` is still the first captured frame.
  `pause()`/`resume()` flush the same way, so paused time stays absent from the
  buffer with no partial batch straddling the gap.

  A disposed or never-started node resolves immediately with an empty take rather
  than waiting for a flush that will never come.

- **REQ-the-mp3-encoder-loads-lazily** (lazy encoder, v4) — `encodeMp3` loads
  lamejs via a dynamic `import()`, so the encoder ships as its **own chunk**,
  fetched on the first MP3 encode rather than at boot. `encodeMp3` is therefore
  `async`; `encodeWav` stays synchronous. `encode.ts` remains AudioContext-free
  and jsdom-testable — a dynamic import is not an environment dependency. Boot
  warms the chunk from `main.ts` on `requestIdleCallback` (2 s `setTimeout`
  fallback — Safari only shipped `requestIdleCallback` in 17.4, and this app
  targets installed iOS PWAs). The warm is what preserves offline parity: by
  default the service worker caches only what a visit fetched
  ([pwa-install](pwa-install.md) REQ-service-worker-is-registered) — the full
  file list is precached only for a device that saved an offline copy
  ([play-offline](play-offline.md)) — so a chunk never fetched while online
  would be missing offline. A failed warm is swallowed — the real `import()`
  inside `encodeMp3` retries it.
- **REQ-labels-echo-the-chosen-format** (format-echoing labels; v5, extended in
  v7) — A control that leads to a file says which format that file will be,
  re-labelled the moment the format changes. v7 adds two surfaces without
  dropping the original:
    - **`Export Song as <WAV|MP3>…`** — the Song tab button. It no longer writes
      the file itself, but it keeps naming the format because it sits a few
      pixels from the panel's *other* `Export` (the `.json`/`.zip` chooser), and
      "as WAV" is what distinguishes them at a glance. The `…` carries its
      conventional "opens a dialog" meaning.
    - **`Export as <WAV|MP3>`** (the modal's confirm) and **`Save as
      <WAV|MP3>`** (the Record window's save) — the two controls that actually
      write, each naming its own overridden format rather than the Song tab's
      default.
    - **`Record…`** names no format: it opens a window, and the take's format is
      not chosen until Save.
  The `testids` below stay the stable handles — these labels are not.
- **REQ-export-opens-an-options-modal** (export options, v7) —
  `song-export-audio` opens an **options modal** rather than exporting on the
  spot, carrying exactly three choices: **Format**, **Runs** (1..`MAX_RUNS`) and
  **Add an empty bar at the end** (checked). It shows a live computed length
  (`bars × runs [+ 1 tail bar] ≈ N s`) so the cost of the choice is visible
  before you commit — a 10-run export of a 32-bar song is over ten minutes of
  rendering, which must not be a surprise. The Song tab keeps its WAV/MP3
  segmented as the **global default**: the modal and the Record window each
  *seed* from it and may override for that one use **without writing back**, so
  a default stays a default. `Export` is disabled with an explanatory `title`
  while the recorder is busy, rather than being a button whose click silently
  does nothing (`exportSong` early-returns when a capture is already in flight).
- **REQ-the-modal-is-the-renders-own-surface** (the modal is the render's own
  surface, v7.1) — **Confirming does not close the modal.** Export renders in
  *real time*: a 32-bar song at 10 runs is over ten minutes during which v7.0
  showed nothing at all — the dialog vanished, the transport ran, and the only
  clue anything was happening was that the app had gone unresponsive-looking. So
  the modal stays and becomes the progress display:
  - **`rendering`** — a determinate progress bar plus `bar n of N`, driven off
    `exportProgress()` (`elapsedSteps / stopAtStep`) repainted on `clock.onTick`.
    `elapsedSteps`, not `clock.step`: the clock's step wrapped at `& 0xffff`
    until [transport](transport.md) REQ-the-step-counter-is-bounded-at-ingress, which made the old form unreachable (REQ-export-song-renders-from-the-top).
    Determinate, not a spinner: the length is known exactly up front, and this is
    long enough that "how much longer" is the actual question. The bar is the
    shared [progress bar](progress-bar.md) (its REQ-determinate-announces-value/REQ-indeterminate-drops-valuenow), testid
    `export-audio-progress`.
  - **`encoding`** — *"Preparing your download…"* (REQ-capture-is-a-five-phase-machine's phase). Indeterminate,
    because lamejs reports no progress.
  - **done** — a short confirmation, then the modal closes itself. The browser's
    own download is the real receipt; making the user dismiss a dialog to
    acknowledge what they asked for is a click that buys nothing.
  - **Cancel is real, or it is not there.** During `rendering` the actions become
    a single Cancel wired to `cancelExport()` — which unhooks the tick, stops the
    transport and drops the buffer. A dead Cancel button next to a ten-minute
    progress bar would be worse than none. During `encoding` there is nothing
    left to cancel, so no action is offered.
  - The backdrop does **not** dismiss (`dismissOnBackdrop: false`) — a stray
    click must not abandon a long render — but Escape still works and, while
    rendering, aborts it. Whatever closes the modal mid-render cancels it: the
    modal *is* the render's surface, so it can never outlive it or be outlived.

- **REQ-a-capture-waits-for-a-bank-render** (v14) — **An export or a manual take
  is refused while a render to the sampler is in flight.** The bank render
  already refused to start while the recorder captured
  ([render-to-sampler](render-to-sampler.md) REQ-a-render-is-refused-while-busy),
  because both restart the transport; the other direction had no guard. An
  export started mid-render called `clock.stop()` under it, the render's promise
  never settled, and the restore it always runs never ran: the sequencer stayed
  forced on with its mute, solo and chain lane changed, and seeking, Loop, the
  render button and the audio watchdog stayed locked until a reload. So
  `RecorderController` takes a `blocked()` predicate, the Engine wires it to
  `bankRender.isRendering()`, and `exportSong` / `startManual` return
  `false` rather than starting. The surfaces say why instead of offering a dead
  button: the export modal's Export and the Record window's Record are disabled
  while a render runs, with the reason as their tooltip, and re-enable when it
  ends.
- **REQ-a-failed-encode-keeps-the-take** (v14) — **A save that fails keeps the
  take, and an export that fails says so.** The MP3 encoder is a lazy chunk
  (REQ-the-mp3-encoder-loads-lazily) and can fail to load — offline, with the
  boot warm-up having failed too. `saveTake` used to drop the take *before*
  encoding, so a failure lost the performance for good; it now keeps it until
  the download is written, returns to `review` on failure (so the user can retry
  or pick WAV), and resolves `false`. An export's failure used to read as success
  — the modal took "back to idle" for "written" and said *Done — check your
  downloads* — and `lastExportFailed()` now tells the two apart; the modal says
  what went wrong and stays open. Neither path leaves an unhandled rejection.
  The wording is the lazy-load one (lazy-load-failure.md's operation shape):
  offline, *this part of the app isn't downloaded yet*; online, *the download
  failed*.
- **REQ-a-discarded-take-stays-discarded** (v14) — **A take discarded while its
  stop is still flushing does not come back.** `stopManual` awaits the worklet's
  final batch (REQ-chunks-are-batched-then-flushed); a Discard in that window
  dropped the take, and then the stop resolved and parked it in `review` again.
  Every take has a generation, bumped by `begin` and `discardTake`; a stop that
  resolves for an older generation is dropped.
- **REQ-the-capture-bound-is-the-songs-bar** (v11) — **A bar is the song's
  bar.** The capture bound (`bars × runs × barTicks`) and the optional tail bar
  both measure in `barTicks` ([meter](meter.md) REQ-bar-exact-capture-follows-bar-ticks), so a 7/8 song exports
  7/8 bars and its tail is one of them. At the default meter every number is
  identical to v10.

## Technical design

### Contract / public interface

```yaml
RecorderController:  # src/audio/recorder/recorder-controller.ts
  ExportFormat = 'wav' | 'mp3'
  RecorderPhase = 'idle' | 'recording' | 'paused' | 'review' | 'encoding'
  ExportOpts    = { runs?: number, tailBar?: boolean }   # runs 1..MAX_RUNS, default 1/false

  exportSong(fmt, opts?): void   # runs passes from step 0, auto-stop, download (REQ-export-song-renders-from-the-top)
  cancelExport(): void           # abort a render in flight -> idle, no file (REQ-the-modal-is-the-renders-own-surface)
  exportProgress(): number       # 0..1 through the pass; 0 when not exporting
  startManual() ; pauseManual() ; resumeManual() ; stopManual()   # REQ-capture-is-a-five-phase-machine verbs
  saveTake(fmt): Promise<void>   # encode + download the reviewed take -> idle
  discardTake(): void            # drop the held buffer -> idle
  get phase: RecorderPhase
  isCapturing(): boolean         # recording | paused — audio is being taken
  isExporting(): boolean         # an automatic pass owns the transport (seek guard)
  capturedSeconds(): number      # true length of the take, paused time excluded
  onPhase(fn) -> unsubscribe
RecorderNode:  # src/audio/recorder/node.ts (wraps recorder.js)
  start() ; stop(): Promise<{ left, right, sampleRate }>   # REQ-chunks-are-batched-then-flushed: awaits the flush
  pause(): Promise<void> ; resume()   # REQ-capture-is-a-five-phase-machine: worklet stop/start WITHOUT clearing chunks
  dispose()                   # sample-recorder REQ-the-recorder-node-is-released-with-the-session; terminal, idempotent
  firstFrame: number | null   # REQ-each-chunk-is-frame-tagged; null until the first chunk arrives
  capturedFrames: number      # running frame count; reset by start(), survives pause
worklet chunk message: { l: Float32Array, r: Float32Array, f: number }  # f = batch's first frame
worklet flush reply:   { l, r, f, done: true }   # REQ-chunks-are-batched-then-flushed — the partial batch at stop/pause
constants: RECORD_BATCH_QUANTA = 16   # ~43 ms at 48 kHz; message rate 375/s -> 23/s
encode.ts (pure):
  encodeWav(left, right, sampleRate): Blob            # dependency-free, sync
  encodeMp3(left, right, sampleRate): Promise<Blob>   # REQ-the-mp3-encoder-loads-lazily lazy lamejs, MP3_KBPS CBR; unsupported rate -> WAV
  triggerDownload(blob, filename): void
constants: FALLBACK_BARS = 4, TAIL_MS = 350, MAX_RUNS = 10, MP3_KBPS = 192
```

The worklet is **unchanged by v7**. It has understood exactly two commands since
v1 (`start` → `recording = true`, `stop` → `recording = false`) and pause needs
no third: the destructive part of a restart — clearing the chunk lists — lives on
the *node* side, so `pause()`/`resume()` are the same two messages with that
clearing left out. Splice-out (REQ-capture-is-a-five-phase-machine) is what you get by not writing code.

`saveTake()` is `async` because of `encodeMp3`, but `node.stop()` and the phase
transition both run **before** any await — capture timing and re-entrancy are
unchanged. The download landing a microtask later is safe: the export path
already downloads from a `setTimeout` with no user activation.

### Layer touchpoints

```yaml
graph: master -> recorder worklet (zero-output sink; does not alter playback)
song export: RecorderController drives clock from step 0 and counts TICKS SEEN
  in its own `elapsedSteps` (the wrap-free counterpart to the clock's step),
  finishing after bars × runs (or FALLBACK_BARS) + the tail (REQ-export-song-renders-from-the-top, REQ-the-capture-keeps-a-tail)
guards keyed off the recorder — two predicates, never one:
  engine.canSeek()              -> !isExporting()   # absolute-step bounds only
  engine.clock.onStop choke     -> !isCapturing()   # don't cut a take's samples
  bankRender.blocked()          -> isCapturing()    # don't fight over the transport
ui: src/ui/panels/song-panel.ts — the Audio row keeps the Format segmented as the
  GLOBAL DEFAULT (REQ-export-opens-an-options-modal) and its two buttons now open surfaces rather than write:
    song-export-audio -> export-audio-modal.ts (Format / Runs / tail bar)
    song-record       -> the Record window (record-window.md)
  testids: song-export-audio, song-export-fmt-<wav|mp3>, song-record  (unchanged
    ids — the help badges and song-mode REQ-sync-and-audio-pair-up's layout probe anchor to them)
    export-audio-modal, export-audio-fmt-<wav|mp3>, export-audio-runs,
    export-audio-tail, export-audio-length, export-audio-confirm, -cancel,
    export-audio-progress + -status (REQ-the-modal-is-the-renders-own-surface's in-flight view), -abort
build: vendor/lamejs is dynamic-import-only -> its own rolldown chunk
  (vite.config.ts codeSplitting group `lamejs`, mirroring `demos`)
boot: src/main.ts warms that chunk on idle (REQ-the-mp3-encoder-loads-lazily)
bench: scripts/audio-bench.mjs calls exportSong(fmt) with NO opts and must keep
  working — that is what pins REQ-the-capture-keeps-a-tail's API-vs-UI default split
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

Scenario: Runs multiply the rendered length (v7, REQ-export-song-renders-from-the-top)
  Given a two-bar enabled chain
  When the user exports with Runs = 3
  Then the capture ends at step 2 × 3 × 16 and the chain replays from slot 0 twice
  And Runs is clamped to 1..MAX_RUNS, so 0 and 99 render 1 and 10 passes
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: The tail bar lets a reverb decay instead of cutting it (v7, REQ-the-capture-keeps-a-tail)
  Given a song whose reverb rings longer than TAIL_MS
  When the user exports with the tail bar checked
  Then the capture continues for one bar of silence after the transport stops
  And no further step is triggered during it — the transport is already stopped
# pinned by: tests/audio/recorder/recorder-controller.test.ts (timing),
#            npm run bench:audio A/B (the only check that it SOUNDS right — ADR-010)

Scenario: An omitted opts renders exactly what v6 did (regression, REQ-the-capture-keeps-a-tail)
  When exportSong(fmt) is called with no options — as scripts/audio-bench.mjs does
  Then it renders one pass and waits TAIL_MS, bar-exact and repeatable
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: The export modal stays open and reports the render (v7.1, REQ-the-modal-is-the-renders-own-surface)
  Given the export options modal with a multi-bar song
  When the user confirms
  Then the modal STAYS OPEN, the options are replaced by a progress bar reading
    "bar n of N", and it advances as the transport does
  When the render finishes
  Then the status reads that it is preparing the download
  And once the file is written the modal closes itself
# pinned by: tests/ui/export-audio-modal.test.ts, e2e/song.spec.ts

Scenario: Cancelling a render in flight leaves no file (v7.1, REQ-the-modal-is-the-renders-own-surface)
  Given a render in progress
  When the user clicks Cancel
  Then the transport stops, the recorder returns to idle and nothing downloads
  And closing the modal mid-render does the same — the modal cannot outlive it
# pinned by: tests/audio/recorder/recorder-controller.test.ts,
#            tests/ui/export-audio-modal.test.ts

Scenario: Encoding is reported, not silence (v7.1, REQ-capture-is-a-five-phase-machine regression)
  Given a take being saved as MP3, where lamejs takes seconds
  Then the phase is `encoding` for the whole encode — not `idle`
  And every surface says so instead of going inert and looking stalled
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: A manual take is reviewed before it is written (v7, REQ-capture-is-a-five-phase-machine)
  Given a manual capture is running
  When the user stops it
  Then the phase is `review`, playback continues, and NOTHING has downloaded
  When the user saves it
  Then one file downloads and the phase returns to idle
  And discarding instead downloads nothing and drops the buffer
# pinned by: tests/audio/recorder/recorder-controller.test.ts, e2e/record-window.spec.ts

Scenario: Pausing splices the take rather than padding it (v7, REQ-capture-is-a-five-phase-machine)
  Given a manual capture that has taken 2 s of audio
  When the user pauses, waits, and resumes for another 2 s
  Then the take is one continuous 4 s buffer — the paused stretch is absent
  And capturedSeconds() never advanced while paused
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: A batched capture is frame-identical to a per-quantum one (v10, REQ-chunks-are-batched-then-flushed)
  Given a run of render quanta with known samples
  When the worklet batches them and the node concatenates the result
  Then every captured sample matches the unbatched capture, in the same order
  And no gap appears at a batch boundary
# pinned by: tests/audio/recorder/node.test.ts

Scenario: Stopping mid-batch keeps the tail (v10, REQ-chunks-are-batched-then-flushed, regression)
  Given a capture stopped part-way through a batch
  When stop() resolves
  Then the frames buffered in the worklet are in the take
  # reading the chunk list synchronously dropped up to ~40 ms off every take
# pinned by: tests/audio/recorder/node.test.ts

Scenario: A node with nothing to flush still resolves (v10, REQ-chunks-are-batched-then-flushed, edge)
  Given a recorder that was never started, or has been disposed
  When stop() is called
  Then it resolves with an empty take rather than waiting for a flush
# pinned by: tests/audio/recorder/node.test.ts

Scenario: A manual take does not lock the playhead (v7, REQ-export-song-renders-from-the-top/REQ-capture-is-a-five-phase-machine)
  Given a manual capture is running
  Then seeking is still allowed — only an export bounds itself by absolute step
  When an export pass is running instead
  Then seeking is refused
# pinned by: tests/audio/recorder/recorder-controller.test.ts (predicates),
#            e2e/record-window.spec.ts

Scenario: MP3 encodes at the high-quality bitrate (v3)
  When encodeMp3 runs at a supported sample rate
  Then the first MP3 frame header carries the 192 kbps bitrate index (0xB)
# pinned by: tests/audio/wav-encode.test.ts

Scenario: The lazily-loaded encoder still produces a valid MP3 (v4, REQ-the-mp3-encoder-loads-lazily)
  Given lamejs has never been imported in this session
  When encodeMp3 is awaited at a supported sample rate
  Then it resolves to an audio/mpeg blob at 192 kbps
# pinned by: tests/audio/wav-encode.test.ts (a fresh module graph per test file)
#   + e2e/song.spec.ts — the only check that the dynamic import resolves in a
#   real browser. It asserts the MPEG frame sync + 192 kbps index by byte
#   inspection, so it runs on CI Chromium, which has no MP3 *decoder*.

Scenario: Everything that leads to a file names the format (v5, extended v7 — REQ-labels-echo-the-chosen-format)
  Given the Song tab default is WAV
  Then its button reads "Export Song as WAV…" — telling it apart from the
    neighbouring Export (.json) at a glance
  And the modal's confirm reads "Export as WAV" and the Record window's save
    reads "Save as WAV"
  When the user picks MP3 inside the modal
  Then its confirm reads "Export as MP3"
  And the Song tab button STILL reads WAV — an override does not write back (REQ-export-opens-an-options-modal)
# pinned by: tests/ui/export-audio-modal.test.ts, tests/ui/record-window.test.ts,
#            e2e/song.spec.ts

Scenario: An unsupported rate never loads the encoder (v4, edge)
  When encodeMp3 is awaited at a sample rate lamejs cannot handle
  Then it resolves to an audio/wav blob with a console warning
  And the lamejs chunk is never fetched
# pinned by: tests/audio/wav-encode.test.ts

Scenario: An export waits for a render to the sampler (v14, REQ-a-capture-waits-for-a-bank-render, regression)
  Given a render to the sampler in flight
  When an export or a manual take is started
  Then it is refused, the render finishes and restores the engine state as always
   And the export modal's Export and the Record window's Record are disabled until it does
# pinned by: tests/audio/recorder/recorder-controller.test.ts, tests/ui/record-window.test.ts

Scenario: A failed MP3 save keeps the take (v14, REQ-a-failed-encode-keeps-the-take, regression)
  Given a take in review and an MP3 encoder that fails to load
  When the user saves it as MP3
  Then saveTake resolves false, the phase is review again and the take is still there
   And saving it as WAV then writes it
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: A failed export is not reported as done (v14, REQ-a-failed-encode-keeps-the-take)
  Given an export whose MP3 encode fails
  When the recorder returns to idle
  Then lastExportFailed() is true and the modal says what went wrong
# pinned by: tests/audio/recorder/recorder-controller.test.ts

Scenario: A take discarded mid-stop stays discarded (v14, REQ-a-discarded-take-stays-discarded, edge)
  Given a stop awaiting its final batch
  When the user discards before it resolves
  Then the phase stays idle and no take is held
# pinned by: tests/audio/recorder/recorder-controller.test.ts
```

## Tests & verification

- `tests/audio/wav-encode.test.ts` (pure encode), `tests/audio/recorder/recorder-controller.test.ts`
  (v7 — the phase machine and the length math; `bank-render.test.ts` is its
  template: a fake clock plus a fake node), `tests/ui/export-audio-modal.test.ts`,
  `e2e/song.spec.ts` (download + RIFF/WAVE header), `e2e/record-window.spec.ts`.
- `npm test` / `npm run e2e`.
- **By ear, for REQ-the-capture-keeps-a-tail.** The tail bar changes what leaves the instrument and
  nothing automated can hear it ([ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)
  ranks *musical* first). Render the same material twice — tail off, tail on —
  and confirm the reverb decays rather than stopping mid-tail. See
  [verify-audio-by-ear](../recipes/verify-audio-by-ear.md).

## Open questions / future

- A new format adds an `ExportFormat` value + an `encode*` function; keep it
  AudioContext-free so it stays unit-testable.
- `MAX_RUNS` is 10 because that is already ten minutes of real-time rendering for
  a 32-bar song, and export is real-time (it drives the live graph, not an
  `OfflineAudioContext`). An offline render would lift the ceiling entirely but is
  a different feature: the FX chain, the worklets and the transport would all have
  to be rebuilt in an offline context.
