# Envelope help graph (AMP ENV / FILTER ENV badges)

```yaml
id: envelope-help-graph
status: implemented
version: 2
owner: ui/onboarding
related:
  - envelopes          # the envelope this draws, and the curve model it shares
  - voicing            # the MULTI | SINGLE switch both panels carry
  - tempo-sync-help    # the dynamic-body mechanism (REQ-a-help-body-may-be-a-function)
  - onboarding         # the info badges that open it
  - typography
source:
  - src/utils/envelope-curve.ts
  - src/ui/onboarding/envelope-graph.ts   # the drawing
  - src/ui/onboarding/help-widgets.ts     # the copy around it
  - src/ui/onboarding/help-content.ts
  - src/ui/styles/tour.module.css
```

## Background / Why

The `ampenv` and `filterenv` ⓘ topics described ADSR as four letters in a list.
Those four letters hide the fact that makes ADSR click: **three of the knobs are
times and one is a level**. Sustain is not "how long". These two badges now draw the
patch's *current* envelope under the copy. The drawing is labelled so that its
geometry carries the explanation: A, D and R are spans along the time axis, and S
is a height. The help modal blocks the knobs while it is open, so the graph is a
snapshot taken when the badge opens, like the relationship badges in
[tempo-sync-help](tempo-sync-help.md).

## Requirements

- **REQ-the-graph-draws-the-engines-curve** — The drawn line is the curve the
  engine plays, sampled from the same pure model `Envelope` schedules
  ([envelopes](envelopes.md) REQ-the-envelope-curve-is-one-pure-model), not a
  textbook trapezoid.
  - Attack rises to ~95% (1 − e⁻³), not 100%, before decay starts.
  - Decay and release are exponential approaches.
  - If the picture and the sound disagreed, the picture would be teaching something
    false.
- **REQ-times-are-spans-and-sustain-is-a-level** — A, D and R are each labelled as
  a span under their stretch of the time axis, marked with brackets. S is labelled
  as a dashed horizontal line at the sustain height.
  - Every label carries the param's own formatted value (`ParamDef.format`, so the
    graph reads exactly as the knob does).
  - The plateau between D and R is the **key held** stretch, marked *key down* at
    its start and *key up* at its end. It has a fixed width because its length is
    the player's, not the patch's.
- **REQ-phase-widths-are-proportional-with-a-floor** — A, D and R share one linear
  time scale, so their widths compare truthfully. Each gets a floor of
  `ENV_GRAPH_MIN_PHASE` of the time width, so a 1 ms attack is still visible and
  labelled. The printed value is always the exact one.
- **REQ-the-copy-names-each-knob-as-a-time-or-a-level** — The list above the graph
  names each letter's kind of value (A *time*, D *time*, S *level*, R *time*) and
  its current setting. It also says each time is measured to ~95% of the way
  there.
- **REQ-the-filter-graph-speaks-in-hertz** — The FILTER ENV variant adds a caption
  that turns the shape into cutoff terms. It uses `filter.cutoff`,
  `filter.envAmount` and `midiToHz`: the base Hz, the peak Hz and the sustain Hz.
  - A negative `filter.envAmount` makes the caption say the sweep goes **down**.
  - At `0` it says the shape currently does nothing and names the ENV knob.
- **REQ-the-copy-covers-every-control-on-the-panel** — (v2) A badge explains its
  whole panel, not just the four ADSR knobs. FILTER ENV names **VEL**
  ([envelopes](envelopes.md) REQ-filter-env-follows-velocity), and each panel names
  its own **MULTI / SINGLE** switch and what that one decides
  ([voicing](voicing.md) REQ-single-trigger-legatos-a-mono-line). The filter's
  paragraph gives the musical reason for splitting the two: AMP at SINGLE over
  FILTER at MULTI keeps the level and re-sweeps every note.
- **REQ-the-graph-is-accessible-and-csp-safe** — The SVG is `role="img"` with an
  `aria-label` that spells out the four values. It is built with
  `createElementNS` and styled only through classes. No element carries a `style`
  attribute, because the shipped CSP has no `style-src 'unsafe-inline'`
  ([untrusted-input](untrusted-input.md) REQ-defence-in-depth-at-delivery).

## Technical design

### Contract / public interface

```ts
// src/utils/envelope-curve.ts (pure, DOM-free)
const MIN_PHASE_SECONDS: number                  // 0.001 — the shortest timed phase (Envelope's setters clamp to it too)
const PHASE_TIME_CONSTANTS: number               // 3 — a phase's knob time is three time constants
function phaseTau(seconds: number): number       // seconds / PHASE_TIME_CONSTANTS
function approach(v0, target, dt, tau): number   // the setTargetAtTime closed form
interface Adsr { attack: number; decay: number; sustain: number; release: number }
interface AdsrCurve {
  points: { t: number; v: number }[]            // sampled, t in seconds from key down
  attackEnd: number                              // the clamped attack — A's labelled span ends
  decayEnd: number                               // attack + decay — D's labelled span ends
  keyUp: number                                  // t where the release starts
  end: number                                    // keyUp + release — R's labelled span ends
}
function adsrCurve(env: Adsr, holdSeconds: number, samplesPerPhase?: number): AdsrCurve

// src/ui/onboarding/envelope-graph.ts — the drawing; knows no params, no bus, not which envelope
const ENV_GRAPH_MIN_PHASE: number                // floor share of the time width per A/D/R span
function phaseWidths(times: number[], total: number): number[]   // proportional, floored
interface EnvelopeGraphLabels {
  title: string                                  // "Amp envelope" — starts the aria-label
  axis: string                                   // "volume" / "cutoff" — the level axis
  values: Record<keyof Adsr, string>             // each knob's own formatted readout
}
function envelopeGraph(env: Adsr, labels: EnvelopeGraphLabels): SVGSVGElement

// src/ui/onboarding/help-widgets.ts — the copy; reads the bus, hands the graph its labels
function renderEnvelopeHelp(ctx: HelpContext, which: 'amp' | 'fil'): HTMLElement
```

