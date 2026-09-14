# Restore to Factory Settings

```yaml
id: factory-reset
status: implemented
version: 5  # v5: the offline copy is deleted too, and downloaded again after the
            #     reload when a complete one existed (REQ-8) — never while the
            #     server is unreachable (REQ-9)
            # v4: the Play offline section (play-offline.md) now sits between the
            #     shortcuts grid and this button, so that is its upper neighbour
            # v3: the About card gained a tour button and a folded key list above
            #     this one — its two neighbours are unchanged (onboarding.md v15)
owner: core
related:
  - architecture
  - dialog
  - debug-panel
  - onboarding
  - brand
  - sample-persistence   # the one non-localStorage store this must also wipe
  - play-offline         # the section above this button, and the copy it re-downloads
  - pwa-install          # the worker whose caches REQ-8 deletes
source:
  - src/state/factory-reset.ts
  - src/state/offline-redownload.ts
  - src/ui/components/about-modal.ts   # buildFactoryResetButton + the card order
```

## Background / Why

All device-local state — presets, saved songs, perf tier, sync mode, collapse
preferences, onboarding flags — lives under `localStorage` (the `websynth.*`
convention), with no single way to wipe it. A user whose device state has
drifted (broken preset, stale setting, handing the device to someone else) has
to clear site data through browser UI. This feature adds an explicit "Restore
to Factory Settings" action in the About modal that clears **all** origin-local
storage and reloads the app into a pristine, factory-seeded state. (v5) That
includes the service worker's caches: a stale cache is the classic reason an
installed app misbehaves, so a factory device is one whose app files are fresh
too — and a device that had saved an offline copy gets it back, freshly
downloaded.

## Requirements

- **REQ-1** — The About modal (`ui/components/about-modal.ts`) shows a full-width
  **"Restore to Factory Settings"** button placed **below the Play offline
  section and above the Debug section header** (v4: the
  [Play offline](play-offline.md) section, REQ-1 there, was inserted between the
  Keyboard Shortcuts grid and this button; the shortcuts grid, folded by the v15
  About rework — [onboarding](onboarding.md) REQ-17b — sits directly above it). It carries
  `data-testid="factory-reset"` and is styled as a destructive action (the
  dialog module's `danger` recolour composed onto the shared switch button
  style).

- **REQ-2** — Clicking the button opens the shared styled `confirmDialog`
  ([dialog](dialog.md)) with `danger: true` — never the native `confirm()`.
  The message asks **"Are you sure?"** and states what is erased *and that the
  app will reload*; below it, rendered in *italics*, the detail line with curly
  quotes: **“Everything not saved will be lost.”** (the classic Nintendo exit
  dialog). This uses `ConfirmOptions.detail` (dialog spec v2).

- **REQ-3** — On confirm, `restoreFactorySettings()` (`state/factory-reset.ts`)
  clears **both** `localStorage` and `sessionStorage` for the whole origin
  (each `.clear()` in its own try/catch, per the `websynth.*` storage
  convention) **and** the IndexedDB sampler-clip store
  ([sample-persistence](sample-persistence.md) REQ-9), and the service worker's
  caches (REQ-8), and then reloads the page. Cancel / Escape / backdrop-click
  leaves all storage untouched.

- **REQ-4** — The reload is **mandatory**, not cosmetic: clearing storage does
  not reset live in-memory state (`ParamBus` values, pattern banks, the preset
  index already read at boot), and several settings are boot-time-only
  (perf-mode's `latencyHint` / `voiceCount` / look-ahead). On reload,
  `ensureFactoryPresets()` re-seeds the factory presets and every `websynth.*`
  consumer falls back to its default — the actual factory state. The user is
  informed via the confirm message (REQ-2) *before* the reload happens.

- **REQ-5** — The reload call is **injectable** (`reload: () => void = () =>
  location.reload()`) so the helper is unit-testable under jsdom, where
  `location.reload` is unimplemented. No production caller passes an override.

- **REQ-6** — **Stacked-modal Escape**: with the confirm open on top of the
  About modal, Escape closes only the confirm; the About modal stays open.
  About's own capture-phase Escape handler (registered first, and calling
  `stopImmediatePropagation`) would otherwise starve the dialog's handler and
  close the wrong layer — it must **yield** while any other (non-hidden)
  `Modal` backdrop is visible.

