# Session autosave & load-undo safety net

```yaml
id: session-autosave
status: implemented
version: 1
owner: websynth
related:
  - architecture
  - song-mode        # the SongFile the session serializes to; the guarded panel
  - toast            # the undo affordance
  - dialog           # New keeps its confirm dialog
source:
  - src/state/session-autosave.ts
  - src/ui/panels/song-panel.ts
  - src/main.ts
```

## Background / Why

The working session lived only in memory: any demo click, Load, Import, or tab
close destroyed it irrecoverably — an accidental demo-button press wiped real
work with zero recourse, and the only guarded path was New's confirm dialog.
The chosen UX is a safety net instead of more confirmation prompts: the session
is continuously autosaved to localStorage (tab close/crash loses nothing), and
every destructive apply stashes the prior session and offers a one-click Undo
via a toast. Loss becomes impossible without adding a single extra click to the
happy path.

## Requirements

- **REQ-1** — The working session (a full `Song.capture`: params + all banks +
  chains + sampleNames + xy + motion) is autosaved to
  `localStorage['websynth.session']`, debounced ~1.5 s after the last change.
  Capture runs **only** inside the debounced callback, never synchronously in a
  change listener (so mid-`Song.apply` states are never captured).
- **REQ-2** — Autosave triggers: any `ParamBus.onChange`, any `PatternStore`
  per-cell / bank-level / edit-bank / sample-meta change, any `XyPadStore`
  change, and **structural** `Arrangement` changes only — a fingerprint of
  `enabled + steps` per lane gates the per-bar `onChange` firings so playback
  never writes storage.
- **REQ-3** — The key lives **outside** `websynth.song.*`: it never appears in
  `Song.list()`, and slot machinery (save/load/delete/factory reset of slots)
  never touches it. Payload: `{ v: 1, savedAt, file }` with `file` in the
  canonical compact form (`compactSongForExport`, ADR-011).
- **REQ-4** — A pending (debounced, unwritten) save is flushed synchronously on
  `pagehide` and on `visibilitychange → hidden`. No `beforeunload` handler.
- **REQ-5** — Boot: a valid autosave is restored **silently** into the working
  session before the UI mounts (controls construct reading restored values);
  the header label becomes the saved song name. Absent key → fresh boot.
  Corrupt/invalid payload → fresh boot and the key is cleared. First visit and
  onboarding are unaffected (no key exists).
- **REQ-6** — A `#song=`/`#songUrl` share link (and an OS-launched file) applies
  **over** the restored session — it routes through the import path, which
  itself stashes, so the toast's Undo returns the user to their autosaved work.
- **REQ-7** — Every destructive apply — demo button (JSON and zip), Load,
  Import (file, share link, launchQueue), and New — first stashes the current
  session **in memory**: the captured `SongFile` **plus the live sampler
  `AudioBuffer` references**, then shows a toast (`song-undo-toast`) with an
  Undo action (~8 s). New keeps its confirm dialog (user decision); the toast
  follows a confirmed clear.
- **REQ-8** — Undo restores the stashed file (params, banks, chains, xy,
  sampler names), the sampler **buffers** (audio playable again immediately),
  the header label, and the slot dropdown's prior selection. The stash lives
  only in the toast's closure — dismissal/replacement releases the buffers
  (toast REQ-5).
- **REQ-9** — In-flight async work from a superseded apply must not leak into
  the current session: a monotonically increasing apply token invalidates
  project-zip clip decodes still pending when another apply (or Undo) lands.
- **REQ-10** — Sampler *audio* does not survive a reload: only `sampleNames`
  restore (slots show the existing `.needs-reload` hint). Deliberate — binary
  clips don't fit localStorage; IndexedDB persistence is out of scope.
- **REQ-11** — Storage failures (quota, private mode) are silent no-ops; the
  app never breaks because autosave couldn't write.
- **REQ-12** — Multi-tab is last-writer-wins on the single key. Documented
  limitation, not defended against.

