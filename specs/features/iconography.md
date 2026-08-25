# Iconography (the icon rule)

```yaml
id: iconography
status: implemented
version: 1
owner: ui
related:
  - architecture
  - typography         # the sibling rule: which face *text* gets
  - responsive-header  # where the icon rule was first written, for the header only
  - onboarding         # the About modal's key list, the bug that generalised it
  - dropdown           # the caret
  - floating-window    # the close / pop-out glyphs
  - untrusted-input    # why `iconTextEl` exists beside `iconLabel`
source:
  - src/ui/components/ui-icons.ts      # the icon set
  - src/ui/components/header-icons.ts  # the header's specialisation of it
  - src/ui/components/wave-icons.ts    # the waveform set (predates both)
  - src/ui/components/rest-glyph.ts    # the rest glyph
  - src/styles/base.css                # the `.ui-icon` sizing/stroke contract
  - tests/ui/iconography.test.ts
```

Every glyph that labels a control is inline SVG, never a font character — and
where the line between an icon and a piece of punctuation falls.

## Background / Why

The app renders a lot of small symbols: arrows on keycaps, a caret on every
dropdown, `✕` on every floating window, `⚙` on the in-panel gears. Almost all of
them were Unicode code points set as text, and that quietly makes the browser's
font-fallback chain part of the design.

On Android it stops being quiet. `--sans` is `'Inter', system-ui, -apple-system,
sans-serif` ([typography](typography.md)), but **Inter is not bundled** — there
is no `@font-face` anywhere in the tree, no font file under `public/`, and the
CSP in `index.html` pins `font-src 'self'`. So `--sans` resolves to Roboto,
Roboto has no glyph for `←`, and the character falls through to a per-character
symbol fallback (Noto Sans Symbols) with its own weight, width and baseline. The
reported bug was the About modal's octave-shift row: `←` and `→` on adjacent
keycaps, drawn in different faces, neither sitting on the row's baseline.

The same fallback picks **Noto Color Emoji** for `💡 🎲 ✨ ✕ ✓ ⚙`, so those
rendered as full-colour emoji inside an otherwise monochrome instrument.

There was already a fix for this, and it is instructive that it failed.
[onboarding](onboarding.md) REQ-17 diagnosed the *monospace* keycap face as
having no arrow and redrew symbol caps in `var(--sans)` at 13 px instead
(`modal.module.css` `.glyph`). That is correct on a desktop, where the sans face
has the arrow. It cannot work on Android, where the sans face **is** the thing
that lacks it — the workaround swapped to a font chosen for the same reason the
first one failed.

The right answer was already in the repo, one spec over.
[responsive-header](responsive-header.md) REQ-5 states it for the header's five
utility buttons: *"Icons are inline SVG strings coloured via CSS `currentColor`
(never Unicode emoji, which render coloured on some platforms)."* `wave-icons.ts`
and `rest-glyph.ts` follow the same shape. The rule was simply never generalised,
so ~25 controls elsewhere kept labelling themselves with a code point. This spec
is that rule's real home; REQ-5 there now references it rather than restating it.

## Requirements

- **REQ-1** — **A glyph that names a control, or marks a state, is an inline
  SVG icon.** Not a font character, not an emoji, not a CSS `content:` string.
  It comes from `ui-icons.ts` (or one of the three older sets, REQ-4), carries no
  inline colour, and inherits `currentColor` — which is what lets a state class
  tint a glyph that knows nothing about that state.

  The *marks a state* half is not padding: it covers the tick in "Linked ✓" and
  the tour's "✓ Nice", which label nothing clickable, and `✓` is one of the code
  points Android hands to the colour-emoji font.

- **REQ-2** — **A glyph used as punctuation inside a sentence stays text.**
  This is the boundary that keeps REQ-1 bounded, and it is a rule about *role*,
  not about the code point: the same `→` is an icon on a keycap and punctuation
  in "Distortion → Wah → Phaser". Text keeps `— – … • ≤ ≥ ≈ ’ “ ” −∞`, the flow
  arrows in help prose, and the `↔` in "dark ↔ bright".

  The test: **could the reader click it?** A glyph standing in for something on
  screen is an icon even when it appears mid-sentence — help copy that says "the
  `←` / `→` arrow keys shift octave" is naming two keys, and draws icons.

