# Signal-flow map

```yaml
id: signal-flow-map
status: implemented
version: 1
owner: core
related:
  - architecture          # "Audio graph" — the source of truth the poster illustrates
  - onboarding            # REQ-about-is-the-single-door-for-help — the map's door
  - info-badges           # a help topic's "Show in the signal flow" — the other door
  - lazy-load-failure     # REQ-every-lazy-trigger-reports
  - untrusted-input       # REQ-defence-in-depth-at-delivery — why the SVG is CSP-safe
  - ui-themes             # colorScheme picks the poster
  - ui-scale              # pointer coordinates
  - input-control         # a focused control consumes the keys it handles
  - runtime-performance   # REQ-boot-cost-matches-the-request
  - iconography
source:
  - src/ui/signal-flow/camera.ts
  - src/ui/signal-flow/zones.ts
  - src/ui/signal-flow/signal-flow-map.ts
  - src/ui/signal-flow/signal-flow-modal.ts
  - src/ui/signal-flow/open.ts           # the one lazy opener both doors call
  - src/ui/signal-flow/help-links.ts     # help topic -> blocks / zones
  - src/ui/onboarding/info-badges.ts     # the help topic's button
  - src/ui/styles/signal-flow.module.css
  - src/ui/components/about-modal.ts     # the About door
  - scripts/diagram/signal-flow.mjs      # the posters and the zone manifest
  - scripts/diagram/signal-flow/         # its parts; layout.mjs is the poster
  - docs/signal-flow-zones.json          # generated
```

The illustrated signal-flow poster of the whole instrument, inside the app: a
fullscreen dialog that opens on the whole poster and zooms into an area when you
pick it, with a panel that says what you are looking at and a Prev / Next walk
that follows the signal from the keys to the speakers. A help topic about part
of the instrument opens it at that part, with the block ringed.

## Background / Why

`scripts/diagram/signal-flow.mjs` draws a one-sheet poster of every path through
the instrument (`docs/signal-flow-light.svg`, `docs/signal-flow-dark.svg`), made
for the README and for print. At poster size its text is a few px on a screen,
so in the app it needs a way in: areas you can pick, a zoom that makes the text
readable, and a sentence per area for orientation. The poster and the map are
the same files — the generator also writes the zone manifest, from the same
layout values that draw each area — so the app never draws a second version of
the diagram, and the viewer knows nothing about synths.

## Requirements

- **REQ-the-map-is-the-poster** — The map shows `docs/signal-flow-light.svg` or
  `docs/signal-flow-dark.svg`, unmodified, inlined into the dialog. Its clickable
  areas come from `docs/signal-flow-zones.json`, which the same generator run
  writes; nothing in `src/` restates a coordinate, a title or a blurb. The
  manifest also lists every drawn block as a **spot** (its layout id, title,
  box and the leaf zone it sits in), taken from the blocks themselves. The
  posters print `package.json`'s version, so `npm run release` redraws them
  with the bump (before its build), and `tests/signal-flow/assets.test.ts`
  fails a committed poster that differs from a fresh draw.
- **REQ-the-poster-is-csp-safe** — Both posters carry no `<style>` element, no
  `style=""` attribute and no external reference, and every `id` starts `sf-`:
  the shipped policy drops inline styles (untrusted-input.md
  REQ-defence-in-depth-at-delivery), and the inlined ids share the page's id
  space. The generator throws rather than write a file that breaks this, and
  `tests/signal-flow/assets.test.ts` checks the committed files. The SVG
  text is a constant bundled with the app, not an ingest surface — `DOMParser`
  here reads our own build output.
- **REQ-the-poster-follows-the-theme-scheme** — A theme whose `colorScheme` is
  `light` shows the light poster; every other theme the dark one. Only the
  chosen poster is downloaded. The dialog's own chrome (panel, buttons, hotspot
  outlines) uses theme tokens.