- **REQ-7** — The clip wipe is asynchronous (IndexedDB has no synchronous
  clear), so `restoreFactorySettings` returns a promise and the About caller
  is `void`-ed. It is awaited but **capped at 500 ms**: a wedged or absent
  IndexedDB delays the reload briefly at worst, never blocks it. The store's
  own `clear()` never rejects, so the race guards only a hang.

- **REQ-8** (the offline copy, v5) — The reset deletes **every** `websynth-*`
  cache (`deleteOfflineCopies`, [play-offline](play-offline.md)) — the saved
  offline copy and the worker's runtime cache alike; foreign caches are left
  alone. When one of them held a complete copy (its marker), the reset writes
  `sessionStorage` `websynth.offline.redownload` **after** clearing the storages,
  so that one intent survives the reload and nothing else does; the next boot
  downloads the copy again (play-offline.md REQ-12). The confirm (REQ-2) says so
  after its first sentence: *"A saved offline copy is downloaded again, fresh."*
  — or, when `navigator.onLine` is false, *"You're offline, so a saved offline
  copy is kept."*

- **REQ-9** (never strand the app, v5) — Deleting the caches of a device that
  cannot reach the server would make the reload itself fail, with no way to
  download anything back. So when any `websynth-*` cache exists, the reset first
  sends `HEAD /` (`cache: 'no-store'`; a non-GET, so the worker passes it straight
  to the network) with a 3 s timeout. **Any** HTTP response counts as reachable;
  a rejection or timeout keeps every cache and writes no intent. The whole cache
  step is capped at 4 s like the clip wipe (REQ-7): a wedged Cache API delays the
  reload, never blocks it, and a timed-out step writes no intent.

## Technical design

### Contract / public interface

```yaml
# src/state/factory-reset.ts
restoreFactorySettings(reload?: () => void, deps?: { caches?, fetch? }): Promise<void>
  # starts the offline-copy step (REQ-9 probe -> deleteOfflineCopies), capped at 4 s,
  # clears localStorage + sessionStorage (each guarded by try/catch),
  # awaits SampleAutosave.clear() capped at 500 ms and the cache step,
  # writes the re-download intent when a complete copy was deleted (REQ-8),
  # then calls reload (default: () => location.reload())
  # deps default to the globals; tests inject both

# src/state/offline-redownload.ts
requestOfflineRedownload(): void    # sessionStorage websynth.offline.redownload = "1"
```

### Layer touchpoints & ordering

```yaml
src/ui/components/about-modal.ts:
  buildModal: card children order ->            # v3: tourBtn + the folded key list
    [brand, meta, tourBtn, shortcuts sec, layout row, keys,
     play-offline section, FACTORY-RESET BUTTON, debug.header, debug.body, closeBtn]
    # v4: play-offline section — features/play-offline.md REQ-1
    # `brand` is the shared block (features/brand.md), not a title/tag pair;
    # `layout row` is the gear's picker (features/keyboard-layout.md), which
    # sits between the foldable header and the grid it folds
  click -> confirmDialog({ danger, detail: nintendo line }) -> ok? restoreFactorySettings()
src/ui/components/dialog.ts: ConfirmOptions.detail (italic second paragraph — see dialog.md REQ-7)
```

There are no unload-time storage writes in `src/`, so nothing can re-persist a
key between the clear and the reload.

### Persistence

