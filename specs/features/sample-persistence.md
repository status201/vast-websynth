# Sampler clip persistence (IndexedDB)

```yaml
id: sample-persistence
status: implemented
version: 3
owner: core
related:
  - architecture
  - session-autosave   # the song half of the same safety net; owns the session a clip belongs to
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
its REQ-every-clip-storage-failure-is-survivable deliberately excluded sampler **audio**: only `sampleNames` survived,
so every slot returned as a name with a `.needs-reload` hint and the user had to
re-pick files from disk. The exclusion was a storage-shape problem, not a design
one: binary clips don't fit in localStorage. IndexedDB does hold them, so this
spec closes the asymmetry — after a reload a restored session's slots are
audible immediately, without touching the song format (a `SongFile` still
carries names only, so songs stay small and shareable).

A clip belongs to a session, the way the song does: the session is per tab
([session-autosave](session-autosave.md) REQ-each-tab-autosaves-to-its-own-key),
so each tab's reload brings back its own audio, never another tab's under its
own sample names. A safety net that swaps your audio for someone else's is
worse than none.

## Requirements

- **REQ-clips-persist-in-indexeddb** — Sampler clips persist in IndexedDB (db
  `websynth`, store `sessionClips`, keyed by **session and slot**,
  REQ-clips-belong-to-a-session) as 16-bit **WAV bytes**
  produced by the pure `encodeClipWav`, read uncopied (`audioBufferView` — the
  encode is synchronous, so nothing changes the buffer mid-read), and are restored through
  `ctx.decodeAudioData` — the same path Load and a
  [project-zip](project-export.md) import already use. The channels are
  the ones `encodeClipWav` keeps: **one** when the clip's left and right are
  sample-for-sample identical, two otherwise — the same rule as a project export
  (project-export.md REQ-a-mono-clip-exports-as-mono). Until v2 every clip was
  stored as stereo, which doubled a mono sample on disk and, worse, brought it
  back from a reload as a two-channel buffer with identical halves — which
  every later project export then wrote out at twice its size.
- **REQ-clips-belong-to-a-session** (v3) — Every clip record names the
  [session](session-autosave.md) it belongs to: the session's localStorage key
  (`websynth.session.<tab>`), the same string that identifies the song. A tab
  writes clips **only under its own session**, and reads at boot **only the
  clips of the session it restores**. Two tabs can never overwrite each other's
  audio, because, as with the song, there is no shared writer.
- **REQ-a-session-is-written-before-its-clips** (v3) — A tab writes clips only
  once its own session exists in storage. Before that, a write pass waits: a
  clip stored under a session nobody has saved could not be restored, and the
  boot sweep (REQ-clips-go-with-their-session) would rightly delete it. When the
  session autosave writes the tab's key for the **first** time — a new tab, a
  tab that restored another tab's session, or a session that was pruned and is
  written again — every loaded slot is written under it afresh, whatever was
  written before. That is how audio restored from another session becomes this
  tab's own.
- **REQ-clips-go-with-their-session** (v3) — When the session autosave removes a
  session (the `MAX_SESSIONS` prune, a quota retry, an invalid payload, a clear),
  that session's clips are deleted with it. At boot, the clips of every session
  that is neither stored nor this tab's own are deleted too, which catches a
  removal whose clip delete never ran. The store therefore holds clips for at
  most the sessions that exist.
- **REQ-legacy-clips-are-adopted-once** (v3) — The v2 store (`clips`, one record
  per slot) is moved into the new store at the database upgrade, under the
  session id `legacy`. A boot whose restored session has no clips of its own
  adopts the legacy ones (best effort: the old store could not say whose they
  were, and they are the last audio any tab saved). Once a write pass has stored
  them under this tab's session, the legacy records are deleted. A boot that
  does not adopt them deletes them straight away, so they are offered once.
- **REQ-clip-writes-are-debounced-through-one-hook** — Writes are debounced
  (~800 ms) and driven by **one** hook: `SamplerMachine.onBufferChange`, emitted
  from `setBuffer`. Every slot-filling path (Load, the [record
  modal](sample-recorder.md), ✎ re-edit,
  [render-to-sampler](render-to-sampler.md), project-zip import, load-undo
  restore, New→null) is covered without the caller knowing.
- **REQ-a-write-pass-reconciles-every-slot** — A write pass reconciles all
  `SAMPLER_SLOT_COUNT` slots against a per-slot record of what was last written,
  compared by **`AudioBuffer` reference identity**: unchanged slots are never
  re-encoded, a cleared slot deletes its record, a new/replaced buffer is
  encoded and put.
- **REQ-clip-names-are-not-stored** — Clip **names are deliberately not
  stored**. `sampleNames` in the autosaved session is the single source of
  truth, so a rename never rewrites (re-encodes) a clip.
- **REQ-boot-restores-clips-before-the-ui** — Boot restores clips **before the
  UI mounts**, so the sampler panel constructs already seeing the buffers: no
  `.needs-reload` flash, and no race with the share-link / launchQueue importers
  (registered after `mountApp`). The store is a lazy chunk, off the entry
  ([runtime-performance](runtime-performance.md) REQ-boot-cost-matches-the-request), and
  both its fetch and the IndexedDB read are started **before** `await
  engine.init()` so they overlap worklet loading; clips then decode
  sequentially (peak-memory rationale of [project-export](project-export.md)
  REQ-clip-codec-is-memory-aware).
- **REQ-clips-restore-only-with-a-session** — Clips are restored **only
  alongside a restored session, only that session's (REQ-clips-belong-to-a-session),
  and only for slots that session names**. No session ⇒ the whole store is
  cleared; an orphaned clip (no name for its slot) of this tab's own session (or the
  legacy store) is deleted rather than
  restored. Another session's orphan is only skipped: that tab may still
  be about to save the session that names it. This keeps the "a named slot is either loaded
  or shows `.needs-reload`" invariant intact. Names and buffers are kept in step
  *while running* by [song-mode](song-mode.md) REQ-stale-sampler-audio-is-evicted (a load evicts audio it
  renames), so an orphan here means a lost race (a clip written but its session
  not), not ordinary use.
- **REQ-an-undecodable-clip-is-skipped** — A clip that fails to decode is
  skipped; the slot simply keeps its existing `.needs-reload` hint. One bad clip
  never aborts the rest, and never blocks boot.
- **REQ-a-clip-restore-raises-a-toast** — When ≥1 clip is restored, a
  [toast](toast.md) (`clips-restored-toast`) says so — fired from the start
  handler rather than boot's own body, so it appears as the modal fades instead
  of underneath it. The reason is the modal, not the gesture: where no modal is
  shown at all ([audio-lifecycle](audio-lifecycle.md) REQ-the-gesture-is-required-only-when-required/REQ-post-gesture-work-is-deferred) the toast
  is raised straight away, with nothing to hide behind.
- **REQ-factory-reset-clears-the-clip-store** — [Factory
  reset](factory-reset.md) clears this store too, capped by a short timeout so a
  wedged IndexedDB can never block the reload.
- **REQ-every-clip-storage-failure-is-survivable** — Every storage failure (no
  IndexedDB, private mode, quota, a blocked upgrade, the store's lazy chunk not
  loading) is a silent no-op — the app
  never breaks because clips could not be persisted or read. Same contract as
  session-autosave REQ-autosave-storage-failures-are-silent.
- **REQ-a-pending-clip-write-cannot-be-flushed** — IndexedDB cannot be flushed
  synchronously, so a pending write is attempted on `visibilitychange → hidden`
  only. Losing that race degrades to exactly the previous behaviour
  (`.needs-reload`), never worse.
- **REQ-debug-shows-the-clip-store-size** — The [Debug panel](debug-panel.md)
  shows the size of this tab's clips (`Sampler clips: 3 · 4.2 MB`) from in-memory
  bookkeeping — never an extra IndexedDB read. It also offers a confirm-guarded
  **Clear** beside that row, which nulls every slot (the one `onBufferChange`
  hook then deletes them) and calls `SampleAutosave.dropSession()` for this tab's
  session and for the legacy clips, for any orphan it never named. Other tabs'
  clips are theirs, and stay. With the stats source unbound, persistence never started
  and the action is disabled (debug-panel
  REQ-an-unbound-action-renders-disabled).

## Technical design

### Contract / public interface

```ts
// src/state/sample-autosave.ts
export const LEGACY_CLIP_SESSION = 'legacy';            // the v2 store's records (REQ-legacy-clips-are-adopted-once)
export interface StoredClip { session: string; slot: number; data: Uint8Array }
export interface ClipRestore { from: string; clips: StoredClip[] }   // whose clips a boot read
export interface ClipKv {                       // injectable — jsdom has no indexedDB
  readSession(session: string): Promise<StoredClip[]>;
  sessions(): Promise<string[]>;                // the distinct sessions that hold clips
  write(rec: StoredClip): Promise<void>;
  delete(session: string, slot: number): Promise<void>;
  deleteSession(session: string): Promise<void>;
  clear(): Promise<void>;
}
export interface SampleAutosaveOptions {
  debounceMs?: number;                          // default 800
  session: string;                              // this tab's session key
  sessionExists: () => boolean;                 // is that key stored yet (REQ-a-session-is-written-before-its-clips)
}
export class SampleAutosave {
  constructor(sampler: ClipSource, kv: ClipKv | undefined, opts: SampleAutosaveOptions);
  attach(): void;                       // onBufferChange -> touch, visibilitychange -> flush
  touch(): void;                        // arm/re-arm the debounce
  flush(): Promise<void>;               // write now if a save is pending
  noteRestored(restore: ClipRestore, buffers: (AudioBuffer | null)[]): void;
  sessionWritten(fresh: boolean): void; // the session autosave wrote this tab's key; fresh = it was absent
  stats(): { count: number; bytes: number };
  static loadFor(session: string, kv?: ClipKv): Promise<ClipRestore>;      // never rejects; adopts legacy
  static drop(session: string, slot: number, kv?: ClipKv): Promise<void>;  // never rejects (orphans)
  static dropSession(session: string, kv?: ClipKv): Promise<void>;         // never rejects
  static sweep(keep: () => readonly string[], kv?: ClipKv): Promise<void>; // never rejects; keep read after listing
  static clear(kv?: ClipKv): Promise<void>;                                // never rejects
}

