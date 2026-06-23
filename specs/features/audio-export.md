# Audio export (WAV / MP3 capture)

```yaml
id: audio-export
status: implemented
version: 1
owner: core
related:
  - architecture
  - song-mode
  - sample-recorder
source:
  - public/worklets/recorder.js
  - src/audio/recorder/node.ts
  - src/audio/recorder/recorder-controller.ts
  - src/audio/recorder/encode.ts
  - src/ui/panels/song-panel.ts
```

Capturing the master output to a downloadable WAV or MP3, either as a full song
pass or a free-form manual record.

## Background / Why

Export taps a **zero-output `recorder` AudioWorklet** off `master` (post
master-volume) as a pure sink — it pulls audio without affecting playback. Encoding
is kept **pure and AudioContext-free** (`encode.ts`) so it is unit-testable under
jsdom: `encodeWav` is dependency-free; `encodeMp3` uses the vendored `lamejs`.
The same `encode.ts` is reused by the [sample recorder](sample-recorder.md).

## Requirements

- **REQ-1** — A zero-output recorder worklet, tapped off `master` post-volume.
- **REQ-2** — `exportSong(fmt)` restarts from the top, renders exactly one pass of
  the longest enabled [arrangement](arrangement.md) chain (or `FALLBACK_BARS` = 4
  when none enabled), auto-stops, and downloads.
- **REQ-3** — A `TAIL_MS` (350 ms) grace period after the last bar captures
  look-ahead + reverb/release tails.
- **REQ-4** — `toggleManual(fmt)` is a free-form record toggle; the second call
  stops + downloads, leaving the transport running.
- **REQ-5** — Encoding is pure (no `AudioContext`): WAV dependency-free, MP3 via
  vendored lamejs.

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
encode.ts (pure):
  encodeWav(left, right, sampleRate): Blob          # dependency-free
  encodeMp3(left, right, sampleRate): Blob          # vendored lamejs
  triggerDownload(blob, filename): void
constants: FALLBACK_BARS = 4, TAIL_MS = 350
```

### Layer touchpoints

```yaml
graph: master -> recorder worklet (zero-output sink; does not alter playback)
song export: RecorderController drives clock from the top, watches bar count,
  finishes after the longest enabled chain (or FALLBACK_BARS) + TAIL_MS
ui: src/ui/panels/song-panel.ts (Export Song WAV/MP3, manual record toggle)
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
```

## Tests & verification

- `tests/audio/wav-encode.test.ts` (pure encode), `e2e/song.spec.ts` (download +
  RIFF/WAVE header).
- `npm test` / `npm run e2e`.

## Open questions / future

- A new format adds an `ExportFormat` value + an `encode*` function; keep it
  AudioContext-free so it stays unit-testable.
