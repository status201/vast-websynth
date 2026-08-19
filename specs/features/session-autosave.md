# Session autosave & load-undo safety net

```yaml
id: session-autosave
status: implemented
version: 8   # v8: REQ-12 — the session is PER TAB. Two tabs sharing one key was
             #     last-writer-wins, and it silently ate a real session's motion
             # v7: REQ-14c — Save guards the same slot the import path does, and
             #     REQ-14d — a demo click never writes a slot at all
             # v6: REQ-14 — an identical slot is not a conflict (re-importing the
             #     same song no longer re-asks). Also renumbers v5's import gate
             #     from REQ-11, which collided with the storage-failure REQ-11.
             # v5: an import confirms before overwriting a same-named saved slot
             #     (the undo toast can't restore one)
owner: websynth
related:
  - architecture
  - untrusted-input      # REQ-14: the song name is attacker-chosen
  - presets              # REQ-14 follows the preset importer's never-blind-merge rule
  - runtime-performance  # REQ-5: automation is not an edit (REQ-2b's other half)
  - motion-sequencer     # the frame-rate writer REQ-2b exists for
  - song-mode        # the SongFile the session serializes to; the guarded panel
  - sample-persistence  # the audio half of the same reload safety net
  - toast            # the undo affordance
  - dialog           # New keeps its confirm dialog
source:
  - src/state/session-autosave.ts
  - src/ui/panels/song-panel.ts
  - src/main.ts
```

`SessionAutosave.stats()` — `{bytes, savedAt}` of the stored payload, or `null`
when there is none — backs the [debug panel](debug-panel.md)'s Session row and
its Clear action. A session the app chokes on was otherwise only escapable via a
full [factory reset](factory-reset.md); the size of a corrupt payload is still
reported (with `savedAt: null`), since that is the half that still helps. It is a
*polled* read, so it is deliberately parse-free (REQ-13).

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
  `localStorage['websynth.session.<tab>']` (REQ-12), debounced ~1.5 s after the
  last change.
  Capture runs **only** inside the debounced callback, never synchronously in a
  change listener (so mid-`Song.apply` states are never captured).
- **REQ-2** — Autosave triggers: any `ParamBus.onChange`, any `PatternStore`
  per-cell / bank-level / edit-bank / sample-meta change, any `XyPadStore`
  change, and **structural** `Arrangement` changes only — a fingerprint of
  `enabled + steps` per lane gates the per-bar `onChange` firings so playback
  never writes storage.
- **REQ-2b** — **Playback alone never re-arms the debounce**, param writes
  included. The two lane gates above cover the `Arrangement`'s per-bar firings;
  the third source is *param automation* — the [motion
  sequencer](motion-sequencer.md) writes its lanes at frame rate, and a Tape Stop
  ramps `master.pitchBend` per frame. Those go through
  `ParamBus.withoutChangeSignal` at the writer (see
  [`runtime-performance.md`](runtime-performance.md) REQ-5), so they never reach
  the trigger in REQ-1 at all. Gating here instead would be the wrong place: the
  distinction is *who wrote it*, which only the writer knows. Without it a
  sliding motion lane re-armed the 1.5 s debounce every ~16 ms and the session
  was **never written for as long as the transport ran** — the failure mode this
  feature exists to prevent, in exactly the songs most worth saving.
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
- **REQ-10** — This key carries `sampleNames` only; binary clips don't fit
  localStorage. Sampler *audio* is persisted separately in IndexedDB and
  restored alongside this session at boot — see
  [sample-persistence](sample-persistence.md), which owns that contract
  (including what happens when a clip is missing: the slot keeps the existing
  `.needs-reload` hint, i.e. this spec's original behaviour).
- **REQ-11** — Storage failures (quota, private mode) are silent no-ops; the
  app never breaks because autosave couldn't write.
- **REQ-12** (v8) — **Each tab autosaves to its own key, and no tab can
  overwrite another's session.** This used to read "multi-tab is last-writer-wins
  on the single key — documented limitation, not defended against". It came due:
  with two tabs open, the one switched away from flushed its own, older session
  over the shared key, and the next boot restored *that*. Because
  [song-mode](song-mode.md) makes motion authoritative on apply, a stale session
  that predates a song's motion does not merely fail to restore it — it **blanks
  it**, silently, while params and patterns look untouched. A session's worth of
  automation went that way, which is what a safety net must never do.

  - **Identity.** A tab takes an id from `sessionStorage`, which is per-tab by
    definition and survives that tab's own reload. Its session lives at
    `websynth.session.<id>`. Writes therefore never collide: last-writer-wins is
    gone because there is no shared writer.
  - **Restore order.** Boot prefers **this tab's own** session (so a reload
    returns exactly where that tab was), and falls back to the **most recently
    saved** of any other — which is what keeps REQ-5's "tab close loses nothing"
    true when the tab that did the work is gone.
  - **Bounded.** At most `MAX_SESSIONS` (3) are kept; a write prunes the oldest
    beyond that, never its own. A session is ~50-100 kB (no audio — clips live in
    IndexedDB, [sample-persistence](sample-persistence.md)), so the cap costs a
    fraction of the quota while covering the realistic number of open tabs.
  - **Quota.** If a write throws, the other tabs' sessions are pruned and it is
    retried **once** before standing down per REQ-11. Storing more sessions must
    not make the safety net *more* likely to fail.
  - **Legacy.** The old single `websynth.session` key is still read as a restore
    candidate, so an existing session survives the upgrade. It is never written
    again.
  - **Storage disabled.** With no `sessionStorage` the id falls back to a
    constant, which is exactly the old single-key behaviour — degraded, not
    broken.