// src/state/session-autosave.ts (added for this spec)
SessionAutosave.loadSession(): { key: string; file: SongFile } | null;  // load() plus which key won
SessionAutosave.ownKey(): string;               // this tab's key
SessionAutosave.liveKeys(): string[];           // every stored session key
SessionAutosave.onRemoved(fn: (key: string) => void): () => void;  // a session key was removed
sessionAutosave.onWritten(fn: (fresh: boolean) => void): () => void;  // this tab's key was written

// src/audio/transport/sampler-machine.ts
onBufferChange(fn: (slot: number) => void): () => void;
```

`ClipSource` is the narrow structural view this store needs
(`{ buffers: readonly (AudioBuffer|null)[]; onBufferChange(fn): () => void }`),
so `state/` never depends on the whole machine. Every `kv` parameter defaults to
one lazily-created shared `IdbClipKv` (`src/state/idb-clip-kv.ts`), so callers
never construct a second connection and tests inject freely.

`noteRestored` seeds the `written[]` identity table (and the byte counts behind
`stats()`) from the boot restore — but only for clips read from **this tab's own**
session. Clips read from another session or adopted from `legacy` are not this
tab's yet, so they are left unseeded and the first write pass stores them under
the tab's session (REQ-a-session-is-written-before-its-clips). A legacy adoption
also deletes the `legacy` records once that pass completes.

`sessionWritten(fresh)` is the link to the session autosave: until the first call
(or until `sessionExists()` is already true at `attach`), a debounced pass only
marks itself pending. A `fresh` write clears `written[]`, so every loaded slot is
written again under the session that now exists.

The IndexedDB connection closes itself on `versionchange`, so a newer build in
another tab can upgrade the database instead of being blocked by this one.

### Data shapes

```yaml
IndexedDB:
  database: websynth        # version 2 (v3 of this spec)
  store: sessionClips       # keyPath ['session', 'slot']
  record: { session: string, slot: number, data: Uint8Array }   # 16-bit WAV file bytes; mono when the clip is
  session: a SessionAutosave key (websynth.session.<tab>), or 'legacy'