The graph does not plot `t` linearly. Each phase is mapped onto its own x-range
(REQ-phase-widths-are-proportional-with-a-floor): attack is
`[0, attack]`, decay is `[attack, attack + decay]`, the hold is a fixed plateau,
and release is `[keyUp, keyUp + release]`. The curve keeps falling after R's
labelled span ends; that tail is not drawn, because the label marks where the knob's
value ends (~95% of the way to 0).

### Layer touchpoints & ordering

- `help-content.ts` `ampenv` / `filterenv` → `(ctx) => renderEnvelopeHelp(ctx, …)`.
- `renderEnvelopeHelp` holds everything that differs between the two envelopes
  (intro, per-knob wording, title, axis word) in one table, and passes the graph
  only an `Adsr` and its labels, so the drawing serves any envelope unchanged.
- `renderEnvelopeHelp` reads `env.<amp|fil>.*` (and, for the filter,
  `filter.cutoff` / `filter.envAmount`) through `ctx.bus` once, when the badge
  opens. It writes nothing.
- `src/audio/envelope.ts` computes its time constants and its `valueAt` with
  `phaseTau` / `approach`, and clamps its times to `MIN_PHASE_SECONDS`. That
  shared formula is the reason the drawing and the sound cannot drift apart.

### Persistence

None. It is display-only.

### Gesture inventory (ADR-014)

None. The graph is display-only: no hover, click or drag. The modal's own
dismiss gestures are unchanged.

## Scenarios (BDD)

```gherkin
Scenario: The amp graph labels the default envelope
  Given a bus with the default params
  When the ampenv help body renders
  Then it shows an SVG labelled A 5ms, D 200ms, S 80% and R 400ms
  And the copy names A, D and R as times and S as a level
# pinned by: tests/ui/envelope-help.test.ts

Scenario: The sustain line follows the sustain level
  Given env.amp.sustain is 0.25
  When the ampenv help body renders
  Then the sustain line sits a quarter of the way up the plot
# pinned by: tests/ui/envelope-help.test.ts

Scenario: The drawn curve is the engine's curve
  Given attack 0.3 s
  When the curve is sampled at t = attack
  Then it reads 1 − e⁻³, the value Envelope schedules there
  And the hold plateau sits at the sustain level and the release falls toward 0
# pinned by: tests/utils/envelope-curve.test.ts, tests/audio/envelope.test.ts

Scenario: A tiny attack is still visible (edge)
  Given env.amp.attack is 0.001 and env.amp.release is 6
  When the graph renders
  Then the attack span is at least ENV_GRAPH_MIN_PHASE of the time width
# pinned by: tests/ui/envelope-help.test.ts

Scenario: The filter graph speaks in Hz
  Given filter.cutoff and filter.envAmount at their defaults
  When the filterenv help body renders
  Then its caption names the base, peak and sustain cutoff in Hz
# pinned by: tests/ui/envelope-help.test.ts

Scenario: A zero or negative ENV is said plainly (edge)
  Given filter.envAmount is 0
  Then the caption says the shape currently does nothing to the cutoff
  And given filter.envAmount is -24 the caption says the sweep goes down
# pinned by: tests/ui/envelope-help.test.ts

Scenario: Every control on the panel is explained (REQ-the-copy-covers-every-control-on-the-panel)
  When the filterenv help body renders
  Then it names VEL and the MULTI / SINGLE switch
  And the ampenv body names its own MULTI / SINGLE switch, and not VEL
# pinned by: tests/ui/envelope-help.test.ts

Scenario: The graph is CSP-safe and labelled for assistive tech
  When either envelope help body renders
  Then no element in it carries a style attribute
  And the SVG is role="img" with an aria-label naming the four values
# pinned by: tests/ui/envelope-help.test.ts
```

## Tests & verification

- Unit: `tests/utils/envelope-curve.test.ts` (the pure model) and
  `tests/ui/envelope-help.test.ts` (the DOM, against a real `ParamBus`). Run with
  `npm test`.
- E2E: `e2e/envelope-help.spec.ts` opens both badges in the real app. Run with
  `npm run e2e`.
- The refactor of `Envelope`: `tests/audio/envelope.test.ts` stays green.
- Typecheck: `npm run typecheck`.
- Visual: `npm run dev`, turn the info badges on, then open AMP ENV ⓘ and FILTER
  ENV ⓘ. Try the defaults, a pad (A 2 s, S 100%), a pluck (A 1 ms, S 0) and a
  negative filter ENV.

## Open questions / future

- `filter.velAmount` scales the filter envelope's peak. The copy says so
  (REQ-the-copy-covers-every-control-on-the-panel), but the graph still draws the
  full-velocity shape.
- With a negative `filter.envAmount`, the graph still rises. It draws the
  envelope, and the caption says the cutoff moves down. Flipping the plot, or
  labelling its axis in Hz, would show the direction in the drawing as well.
- The width floor makes a 1 ms attack look like a short ramp rather than a
  vertical edge. Its label says `1ms`, so the number is still right.
