# Audio export (WAV / MP3 capture)

```yaml
id: audio-export
status: implemented
version: 6   # v6: exportSong pins start(0) and refuses a playhead seek (REQ-2)
owner: core
related:
  - architecture
  - song-mode
  - sample-recorder
  - pwa-install
source:
  - public/worklets/recorder.js
  - src/audio/recorder/node.ts
  - src/audio/recorder/recorder-controller.ts
  - src/audio/recorder/encode.ts
  - src/ui/panels/song-panel.ts
  - src/main.ts
```

Capturing the master output to a downloadable WAV or MP3, either as a full song
pass or a free-form manual record.

## Background / Why

Export taps a **zero-output `recorder` AudioWorklet** off `master` (post
master-volume) as a pure sink — it pulls audio without affecting playback. Encoding
is kept **pure and AudioContext-free** (`encode.ts`) so it is unit-testable under
jsdom: `encodeWav` is dependency-free; `encodeMp3` uses the vendored `lamejs`.
The same `encode.ts` is reused by the [sample recorder](sample-recorder.md).

`lamejs` is **pre-minified and 153 kB** — 30% of what used to be a single
505 kB entry chunk, downloaded and parsed by every visitor whether or not they
ever export MP3. It is therefore loaded with a dynamic `import()` (v4, REQ-7),
which is why `encodeMp3` is async. MP3 encoding is a rare, deliberate,
already-slow action, so the fetch is invisible next to the encode itself.

## Requirements

- **REQ-1** — A zero-output recorder worklet, tapped off `master` post-volume.
- **REQ-2** — `exportSong(fmt)` restarts from the top, renders exactly one pass of
  the longest enabled [arrangement](arrangement.md) chain (or `FALLBACK_BARS` = 4
  when none enabled), auto-stops, and downloads. "From the top" means
  **`clock.start(0)` explicitly**: the capture's end is `step >= stopAtStep`, an
  absolute step number, and since [transport](transport.md) REQ-7 a plain `start()`
  begins from the user's cue rather than 0 — so a cued transport would silently
  truncate the export. For the same reason a **playhead seek is refused while this
  capture is in flight** ([transport-position](transport-position.md) REQ-6);
  `RecorderController` exposes its capture state for that guard.
- **REQ-3** — A `TAIL_MS` (350 ms) grace period after the last bar captures
  look-ahead + reverb/release tails.
- **REQ-4** — `toggleManual(fmt)` is a free-form record toggle; the second call
  stops + downloads, leaving the transport running.
- **REQ-5** — Encoding is pure (no `AudioContext`): WAV dependency-free, MP3 via
  vendored lamejs. MP3 encodes at **`MP3_KBPS` = 192 kbps CBR** (v3; the LAME
  "high quality" sweet spot, ≈ `-V2`) — every MP3 surface (song export, project
  clips, sample-editor saves) goes through this one `encodeMp3`, so they all
  inherit the bitrate. A sample rate lamejs cannot handle still falls back to
  WAV with a console warning — on that path `encodeMp3` returns **without**
  loading lamejs at all.
