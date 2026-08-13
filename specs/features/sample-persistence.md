# Sampler clip persistence (IndexedDB)

```yaml
id: sample-persistence
status: implemented
version: 1
owner: core
related:
  - architecture
  - session-autosave   # the song half of the same safety net; the boot restore point
  - sampler            # owns the buffers this spec persists
  - factory-reset      # must wipe this store too
  - project-export     # the other place a slot is filled from stored bytes
  - toast              # the "restored N clips" hint
  - debug-panel        # surfaces the store's size
source:
  - src/state/sample-autosave.ts
  - src/state/idb-clip-kv.ts
  - src/audio/transport/sampler-machine.ts
  - src/main.ts
```

## Background / Why

[Session autosave](session-autosave.md) makes a tab close lose *nothing* of the
song — params, banks, chains, xy and motion all come back silently at boot — but
its REQ-10 deliberately excluded sampler **audio**: only `sampleNames` survived,
so every slot returned as a name with a `.needs-reload` hint and the user had to
re-pick files from disk. The exclusion was a storage-shape problem, not a design
one: binary clips don't fit in localStorage. IndexedDB does hold them, so this
spec closes the asymmetry — after a reload a restored session's slots are
audible immediately, without touching the song format (a `SongFile` still
carries names only, so songs stay small and shareable).

## Requirements

- **REQ-1** — Sampler clips persist in IndexedDB (db `websynth`, store `clips`,
  keyed by slot index) as 16-bit stereo **WAV bytes** produced by the existing
  pure `encodeWav`, and are restored through `ctx.decodeAudioData` — the same
  path Load and a [project-zip](project-export.md) import already use.
- **REQ-2** — Writes are debounced (~800 ms) and driven by **one** hook:
  `SamplerMachine.onBufferChange`, emitted from `setBuffer`. Every slot-filling
  path (Load, the [record modal](sample-recorder.md), ✎ re-edit,
  [render-to-sampler](render-to-sampler.md), project-zip import, load-undo
  restore, New→null) is covered without the caller knowing.
- **REQ-3** — A write pass reconciles all `SAMPLER_SLOT_COUNT` slots against a
  per-slot record of what was last written, compared by **`AudioBuffer`
  reference identity**: unchanged slots are never re-encoded, a cleared slot
  deletes its record, a new/replaced buffer is encoded and put.
- **REQ-4** — Clip **names are deliberately not stored**. `sampleNames` in the
  autosaved session is the single source of truth, so a rename never rewrites
  (re-encodes) a clip.
- **REQ-5** — Boot restores clips **before the UI mounts**, so the sampler panel
  constructs already seeing the buffers: no `.needs-reload` flash, and no race
  with the share-link / launchQueue importers (registered after `mountApp`). The
  IndexedDB read is started **before** `await engine.init()` so its I/O overlaps
  worklet loading; clips then decode sequentially (peak-memory rationale of
  [project-export](project-export.md) REQ-8).
- **REQ-6** — Clips are restored **only alongside a restored session, and only
  for slots that session names**. No session ⇒ the whole store is cleared; an
  orphaned clip (no name for its slot) is deleted rather than restored. This
  keeps the "a named slot is either loaded or shows `.needs-reload`" invariant
  intact. Names and buffers are kept in step *while running* by
  [song-mode](song-mode.md) REQ-3b (a load evicts audio it renames), so an
  orphan here means a lost race (a clip written but its session not), not
  ordinary use.
- **REQ-7** — A clip that fails to decode is skipped; the slot simply keeps its
  existing `.needs-reload` hint. One bad clip never aborts the rest, and never
  blocks boot.
- **REQ-8** — When ≥1 clip is restored, a [toast](toast.md)
  (`clips-restored-toast`) says so — fired from the start-modal gesture, not at
  boot, so it appears as the modal fades instead of underneath it.
- **REQ-9** — [Factory reset](factory-reset.md) clears this store too, capped by
  a short timeout so a wedged IndexedDB can never block the reload.
- **REQ-10** — Every storage failure (no IndexedDB, private mode, quota, a
  blocked upgrade) is a silent no-op — the app never breaks because clips could
  not be persisted or read. Same contract as session-autosave REQ-11.
- **REQ-11** — IndexedDB cannot be flushed synchronously, so a pending write is
  attempted on `visibilitychange → hidden` only. Losing that race degrades to
  exactly the previous behaviour (`.needs-reload`), never worse.
- **REQ-12** — The [Debug panel](debug-panel.md) shows the store's size
  (`Sampler clips: 3 · 4.2 MB`) from in-memory bookkeeping — never an extra
  IndexedDB read. It also offers a confirm-guarded **Clear** beside that row,
  which nulls every slot (the one `onBufferChange` hook then deletes them) and
  calls `SampleAutosave.clear()` for any orphan the session never named. With
  the stats source unbound, persistence never started and the action is disabled
  (debug-panel REQ-8).

