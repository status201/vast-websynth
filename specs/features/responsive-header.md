# Responsive header (mobile menu)

```yaml
id: responsive-header
status: active
version: 1
owner: ui
related:
  - architecture
  - performance-mode
source:
  - src/ui/app.ts                      # buildHeader: hamburger toggle + preset cluster
  - src/ui/styles/layout.module.css    # .menuToggle / .presetGroup / .menuOpen rules
```

## Background / Why

The header is a single sticky flex row holding four clusters: brand, the preset
cluster (`Preset:` + preset dropdown + **Save / Perf / About / Help**), the
transport cluster (Play / BPM / Swing) and the voicing cluster (Mono-Poly /
Panic / Vol). On a phone (~390px) the preset cluster alone is wider than the
viewport, so it was clipped by the page's `overflow-x: hidden`. Simply letting
it wrap fixes the clipping but adds a permanent extra row to a **sticky** header,
stealing vertical space from the synth. Instead, below a phone breakpoint the
preset cluster collapses behind a mobile-style hamburger (☰) and expands inline
only on demand. Wider screens are unchanged.

## Requirements

- **REQ-1** — Below **720px** the preset cluster is hidden by default and a ☰
  toggle button is shown, parked at the top-right of the header's first row.
- **REQ-2** — Tapping ☰ expands the preset cluster **inline** as its own
  full-width header row; tapping again hides it. The button's `aria-expanded`
  reflects the open state, and it shows a visible active (gold "on") style while
  the menu is open.
- **REQ-3** — At **≥721px** there is no hamburger and the preset cluster is shown
  inline (desktop/tablet behaviour unchanged). Crossing the breakpoint needs no
  JS: the CSS shows the cluster / hides the toggle regardless of the open class.
- **REQ-4** — Only the preset cluster collapses. The transport cluster
  (Play/BPM/Swing) and the voicing cluster (Mono-Poly/Panic/Vol) stay visible at
  every width.

## Technical design

### Contract / public interface

No new module. `buildHeader` (`src/ui/app.ts`) builds the toggle with the shared
`createButton` factory (`ui/components/button.ts`) and toggles a module class on
the header element via `classList.toggle` (the same convention as the Play
button). The preset cluster carries a distinct `presetGroup` hook class in
addition to the shared `headerGroup` class.

- Toggle button: `data-testid="header-menu"`, label `☰`, `aria-label="Toggle
  preset menu"`, `aria-expanded` kept in sync.
- DOM order in the header: `brand, menuToggle, presetGroup, spacer, transport,
  right`. The toggle sits right after `brand` so, on a narrow screen, CSS
  `margin-left: auto` parks it at the right end of the first wrapped line.

### Layer touchpoints & ordering

- `src/ui/app.ts` — adds the toggle + `presetGroup` class; all other header
  construction unchanged.
- `src/ui/styles/layout.module.css` — `.menuToggle { display: none }` by
  default; an `@media (max-width: 720px)` block (placed **after** the existing
  `≤992px` block so it wins at narrow widths) shows the toggle, hides
  `.presetGroup`, and reveals it via `.header.menuOpen .presetGroup { display:
  flex; flex-basis: 100% }`. The `≤992px` `.headerGroup { flex-wrap: wrap }` rule
  is retained so the revealed cluster wraps its buttons.

### Persistence

None. The open/closed state is transient in-DOM only; it deliberately does **not**
persist (unlike the `createCollapseToggle` panels). Each load starts collapsed
on a narrow screen.

## Scenarios (BDD)

```gherkin
Scenario: Preset cluster collapsed by default on a phone
  Given the app is open at a 390px-wide viewport
  Then the header menu toggle (☰) is visible
  And the preset selector is hidden
  And the Play transport button is visible

Scenario: Hamburger expands the preset cluster inline
  Given the app is open at a 390px-wide viewport
  When I click the header menu toggle
  Then the preset selector becomes visible

Scenario: No hamburger on a wide screen
  Given the app is open at a 1280px-wide viewport
  Then the header menu toggle is hidden
  And the preset selector is visible
# pinned by: e2e/responsive-header.spec.ts
```

## Tests & verification

- E2E: `e2e/responsive-header.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Manual: dev server at a 390px viewport — collapse/expand round-trip; widen
  past 720px to confirm the inline cluster returns and the toggle disappears.

## Open questions / future

- Auto-close the menu after a preset is chosen (currently the user closes it with
  the toggle).
- If the transport/voicing clusters ever outgrow the phone width, they could fold
  into the same menu.