This feature *destroys* persisted state. It clears the whole origin's
`localStorage`/`sessionStorage` (not just `websynth.*` keys), the IndexedDB clip
store and (v5) every `websynth-*` CacheStorage cache, so truly everything local is
gone, matching the "factory" promise. It writes back exactly one key, and only
when a complete offline copy was deleted: `sessionStorage`
`websynth.offline.redownload` (REQ-8).

## Scenarios (BDD)

```gherkin
Scenario: The button sits between Play offline and Debug
  Given the About modal is open
  Then a "Restore to Factory Settings" button (testid factory-reset) exists
  And it appears after the play-offline section and before the Debug section header
# pinned by: tests/ui/about.test.ts

Scenario: Confirming wipes all local data and reloads
  Given localStorage and sessionStorage hold websynth keys
  When the user clicks Restore to Factory Settings and confirms
  Then both storages are empty and the app reloads
# pinned by: tests/ui/about.test.ts (reload via injected spy), tests/state/factory-reset.test.ts

Scenario: The reload happens even without IndexedDB (failure)
  Given IndexedDB is unavailable, so the clip wipe cannot run
  When the user confirms Restore to Factory Settings
  Then the storages are still cleared and the app still reloads
# pinned by: tests/state/factory-reset.test.ts

Scenario: Cancelling leaves everything intact
  Given localStorage holds websynth keys
  When the user clicks Restore to Factory Settings and cancels
  Then storage is unchanged and no reload happens
# pinned by: tests/ui/about.test.ts

Scenario: The confirm shows the Nintendo exit line in italics
  Given the factory-reset confirm dialog is open
  Then an italic detail line reads “Everything not saved will be lost.”
# pinned by: tests/ui/about.test.ts

Scenario: A saved offline copy is deleted and asked for again (REQ-8)
  Given websynth-1.0.0 holds a complete offline copy and the server answers HEAD /
  When the user confirms Restore to Factory Settings
  Then every websynth-* cache is deleted and a foreign cache is kept
   And sessionStorage holds only websynth.offline.redownload when the reload runs
# pinned by: tests/state/factory-reset.test.ts

Scenario: Runtime caches are deleted without asking for a download (REQ-8)
  Given a websynth-* cache with no offline-copy marker
  When the reset runs
  Then the cache is deleted and no re-download intent is written
# pinned by: tests/state/factory-reset.test.ts

Scenario: An unreachable server keeps the caches (REQ-9, failure)
  Given a complete offline copy and a HEAD / that rejects
  When the reset runs
  Then every cache is kept, no intent is written, and the app still reloads
# pinned by: tests/state/factory-reset.test.ts

Scenario: A wedged Cache API cannot hold the reload hostage (REQ-9, failure)
  Given caches.keys() never settles
  When the reset runs
  Then the app reloads after the cap and no intent is written
# pinned by: tests/state/factory-reset.test.ts

Scenario: The confirm names what happens to the offline copy (REQ-8)
  Given the factory-reset confirm dialog is open
  Then its message says a saved offline copy is downloaded again, fresh
# pinned by: tests/ui/about.test.ts

Scenario: Escape closes the confirm, not the About modal beneath it
  Given the factory-reset confirm dialog is open on top of the About modal
  When the user presses Escape
  Then the confirm closes without restoring, and the About modal stays open
# pinned by: tests/ui/about.test.ts
```

## Tests & verification

- Unit: `tests/state/factory-reset.test.ts` (clear + reload callback, storage
  errors swallowed, the offline-copy step against fake caches and fetch),
  `tests/ui/about.test.ts` (placement + confirm/cancel flows) — `npm test`
- Real browser (the offline copy only exists in a production build): against
  `vite preview`, Play offline → Restore → confirm → after the reload the copy
  downloads again and About shows Ready.
- Typecheck: `npm run typecheck`
- Manual: About → Restore → confirm → app reloads to the start modal with
  factory presets only.

## Open questions / future

- ~~Could also clear the service worker's caches~~ — done in v5 (REQ-8/REQ-9).
  The worker itself stays registered: it is not state, and re-registering would
  only delay the re-download behind a fresh install.
