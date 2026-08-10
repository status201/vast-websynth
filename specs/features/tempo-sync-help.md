# Tempo-sync & relationship help badges

```yaml
id: tempo-sync-help
status: implemented
version: 2   # v2: the divisions module moved to src/utils/tempo.ts and now
             #     drives a real tempo lock on the LFO (lfo.md REQ-9)
owner: ui/onboarding
related:
  - architecture
  - performance-mode        # both live under ui/onboarding chrome
source:
  - src/utils/tempo.ts                  # the pure math (moved out of ui/ for lfo.md REQ-9)
  - src/ui/onboarding/help-widgets.ts
  - src/ui/onboarding/help-content.ts
  - src/ui/onboarding/info-badges.ts
  - src/ui/onboarding/index.ts
```

## Background / Why

Dialling a delay (or an LFO / phaser / wah rate) so it sits *in time* with the
song used to mean doing the math by ear: a delay in sync with 120 BPM wants
~375 ms (dotted-eighth), ~250 ms (eighth), etc. Nothing surfaced those values.
This feature turns the existing ⓘ info badges on the relevant knobs into
**live, BPM-aware helpers**: a "sweet spots" list of musical note divisions with
their millisecond (delay) or Hz (rate) value at the *current* tempo, where
**clicking a value snaps the knob to it**. The same dynamic-body mechanism also
powers a first set of **mutual-dependency** explainer badges (filter cutoff↔
resonance↔envelope, unison voices↔detune, compressor threshold↔ratio↔makeup)
that show a live derived number instead of static prose.

It is advisory only — there is **no** new tempo-sync mode; the knobs stay free,
the badge just recommends/sets a plain value (delay maps its `time` param 1:1 to
`DelayNode.delayTime`).

## Requirements

- **REQ-1** — A pure, DOM-free module computes note divisions → seconds/Hz for a
  BPM: straight, dotted (×1½) and triplet (×⅔) from 1/1 down to 1/32.
- **REQ-2** — A tempo-sync badge lists only the divisions whose value falls in
  the target knob's `[min,max]` range, sorted ascending by the shown quantity.
- **REQ-3** — Delay-time badges show milliseconds (seconds ≥ 1 s shown as `s`);
  rate badges (LFO/wah/phaser) show Hz. The value reflects the **current**
  `transport.bpm` each time the badge is opened.
- **REQ-4** — Clicking a listed division sets the target param via `bus.set` and
  closes the modal. The row nearest the current value is marked (global `.on`).
- **REQ-5** — Help-topic bodies may be a **function** `(ctx: HelpContext) => Node`
  as well as a static HTML string; `HelpContext = { bus, close }`. Static bodies
  keep working unchanged.
- **REQ-6** — `InfoBadges` receives the `ParamBus` (from `createOnboarding`) and
  passes it to the topic body when it is a function.
- **REQ-7** — Tempo badges pin to `knob-<paramId>` for: `fx.delay.time`,
  `fx.drum.delay.time`, `fx.sampler.delay.time` (time); `lfo.rate`,
  `fx.wah.rate`, `fx.phaser.rate`, `fx.drum.phaser.rate`, `fx.sampler.phaser.rate`
  (freq). A knob absent from the DOM (unbuilt tab) simply shows no badge.
- **REQ-8** — Relationship badges show live derived numbers: `filter.cutoff`
  (cutoff Hz + self-oscillation note), `filter.resonance`, `filter.envAmount`
  (sweep top Hz = note→Hz of cutoff+env), `unison.detune` (spread in cents; no
  effect at 1 voice), `fx.master.comp.threshold` + `fx.drum.comp.threshold`
  (threshold/ratio/makeup interplay). These are display-only (no click-to-snap).

## Technical design

### Contract / public interface

```ts
// tempo-sync.ts (pure)
interface Division { label: string; beats: number }          // beats = quarter notes
interface SweetSpot { label: string; beats: number; seconds: number; hz: number }
type TempoQuantity = 'time' | 'freq'
const DIVISIONS: Division[]
function sweetSpots(bpm: number): SweetSpot[]                 // beat = 60/bpm
function sweetSpotsInRange(bpm, min, max, q: TempoQuantity): SweetSpot[]
function noteToHz(note: number): number                      // 440·2^((n-69)/12)

// help-content.ts
interface HelpContext { bus: ParamBus; close: () => void }
interface HelpTopic { title: string; body: string | ((ctx: HelpContext) => Node) }

// help-widgets.ts (DOM)
function renderTempoSync(ctx, paramId, q: TempoQuantity): HTMLElement
// + renderFilterCutoff / renderFilterResonance / renderFilterEnvAmount /
//   renderUnisonDetune / renderCompThreshold(prefix)
```

