# Responsive header (mobile menu)

```yaml
id: responsive-header
status: implemented
version: 3
owner: ui
related:
  - architecture
  - performance-mode
  - dropdown
source:
  - src/ui/app.ts                      # buildHeader: hamburger toggle + preset cluster
  - src/ui/styles/layout.module.css    # .menuToggle / .presetGroup / .menuOpen rules
  - src/ui/components/header-icons.ts  # inline-SVG glyphs for the utility buttons
  - src/ui/components/button.ts        # createButton icon/title/ariaLabel options
  - src/ui/styles/switch.module.css    # svg.hdr-icon sizing/stroke rules
```

## Background / Why

The header is a single sticky flex row holding four clusters: brand, the preset
cluster (`Preset:` + preset dropdown + the utility buttons **Save / Perf /
About / Help / Full**), the transport cluster (Play / BPM / Swing) and the
voicing cluster (Mono-Poly / Panic / Vol). On a phone (~390px) the preset
cluster alone is wider than the viewport, so it was clipped by the page's
`overflow-x: hidden`. Simply letting it wrap fixes the clipping but adds a
permanent extra row to a **sticky** header, stealing vertical space from the
synth. Instead, below a phone breakpoint the preset cluster collapses behind a
mobile-style hamburger (☰) and expands inline only on demand. Wider screens are
unchanged.

Even on desktop the cluster grew crowded as buttons accrued (v2): the five
utility buttons are now compact **icon buttons** — inline SVG glyphs in the
synth's `currentColor` style (the `wave-icons.ts` precedent) — each with a
descriptive `title` tooltip and an `aria-label`, with fullscreen moved to the
end of the row.

## Requirements

- **REQ-1** — Below **720px** the preset cluster is hidden by default and a ☰
  toggle button is shown, parked at the **far right** of the header's first row
  (the brand row): the REQ-9 line break keeps the transport cluster off that
  row, so the toggle's `margin-left: auto` has the whole first row's free
  space to absorb.
- **REQ-2** — Tapping ☰ expands the preset cluster **inline** as its own
  full-width header row; tapping again hides it. The button's `aria-expanded`
  reflects the open state, and it shows a visible active (gold "on") style while
  the menu is open.
- **REQ-3** — At **≥721px** there is no hamburger and the preset cluster is shown
  inline (desktop/tablet behaviour unchanged). Crossing the breakpoint needs no
  JS: the CSS shows the cluster / hides the toggle regardless of the open class.
- **REQ-4** — Only the preset cluster collapses. The transport cluster
  (Play/BPM/Swing) and the voicing cluster (Mono-Poly/Panic/Vol) stay visible at
  every width; whenever the header wraps they sit on the row **below** the
  first row (REQ-9) instead of crowding it.
- **REQ-5** — The cluster's utility buttons are **icon-only**: Save (floppy),
  Perf (gauge), About (ⓘ), Help (?-in-circle), Fullscreen (expand corners,
  swapping to compress corners while fullscreen), appended **in that order** —
  fullscreen last, still omitted entirely where `document.fullscreenEnabled`
  is false. Icons are inline SVG strings coloured via CSS `currentColor`
  (never Unicode emoji, which render coloured on some platforms), so the Perf
  button's tier classes tint its glyph automatically.
- **REQ-6** — Every icon button carries a descriptive `title` (hover tooltip)
  **and** an `aria-label`, so accessible names survive the loss of text labels
  (`createButton` defaults `aria-label` to the `label` option when an icon is
  set). Stable testids: `preset-save`, `perf-settings`, `about-button`,
  `help-button`, `fullscreen`.
- **REQ-7** — The header must never clip content off the right edge at any
  width. Its clusters' combined min-content width (~1140px) exceeds the
  viewport well before the 992px reflow, so from **≤1140px** the header row
  wraps (`flex-wrap`, spacer hidden) instead of overflowing — otherwise the
  page's `overflow-x: hidden` cuts off the voicing cluster *and*, because the
  over-wide header widens the single `.app` grid column, the `.main` panel
  grid's right column (MIXER) with it.
- **REQ-8** — From **≤1140px** the `Preset:` text label is hidden to save
  header width; the preset dropdown and the utility icon buttons remain. At
  ≥1141px the label shows as before.
- **REQ-9** — From **≤1140px** (the wrap step) the header is a deterministic
  two-row layout: a zero-height line-break element before the transport
  cluster forces it to **lead the second row** (far left), and the voicing
  cluster right-aligns on that row via `margin-left: auto`. Row 1 holds the
  brand + preset cluster (or brand + ☰ below 720px).

## Technical design

### Contract / public interface

No new module. `buildHeader` (`src/ui/app.ts`) builds the toggle with the shared
`createButton` factory (`ui/components/button.ts`) and toggles a module class on
the header element via `classList.toggle` (the same convention as the Play
button). The preset cluster carries a distinct `presetGroup` hook class in
addition to the shared `headerGroup` class.

