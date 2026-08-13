# Project export (song + sampler audio in one zip)

```yaml
id: project-export
status: implemented
version: 5   # v5: REQ-2 budgets the reader (entry count, declared-size pre-flight,
             #     capped inflate, running total) — a zip is untrusted input
             # v4: REQ-1 names no canonical version (it had frozen at "v4")
             # v3: JSON demos are fetched on click too; loadDemo is async
owner: core
related:
  - song-mode
  - sampler
  - audio-export
  - sample-recorder
  - dialog
  - untrusted-input
  - ../decisions/adr-015-untrusted-input-is-bounded
source:
  - src/utils/compression.ts            # shared deflate-raw helpers (extracted from webrtc-signaling)
  - src/utils/zip.ts                    # minimal dependency-free ZIP codec
  - src/state/project.ts                # pure bundle build/parse (AudioContext-free)
  - src/ui/components/export-song-modal.ts
  - src/ui/panels/song-panel.ts         # export modal wiring + zip import + demo-zip buttons
  - src/state/song.ts                   # ZIP_DEMOS (?url glob)
```

## Background / Why

Sampler slot audio lives only in `SamplerMachine.buffers`; a saved/exported song
persists just the filenames (`SongFile.sampleNames`), so every export/import loses
the audio and the sampler panel falls back to the `.needs-reload` hint
([song-mode](song-mode.md) REQ-5, [sampler](sampler.md) REQ-4). This feature adds a
**"Project"** export: a `<name>.websynth.zip` containing the canonical compact song
JSON plus each loaded slot's audio clip, importable in one step, and a loader path
so future demos can ship as zips with audio. The `.json` song format is untouched.

## Requirements

- **REQ-1** — A project zip contains the **unmodified canonical compact** song JSON
  (`Song.toJSON`, ADR-011) as `song.json`, plus one `samples/<slot>-<name>.<ext>`
  entry per loaded sampler slot. `SongFile` stays whatever the current canonical
  version is — the zip is a container, never a new song format, so a format bump
  needs no edit here. Clip slot assignment is keyed by the **slot index in the
  entry name**; `sampleNames` in `song.json` remains the display-name source of truth.
- **REQ-2** — The zip codec is **hand-written and dependency-free** (ADR-003):
  writer emits method 0 (stored) for audio + method 8 (deflate, via
  `CompressionStream('deflate-raw')` when available) for `.json`; reader accepts
  methods 0 + 8, locates the EOCD by backward scan (tolerates trailing bytes),
  trusts central-directory metadata, verifies CRC-32, and throws a typed `ZipError`
  on zip64 / unknown methods / bad CRC / truncation.
  **A zip is an untrusted container (v5)**, so the reader is also *budgeted*
  ([untrusted-input](untrusted-input.md) REQ-2): it refuses a central directory
  declaring more than `MAX_ZIP_ENTRIES`, uses each entry's **declared
  uncompressed size as a pre-flight budget** against `MAX_ZIP_ENTRY_BYTES`
  *before* inflating, caps the inflate itself at the same figure, and refuses
  once the running total across entries passes `MAX_ZIP_TOTAL_BYTES`. Previously
  the declared size was read but only compared *after* a full uncapped inflate,
  so a deflate bomb was spent before it was noticed.
- **REQ-3** — The shared deflate helpers live in `src/utils/compression.ts`
  (extracted from `webrtc-signaling.ts`, behaviour identical) so the zip module does
  not depend on an audio/signaling module.
- **REQ-4** — **Export** opens a modal offering **Song (.json)** (default) and
  **Project (.zip)**. The Project row is **disabled with an explanation when no
  sampler slot has audio loaded**. Project export offers a WAV (default) / MP3
  clip-format toggle; MP3 shows a caveat that encoder padding slightly alters clip
  length. Clip extension derives from the encoded blob's MIME type — `encodeMp3`'s
  unsupported-rate WAV fallback must yield `.wav`. `encodeClip` is **async** (v2)
  because `encodeMp3` lazily imports lamejs ([audio-export](audio-export.md)
  REQ-7); the export flow already awaits per clip, so this adds no round trip.
- **REQ-5** — **Import** auto-detects zip vs JSON by magic bytes (`PK` first,
  extension fallback). The JSON path is unchanged. The zip path validates
  `song.json` via `Song.parse` (reused), tolerates one level of folder nesting
  (Explorer re-zip), and **degrades gracefully**: a missing or undecodable clip
  never aborts the apply — the slot just keeps the existing `.needs-reload` hint;
  out-of-range slots are skipped.
- **REQ-6** — **Save (slots) stays JSON-only** — a zip cannot live in localStorage.
  After importing a project then reloading the page, `.needs-reload` correctly
  reappears (the buffers were session-only, as before).
