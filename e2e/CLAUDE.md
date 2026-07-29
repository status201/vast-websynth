# E2E (Playwright)

Loaded when working with files under `e2e/`. The conventions for *writing* a spec
are `specs/recipes/write-a-test.md`; the **selector catalogue** — every stable
`data-testid` and the rules for minting one — is `specs/features/testids.md`.
This file holds only what is specific to running them here.

E2E lives in `e2e/` (outside `src/`, so `tsc` ignores it), config in
`playwright.config.ts`. It drives the **dev server** in headless Chromium —
Playwright clicks are trusted gestures, so they unlock the `AudioContext` behind
"Tap to start".

## Selecting

CSS Modules hash every class name, so select by `data-testid`, text or role.
**Prefer testids over labels**: capitalised button text collides with lowercase
siblings under Playwright's case-insensitive matching — the header `Play` vs the
Arpeggiator's `play`, the `Sampler` tab vs the Song panel's `sampler` lane.

Assert engine state through the dev-only bridge `window.__synth =
{ engine, bus, patterns, session, xy, patternUndo }` (gated on
`import.meta.env.DEV`, absent in production) — e.g.
`window.__synth.bus.get('filter.cutoff')`.

## Gotchas

- `prompt`/`confirm`: `page.once('dialog', …)`. Blob downloads:
  `page.waitForEvent('download')`.
- The mic spec needs the `--use-fake-device/ui-for-media-stream` Chromium flags
  (already in `playwright.config.ts`) plus
  `context.grantPermissions(['microphone'])`, so `getUserMedia` resolves with a
  synthetic stream — and a secure context, which `localhost` satisfies.
- Shared fixtures (WAV builders etc.) live in `e2e/helpers.ts`.

## Environment-bound specs

- `sync` covers presence + mode persistence only — headless Chromium has no MIDI
  ports. The timing math is unit-tested under `tests/audio/transport/sync/`.
- `export-project` is WAV-only: CI Chromium can't decode MP3.
