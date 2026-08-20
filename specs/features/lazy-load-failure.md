# Deferred-surface load failure (the report behind every `import()`)

```yaml
id: lazy-load-failure
status: implemented
version: 1
owner: core
related:
  - runtime-performance   # REQ-1 — the split that creates this failure mode
  - pwa-install           # REQ-6 — the idle warm that prevents it
  - toast                 # the surface the report is rendered on
  - onboarding            # REQ-24 — the help door, the worked example
  - presets
  - audio-export
  - sample-recorder
  - webrtc-sync
  - ai-prompt
source:
  - src/ui/components/lazy-load-toast.ts   # the helper — the whole contract
  - src/ui/components/about-button.ts      # trigger: Help & About
  - src/ui/onboarding/index.ts             # triggers: the tour, the info badges
  - src/ui/app.ts                          # trigger: the preset manager
  - src/ui/panels/song-panel.ts            # trigger: the audio-export dialog
  - src/ui/panels/sampler-panel.ts         # trigger: the sound recorder
  - src/ui/components/sync-section.ts      # trigger: WiFi pairing
  - src/ui/components/ai-prompt.ts         # trigger: the authoring guide
  - src/main.ts                            # the idle warms (prevention)
```

## Background / Why

[`runtime-performance.md`](runtime-performance.md) REQ-1 splits every
click-reachable surface behind an `import()` so a player never pays boot cost for
a modal they never open. That is the right trade, but it converts a class of
module from *cannot fail* to *can fail*: a static import is resolved before the
app runs, a dynamic one is a network fetch at the moment of the click.

Every one of those triggers was written the same way — `onClick: () => void
open()` — which swallows the rejection. The result was a control that did
**nothing at all**: no surface, no error, no console line the player would ever
see. The realistic trigger is not exotic. The service worker caches only what the
page actually requested ([`pwa-install.md`](pwa-install.md) REQ-6), so any chunk
never fetched while online is simply absent on an offline revisit — and the first
report came from exactly that: the header's **?** button, dead offline, which
reads as a broken app rather than a missing download.

This spec is the one place the failure path is described, because the fix is the
same shape at every trigger and describing it seven times is how six of them
would drift.

## Requirements

- **REQ-1** (every trigger reports) — A trigger that `import()`s a **surface**
  must handle the rejection and tell the user. Silently returning is not an
  option, and neither is a bare `console.error`. The current set is: Help &
  About, the guided tour, the info badges, the preset manager, the audio-export
  dialog, the sound recorder, WiFi pairing, and the AI-prompt authoring guide.
  A new deferred surface joins the list by construction — see the recipe note in
  [runtime-performance](runtime-performance.md) REQ-1.

- **REQ-2** (one report, one wording) — The report is
  `showLazyLoadFailure(surface, retry)`, and it is the **only** place the wording
  lives. It raises a [toast](toast.md) with a **Retry** action and testid
  `lazy-load-failed-toast`, worded off `navigator.onLine`:

  | `navigator.onLine` | message |
  | --- | --- |
  | `false` | `Couldn't open <surface> — you're offline and this part of the app isn't downloaded yet.` |
  | `true` | `Couldn't open <surface> — the download failed.` |

  The split is not decoration: offline names a cause the user can act on
  (reconnect once and it stays available), whereas `onLine === true` only means
  an interface is up, so that branch stays vague rather than blaming a network
  that may be fine. `surface` is a lowercase noun phrase that reads after
  "open" — `'the preset manager'`, `'the guided tour'` — except for proper names
  of UI surfaces, which keep their capitals (`'Help & About'`).

- **REQ-3** (Retry is a real retry) — `retry` re-runs the **whole gesture**, not
  the bare import, so the surface opens with the arguments the original click
  carried. Where a trigger **memoizes** its import promise — the onboarding
  facade does, so two triggers cannot construct two `InfoBadges` — the catch must
  clear the memo before rethrowing. A cached *rejection* is permanent: without
  this, one offline click kills that surface for the rest of the session even
  after the network returns. Clearing it is safe precisely because a failed load
  constructed nothing for a later load to duplicate.

- **REQ-4** (report is the backstop, not the plan) — The primary defence is the
  idle warm ([`pwa-install.md`](pwa-install.md) REQ-6): a surface reachable
  offline is fetched on idle at boot, so one online visit makes it permanently
  available. The warm swallows its own error and never reports — it is not a
  gesture, and a toast for something the user did not ask for is noise. REQ-1's
  report covers what the warm cannot: a first visit that lost the network before
  idle, a purged cache, a flaky fetch.

- **REQ-5** (scope: surfaces, not operations) — This is for `import()`s that
  **open something**. An `import()` in the middle of an operation already has a
  flow that owns its errors, and "Couldn't open …" is the wrong sentence for it,
  so those stay with their own feature: the `lamejs` encoder inside an MP3 export
  ([audio-export](audio-export.md)) and the `jsqr` decoder inside a QR scan
  ([webrtc-sync](webrtc-sync.md)). Neither is covered here.

## Technical design

### Contract / public interface

```ts
// src/ui/components/lazy-load-toast.ts
export function showLazyLoadFailure(surface: string, retry: () => void): void;
```

The canonical trigger shape, for a surface with no local state:

```ts
async function openThing(args: Args): Promise<void> {
  let m: typeof import('./thing');
  try {
    m = await import('./thing');
  } catch {
    showLazyLoadFailure('the thing', () => void openThing(args));
    return;
  }
  m.openThing(args);
}
```

Only the `import()` sits inside the `try`. A throw from the surface's own
constructor is a bug, not a missing chunk, and must not be reported as one —
which is also why the facade uses two-argument `then(use, onRejected)` rather
than `.then(use).catch(...)`.

