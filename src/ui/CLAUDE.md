# UI layer — CSS Modules conventions

Loaded when working with files under `src/ui/`. See the root `CLAUDE.md` for
architecture, the `StudioApi`/`UiBridge` contracts and the SDD rules.

All component/panel styling is in `src/ui/styles/*.module.css`. Global CSS is
now only `src/styles/base.css` (reset), `src/styles/theme.css` (custom
properties), and `src/styles/layout.css` (`.app` grid + responsive).

- **Typography**: `--serif` is display type only — identity, headings, taglines, and faceplate legends (tabs, step buttons, segmented, track labels). Body copy, status lines and anything the user *types* are `--sans`; readouts with changing digits are `--mono` (Georgia's figures are proportional old-style, so a serif counter jitters). Sans is the inherited default, so a serif is always a deliberate opt-in — and `tests/ui/typography.test.ts` fails on any new one until it's declared. → `specs/features/typography.md`.
- State classes (`.on`, `.active`, `.hidden`, `.playing`, `.collapsed`, `.synced`) are global — match them with `:global(.on)` in module selectors. `.synced` is on a `Knob` root while its param is tempo-locked, and **two** modules key off it (`knob.module.css` hides the dial, `tempo-lock.module.css` shows the chip in its place) — which is exactly why it is global rather than either module's own. → `specs/features/tempo-lock.md`.
- Bridge global classes (e.g. `switch-label`) are kept alongside module classes where global descendant selectors still target children: `className: 'switch-label ' + styles.label!`.
- Use `:global()` when a module selector targets an element with only a global class: `.icons button :global(svg.wave-icon)`.
- Step buttons: `.root` is `min-width: 0; width: 100%; height: 32px`. `.drum-cell` overrides height to 22px and font-size to 8px but does NOT set width — parent grid controls sizing.
- Step buttons (seq/drum/sampler) visualize per-step settings via `StepButton.setViz()`: a lazily-created `.fill` layer driven by inline custom props (`--sb-gate` width, `--sb-vel` brightness, `--sb-ratchet` top ticks) plus `tie`/`prob`/`ratchet` classes; the label lives in a `.label` span so `setLabel` can't wipe the layer. `.red .fill` keeps the drum/sampler beat columns red when lit; `.drum-cell.tie .fill` shortens the tie bridge to the drum grid's 3px gap.
- The drum module's `.cells` uses `display: grid; grid-template-columns: repeat(16, 1fr); gap: 3px` — both `drum-panel.ts` and `sampler-panel.ts` import this via `drumStyles.cells`.
- Sampler action buttons (`.load`, `.edit`, `.rec`) need full base button styling (background, border, border-radius, cursor, font-family, box-shadow, transition) in their module class — they are standalone classes with no shared base class to inherit from.
- Panel builder functions must explicitly `appendChild` every sub-container to the root element. Orphaned DOM subtrees (built but never appended) are a common source of blank panels — previously tripped on `drum-panel.ts` where the grid was constructed but `root.appendChild(grid)` was missing.
