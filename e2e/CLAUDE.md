# E2E (Playwright)

Loaded when working with files under `e2e/`. The conventions for *writing* a spec
are `specs/recipes/write-a-test.md`; the **selector catalogue** — every stable
`data-testid` and the rules for minting one — is `specs/features/testids.md`.
This file holds only what is specific to running them here.

E2E lives in `e2e/` (outside `src/`, so `tsc` ignores it), config in
`playwright.config.ts`. It drives the **dev server** in headless Chromium.

**Getting past the start gate: always `await startAudio(page)`** (or
`gotoAndStart`, which calls it). Never click "Tap to start" directly. The modal
is shown only where the browser demands a gesture (`audio-lifecycle.md` REQ-20),
and the default project launches with `--autoplay-policy=no-user-gesture-required`
— so in this suite the context is created **running** and *there is no modal at
all*. `startAudio` takes whichever gate it is given and returns once the
`AudioContext` is running. `audio-autostart.spec.ts` is the one spec that asserts
which gate appears; it covers the blocked branch by overriding `launchOptions.args`
in its own describe block.

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
- **Never spell a demo song's name.** `src/state/demos/` is a drop-in directory,
  so naming one couples the spec to data — and to the demo *row position* that
  decides whether its button is inline or hidden behind "All Demos". Pick by kind
  with `pickDemo(page, 'drop-in' | 'built-in' | 'zip')` + `clickDemo`, and read
  expected values from the shipped file via `dropInDeclaring` (all in
  `helpers.ts`). `tests/no-shipped-demo-names.test.ts` fails the build otherwise;
  the full rule is `specs/recipes/write-a-test.md`.

## Environment-bound specs

- `sync` covers presence + mode persistence only — headless Chromium has no MIDI
  ports. The timing math is unit-tested under `tests/audio/transport/sync/`.
- `export-project` is WAV-only: CI Chromium can't decode MP3.
