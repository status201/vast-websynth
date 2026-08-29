# Recipe — write a test

```yaml
id: write-a-test
status: implemented
version: 2  # v2: a test may not name a shipped demo song — pick by kind, read
            #     expected values from the shipped file, reserve the `test-` prefix
owner: core
related:
  - architecture
  - song-mode          # the demo library a test must not name
source:
  - tests/audio/mock-audio-context.ts
  - tests/storage-mock.ts
  - tests/fixtures/song-fixture.ts        # the test-owned song, in place of a demo
  - tests/state/demo-files.ts             # the drop-in glob + dropInDeclaring
  - tests/no-shipped-demo-names.test.ts   # enforces the rule below
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
- Get past the start gate with **`startAudio(page)`** (or `gotoAndStart`), never
  by clicking "Tap to start" yourself: the modal is shown only where the browser
  demands a gesture, and this suite runs with autoplay permitted, so usually there
  is no modal at all ([audio-lifecycle](../features/audio-lifecycle.md) REQ-20).
  Playwright clicks are trusted gestures, so the modal path really does unlock.
- Assert engine state through the DEV bridge `window.__synth` (e.g.
  `window.__synth.bus.get('filter.cutoff')`).
- `prompt`/`confirm`: `page.once('dialog', …)`. Downloads:
  `page.waitForEvent('download')`.
- Shared helpers (WAV fixtures etc.) live in `e2e/helpers.ts`; config +
  fake-media-device flags are in `playwright.config.ts`.

Run: `npm run e2e` (or `npm run e2e:ui`).

## Never name a shipped demo song

`src/state/demos/` is a **drop-in directory**: adding, editing, renaming or
removing a song there is a data change that
[add-a-demo-song](add-a-demo-song.md) promises needs no code change. A test that
spells a demo's name, or pins one's BPM or step notes, silently revokes that
promise — and it broke for real: adding one demo pushed another past
`DEMO_ROW_LIMIT` into the collapsed overflow, and every spec that clicked that
one by name started timing out.

So a test may never name a shipped demo. `tests/no-shipped-demo-names.test.ts`
enforces it, scanning `tests/**` and `e2e/**` for the `song-demo-<name>` testid
and for exact quoted tokens (comments included — a comment quoting a demo name
goes stale too).

- **Pick by *kind*, not by name.** Kind is what a spec actually cares about: a
  drop-in exercises the fetch path, a built-in is synchronous, a zip is the
  project-bundle path. In E2E, `e2e/helpers.ts` gives
  `pickDemo(page, 'drop-in' | 'built-in' | 'zip')`, `clickDemo(page, name)`
  (which reveals the overflow if the button is hidden), `demoLibrary`,
  `renderedDemoNames` and `visibleDemoNames`.
- **Read expected values from the shipped file**, so editing a demo moves the
  assertion with it: `dropInDeclaring([...keys])` returns the first drop-in that
  states those params, throwing rather than skipping if none does. There is a
  unit-side twin in `tests/state/demo-files.ts`.
- **Assert over the whole library, not one song.** `it.each` over
  `DROP_IN_DEMOS` / `DEMO_SONGS` (see `tests/state/song-validate.test.ts`) means
  a new demo gains coverage for free instead of needing a test edit.
- **A test that needs to assert on a song's contents uses the test-owned
  fixture**, `tests/fixtures/song-fixture.ts` — not a demo.
- **Test-owned song and slot names use the reserved `test-` prefix.** No shipped
  demo may claim it (also enforced), so *adding* a demo can never collide with a
  name a test invented.

Derived discriminators beat literals in general: where a test needs "the other
tempo", `otherBpm(theDemos)` picks a valid one that differs, instead of hoping
96 is never a demo's BPM.

## Gotchas

- Keep tests **outside `src/`** — a test under `src/` would change `tsc` output.
- Don't reach for a real `AudioContext` in unit tests; use the mock.
- `window.__synth` exists only in DEV builds — fine for E2E against the dev server.
- **The mock proves wiring, not sound.** No suite here can tell you whether a
  change is *musical* — that is [ADR-010](../decisions/adr-010-musical-stable-cheap-dsp.md)'s
  first priority and nothing automated covers it. A DSP or routing change is not
  verified until it has been heard: render a take through the real graph with
  `npm run bench:audio` and listen to it
  ([verify-audio-by-ear](verify-audio-by-ear.md)). Tests are the regression
  guard; the acceptance test is a person.

## Scenarios (BDD)

```gherkin
Scenario: A new unit test pins behaviour without real audio
  Given a transport module under test
  When it is constructed with the mock AudioContext and driven by the test clock
  Then its logic is asserted with no audio output
# pinned by: tests/audio/transport/*.test.ts (pattern)

Scenario: A test may not name a shipped demo song
  Given a file under tests/ or e2e/
  When it contains a song-demo-<name> testid or a demo's name as a quoted token
  Then the guard fails, naming the file, the line and the demo
  And it points at pickDemo/clickDemo/dropInDeclaring and the test-owned fixture
# pinned by: tests/no-shipped-demo-names.test.ts

Scenario: No shipped demo may claim the reserved test- prefix
  Given test-owned song and slot names all begin with "test-"
  Then no demo in demoNames() begins with it, so adding one cannot collide
# pinned by: tests/no-shipped-demo-names.test.ts
```

## Tests & verification

- `npm test` (Vitest), `npm run e2e` (Playwright), `npm run typecheck`.
- For anything that changes the *sound*: `npm run bench:audio` +
  `npm run bench:metrics` ([verify-audio-by-ear](verify-audio-by-ear.md)).