### Data shapes

```yaml
SweetSpot:
  label: string     # "1/8", "1/8 D", "1/4 T"
  beats: number     # length in quarter-note beats
  seconds: number   # beats * 60/bpm  (a delay time / one LFO cycle)
  hz: number        # 1 / seconds     (the matching rate)
```

### Layer touchpoints & ordering

`createOnboarding(ctx)` builds `new InfoBadges(ctx.bus)` — `TourCtx` already
carries `bus`. `InfoBadges.openTopic` appends `body(ctx)` when the body is a
function, else sets `innerHTML` (unchanged path). New anchors are appended to
`ANCHORS`; they reposition/hide via the existing reflow path (ResizeObserver +
resize/scroll), exactly like the Song per-button badges, so tab-switched knobs
(drum/sampler/song panels) get their badge when their panel lays out.

### Persistence

None. Nothing here is a `ParamBus` param; the helper reads live `transport.bpm`
and the target param on demand and writes only through `bus.set` on click.

## Scenarios (BDD)

```gherkin
Scenario: Delay sweet spots at 120 BPM
  Given transport.bpm is 120
  When the fx.delay.time help badge renders
  Then it lists 1/4 = 500 ms and 1/8 D = 375 ms among the divisions in range
# pinned by: tests/ui/tempo-sync.test.ts

Scenario: Clicking a division snaps the knob
  Given the fx.delay.time sweet-spots list is shown at 120 BPM
  When the user clicks the "1/8" row
  Then bus.get('fx.delay.time') becomes 0.25 and the modal closes
# pinned by: tests/ui/tempo-sync.test.ts

Scenario: Range filtering
  Given a delay time range of [0.01, 1.5] s at 120 BPM
  When divisions are filtered
  Then 1/1 (2.0 s) is excluded and 1/32 (62.5 ms) is included
# pinned by: tests/ui/tempo-sync.test.ts

Scenario: Rate badge shows Hz
  Given transport.bpm is 120 and the lfo.rate badge (freq)
  Then 1/4 is listed as 2.00 Hz
# pinned by: tests/ui/tempo-sync.test.ts

Scenario: End-to-end click-to-snap in the browser
  Given the info badges are on and transport.bpm is 120
  When the user opens the Delay Time badge and clicks the "1/8" row
  Then the dialog lists 375 ms + 500 ms, closes, and fx.delay.time is 0.25;
    reopening after setting 90 BPM shows 333 ms
# pinned by: e2e/tempo-sync.spec.ts
```

## Tests & verification

- Unit: `tests/ui/tempo-sync.test.ts` — pure math + `renderTempoSync` DOM/click
  against a real `ParamBus` (`registerDefaults`). `npm test`
- E2E: `e2e/tempo-sync.spec.ts` — info badges on → Delay Time badge lists the live
  ms values, click-to-snap sets `fx.delay.time`, reopen after a BPM change
  refreshes. `npm run e2e`
- Typecheck: `npm run typecheck`
- Manual: set BPM, toggle Help, open the Delay TIME (i), click a value → knob
  snaps; change BPM and reopen → values refresh; spot-check a rate + a
  relationship badge. `npm run dev`

## Open questions / future

- **Done for the LFO** (`lfo.sync`, [lfo](lfo.md) REQ-9): the divisions helper is
  now a real tempo lock there, not just advice. Doing it moved the module from
  `src/ui/onboarding/tempo-sync.ts` to `src/utils/tempo.ts` — the audio layer may
  not import from `src/ui/` (architecture REQ-1, ADR-001), and that import rule is
  what had kept the math advisory. The badges are unchanged and still read from
  the same table, so the recommendation and the lock cannot disagree.
- The same promotion is still open for the **delay times** and the phaser/wah
  rates; those knobs stay free-valued and advisory.
- Relationship badges are display-only for now; some (e.g. env sweep target)
  could gain click-to-set presets.
