# Progress bar (shared component)

```yaml
id: progress-bar
status: implemented
version: 1
owner: core
related:
  - audio-export     # first consumer: the export dialog's render + encode view
  - play-offline     # second consumer: the About card's offline download
  - typography
source:
  - src/ui/components/progress-bar.ts
  - src/ui/styles/progress-bar.module.css
```

## Background / Why

The export dialog ([audio-export](audio-export.md) REQ-10) built its own progress
bar: a track, a gradient fill whose width is the ratio, a striped "working, length
unknown" variant for the MP3 encode, and a reduced-motion opt-out. The offline
download ([play-offline](play-offline.md)) needs the same bar. A second copy is
where two bars start to disagree about height, colour and ARIA, so the bar becomes
one component both call.

## Requirements

- **REQ-1** (determinate) — `createProgressBar()` returns a `role="progressbar"`
  track with `aria-valuemin="0"` / `aria-valuemax="100"` and a fill child.
  `set(ratio)` clamps to 0…1, sets the fill's width to that percentage and
  `aria-valuenow` to the rounded percentage. A non-finite ratio counts as 0.

- **REQ-2** (indeterminate) — `setIndeterminate(true)` fills the track, animates
  diagonal stripes across it and **removes** `aria-valuenow` — a filled bar would
  claim a length nobody knows. `setIndeterminate(false)` removes the stripes; the
  next `set()` restores the value.

- **REQ-3** (motion) — The fill eases between values (`0.12s linear`), so a bar
  advancing a few times a second reads as motion rather than a stutter. Under
  `prefers-reduced-motion: reduce` neither the ease nor the stripe animation runs.

- **REQ-4** (identity) — `testId` sets the track's `data-testid` and `label` its
  `aria-label`. Callers keep their existing testids (`export-audio-progress`).

## Technical design

### Contract / public interface

```yaml
# src/ui/components/progress-bar.ts
createProgressBar(opts?: { testId?: string; label?: string }): ProgressBar
ProgressBar:
  el: HTMLElement                 # the track; hide/show it with el.hidden
  set(ratio: number): void
  setIndeterminate(on: boolean): void
```

### Layer touchpoints & ordering

```yaml
export-audio-modal.ts: progress view -> [status <p>, createProgressBar({testId: export-audio-progress})]
about-offline.ts:      section -> [button, status, createProgressBar({testId: play-offline-progress})]
progress-bar.module.css: .track, .fill, .indeterminate (moved from export-audio-modal.module.css)
```

## Scenarios (BDD)

```gherkin
Scenario: A ratio sets the width and the value (REQ-1)
  Given a progress bar
  When set(0.5) is called
  Then the fill is 50% wide and aria-valuenow is "50"
   And set(2) clamps to 100 and set(NaN) to 0
# pinned by: tests/ui/progress-bar.test.ts

Scenario: Indeterminate drops the value (REQ-2)
  Given a progress bar at 40%
  When setIndeterminate(true) is called
  Then the track carries the indeterminate class and has no aria-valuenow
# pinned by: tests/ui/progress-bar.test.ts

Scenario: The export dialog still reports its render through the shared bar (REQ-4)
  Given the export dialog rendering at half-way
  Then export-audio-progress has aria-valuenow "50"
# pinned by: tests/ui/export-audio-modal.test.ts
```

## Tests & verification

- Unit: `tests/ui/progress-bar.test.ts`, `tests/ui/export-audio-modal.test.ts` — `npm test`
- E2E: `e2e/song.spec.ts` (the export progress stays visible) — `npm run e2e`
- Typecheck: `npm run typecheck`
