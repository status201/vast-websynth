# Recipe — write a test

```yaml
id: write-a-test
status: implemented
version: 1
owner: core
related:
  - architecture
source:
  - tests/audio/mock-audio-context.ts
  - tests/storage-mock.ts
  - e2e/helpers.ts
  - playwright.config.ts
```

How to add a unit (Vitest) or E2E (Playwright) test, following the repo's
conventions. There is no linter — tests + `typecheck` are the safety net.

## Background / Why

Tests live **outside `src/`** (under `tests/` and `e2e/`) so `tsc` ignores them and
`typecheck`/`build` behaviour is unchanged. Pure logic is tested directly; audio
graph code is tested against mocks so no real audio runs.

## Unit test (Vitest, jsdom) — `tests/<mirror of src path>.test.ts`

- **Pure logic** (params, patterns, song, step-hits, encode, buffer-dsp): import and
  assert directly.
- **Transport / audio modules** whose constructor builds a graph: pass the mock
  `AudioContext` from `tests/audio/mock-audio-context.ts` (chainable node stubs with
  `vi.fn()` `AudioParam`s — the wiring builds, no audio runs). Use
  `tests/audio/transport/test-clock.ts` to drive ticks deterministically.
- **`localStorage`-backed** suites: install the in-memory `Storage` from
  `tests/storage-mock.ts` (jsdom's isn't reliably wired under Vitest).
- **Worklet DSP**: stub the worklet globals and import `public/worklets/<x>.js`
  directly (see `tests/audio/compressor-worklet.test.ts`).
- **DOM components**: build the component in jsdom and assert DOM + `bus`
  interactions (mirror `tests/ui/switch.test.ts`).

Run: `npm test` (or `npm run test:watch`).

## E2E test (Playwright, Chromium) — `e2e/<name>.spec.ts`

- Select by **`data-testid`** / text / role — CSS-Module class names are hashed.
  Prefer testids over capitalised button text (case-insensitive collisions).
- Playwright clicks are trusted gestures, so they unlock the `AudioContext` behind
  "Tap to start".
- Assert engine state through the DEV bridge `window.__synth` (e.g.
  `window.__synth.bus.get('filter.cutoff')`).
- `prompt`/`confirm`: `page.once('dialog', …)`. Downloads:
  `page.waitForEvent('download')`.
- Shared helpers (WAV fixtures etc.) live in `e2e/helpers.ts`; config +
  fake-media-device flags are in `playwright.config.ts`.

Run: `npm run e2e` (or `npm run e2e:ui`).

## Gotchas

- Keep tests **outside `src/`** — a test under `src/` would change `tsc` output.
- Don't reach for a real `AudioContext` in unit tests; use the mock.
- `window.__synth` exists only in DEV builds — fine for E2E against the dev server.

## Acceptance (BDD)

```gherkin
Scenario: A new unit test pins behaviour without real audio
  Given a transport module under test
  When it is constructed with the mock AudioContext and driven by the test clock
  Then its logic is asserted with no audio output
# pinned by: tests/audio/transport/*.test.ts (pattern)
```

## Tests & verification

- `npm test` (Vitest), `npm run e2e` (Playwright), `npm run typecheck`.