- **REQ-3** — **An icon is `aria-hidden`; the control carries the name.**
  Three cases, and the third is the one that gets forgotten:
  - **Icon + text** (`✨ AI Prompt`) — the text is already the accessible name,
    so the icon simply hides. This **shortens** the name, deliberately: a screen
    reader should announce "AI Prompt", never "sparkles AI Prompt".
  - **Icon alone on a control** (`✕`, `⚙`, `❐`) — the button needs an
    `aria-label`. `createButton`'s `icon` path sets one from `label` already.
  - **Icon alone with no control under it** — the About modal's arrow keycaps
    are `<span>`s, not buttons. The cap takes `role="img"` **and** an
    `aria-label`; without both it is an empty box and a screen reader reads
    nothing at all where a key name used to be.

- **REQ-4** — **One builder, four sets — and the split is not arbitrary.**
  `ui-icons.ts` is the general set and the default home for a new glyph. The
  three that predate it stay separate because each has a reason:
  - `header-icons.ts` — `class="hdr-icon"`, sized and stroked by
    `switch.module.css`, with per-part hook classes (`.disc` / `.stem` / `.dot`)
    that `tour.module.css` recolours while the info badges show
    ([onboarding](onboarding.md) REQ-8b). Three stylesheets key off that class.
  - `wave-icons.ts` — index-parallel to `WAVE_LABELS` in `state/params.ts`.
  - `rest-glyph.ts` — one glyph with its own viewBox and stroke weight.

  Where two sets need the **same drawing**, they share the shape rather than the
  wrapper: `ui-icons.ts` exports `INFO_SHAPE`, and `header-icons.ts` imports it,
  so the ⓘ on the header button and the ⓘ help copy points at cannot drift
  apart. A fifth *set* is a smell — a new glyph belongs in `UI_ICONS`.

  The split is a CSS contract, not a style preference: an `hdr-icon` gets its
  size and `stroke: currentColor` from rules scoped to the header's button
  classes, so dropping one into a help paragraph renders a solid black blob.
  That is a mistake this repo has already made once (see
  `tests/ui/about.test.ts`, the empty-gear regression), which is why REQ-5
  exists.

- **REQ-5** — **`ui-icons.ts` icons are self-stroking.** Unlike `hdr-icon`, which
  depends on `switch.module.css` to give it a stroke, a `ui-icon` renders
  correctly anywhere — a keycap, a button, a help paragraph, a menu row — from
  the single global rule in `base.css`. That is why the rule is global and not a
  CSS Module: the class name is hard-coded in the markup string, and a module
  would scope it away.

  Sizing is **`1em`**, so an icon tracks its context's font-size instead of
  pinning a pixel size that is wrong in three of the four contexts. The keycap
  arrows stay visibly larger than the letter caps beside them — REQ-17's original
  intent — because the cap sets the font-size, not the icon.

- **REQ-6** — **The rule is pinned by `tests/ui/iconography.test.ts`**, for the
  same reason [typography](typography.md) REQ-6 needs a pin: a glyph regression
  is a *string* change — `b.textContent = '✕'` typechecks perfectly — and the bug
  it causes is invisible on the machine that writes it. The pin reads `src/ui/**`
  as text and fails when an icon code point appears in a **label position**
  (`textContent` / `innerHTML` / a `label:` / `title:` / `ariaLabel:` /
  `heading:` property). It deliberately does not ban the characters outright:
  `ui-icons.ts` names each one in a doc comment to say which glyph it replaces,
  and REQ-2's prose arrows must stay legal — the pin asserts two of them are
  still there, so the boundary is pinned from both sides.

  It also holds the structural half: `INFO_SHAPE` is shared rather than copied,
  no glyph carries an inline `fill`/`stroke`, and the wrapper is `aria-hidden`.

  It cannot catch everything — a glyph assembled at runtime, or one in an
  `innerHTML` template built from variables, slips past — so the pin is a floor,
  not a proof.