**Where the trigger wants named exports rather than the namespace, keep the
destructure inside the `import()` expression** — return the binding out of the
`try` instead of assigning into one declared above it:

```ts
async function loadThing(): Promise<Thing | null> {
  try {
    const { thing } = await import('./thing');   // NOT: ({ thing } = await import(…))
    return thing;
  } catch {
    showLazyLoadFailure('the thing', retry);
    return null;
  }
}
```

`const { x } = await import(…)` is the form rollup can shake the module's other
exports against; hoisting the binding and destructuring by assignment re-attaches
the whole namespace. This is not theoretical — writing it the other way silently
grew the authoring-guide chunk from 16.25 kB to 19.94 kB by dragging
`buildPresetGuide` and friends in behind the AI Prompt button. The `npm run
build` chunk table is where that shows up; nothing else catches it.

### Layer touchpoints & ordering

- `lazy-load-toast.ts` imports only `toast.ts`, which is already in the entry
  chunk (`main.ts` raises the sampler-restore toast), so the helper adds no new
  boot-path weight — it must stay that way, or the report would cost every
  visitor more than the split saves.
- Each trigger owns its own `surface` string and its own retry closure; the
  helper holds no state and no registry.
- `main.ts` warms `lamejs`, `onboarding-impl` and `about-modal` on one
  `requestIdleCallback` (timeout fallback for Safari <17.4).

### Persistence

None. A failed load is not remembered — the next click is a fresh attempt, which
is the whole point of REQ-3.

## Scenarios (BDD)

```gherkin
Scenario: a trigger whose chunk is missing says so
  Given the About body's import will reject
  When the user clicks the ? button
  Then no card is appended
  And a toast names Help & About and offers Retry
# pinned by: tests/ui/lazy-load-failure.test.ts

Scenario: the wording distinguishes offline from a failed fetch (REQ-2)
  Given a trigger whose import will reject
  When navigator.onLine is false
  Then the toast says "you're offline and this part of the app isn't downloaded yet"
  When navigator.onLine is true
  Then the toast says "the download failed" and does not mention being offline
# pinned by: tests/ui/lazy-load-failure.test.ts

Scenario: Retry re-runs the gesture once the import succeeds (REQ-3)
  Given the load-failure toast is showing
  When the import stops rejecting and the user clicks Retry
  Then the surface opens normally and the toast is gone
# pinned by: tests/ui/lazy-load-failure.test.ts

Scenario: a memoizing trigger does not cache its rejection (REQ-3)
  Given the onboarding facade's import of onboarding-impl rejects
  When startTour() is called and then retried after the import recovers
  Then the body is imported again and the tour starts
  And the badge toggle names the info badges rather than the tour when it is
    the toggle that failed
# pinned by: tests/ui/lazy-load-failure.test.ts

Scenario: the AI prompt and WiFi pairing report too (REQ-1)
  Given the authoring guide / the pair modal will not load
  When the user clicks the button that opens it
  Then a toast names that surface and no modal is appended
# pinned by: tests/ui/lazy-load-failure.test.ts

Scenario: no deferred surface is left silent (REQ-1, drift)
  Given every .ts file under src/ outside vendor/
  When one contains a runtime import() — `await import(` or `import(...).then/.catch`
  Then that file also calls showLazyLoadFailure, or is one of the three
    exemptions REQ-4/REQ-5 name, with its reason recorded beside it
# pinned by: tests/ui/lazy-load-failure.test.ts
```

## Tests & verification

- Unit: `tests/ui/lazy-load-failure.test.ts` — `npm test`. Two kinds of pin, and
  the difference is worth knowing:
  - **Behavioural**, with the lazy module mocked to throw on evaluation (what a
    rejected chunk fetch looks like from the importer's side): Help & About, the
    tour, the info badges, the AI prompt, WiFi pairing. These cover the wording
    table, the Retry path and the memo rule.
  - **Structural**, over the source text: no `.ts` under `src/` (outside
    `vendor/`) holds a runtime `import()` without also calling
    `showLazyLoadFailure`, bar three exemptions carrying their reason. This is
    what pins the *set* — the regression this spec exists to prevent is an
    eighth surface added without a catch, which no behavioural test can see.
    It is also, for now, the only pin on the preset manager, the audio-export
    dialog and the sound recorder: all three are private functions behind a
    whole panel's dependency graph, so they are verified by construction and by
    `typecheck`, not by being driven.
- Typecheck: `npm run typecheck`
- **By hand, and only by hand, for REQ-4**: no test can see whether a chunk is in
  the service-worker cache. `npm run build && npx vite preview`, load, reload
  (the SW takes control), then DevTools ▸ Network ▸ Offline and reload: the `?`
  button must open About and its tour button must start the tour.
- Boot payload: `npm run build` — the helper must not pull anything new into the
  entry chunk, each surface must still appear as its own chunk, and **no lazy
  chunk may grow**: adding a guard is a pure control-flow change, so a chunk that
  gets bigger means the destructure trap above was tripped. Baseline at the time
  of writing: entry 421.7 kB, about-modal 12.98, authoring-guide 16.25,
  preset-manager 7.01, export-audio 4.34, record-sound 10.60, sync-pair 31.04,
  onboarding-impl 62.83.

## Open questions / future

- REQ-5's two mid-operation imports (`lamejs`, `jsqr`) are still weakly
  reported: an MP3 export whose encoder chunk is missing ends back at idle with
  no message, and a QR scan whose decoder is missing shows "Camera unavailable",
  which is not what went wrong. Both want a fix in their own feature's error
  path, not this toast.