## Technical design

### Contract / public interface

```ts
// src/state/sample-autosave.ts
export interface StoredClip { slot: number; data: Uint8Array }
export interface ClipKv {                       // injectable — jsdom has no indexedDB
  readAll(): Promise<StoredClip[]>;
  write(rec: StoredClip): Promise<void>;
  delete(slot: number): Promise<void>;
  clear(): Promise<void>;
}
export class SampleAutosave {
  constructor(sampler: ClipSource, kv?: ClipKv, opts?: { debounceMs?: number }); // default 800
  attach(): void;                       // onBufferChange -> touch, visibilitychange -> flush
  touch(): void;                        // arm/re-arm the debounce
  flush(): Promise<void>;               // write now if a save is pending
  noteRestored(clips: StoredClip[], buffers: (AudioBuffer | null)[]): void;
  stats(): { count: number; bytes: number };
  static loadAll(kv?: ClipKv): Promise<StoredClip[]>;   // never rejects
  static drop(slot: number, kv?: ClipKv): Promise<void>;// never rejects (orphans)
  static clear(kv?: ClipKv): Promise<void>;             // never rejects
}

// src/audio/transport/sampler-machine.ts (added)
onBufferChange(fn: (slot: number) => void): () => void;
```

`ClipSource` is the narrow structural view this store needs
(`{ buffers: readonly (AudioBuffer|null)[]; onBufferChange(fn): () => void }`),
so `state/` never depends on the whole machine. Every `kv` parameter defaults to
one lazily-created shared `IdbClipKv` (`src/state/idb-clip-kv.ts`), so callers
never construct a second connection and tests inject freely.

`noteRestored` seeds the `written[]` identity table (and the byte counts behind
`stats()`) from the boot restore, so restoring a clip does not immediately
re-encode and re-write it.

### Data shapes

```yaml
IndexedDB:
  database: websynth        # version 1
  store: clips              # keyPath 'slot'
  record: { slot: number, data: Uint8Array }   # 16-bit stereo WAV file bytes
```

### Layer touchpoints & ordering

```yaml
main.ts boot order:
  SampleAutosave.loadAll()          # kicked off first — no ctx needed
  await engine.init()               # worklet load hides the IDB I/O
  preset seed
  SessionAutosave.load() -> Song.apply    # names land here
  restore clips (awaited)           # setBuffer per named slot; count them
  mountApp                          # sampler panel sees loaded slots
  new SampleAutosave(...).attach()  # after the restore, so it schedules no rewrite
  showStartModal(onStart: initMIDI + the restored-clips toast)
src/ui/components/about-debug.ts: Debug row 'Sampler clips' <- SampleAutosave.stats()
src/state/factory-reset.ts: await SampleAutosave.clear() (timeout-capped) -> reload
```

### Persistence

- IndexedDB `websynth` → `clips`: this spec.
- Deliberately **not** stored: clip names (REQ-4 — the session owns them), and
  anything about which *song* a clip belonged to (last-writer-wins, like
  session-autosave REQ-12).

## Scenarios (BDD)

```gherkin
Scenario: a loaded sample survives a reload
  Given a WAV is loaded into sampler slot 0 and the session has autosaved
  When the page is reloaded
  Then slot 0 is audible immediately with no needs-reload hint
# pinned by: e2e/sampler.spec.ts

Scenario: an unchanged buffer is never re-encoded
  Given slot 0 has been persisted
  When another slot changes and a write pass runs
  Then slot 0's record is not rewritten (reference identity match)
# pinned by: tests/state/sample-autosave.test.ts

Scenario: clearing a slot deletes its clip
  Given slot 0 holds a persisted clip
  When setBuffer(0, null) runs (New song, or a cleared slot)
  Then the stored record for slot 0 is deleted
# pinned by: tests/state/sample-autosave.test.ts

Scenario: storage failures are silent (failure)
  Given IndexedDB is unavailable or every operation rejects
  When clips are written, read, or cleared
  Then nothing throws and the app behaves exactly as before this feature
# pinned by: tests/state/sample-autosave.test.ts

Scenario: an orphaned clip is dropped, not restored (edge)
  Given a stored clip for a slot the restored session does not name
  When the app boots
  Then the clip is deleted and the slot stays empty
# pinned by: tests/state/sample-autosave.test.ts
```

## Tests & verification

- Unit: `tests/state/sample-autosave.test.ts` (in-memory `ClipKv` + fake
  timers) — `npm test`
- E2E: `e2e/sampler.spec.ts` (load → autosave → reload → still loaded) —
  `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.engine.sampler.buffers[0] != null`

## Open questions / future

- A per-origin size cap / LRU eviction if users ever hit quota; today a failed
  write is simply a silent no-op (REQ-10).
- Persisting clips per *saved song slot* rather than per session, so switching
  songs restores each one's audio.