upgrade 1 -> 2:
  every record of store clips -> sessionClips with session 'legacy'; store clips deleted
```

### Layer touchpoints & ordering

```yaml
main.ts boot order:
  SessionAutosave.onRemoved(key -> SampleAutosave.dropSession(key))   # before anything can remove a key
  SessionAutosave.loadSession()     # pure localStorage: which session restores, and its file
  import('./state/sample-autosave') -> SampleAutosave.loadFor(restored.key)   # lazy chunk + read, before engine.init
  await engine.init()               # worklet load hides the IDB I/O
  preset seed
  Song.apply(restored.file)         # names land here
  restore clips (awaited)           # setBuffer per named slot; orphans dropped from their session
  SampleAutosave.sweep(live keys + own key + legacy if adopted)
  mountApp                          # sampler panel sees loaded slots
  new SessionAutosave(...).attach()
  new SampleAutosave(sampler, kv, { session: ownKey, sessionExists }).noteRestored(...).attach()
  sessionAutosave.onWritten(fresh -> clipStore.sessionWritten(fresh))
  showStartModal(onStart: initMIDI + the restored-clips toast)
src/ui/components/about-debug.ts: Debug row 'Sampler clips' <- SampleAutosave.stats();
  Clear -> null every slot + SampleAutosave.dropSession(SessionAutosave.ownKey())
