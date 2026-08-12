# Restore to Factory Settings

```yaml
id: factory-reset
status: implemented
version: 3  # v3: the About card gained a tour button and a folded key list above
            #     this one — its two neighbours are unchanged (onboarding.md v15)
owner: core
related:
  - architecture
  - dialog
  - debug-panel
  - onboarding
  - brand
  - sample-persistence   # the one non-localStorage store this must also wipe
source:
  - src/state/factory-reset.ts
  - src/ui/components/about-modal.ts   # buildFactoryResetButton + the card order
```

## Background / Why

All device-local state — presets, saved songs, perf tier, sync mode, collapse
preferences, onboarding flags — lives under `localStorage` (the `websynth.*`
convention), with no single way to wipe it. A user whose device state has
drifted (broken preset, stale setting, handing the device to someone else) has
to clear site data through browser UI. This feature adds an explicit "Restore
to Factory Settings" action in the About modal that clears **all** origin-local
storage and reloads the app into a pristine, factory-seeded state.

## Requirements

- **REQ-1** — The About modal (`ui/components/about.ts`) shows a full-width
  **"Restore to Factory Settings"** button placed **below the Keyboard
  Shortcuts grid and above the Debug section header** — both neighbours
  unchanged by the v15 About rework, which folds the shortcuts grid
  ([onboarding](onboarding.md) REQ-17b) but does not move it. It carries
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
  ([sample-persistence](sample-persistence.md) REQ-9), and then reloads the
  page. Cancel / Escape / backdrop-click leaves all storage untouched.
- **REQ-7** — The clip wipe is asynchronous (IndexedDB has no synchronous
  clear), so `restoreFactorySettings` returns a promise and the About caller
  is `void`-ed. It is awaited but **capped at 500 ms**: a wedged or absent
  IndexedDB delays the reload briefly at worst, never blocks it. The store's
  own `clear()` never rejects, so the race guards only a hang.
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

## Technical design

### Contract / public interface

```yaml
# src/state/factory-reset.ts
restoreFactorySettings(reload?: () => void): Promise<void>
  # clears localStorage + sessionStorage (each guarded by try/catch),
  # awaits SampleAutosave.clear() capped at 500 ms,
  # then calls reload (default: () => location.reload())
```

### Layer touchpoints & ordering

```yaml
src/ui/components/about.ts:
  buildModal: card children order ->            # v3: tourBtn + the folded key list
    [brand, meta, tourBtn, shortcuts sec, layout row, keys,
     FACTORY-RESET BUTTON, debug.header, debug.body, closeBtn]
    # `brand` is the shared block (features/brand.md), not a title/tag pair;
    # `layout row` is the gear's picker (features/keyboard-layout.md), which
    # sits between the foldable header and the grid it folds
  click -> confirmDialog({ danger, detail: nintendo line }) -> ok? restoreFactorySettings()
src/ui/components/dialog.ts: ConfirmOptions.detail (italic second paragraph — see dialog.md REQ-7)
```

There are no unload-time storage writes in `src/`, so nothing can re-persist a
key between the clear and the reload.

### Persistence

Deliberately none — this feature only *destroys* persisted state. It clears
the whole origin's `localStorage`/`sessionStorage` (not just `websynth.*` keys)
plus the IndexedDB clip store, so truly everything local is gone, matching the
"factory" promise.

## Scenarios (BDD)

```gherkin
Scenario: The button sits between Keyboard Shortcuts and Debug
  Given the About modal is open
  Then a "Restore to Factory Settings" button (testid factory-reset) exists
  And it appears after the shortcuts grid and before the Debug section header
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

Scenario: Escape closes the confirm, not the About modal beneath it
  Given the factory-reset confirm dialog is open on top of the About modal
  When the user presses Escape
  Then the confirm closes without restoring, and the About modal stays open
# pinned by: tests/ui/about.test.ts
```

## Tests & verification

- Unit: `tests/state/factory-reset.test.ts` (clear + reload callback, storage
  errors swallowed), `tests/ui/about.test.ts` (placement + confirm/cancel
  flows) — `npm test`
- Typecheck: `npm run typecheck`
- Manual: About → Restore → confirm → app reloads to the start modal with
  factory presets only.

## Open questions / future

- Could also unregister the service worker / clear its caches; skipped —
  caches hold no user state and refresh themselves on the next version.