- **REQ-13** — **`stats()` never parses the payload.** It is called from the
  [debug panel](debug-panel.md)'s poll, and the payload is the entire session —
  megabytes once samples are in play — so `JSON.parse`-ing it to recover one
  number is out of proportion to the answer. `savedAt` is instead read by scanning
  a short **prefix** of the raw string: `write()` builds its object literal in a
  fixed order (`{ v, savedAt, file }`, REQ-3) and `JSON.stringify` preserves it, so
  the value always lands in the first few dozen characters. The prefix bound is
  also what makes the scan *correct* — it cannot match a `savedAt` occurring later
  inside `file`. **Constraint: `savedAt` must stay ahead of `file` in `write()`'s
  literal.** If it ever moves, the scan degrades to `savedAt: null` (the same
  graceful path as a corrupt payload) rather than reporting a wrong time; `bytes`
  is unaffected either way.
- **REQ-14** (v5, was REQ-11) — **The undo net covers the session, not the slot —
  so an import may not silently overwrite a saved slot.** REQ-8 restores the
  in-memory session; it cannot restore a `localStorage` slot that `Song.saveSlot`
  has already replaced, so an unconfirmed overwrite is *unrecoverable*. An import
  whose song name collides with an existing slot therefore **asks first**
  (naming the slot), and on a decline the song still **applies to the session** —
  only the persistence is skipped, so nothing is lost either way. A non-colliding
  name saves as before. This matters because the name is attacker-chosen: a
  share link naming its song after a common slot ("My Song") would otherwise
  destroy that work at boot. Mirrors [presets](presets.md) REQ-10 ("never a
  blind merge") and [untrusted-input](untrusted-input.md) REQ-9.
- **REQ-14b** (v6) — **An identical slot is not a conflict.** The question REQ-14
  asks is "may I destroy this?", so it may only be asked when there is something
  to destroy: if the stored slot's bytes are *already* what saving this import
  would write, the write is a no-op and the prompt is pure noise. `planImportSave`
  therefore compares `Song.toJSON(file)` against the stored raw and reports a
  conflict only on a **difference**. Without this, "Replace it" never stuck —
  re-opening the same share link (or importing the same file after loading
  another song) re-asked forever, teaching the user that the dialog means
  nothing, which is exactly how a real overwrite gets waved through. The
  comparison is on the canonical compact string (ADR-011), so it is exact and
  order-sensitive: a same-song-different-encoding edge falls back to *asking*,
  which is the safe side. A **changed** song under a saved name still asks —
  that is REQ-14's whole point, and a slot the user chose to keep is theirs.
- **REQ-14c** (v7) — **Every write to a slot is guarded, not just the import
  one.** The Save button called `Song.saveSlot` unconditionally, so typing a name
  another song already used destroyed it with no dialog and no undo — the exact
  loss REQ-14 exists to prevent, reached by a likelier route than a share link.
  Save therefore asks too, on the same content test (REQ-14b), with one addition:
  it does **not** ask when the name is the slot **this session came from**.
  Re-saving your own song after an edit is the normal loop and must stay one
  click, whereas saving *onto* a name whose song you have not been working on is
  a Save-As over someone else's work. The panel tracks that provenance as
  `sessionSlot` — the stored slot the session was last read from or written to,
  `null` after a demo, a New, or an import that did not persist — and it is
  stashed and restored with the undo net (REQ-7/REQ-8), so Undo cannot leave the
  guard describing a session that no longer exists.
- **REQ-14d** (v7) — **A demo click never writes a slot.** Zip demos routed
  through the *import* path and so persisted themselves, while JSON and built-in
  demos did not: clicking `1973` could prompt to replace your saved `1973` while
  clicking `1979` silently ignored yours, and one of the two kinds quietly filled
  localStorage with copies of read-only content. Demos are content, not the
  user's work — `applyProjectBundle` persists only when the caller is an import.
  What remains of the collision is a *naming* one, and [song-mode](song-mode.md)
  REQ-15 owns it: the demo button and the slot list can offer two different songs
  under one name, so the demo doors ask which was meant instead of guessing.

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
  static stats(): { bytes: number; savedAt: number | null } | null;  // REQ-13's debug row
}
```

The capture callback is injected (closes over `Song.capture(bus, patterns,
arr, session.label || 'My Song', xy)` in `main.ts`) so the module depends only
on `song-validate`/`serialize`, not `song.ts`.

### Layer touchpoints & ordering

- `main.ts` boot order: preset seed → **silent restore** (`SessionAutosave.load()`
  → `Song.apply` + `session.setActive`) → sampler-clip restore (awaited; see
  [sample-persistence](sample-persistence.md) REQ-5) → `mountApp` → construct +
  `attach()` the autosaver → share-link hook (unchanged position; applies over
  the restore via the import path).
- `song-panel.ts`: `applySongWithUndo(file, verb)` wraps the existing
  `applySong` choke point — stash (file + `[...engine.sampler.buffers]` +
  dropdown value) → apply → toast. Used by `loadDemo`, Load,
  `applyProjectBundle`; New stashes/toasts inside its confirmed branch.
  `applySong` bumps the apply token; `applyProjectBundle`'s sequential clip
  loop re-checks it before each `setBuffer`.
- Undo re-fires `setSampleName` per slot after restoring buffers — the meta
  event is what clears `.needs-reload` in the sampler panel (same idiom as the
  project-zip import).
- `Song.slotDiffers(file)` is the one primitive under REQ-14b/14c:
  `store.readRaw(file.name)` compared to `Song.toJSON(file)` — absent slot **or**
  equal string ⇒ `false`. It stays in `song.ts` beside `saveSlot`, whose exact
  serialization it has to mirror. Above it sits one rule,
  `planSlotSave(file, from)` = `file.name !== from && slotDiffers(file)`, of which
  `planImportSave(file)` is the no-provenance case (`from = null`) — so the Save
  button and the import path cannot drift apart. The dialogs live in
  `song-panel.ts` (`saveImportedSlot`, the Save handler), which own the decisions
  the plan only describes — the `preset-file.ts` `planImport` idiom.
- `sessionSlot` (REQ-14c) is a single `string | null` in the panel closure, set
  by Save and by a Load that resolved to a **stored** slot, cleared by demos /
  New / a non-persisting import, and carried in `SessionStash` so Undo restores
  it with the dropdown value it already stashes.

### Persistence

- `websynth.session` — the autosaved session (this spec). **Not** a song slot;
  invisible to `Song.list()`.
- Sampler audio lives in IndexedDB, not here (REQ-10).
- Deliberately not persisted: the undo stash (memory only), any history.

## Scenarios (BDD)

```gherkin
Scenario: accidental demo click is undoable
  Given the user has an in-progress song with a loaded sampler clip
  When they click a demo button
  Then the demo applies and a toast offers Undo
  And clicking Undo restores their song including the audible sampler clip