- **REQ-7** — **A native `title` tooltip names the key instead of drawing it.**
  A `title` attribute is OS chrome: it takes a string and no markup, so REQ-1
  has nothing to work with. Such copy says the words — the step editor's
  micro-timing tooltip reads "drag, −/+ or the arrow keys", not "←/→". Android
  draws no hover tooltip at all, so nothing is lost there either.

## Technical design

### Contract / public interface

`src/ui/components/ui-icons.ts`:

```ts
export const UI_ICONS: Record<IconName, string>;
export type IconName = keyof typeof UI_ICONS;

/** SVG markup for `name`. Safe to `innerHTML` — no interpolation. */
export function icon(name: IconName): string;

/** An icon as an element. `label` sets role="img" + aria-label (REQ-3). */
export function iconEl(name: IconName, label?: string): HTMLElement;

/** Icon + text in one markup string; the icon is aria-hidden (REQ-3). */
export function iconLabel(name: IconName, text: string, pos?: 'before' | 'after'): string;

/** The same pairing as DOM, for text that is not a literal. */
export function iconTextEl(name: IconName, text: string, pos?: 'before' | 'after'): HTMLElement;
```

`iconLabel` builds markup and is for **literal** copy; `iconTextEl` builds nodes
and is for anything derived — a diagnostics hint, a filename. The split is not
style: `innerHTML` on a value that came from a peer or a file would make it
markup ([untrusted-input](untrusted-input.md)). Both emit the same
`.icon-label` span, so the two look identical.

`INFO_SHAPE` is exported alongside them — the one drawing `header-icons.ts`
reuses (REQ-4).

`src/ui/components/button.ts` — `ButtonOptions` grows two optional fields
alongside the existing `icon`:

```ts
iconBefore?: string;  // SVG rendered before the text label
iconAfter?: string;   // SVG rendered after it
```

`icon` replaces the label (icon-only button); `iconBefore` / `iconAfter`
accompany it. All three take markup, never an `IconName`, so `button.ts` keeps
no dependency on the icon set.

### Data shapes

```yaml
# The markup contract every set emits (REQ-4).
svg:
  class: ui-icon | hdr-icon | wave-icon | rest-glyph
  viewBox: "0 0 16 16"     # ui-icon; other sets keep their own
  aria-hidden: "true"      # always — the name lives on the control (REQ-3)
  colour: none             # currentColor via CSS, never an inline fill/stroke
  fill-parts: class="fill" # opt-out for solid sub-shapes (triangles, pips)
```

The set, and the character each name replaces:

```yaml
arrowLeft / arrowRight:        ← →   # keycaps, "← Back", help prose
chevronLeft / chevronRight:    ‹ ›   # playhead ruler bar-step nav
triangleLeft / triangleRight:  ◀ ▶   # chip reorder, "▶ Play a demo"
toStart:                       ⏮     # transport
caretDown / caretRight:        ▾ ▸   # dropdown, collapse toggle, fold headers
close:                         ✕     # floating window, toast, chip remove
check:                         ✓     # "Linked ✓", tour confirmation
gear:                          ⚙     # in-panel settings reveal
popOut:                        ❐     # "opens a floating window"
edit:                          ✎     # sampler slot editor
menu:                          ☰     # responsive header toggle
sparkle:                       ✨    # AI Prompt
dice:                          🎲    # drum randomiser
bulb:                          💡    # wizard hint
reset:                         ↺     # motion "inherit"
launch:                        ↗     # song card → chain
```

```yaml
info:                          ⓘ     # where help copy names the badges toggle
```

`info` appears in **both** sets and is still one drawing: `UI_ICONS.info` and
`HEADER_ICONS.info` are two wrappers over the exported `INFO_SHAPE` (REQ-4). The
header's copy needs the `hdr-icon` class for its state hooks; help copy needs
the `ui-icon` class to be stroked at all outside a header button.

### Layer touchpoints & ordering

- `src/styles/base.css` holds the `svg.ui-icon` rule (REQ-5) — width/height
  `1em`, `vertical-align: -0.125em` so an icon sits on the baseline in prose,
  `flex: none` so it never shrinks in a flex row, and
  `fill: none; stroke: currentColor` with a `.fill` escape hatch. It loads before
  `theme.css`, and declares no `font-family`, so it is invisible to the
  [typography](typography.md) drift pin.