- Toggle button: `data-testid="header-menu"`, label `☰`, `aria-label="Toggle
  preset menu"`, `aria-expanded` kept in sync.
- DOM order in the header: `brand, menuToggle, presetGroup, spacer,
  headerBreak, transport, right`. The toggle sits right after `brand` so, on a
  narrow screen, CSS `margin-left: auto` parks it at the right end of the
  first wrapped line. `headerBreak` is an empty `div` (`display: none` by
  default); at ≤1140px it becomes a zero-height `flex-basis: 100%` item, so
  the transport cluster always starts the second flex line (REQ-9), the
  voicing cluster (`voicingGroup` hook class, `margin-left: auto`) right-aligns
  on it, and below 720px the toggle's auto margin claims the whole first row
  (REQ-1/REQ-4). With the menu open the expanded preset cluster (its own
  `flex-basis: 100%` row) sits between the brand row and the transport row.
- The `Preset:` label span carries the `presetLabel` module class, hidden in
  the ≤1140px media block (REQ-8).
- Icon buttons (REQ-5/6): `createButton` grows optional `icon` (inline SVG
  markup rendered instead of the text label), `title`, and `ariaLabel` options;
  `setButtonIcon` is the icon counterpart of `setButtonLabel` (used by the
  fullscreen expand↔compress swap on `fullscreenchange`). The glyph strings
  live in `src/ui/components/header-icons.ts` (`HEADER_ICONS`), modeled on
  `wave-icons.ts`: `class="hdr-icon"`, `aria-hidden="true"`, no inline colour.
  `switch.module.css` sizes/strokes `svg.hdr-icon` inside any switch-styled
  button (`stroke: currentColor; fill: none`, with a `.fill` escape hatch for
  solid dots).

### Layer touchpoints & ordering

- `src/ui/app.ts` — adds the toggle + `presetGroup` class; all other header
  construction unchanged.
- `src/ui/styles/layout.module.css` — `.menuToggle { display: none }` and
  `.headerBreak { display: none }` by default; an `@media (max-width: 720px)`
  block (placed **after** the existing `≤992px` block so it wins at narrow
  widths) shows the toggle, hides `.presetGroup`, and reveals it via
  `.header.menuOpen .presetGroup { display: flex; flex-basis: 100% }`. The
  `≤1140px` block (REQ-7) holds the header/cluster `flex-wrap: wrap` rules,
  `.presetLabel { display: none }` (REQ-8), and the two-row layout (REQ-9):
  `.headerBreak { display: block; flex-basis: 100%; height: 0 }` +
  `.voicingGroup { margin-left: auto }` — so the revealed cluster wraps its
  buttons at every narrower width; the `≤992px` block keeps only the tighter
  gap/padding. Breakpoint cascade order in the file: 1280 → 1140 → 992 → 720.
- `src/styles/layout.css` — the `.app` grid's first row is a fixed `80px`
  track; a matching `≤1140px` block relaxes it to `auto` (all-auto rows), or
  the wrapped second header row would paint *over* the panel grid instead of
  pushing it down. Any width at which the header can wrap must also have the
  auto row track.

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

Scenario: Hamburger far right, transport on the row below
  Given the app is open at a 390px-wide viewport
  Then the menu toggle sits at the far right edge of the header
  And the Play transport button sits on a row below the toggle
# pinned by: e2e/responsive-header.spec.ts

Scenario: Preset label hidden below the 1140px wrap step
  Given the app is open at a 1024px-wide viewport
  Then the "Preset:" text label is hidden
  And the preset selector remains visible
# pinned by: e2e/responsive-header.spec.ts

Scenario: Two-row layout below the 1140px wrap step
  Given the app is open at a 1024px-wide viewport
  Then the Play transport button leads the second row at the far left
  And the voicing cluster (Panic / master volume) sits at the far right of that row
# pinned by: e2e/responsive-header.spec.ts

Scenario: Hamburger expands the preset cluster inline
  Given the app is open at a 390px-wide viewport
  When I click the header menu toggle
  Then the preset selector becomes visible

Scenario: No hamburger on a wide screen
  Given the app is open at a 1280px-wide viewport
  Then the header menu toggle is hidden
  And the preset selector is visible
# pinned by: e2e/responsive-header.spec.ts

Scenario: No right-edge clipping in the 993-1140px dead zone
  Given the app is open at a 1024px-wide viewport (iPad Pro)
  Then neither the page nor the header overflows horizontally
  And the Panic button and master volume knob are fully within the viewport
  And the MIXER panel is visible
# pinned by: e2e/responsive-header.spec.ts

Scenario: Utility buttons are icon buttons with accessible names
  Given the app header is built
  Then Save, Perf, About, Help and Fullscreen render an svg.hdr-icon glyph
  And each has a descriptive title and aria-label
  And Fullscreen is the last button of the preset cluster
# pinned by: tests/ui/button.test.ts (icon/title/ariaLabel options)
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