- **REQ-7** — Demo projects: any `src/state/demos/*.websynth.zip` is auto-registered
  at build time via an `import.meta.glob` `?url` (fetched lazily on click, which is a
  user gesture). The display name comes from `demos-index.json`, which
  `npm run clean:demos` fills by opening every zip through `parseProjectZip` in
  Node and reading the song's own `name` — so a zip demo is named exactly like a
  JSON one. The filename-minus-extension mangle (`Run_Away_2.websynth.zip` →
  "Run Away 2") survives only as the fallback for a zip the index has not seen;
  export filenames are underscore-sanitized (`projectFilename`), so that fallback
  round-trips the common case. An empty glob (no zip assets) costs nothing.
  (v2) The **JSON** drop-in demos are fetched on click the same way — see
  [song-mode](song-mode.md) REQ-12 — so zips are no longer the odd one out in
  either naming or loading.
- **REQ-8** — Decode/encode is memory-aware: clips are encoded/decoded
  **sequentially** (8 × multi-MB WAVs), and `decodeAudioData` gets a **copy** of the
  clip bytes (`.slice()`) because entries are subarray views of the whole zip buffer
  and `decodeAudioData` detaches its input.

## Technical design

### Contract / public interface

```yaml
zip:  # src/utils/zip.ts (pure; async only for the Compression/DecompressionStream hops)
  ZipEntry: { name: string, data: Uint8Array }
  zipWrite(entries): Promise<Uint8Array>   # UTF-8 names (bit 11), fixed DOS timestamp (deterministic)
  zipRead(bytes): Promise<ZipEntry[]>      # skips directory entries; CRC-verified
  crc32(bytes): number                     # table-based; exported for tests
  ZipError extends Error                   # mirrors SignalDecodeError idiom

compression:  # src/utils/compression.ts (extracted; feature-detected platform globals)
  hasCompression(): boolean
  deflateRaw(bytes) / inflateRaw(bytes): Promise<Uint8Array>

project:  # src/state/project.ts (pure — no AudioContext, no DOM beyond Blob)
  ClipExt: 'wav' | 'mp3'
  ProjectClipOut: { slot: number, data: Uint8Array, ext: ClipExt }   # input to buildProjectZip
  ProjectClipIn:  { slot: number, entryName: string, data: Uint8Array }  # normalized '/' entryName
  encodeClip(a: CapturedAudio, fmt: ClipExt): Promise<{ blob: Blob, ext: ClipExt }>
    # ext from blob.type, not fmt; caller adds slot + materializes data
    # async since v2: encodeMp3 lazily imports lamejs (audio-export REQ-7)
  buildProjectZip(file: SongFile, clips: ProjectClipOut[]): Promise<Uint8Array>
    # clip entry names derive from file.sampleNames[slot] (sanitized)
  parseProjectZip(bytes): Promise<ProjectParse>
    # { ok:true, file, clips: ProjectClipIn[] } | { ok:false, errors: string[] }
  projectFilename(songName): string        # Song.download's sanitize idiom + '.websynth.zip'
  sniffImportKind(head, filename): 'zip' | 'json'

ui:  # src/ui/components/export-song-modal.ts
  openExportSongModal({ hasSamplerAudio, onExport }): void
  # onExport(kind: 'json' | 'project', fmt: 'wav' | 'mp3')
```

### Data shapes (the zip layout)

```yaml
MySong.websynth.zip:
  song.json:              Song.toJSON(file)   # deflated when CompressionStream exists, else stored
  samples/<slot>-<sanitized>.<ext>:           # stored (method 0); one per loaded slot
    slot:      0..7 — the sampler slot index (authoritative for re-assignment)
    sanitized: name minus extension, [^A-Za-z0-9._-]+ -> _, capped (40), fallback 'clip'
    ext:       wav | mp3 — the encoded clip's real container (from blob.type)
import matching (tolerates one folder level from an Explorer re-zip):
  song.json:  by basename
  clips:      /(?:^|\/)samples\/(\d+)-[^/]*\.(wav|mp3)$/i
  separators: entry names are '\'->'/' normalized first — PowerShell's
              Compress-Archive writes backslash separators (verified on Win11)
```

### Layer touchpoints & ordering