- **REQ-the-map-opens-on-the-overview** — It opens with the whole poster fitted
  to the stage, the top-level areas outlined and labelled, and the panel showing
  the manifest's `intro` and a button per area.
- **REQ-picking-an-area-zooms-to-it** — Clicking or tapping an outlined area, or
  its button in the panel, animates the view to fit that zone, and the panel
  shows its breadcrumb, title and blurb. The hotspots become that zone's
  children; a zone without children offers its siblings instead, so a neighbour
  is one click away.
- **REQ-next-follows-the-signal** — Prev / Next walk the manifest's `tour`. From
  the overview, Next is the first stop; from the first stop, Prev is the
  overview; from an area that is not a stop, Next is its first stop. The panel
  counts the stop ("6 / 23").
- **REQ-the-map-can-be-explored-freely** — Drag pans; the wheel and a trackpad
  pinch zoom about the pointer; two fingers pinch-zoom; a double click or double
  tap off the outlined areas zooms in 2× at the point; the stage's + / − / fit buttons and the keyboard
  do the same (gesture inventory). The view never zooms out past the whole
  poster, never closer than `MAX_PX_PER_UNIT` screen px per poster unit, and its
  centre stays on the poster. Free exploring keeps the panel's area: the panel
  describes what was picked, not what is under the view.
- **REQ-escape-steps-out-before-it-closes** — Escape with an area picked goes up
  one level — to its parent, or the overview — and only closes the dialog from
  the overview. The ✕ always closes (an icon means one thing, ADR-014); a press
  beside the near-fullscreen card does not.
- **REQ-a-help-topic-shows-its-place** — A help topic about something on the
  signal path carries a **Show in the signal flow** button (testid
  `help-signal-flow`), above its Close. It closes the topic and opens the map
  at the topic's link: a list of spot and zone ids in `SIGNAL_FLOW_LINKS`. The
  view frames the innermost zone holding all of them and rings each spot; the
  panel names the ringed blocks. The rings go with the next pick. A topic that
  is about the app rather than the sound (files, presets, demos, Panic,
  Settings) has no link and no button. Every link must name ids that exist and
  land on an area, never the bare overview —
  `tests/signal-flow/help-links.test.ts` checks the table against the manifest.
- **REQ-the-map-costs-nothing-until-opened** — Nothing of the map is in the entry
  chunk: both doors go through `openSignalFlow` (`open.ts`), which
  `import()`s the dialog — a second request while one is still loading is the
  same open, never a second map — and the dialog `import()`s one
  poster, each through `loadSurface` (lazy-load-failure.md
  REQ-every-lazy-trigger-reports). It is not idle-warmed: two posters of
  ~210 kB are not worth fetching for every visit; a saved offline copy has them.
  While open, animation frames run only during a zoom animation; an idle map
  does no work. `prefers-reduced-motion` jumps instead of animating.

## Technical design

### Contract / public interface

```yaml
src/ui/signal-flow/camera.ts:            # pure, no DOM
  Rect / View: { x, y, w, h }            # poster units
  fitRect(r, stage, pad?): View          # r whole and centred, at the stage's aspect
  zoomAt(v, factor, px, py): View        # (px, py) stays put on screen
  panBy(v, dx, dy): View
  reshape(v, from, to): View             # stage resized: same centre, same scale
  clampView(v, bounds, stage): View      # REQ-the-map-can-be-explored-freely's limits
  lerpView(a, b, t): View                # geometric size, linear centre
  ease(t): number
  MAX_PX_PER_UNIT: 3
src/ui/signal-flow/zones.ts:             # pure walks over the manifest
  ZoneManifest: { width, height, intro, zones: Zone[], tour: string[], spots: Spot[] }
  Zone: { id, title, blurb, x, y, w, h, parent? }
  Spot: { id, title, zone, x, y, w, h }
  zoneById / childrenOf / ancestors / hotspotsFor / tourStep / tourIndex
  resolveLink(m, ids): { zone, spots } | null   # REQ-a-help-topic-shows-its-place
src/ui/signal-flow/signal-flow-map.ts:
  new SignalFlowMap({ svgText, manifest })
  .root: HTMLElement                     # stage + panel
  .focus(id | null): void                # null = the overview
  .show(ids): boolean                    # a deep link; false when none of ids is on the poster
  .focused: string | null
  .stepOut(): boolean                    # false at the overview (Escape closes then)
  .dispose(): void
src/ui/signal-flow/open.ts:
  openSignalFlow(link?): Promise<void>   # the lazy door: About, and help topics with a link
src/ui/signal-flow/signal-flow-modal.ts:
  showSignalFlow(retry, link?): Promise<void>   # loads the poster for the theme, opens the dialog
src/ui/signal-flow/help-links.ts:
  SIGNAL_FLOW_LINKS: Partial<Record<TopicId, string[]>>   # spot / zone ids per help topic
```