# pinned by: e2e/session.spec.ts

Scenario: A second tab cannot overwrite the first tab's session (v8, REQ-12, regression)
  Given two tabs each with their own session
  When the second tab autosaves
  Then the first tab's stored session is untouched
  And each tab restores its own on reload
# pinned by: tests/state/session-autosave.test.ts

Scenario: A closed tab's session is still restored (v8, REQ-12)
  Given a stored session belonging to a tab id this tab does not have
  And no session of this tab's own
  When the app boots
  Then the most recently saved session is restored
# pinned by: tests/state/session-autosave.test.ts

Scenario: Stored sessions stay bounded (v8, REQ-12)
  Given more than MAX_SESSIONS stored sessions
  When a tab writes
  Then the oldest beyond the cap are dropped and this tab's own is kept
# pinned by: tests/state/session-autosave.test.ts

Scenario: A session written before per-tab keys still restores (v8, REQ-12, edge)
  Given only the legacy websynth.session key
  When the app boots
  Then it is restored, and never written to again
# pinned by: tests/state/session-autosave.test.ts

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

Scenario: automation never starves the debounce (REQ-2b, regression)
  Given a motion lane sliding a param every frame while the transport runs
  When frames elapse well past the debounce window with no user edit
  Then no autosave write occurs
  And a subsequent real edit is still written 1.5 s later, while automation keeps writing
