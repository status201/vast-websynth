# Storage failures (localStorage slots)

```yaml
id: storage-failures
status: implemented
version: 1
owner: core
related:
  - architecture       # SlotStore, the localStorage keys
  - presets            # the factory seed and the preset Save / Import
  - song-mode          # the song Save
  - session-autosave   # the import's slot write; the autosave's own silent rule
  - sample-persistence # the clip store's own silent rule
  - dialog             # alertDialog
source:
  - src/state/slot-store.ts
  - src/state/preset.ts
  - src/ui/storage-failure.ts
  - src/ui/panels/song-panel.ts
  - src/ui/panels/song-io.ts
  - src/ui/components/preset-manager-modal.ts
```

## Background / Why

Presets and saved songs live in `localStorage` (`SlotStore`), which a browser
can refuse: the origin's quota is full (autosaved sessions and saved songs share
about 5 MB), or storage is blocked outright. Nothing handled that. A refused
write threw out of the click handler, so Save did nothing and said nothing, and
the user believed the song was stored. Worse, the factory-preset seed at boot
threw the same way, and the app stopped at "failed to start", with Factory
Reset, the one way out, inside the app it had stopped.

The autosaves stay silent on failure by design
([session-autosave](session-autosave.md) REQ-autosave-storage-failures-are-silent,
[sample-persistence](sample-persistence.md) REQ-every-clip-storage-failure-is-survivable):
the user never asked for them. This spec covers the stores the user *does* ask
for, and the boot.

## Requirements

- **REQ-a-slot-read-never-throws** — Every `SlotStore` read treats storage that
  throws as empty: `readIndex` and `readRaw` return `[]` / `null`. A blocked
  store then looks like a fresh one, and every caller already handles that.
  Writes still throw, so the caller can tell the user.
- **REQ-seeding-never-fails-the-boot** — `Presets.ensureFactoryPresets()` runs
  before the UI exists. Each seed write, and the index write, is attempted on its
  own, and one the storage refuses is skipped. The factory bank still plays,
  because `Presets.load` falls back to `FACTORY` for a slot that is absent or
  unreadable. Any release that adds a param to the factory bank rewrites every
  factory slot at the next boot ([presets](presets.md)
  REQ-an-older-factory-seed-is-refreshed), which a nearly full store refuses.
- **REQ-a-failed-save-says-so** — A save the user asked for and the browser
  refused is reported, never dropped, through one dialog
  (`alertStorageFailure`). It says what was not stored and why: "storage is
  full" for a quota error, "the browser would not store it" otherwise.
  - **Song Save** still downloads the file, so the work is safe, and says it is
    in the download but not in this browser's saved songs. The session's slot
    and the picker are left as they were.
  - **Preset Save** reports it and leaves the active preset and the list as they
    were: no "Saved" toast.
  - **Preset Import** stores what fits and reports how many could not be stored.
  - **Song Import** (its slot write) keeps the song applied, which it already
    is, and says it was not saved to this browser, never that the import
    failed.

## Technical design

### Contract / public interface

```ts
// src/ui/storage-failure.ts
storageFailureReason(e: unknown): string;   // 'storage is full' | 'the browser would not store it'
alertStorageFailure(opts: { title: string; message: string; error: unknown }): Promise<void>;

// src/state/slot-store.ts (unchanged signatures)
SlotStore.readIndex(): string[];     // never throws
SlotStore.readRaw(name): string | null;  // never throws
SlotStore.writeRaw / writeIndex / addToIndex / remove   // throw on a refused write
```

A quota error is a `DOMException` named `QuotaExceededError`, or Firefox's
`NS_ERROR_DOM_QUOTA_REACHED`.

### Layer touchpoints & ordering

```yaml
main.ts boot: Presets.ensureFactoryPresets() — never throws (REQ-seeding-never-fails-the-boot)
song-panel.ts Save: Song.saveSlot in try; on failure Song.download + alertStorageFailure
preset-manager-modal.ts: Save and applyImport catch per Presets.save
song-io.ts saveImportedSlot: Song.saveSlot in try; on failure alertStorageFailure, returns false
```

## Scenarios (BDD)

```gherkin
Scenario: A full or blocked storage cannot stop the boot (REQ-seeding-never-fails-the-boot, regression)
  Given localStorage refuses every write, or throws on every access
  When the factory presets are seeded
  Then the seeding returns without throwing
  And every factory preset still loads from the built-in bank
# pinned by: tests/state/preset.test.ts

Scenario: A blocked store reads as empty (REQ-a-slot-read-never-throws)
  Given localStorage throws on every access
  Then readIndex is [] and readRaw is null
# pinned by: tests/state/slot-store.test.ts

Scenario: A song Save the browser refuses still downloads and says so (REQ-a-failed-save-says-so, regression)
  Given localStorage is full
  When the user saves the song under a name
  Then the song file is downloaded
  And a dialog says it was not stored in this browser because storage is full
  And the session's slot is unchanged
# pinned by: tests/ui/storage-failure.test.ts

Scenario: A preset Save the browser refuses says so (REQ-a-failed-save-says-so, regression)
  Given localStorage is full
  When the user saves the current sound as a preset
  Then a dialog says it was not saved, and no "Saved" toast appears
# pinned by: tests/ui/storage-failure.test.ts

Scenario: A song import whose slot write is refused stays loaded (REQ-a-failed-save-says-so, regression)
  Given localStorage is full
  When a song file is imported
  Then the song is applied, and a dialog says it was not saved to this browser
  And no "failed to apply" message appears
# pinned by: tests/ui/storage-failure.test.ts
```

## Tests & verification

- `tests/state/slot-store.test.ts`, `tests/state/preset.test.ts`,
  `tests/ui/storage-failure.test.ts` (the storage mock, made to throw) —
  `npm test`.