- Rotation-driven carets (`dropdown.module.css` `.caret`, `tabs.module.css`
  `.collapse[aria-expanded='false']`) transform the element, which works on an
  `<svg>` unchanged — no CSS change was needed there.
- `ui-icons.ts` is on the boot path (`app.ts`, `dropdown.ts`,
  `collapse-toggle.ts` all import it). It is a frozen string map with no
  behaviour, the same shape as `wave-icons.ts`, so it costs parse time and
  nothing else ([runtime-performance](runtime-performance.md) REQ-1).
- **Ordering constraint:** `Modal.glyphClass` and `modal.module.css` `.glyph`
  are removed with the last symbol keycap, not before — they are the superseded
  mechanism, and leaving them behind invites a future glyph to opt back into the
  broken path.

### Persistence

None.

## Scenarios (BDD)

```gherkin
Scenario: the octave-shift keycaps draw identically on any device (REQ-1)
  Given the About modal's Keyboard Shortcuts list
  When the "Shift keyboard octave down / up" row renders
  Then each arrow cap contains an svg.ui-icon and no arrow character
# pinned by: tests/ui/about.test.ts

Scenario: a textless icon cap still has a name (REQ-3)
  Given an arrow keycap, which is a span and not a button
  Then it carries role="img" and an aria-label naming the key
# pinned by: tests/ui/about.test.ts

Scenario: an icon beside text drops out of the accessible name (REQ-3)
  Given the AI Prompt button, labelled with a sparkle and the words "AI Prompt"
  Then its accessible name is "AI Prompt", with no glyph in it
# pinned by: e2e/paste-import.spec.ts

Scenario: punctuation is left alone (REQ-2)
  Given help copy reading "Distortion → Wah → Phaser"
  Then the arrows stay text characters, because they join words rather than name controls
# pinned by: tests/ui/iconography.test.ts

Scenario: a new Unicode icon fails the suite (REQ-6)
  Given someone sets a control's textContent to a bare "✕"
  Then the iconography drift pin fails until the glyph moves into UI_ICONS
# pinned by: tests/ui/iconography.test.ts

Scenario: the superseded font-swap path is gone (REQ-4, regression)
  Given the About modal's key list
  Then no cap carries a glyph class that re-faces a character instead of drawing one
# pinned by: tests/ui/about.test.ts
```

## Tests & verification

- Unit: `tests/ui/iconography.test.ts` (the drift pin), plus the call-site
  assertions in `tests/ui/about.test.ts`, `record-window.test.ts`,
  `transport-controls.test.ts`, `help-content.test.ts` — `npm test`
- E2E: `e2e/paste-import.spec.ts`, `e2e/live-fx.spec.ts` — `npm run e2e`
- Typecheck: `npm run typecheck`
- Manual, and this is the part that matters: **appearance is verified by eye, on
  a phone.** The bug this spec exists for is invisible on a desktop, because the
  desktop font stack happens to have the glyphs. Open Help & About → Keyboard
  Shortcuts on Android and check that the two arrow caps are the same weight and
  sit on the same baseline; then check that the AI Prompt, Random and wizard-hint
  glyphs are monochrome rather than colour emoji.

## Open questions / future

- Bundling a subset of Inter would fix the *typographic* half of this (real
  arrows in the body face) but not the icon half, and would need a CSP change
  (`font-src 'self'` is fine for a self-hosted file, but the font is a new
  asset on the boot path). Not worth it for ~16 glyphs that SVG draws better.
- `wave-icons.ts` and `rest-glyph.ts` could fold into `UI_ICONS` with a
  per-icon viewBox. Deliberately not done: `wave-icons.ts` is index-parallel to
  a param's label list and its ordering is load-bearing, which is a different
  contract from "look up a glyph by name".
- The drift pin (REQ-6) reads source text, so it cannot see a glyph composed at
  runtime. If one ever slips through, the fix is a call-site assertion, not a
  cleverer regex.