### Gesture inventory — the map stage (ADR-014)

| Gesture | Outcome | Precedent |
| --- | --- | --- |
| click / tap an outlined area | zoom to it (a press under the 6 px slop) | map apps, the poster's own regions |
| drag | pan | every map |
| wheel / trackpad pinch | zoom about the pointer, by how far the wheel moved — a continuous zoom, not a stepped value, so not [wheel-steps](wheel-steps.md)'s stepper | every map |
| two-finger pinch | zoom about the fingers' midpoint | every map on touch |
| double click / double tap where no area is outlined (e.g. inside the area you are on) | zoom in 2× at the point; on an outlined area each click picks, so a double click picks an area and then the part under the pointer | every map |
| + / − / fit buttons | zoom about the centre; fit returns to the picked area (or the overview) | map zoom controls |
| `←` `↑` `→` `↓` | pan a tenth of the view | map apps |
| `+` / `=`, `−` / `_` | zoom about the centre | browser zoom keys |
| `Home` | the overview | — |
| any key with Ctrl / Cmd / Alt | — the browser's (page zoom, Back); the map takes no modified key | input-control.md |
| `Escape` | up one level; closes from the overview (REQ-escape-steps-out-before-it-closes) | Modal's Escape |
| long-press / right-click | — the map has no third job | — |

### Layer touchpoints & ordering

```yaml
about-modal.ts: card children -> [..., tourBtn, flowBtn, ...]   # factory-reset.md "Layer touchpoints"
  flowBtn click -> close About -> openSignalFlow()
info-badges.ts openTopic(id): SIGNAL_FLOW_LINKS[id]? -> "Show in the signal flow" -> close topic -> openSignalFlow(link)
open.ts: loadSurface(import signal-flow-modal) -> showSignalFlow(retry, link)
signal-flow-modal.ts:
  scheme = themeInfo(<html data-theme>).colorScheme
  loadSurface(import docs/signal-flow-<scheme>.svg?raw) -> new Modal({ beforeClose: () => closeAsked || !map.stepOut() })
signal-flow-map.ts:
  DOMParser(svgText) -> importNode -> stage; ring <g> then hotspot <g> appended inside the poster svg
  view -> svg viewBox (one write per frame); hotspot labels counter-scaled to a fixed screen size
```

### Data shapes

```yaml
docs/signal-flow-zones.json:             # written by npm run docs:diagram
  width: 7300
  height: 3760
  intro: string
  zones: [{ id, title, blurb, x, y, w, h, parent? }]   # a child lies inside its parent
  tour: [zone id]                        # leaf zones, signal order
  spots: [{ id, title, zone, x, y, w, h }]   # every drawn block; zone = the leaf holding its centre
```

### Persistence

None. The map opens on the overview, or at a help topic's link.

## Scenarios (BDD)