```yaml
export (song-panel):
  song-export click -> openExportSongModal({ hasSamplerAudio: sampler.buffers.some(b => b != null) })
  kind json    -> Song.download(Song.capture(...))            # unchanged path
  kind project -> capture; per loaded slot audioBufferToCaptured -> await encodeClip(fmt)
                  -> await blob.arrayBuffer()  (sequentially — REQ-8)
                  -> buildProjectZip -> triggerDownload(application/zip, projectFilename)
import (song-panel):
  fileInput accepts .json,.zip; sniff first 4 bytes (sniffImportKind)
  zip -> parseProjectZip; errors reuse the alertDialog bullet-list idiom
      -> applyProjectBundle: applySong -> Song.saveSlot (JSON only — REQ-6)
         -> decode clips sequentially with ctx.decodeAudioData(clip.data.slice().buffer)
         -> sampler.setBuffer, then ALWAYS setSampleName (the song's own name, or the
            zip entry name as fallback) — its meta event is what tells the sampler
            panel to drop the .needs-reload hint now the buffer is live
         per-clip decode failures collect into ONE alert; the song stays applied
help copy (onboarding.md): the song.export / song.import topics in
  src/ui/onboarding/help-content.ts describe the chooser and the zip import
demo zips (song.ts + song-panel):
  ZIP_DEMOS from import.meta.glob('./demos/*.websynth.zip', { query: '?url' })
  name = DEMO_INDEX[file] (clean:demos reads it out of the zip); the basename
    mangle is only the fallback (REQ-7)
  one button per entry, sorted with every other demo by display name
    (compareSongNames) — NOT last (testid song-demo-<name>)
  click -> fetch(url) -> parseProjectZip -> applyProjectBundle
  Song.list()/loadSlot() stay sync + JSON-only, and list() omits zip demos entirely
    (a project bundle is not a song file)
  loadDemo(name) is async and RESOLVES WHEN APPLIED — it dispatches built-in /
    JSON drop-in / zip; callers that act on the loaded song (the guided tour, the
    empty-play modal) await it (song-mode.md REQ-12)
```

### Persistence

```yaml
file:  "<name>.websynth.zip" (download only)
NOT persisted: the zip itself — localStorage slots stay JSON (REQ-6); decoded
               buffers stay session-only exactly as before (sampler.md REQ-4)
```

## Scenarios (BDD)

```gherkin
Scenario: Export a project and re-import it in one step
  Given a WAV loaded into sampler slot 0
  When the user exports a Project (WAV) and re-imports the downloaded zip
  Then the song applies AND slot 0 is named without the needs-reload hint
# pinned by: e2e/export-project.spec.ts, tests/state/project.test.ts

Scenario: Project row is disabled with no sampler audio
  Given a fresh boot with no sampler slots loaded
  When the user clicks Export
  Then the modal's Project row is disabled and shows the explanation note,
    and confirming exports the plain .websynth.json
# pinned by: e2e/export-project.spec.ts

Scenario: The zip embeds the canonical compact song JSON unchanged
  Given a captured SongFile
  When buildProjectZip runs
  Then the song.json entry's text equals Song.toJSON(file)
# pinned by: tests/state/project.test.ts

Scenario: A hand-re-zipped project still imports (edge)
  Given a project zip whose entries are nested one folder deep with trailing bytes
  When parseProjectZip runs
  Then song.json is found by basename and clips match by the samples/<slot>- pattern
# pinned by: tests/state/project.test.ts, tests/utils/zip.test.ts

Scenario: A missing or undecodable clip degrades to needs-reload (failure)
  Given a project zip whose sampleNames name a slot with no clip entry
  When the project is imported
  Then the song applies, the slot keeps its name, and the needs-reload hint shows
# pinned by: tests/state/project.test.ts (a clip-less slot or out-of-range clip
#   never fails the parse); the hint itself is the sampler panel's existing
#   name-without-buffer behaviour (sampler.md REQ-4) — e2e/export-project.spec.ts
#   asserts its absence when clips DO decode

Scenario: Corrupt zips are rejected with a typed error (failure)
  Given bytes with a bad CRC, an unknown compression method, or a zip64 EOCD
  When zipRead runs
  Then it throws ZipError (and the import UI shows the alertDialog bullet list)
# pinned by: tests/utils/zip.test.ts

Scenario: A zip bomb is refused before it is materialized (v5)
  Given an entry whose declared size — or whose actual inflate — exceeds
    MAX_ZIP_ENTRY_BYTES
  When zipRead runs
  Then it throws ZipError without buffering the full output
  And a central directory declaring more than MAX_ZIP_ENTRIES is refused up front
  And entries summing past MAX_ZIP_TOTAL_BYTES are refused part-way through
# pinned by: tests/utils/zip.test.ts

Scenario: MP3 clip encoding falls back to WAV at unsupported rates (edge)
  Given a CapturedAudio at a sample rate lamejs cannot handle
  When encodeClip(a, 'mp3') is awaited
  Then the returned ext is 'wav' (derived from blob.type, never from the request)
# pinned by: tests/state/project.test.ts
```

## Tests & verification

- Unit: `tests/utils/zip.test.ts` (CRC vectors, stored+deflate round-trips,
  determinism, trailing garbage, truncation/bad-CRC/unknown-method → `ZipError`),
  `tests/state/project.test.ts` (layout, sanitization, nested folders, error paths,
  `sniffImportKind`, `encodeClip` ext), `tests/audio/webrtc-signaling.test.ts`
  (unchanged — guards the compression extraction) — `npm test`
- E2E: `e2e/export-project.spec.ts` (disabled row + JSON export; WAV round-trip via
  download.path() re-import) — `npm run e2e`
- Typecheck: `npm run typecheck`

## Open questions / future

- Embedding slot trim/edit metadata alongside clips would need a manifest entry —
  keep it additive if it ever lands.