# pinned by: tests/state/session-autosave.test.ts, tests/audio/transport/motion-machine.test.ts

Scenario: stats reads the age without parsing the session (REQ-13)
  Given a written autosave whose file is large
  When stats() is called
  Then savedAt matches the time it was written
  And no JSON.parse of the payload occurs
# pinned by: tests/state/session-autosave.test.ts (stats() — REQ-13)

Scenario: stats survives a payload it cannot scan (REQ-13, edge)
  Given a stored payload that is not the shape write() produces
  When stats() is called
  Then bytes is still its true length
  And savedAt is null
# pinned by: tests/state/session-autosave.test.ts

Scenario: corrupt autosave falls back to a fresh boot
  Given websynth.session holds invalid JSON or a non-song payload
  When the app boots
  Then defaults load and the key is cleared
# pinned by: tests/state/session-autosave.test.ts

Scenario: an import confirms before overwriting a saved slot (v5, REQ-14)
  Given a saved slot named "My Song" holding different music
  When a shared song also named "My Song" is imported
  Then Song.planImportSave reports a conflict and writes nothing itself
  And the panel confirms, naming the slot, before Song.saveSlot runs
  And declining still applies the song to the session, leaving the slot intact
  And a song with an unused name — or a demo's name — saves without asking
# pinned by: tests/state/song-import-slot.test.ts (the plan; the dialog wiring is
#   song-panel's saveImportedSlot, following preset-file.ts planImport)

Scenario: re-importing the very same song does not re-ask (v6, REQ-14b, regression)
  Given a song was imported and the user chose "Replace it"
  When the user loads another song and then imports that same song again
  Then Song.planImportSave reports no conflict
  And the slot is written without a dialog
# pinned by: tests/state/song-import-slot.test.ts

Scenario: an edited song under a saved name still asks (v6, REQ-14b, boundary)
  Given a saved slot named "1973"
  When a song named "1973" with one changed step or param is imported
  Then Song.planImportSave still reports a conflict
# pinned by: tests/state/song-import-slot.test.ts

Scenario: Save asks before landing on another song's slot (v7, REQ-14c)
  Given a saved slot "Night Shift" holding a song the user is not working on
  When they Save the current session under the name "Night Shift"
  Then Song.planSlotSave reports a conflict, so a confirm runs before saveSlot
  And declining leaves both the slot and the session untouched
# pinned by: tests/state/song-import-slot.test.ts (the rule), e2e/song.spec.ts (the dialog)

Scenario: re-saving the song you are working on never asks (v7, REQ-14c)
  Given the session was loaded from — or last saved to — the slot "My Song"
  When the user edits a param and saves under "My Song" again
  Then planSlotSave reports no conflict and it saves silently
# pinned by: tests/state/song-import-slot.test.ts, e2e/song.spec.ts

Scenario: a demo click writes no slot (v7, REQ-14d, regression)
  Given the zip demo "1973" and the JSON demo "1979"
  When either is clicked
  Then the song applies with an Undo toast and no localStorage slot is created
  And a following Save under that name is guarded like any other (REQ-14c)
# pinned by: e2e/song.spec.ts

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

- A "Restore previous session?" affordance if silent restore ever proves
  surprising (no evidence yet).