src/state/factory-reset.ts: await SampleAutosave.clear() (timeout-capped) -> reload
```

### Persistence

- IndexedDB `websynth` → `sessionClips`: this spec.
- Deliberately **not** stored: clip names (REQ-clip-names-are-not-stored — the
  session owns them). Which *saved song* a clip belonged to is not stored either:
  clips follow the working session, as the autosave does.

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

Scenario: a mono clip is stored as mono (v2, REQ-clips-persist-in-indexeddb, regression)
  Given slot 0 holds a buffer whose two channels are identical
  When a write pass runs
  Then the stored record is a one-channel WAV
  And a slot whose channels differ is stored as a two-channel WAV
# pinned by: tests/state/sample-autosave.test.ts
Scenario: two tabs keep their own audio (v3, REQ-clips-belong-to-a-session, regression)
  Given tab A has sample a.wav in slot 0 and tab B has a different b.wav in slot 0
  And both sessions have autosaved
  When tab A is reloaded
  Then slot 0 plays a.wav's audio, and tab B's b.wav is still stored for tab B
  # the bug: one record per slot for the whole browser; the last tab to write owned it
# pinned by: e2e/sample-persistence.spec.ts, tests/state/sample-autosave.test.ts

Scenario: a tab that restored another tab's session keeps that audio as its own (v3, REQ-a-session-is-written-before-its-clips)
  Given a new tab restores tab B's session and B's clips
  When the new tab's session is autosaved for the first time
  Then every loaded slot is written under the new tab's session
  And nothing was written under it before that
# pinned by: tests/state/sample-autosave.test.ts

Scenario: a pruned session takes its clips with it (v3, REQ-clips-go-with-their-session)
  Given a session that holds clips
  When the session autosave removes that session
  Then its clips are deleted
  And at the next boot, clips of a session that is neither stored nor this tab's are deleted
# pinned by: tests/state/sample-autosave.test.ts, tests/state/session-autosave.test.ts

Scenario: clips saved before v3 are adopted once (v3, REQ-legacy-clips-are-adopted-once)
  Given a database from before v3 with a clip for slot 0, and a session naming slot 0
  When the app boots
  Then slot 0 is audible, and the clip is stored under this tab's session once a pass runs
  And the legacy record is gone afterwards
# pinned by: e2e/sample-persistence.spec.ts, tests/state/sample-autosave.test.ts
```

## Tests & verification

- Unit: `tests/state/sample-autosave.test.ts` (in-memory `ClipKv` + fake
  timers), `tests/state/session-autosave.test.ts` (the `onRemoved` / `onWritten`
  hooks), `tests/ui/about.test.ts` (Debug Clear drops this tab's session only) —
  `npm test`
- E2E: `e2e/sampler.spec.ts` (load → autosave → reload → still loaded) and
  `e2e/sample-persistence.spec.ts` (two tabs; the v2 → v3 upgrade, in a real
  IndexedDB) — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.engine.sampler.buffers[0] != null`

## Open questions / future

- A per-origin size cap / LRU eviction if users ever hit quota; today a failed
  write is simply a silent no-op (REQ-every-clip-storage-failure-is-survivable).
- Persisting clips per *saved song slot* as well, so loading a saved song brings
  its audio back. v3 keys clips by working session only.