```gherkin
Scenario: The committed posters stay inside the CSP (REQ-the-poster-is-csp-safe)
  Given docs/signal-flow-light.svg and docs/signal-flow-dark.svg
  Then neither has a <style> element, a style attribute or an external href
  And every id starts with sf-
  And the generator still writes exactly the committed zone manifest
# pinned by: tests/signal-flow/assets.test.ts

Scenario: Opening shows the overview (REQ-the-map-opens-on-the-overview)
  Given the map mounted from a poster and its manifest
  Then the hotspots are the top-level areas and the panel shows the intro
# pinned by: tests/ui/signal-flow-map.test.ts

Scenario: Picking an area zooms to it (REQ-picking-an-area-zooms-to-it)
  Given the map at the overview
  When the Machines area is picked, then the Synth voice inside it
  Then the panel's title is "Synth voice" and its breadcrumb runs Overview › Machines & sound sources › Synth
  And the hotspots are the voice's siblings
# pinned by: tests/ui/signal-flow-map.test.ts, e2e/signal-flow.spec.ts

Scenario: Next follows the signal (REQ-next-follows-the-signal)
  Given the map at the overview
  When Next is pressed twice
  Then the second tour stop is picked and Prev returns to the first
# pinned by: tests/signal-flow/zones.test.ts, tests/ui/signal-flow-map.test.ts

Scenario: Escape steps out first (REQ-escape-steps-out-before-it-closes)
  Given the Synth voice picked
  When Escape is pressed three times
  Then the map goes to Synth, then Machines & sound sources, then the overview, and the dialog is still open
  When Escape is pressed again
  Then the dialog closes
# pinned by: tests/ui/signal-flow-map.test.ts, e2e/signal-flow.spec.ts

Scenario: The view keeps its limits (REQ-the-map-can-be-explored-freely)
  Given any view
  Then zooming out stops at the whole poster, zooming in stops at MAX_PX_PER_UNIT, and the centre stays on the poster
# pinned by: tests/signal-flow/camera.test.ts

Scenario: A drag pans and is not a tap; two fingers pinch-zoom (REQ-the-map-can-be-explored-freely)
  Given the Synth voice picked
  When the stage is dragged, or pinched apart to twice the finger distance
  Then the view moves (and the pick stays Synth voice), or its width halves
# pinned by: tests/ui/signal-flow-map.test.ts

Scenario: A help topic shows its place (REQ-a-help-topic-shows-its-place)
  Given the info badges on
  When the Filter topic's "Show in the signal flow" is pressed
  Then the topic closes, the map frames Synth voice, the FILTER block is ringed and the panel says "Ringed: FILTER"
  And a topic about the app (Panic) offers no such button
# pinned by: e2e/signal-flow.spec.ts, tests/ui/signal-flow-map.test.ts

Scenario: Every link lands somewhere real (REQ-a-help-topic-shows-its-place)
  Given SIGNAL_FLOW_LINKS and the shipped manifest
  Then every id names a spot or a zone, and every link frames an area, not the overview
# pinned by: tests/signal-flow/help-links.test.ts, tests/signal-flow/zones.test.ts

Scenario: It reads and moves well (REQ-the-map-can-be-explored-freely)
  Given the map open in Firefox and Chrome, at UI scale 100 % and 150 %, a dark and the Light theme, and a phone width
  Then zooms animate smoothly, drag / wheel / pinch track the pointer, and the zoomed text is crisp
# not automated — perceived, checked by hand
```

## Tests & verification

- `tests/signal-flow/camera.test.ts`, `tests/signal-flow/zones.test.ts`,
  `tests/signal-flow/help-links.test.ts`, `tests/signal-flow/assets.test.ts`
  (node), `tests/ui/signal-flow-map.test.ts` and `tests/ui/signal-flow-open.test.ts`
  (jsdom) — `npm test`.
- `e2e/signal-flow.spec.ts` — `npm run e2e`.
- The shipped CSP: `npm run build && npx vite preview`, open the map, and see
  styled text with no `securitypolicyviolation` (`vite dev` relaxes the policy).

## Open questions / future

- A deep link from places other than help topics (a panel's own header, the
  FX slot picker) would reuse `openSignalFlow(link)` unchanged.