## Technical design

### Contract / public interface

```ts
// src/state/session-autosave.ts
export const SESSION_KEY = 'websynth.session';
export class SessionAutosave {
  constructor(capture: () => SongFile, opts?: { debounceMs?: number }); // default 1500
  attach(deps: { bus: ParamBus; patterns: PatternStore; arr: Arrangement; xy: XyPadStore }): void;
  touch(): void;             // arm/re-arm the debounce
  flush(): void;             // synchronous write if a save is pending
  static load(): SongFile | null;  // validated; clears the key on corrupt payloads
  static clear(): void;
}
```

The capture callback is injected (closes over `Song.capture(bus, patterns,
arr, session.label || 'My Song', xy)` in `main.ts`) so the module depends only
on `song-validate`/`serialize`, not `song.ts`.

### Layer touchpoints & ordering

- `main.ts` boot order: preset seed → **silent restore** (`SessionAutosave.load()`
  → `Song.apply` + `session.setActive`) → `mountApp` → construct + `attach()`
  the autosaver → share-link hook (unchanged position; applies over the
  restore via the import path).
- `song-panel.ts`: `applySongWithUndo(file, verb)` wraps the existing
  `applySong` choke point — stash (file + `[...engine.sampler.buffers]` +
  dropdown value) → apply → toast. Used by `loadDemo`, Load,
  `applyProjectBundle`; New stashes/toasts inside its confirmed branch.
  `applySong` bumps the apply token; `applyProjectBundle`'s sequential clip
  loop re-checks it before each `setBuffer`.
- Undo re-fires `setSampleName` per slot after restoring buffers — the meta
  event is what clears `.needs-reload` in the sampler panel (same idiom as the
  project-zip import).

### Persistence

- `websynth.session` — the autosaved session (this spec). **Not** a song slot;
  invisible to `Song.list()`.
- Deliberately not persisted: sampler audio (REQ-10), the undo stash (memory
  only), any history.

## Scenarios (BDD)

```gherkin
Scenario: accidental demo click is undoable
  Given the user has an in-progress song with a loaded sampler clip
  When they click a demo button
  Then the demo applies and a toast offers Undo
  And clicking Undo restores their song including the audible sampler clip
# pinned by: e2e/session.spec.ts

Scenario: tab close loses nothing
  Given the user edited params and toggled drum steps
  When the debounce elapses and the page is reloaded
  Then the session restores silently at boot with the same state
# pinned by: e2e/session.spec.ts

Scenario: New still confirms, then offers Undo
  Given a non-empty session
  When the user clicks New and confirms the dialog
  Then the session clears and a toast offers Undo
  And Undo restores banks, chains, and sampler buffers
# pinned by: e2e/session.spec.ts

Scenario: playback never writes storage
  Given the transport is running with an enabled chain
  When bars elapse with no user edits
  Then no autosave write occurs (arrangement fingerprint unchanged)
# pinned by: tests/state/session-autosave.test.ts

Scenario: corrupt autosave falls back to a fresh boot
  Given websynth.session holds invalid JSON or a non-song payload
  When the app boots
  Then defaults load and the key is cleared
# pinned by: tests/state/session-autosave.test.ts

Scenario: undo mid-import cancels stale clip decodes
  Given a project-zip import is decoding clips
  When the user clicks Undo before decoding finishes
  Then remaining clips never overwrite the restored session's slots
# pinned by: apply-token guard in song-panel.ts (applyProjectBundle)
```

## Tests & verification

- Unit: `tests/state/session-autosave.test.ts` (storage mock + fake timers) —
  `npm test`
- E2E: `e2e/session.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Dev-bridge assertions: `window.__synth.bus.get(...)`, `__synth.patterns`

## Open questions / future

- Persist sampler clips to IndexedDB so audio also survives reload.
- A "Restore previous session?" affordance if silent restore ever proves
  surprising (no evidence yet).
