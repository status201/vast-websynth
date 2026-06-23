# Onboarding (guided tour & help mode)

```yaml
id: onboarding
status: implemented
version: 1
owner: core
related:
  - architecture
  - input-control
source:
  - src/ui/onboarding/tour.ts
  - src/ui/onboarding/help-mode.ts
  - src/ui/onboarding/help-content.ts
  - src/ui/onboarding/index.ts
```

First-run guidance: an interactive spotlight tour and a persistent help mode that
annotates controls.

## Background / Why

New users face a dense control surface, so the tour walks them through it one
control at a time with a dimmed spotlight and a callout. The spotlight is
`pointer-events: none`, so the **real control underneath stays clickable** — that's
what lets steps like "press a key" or "press Play" be genuinely interactive rather
than a slideshow. The tour takes its runtime hooks via an injected `TourCtx` so it
never reads DEV-only globals.

## Requirements

- **REQ-1** — The tour highlights one target at a time; only the callout (and its
  Back/Skip/Next) is clickable — the spotlighted control remains live.
- **REQ-2** — Interactive steps (play a note, press Play, load a demo) work against
  the real app via injected hooks, not globals.
- **REQ-3** — Help mode shows per-control help badges/content from
  `help-content.ts`.
- **REQ-4** — Placement of callouts adapts (`auto`/top/bottom/left/right) to stay
  on-screen.

## Technical design

### Contract / public interface

```yaml
tour.ts:
  Placement = 'auto' | 'top' | 'bottom' | 'left' | 'right'
  TourTarget = string | (() => Element | null)
  TourCtx (injected hooks):
    bus, engine
    toggleTransport()        # via the header button (keeps LED/label synced)
    applyDemo(name)          # load a demo song (does not start transport)
    resumeAudio(): Promise   # idempotent AudioContext resume (before note step)
    expandFx()               # open the collapsible FX section
help-mode.ts / help-content.ts: per-control help badges + copy
```

### Layer touchpoints

```yaml
boot: onboarding/index.ts wires the tour + help mode with a TourCtx from main.ts
interactivity: spotlight overlay is pointer-events:none so the underlying control
  stays clickable; only the callout intercepts clicks
```

## Scenarios (BDD)

```gherkin
Scenario: The spotlighted control stays interactive
  Given the tour is on the "press a key" step
  When the user clicks the spotlighted key
  Then the note actually sounds and the step advances
# pinned by: e2e/onboarding.spec.ts

Scenario: Callout placement stays on-screen (edge)
  Given a target near the viewport edge
  When the callout renders with placement 'auto'
  Then it flips to a side that keeps it fully visible
# pinned by: tests/ui/tour-place.test.ts
```

## Tests & verification

- `tests/ui/tour-place.test.ts` (placement math), `e2e/onboarding.spec.ts`
  (interactive flow).
- `npm test` / `npm run e2e`.

## Open questions / future

- New tour steps should keep using injected `TourCtx` hooks (never DEV globals) so
  they work in production builds.
