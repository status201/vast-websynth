# Recipe — add a guided-tour step

```yaml
id: add-a-tour-step
status: implemented
version: 2   # v2: step actions are awaited; applyDemo is async
owner: core
related:
  - onboarding
source:
  - src/ui/onboarding/help-content.ts    # TOUR_STEPS array
  - src/ui/onboarding/tour.ts            # TourStep / TourCtx
```

How to add a step to the first-run guided tour, and (optionally) a help-mode badge
for a new control.

## Background / Why

The [tour](../features/onboarding.md) is a list of `TourStep`s rendered as a
spotlight + callout. Steps can be interactive because the spotlight is
`pointer-events: none` (the real control stays clickable). Steps get their runtime
via an injected `TourCtx` — never DEV-only globals — so they work in production.

## Steps

### 1. Append a `TourStep` to `TOUR_STEPS` — `src/ui/onboarding/help-content.ts`

```ts
{
  target: 'knob-filter.cutoff',   // a data-testid string, a () => Element, or omit for a centered card
  title: 'Shape the sound',
  body: 'Light HTML, authored + trusted.',
  placement: 'right',             // 'auto' | top | bottom | left | right (default auto)
  precondition: (ctx) => ctx.expandFx(),        // open a tab / resumeAudio before render
  action: async (ctx) => { await ctx.applyDemo('Night Rider'); }, // run on Next
  advanceOn: 'note',              // auto-advance on first incoming note (default 'next')
}
```

`TourStep` shape (`tour.ts`): `{ target?, title, body, placement?, precondition?,
action?, advanceOn? }`. `TourCtx` hooks: `bus, engine, toggleTransport, applyDemo,
resumeAudio, expandFx`.

`action` may return a promise and the tour **awaits** it before advancing, which
matters for `applyDemo`: all but the two built-in demos are fetched on click
([song-mode](../features/song-mode.md) REQ-12), so a step that loads a demo *and
then acts on it* — starting the transport, say — must `await` or it will act on
whatever was loaded before. `resumeAudio` is async for the same reason.

### 2. (Optional) add a help-mode badge

If the step introduces a new control, add a `HelpTopic` + `TopicId` in
`help-content.ts` so help mode shows an (i) badge for it.

## Gotchas

- `target` resolves via `[data-testid="…"]` — make sure the control has that testid
  (see [add-a-ui-component](add-a-ui-component.md)).
- Use **`precondition`** to make the target visible (open its tab / expand FX)
  before the spotlight tries to position on it.
- Take everything from `TourCtx`; never read `window.__synth` or other globals from
  a step (they're absent in production).

## Scenarios (BDD)

```gherkin
Scenario: The new step spotlights a live control
  Given the tour reaches the step
  When the callout renders
  Then the target is spotlit, stays clickable, and the callout stays on-screen
# pinned by: tests/ui/tour-place.test.ts, e2e/onboarding.spec.ts
```

## Tests & verification

- `tests/ui/tour-place.test.ts` (placement), `e2e/onboarding.spec.ts` (flow).
  `npm test` / `npm run e2e`.