- **REQ-6 (frame tagging)** — Each chunk the worklet posts carries
  `f = currentFrame` (the absolute sample index of the chunk's first frame in
  the context timeline). `RecorderNode` records the first chunk's tag as
  `firstFrame` (reset by `start()`), letting consumers map a scheduled
  `AudioContext` time to an exact offset in the captured stream —
  `offset = round(when × sampleRate) − firstFrame`. Consumers that ignore the
  tag (this spec's own controller) are unaffected. Consumed by
  [render-to-sampler](render-to-sampler.md).
- **REQ-7 (lazy encoder, v4)** — `encodeMp3` loads lamejs via a dynamic
  `import()`, so the encoder ships as its **own chunk**, fetched on the first
  MP3 encode rather than at boot. `encodeMp3` is therefore `async`; `encodeWav`
  stays synchronous. `encode.ts` remains AudioContext-free and jsdom-testable —
  a dynamic import is not an environment dependency.
  Boot warms the chunk from `main.ts` on `requestIdleCallback` (2 s `setTimeout`
  fallback — Safari only shipped `requestIdleCallback` in 17.4, and this app
  targets installed iOS PWAs). The warm is what preserves offline parity: the
  service worker is runtime-cache-only with no precache manifest of hashed
  assets ([pwa-install](pwa-install.md) REQ-6), so a chunk never fetched while
  online would be missing offline. A failed warm is swallowed — the real
  `import()` inside `encodeMp3` retries it.
- **REQ-8 (format-echoing labels, v5)** — The Song tab's two audio buttons name
  the format they will write: **`Export Song as <WAV|MP3>`** and
  **`Record as <WAV|MP3>`**, both re-labelled the moment the Format switch
  changes. While capturing, the record button reads plain **`Stop`** (stopping
  needs no format) and reverts to `Record as <FMT>` afterwards. The `testids`
  below stay the stable handles — these labels are not.

## Technical design

### Contract / public interface

```yaml
RecorderController:  # src/audio/recorder/recorder-controller.ts
  exportSong(fmt): void          # one full pass, auto-stop, download
  toggleManual(fmt): void        # start/stop free-form record
  isRecording(): boolean
  onState(fn) -> unsubscribe
  ExportFormat = 'wav' | 'mp3'
RecorderNode:  # src/audio/recorder/node.ts (wraps recorder.js)
  start() ; stop(): { left, right, sampleRate }
  firstFrame: number | null   # REQ-6; null until the first chunk arrives
worklet chunk message: { l: Float32Array, r: Float32Array, f: number }  # f = currentFrame
encode.ts (pure):
  encodeWav(left, right, sampleRate): Blob            # dependency-free, sync
  encodeMp3(left, right, sampleRate): Promise<Blob>   # REQ-7 lazy lamejs, MP3_KBPS CBR; unsupported rate -> WAV
  triggerDownload(blob, filename): void
constants: FALLBACK_BARS = 4, TAIL_MS = 350, MP3_KBPS = 192
```

`RecorderController.finish()` is `async` because of `encodeMp3`, but its
`finishing` guard and `node.stop()` both run **before** the await — capture
timing and re-entrancy are unchanged, and both callers fire-and-forget
(`void this.finish(fmt)`). The download landing a microtask later is safe:
`exportSong` already downloads from a `setTimeout` with no user activation.

### Layer touchpoints

```yaml
graph: master -> recorder worklet (zero-output sink; does not alter playback)
song export: RecorderController drives clock from the top, watches bar count,
  finishes after the longest enabled chain (or FALLBACK_BARS) + TAIL_MS
ui: src/ui/panels/song-panel.ts (Export Song WAV/MP3, manual record toggle;
  both labels echo the selected format — REQ-8 — via one syncAudioLabels())
  testids: song-export-audio, song-export-fmt-<wav|mp3>, song-record
build: vendor/lamejs is dynamic-import-only -> its own rolldown chunk
  (vite.config.ts codeSplitting group `lamejs`, mirroring `demos`)
boot: src/main.ts warms that chunk on idle (REQ-7)
```

## Scenarios (BDD)

```gherkin
Scenario: Export Song writes a valid WAV
  Given a song with an enabled chain
  When the user clicks Export Song (WAV)
  Then a .wav blob downloads whose RIFF/WAVE header is valid
# pinned by: e2e/song.spec.ts, tests/audio/wav-encode.test.ts

Scenario: No enabled chain falls back to 4 bars (edge)
  Given no arrangement lane is enabled
  When Export Song runs
  Then it renders FALLBACK_BARS (4) bars + TAIL_MS, then auto-stops
# pinned by: recorder-controller logic; e2e/song.spec.ts

Scenario: Manual record leaves the transport running
  When the user toggles manual record off
  Then the file downloads but playback continues
# pinned by: recorder-controller contract

Scenario: MP3 encodes at the high-quality bitrate (v3)
  When encodeMp3 runs at a supported sample rate
  Then the first MP3 frame header carries the 192 kbps bitrate index (0xB)
# pinned by: tests/audio/wav-encode.test.ts

Scenario: The lazily-loaded encoder still produces a valid MP3 (v4, REQ-7)
  Given lamejs has never been imported in this session
  When encodeMp3 is awaited at a supported sample rate
  Then it resolves to an audio/mpeg blob at 192 kbps
# pinned by: tests/audio/wav-encode.test.ts (a fresh module graph per test file)
#   + e2e/song.spec.ts — the only check that the dynamic import resolves in a
#   real browser. It asserts the MPEG frame sync + 192 kbps index by byte
#   inspection, so it runs on CI Chromium, which has no MP3 *decoder*.

Scenario: The audio buttons name the format they will produce (v5, REQ-8)
  Given the Song tab with Format = WAV
  Then the buttons read "Export Song as WAV" and "Record as WAV"
  When the user picks MP3
  Then they read "Export Song as MP3" and "Record as MP3"
# pinned by: e2e/song.spec.ts

Scenario: An unsupported rate never loads the encoder (v4, edge)
  When encodeMp3 is awaited at a sample rate lamejs cannot handle
  Then it resolves to an audio/wav blob with a console warning
  And the lamejs chunk is never fetched
# pinned by: tests/audio/wav-encode.test.ts
```

## Tests & verification

- `tests/audio/wav-encode.test.ts` (pure encode), `e2e/song.spec.ts` (download +
  RIFF/WAVE header).
- `npm test` / `npm run e2e`.

## Open questions / future

- A new format adds an `ExportFormat` value + an `encode*` function; keep it
  AudioContext-free so it stays unit-testable.
