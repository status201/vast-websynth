# Recipe — add a UI theme

```yaml
id: add-a-theme
status: implemented
version: 1
owner: core
related:
  - ui-themes
  - typography
  - css-cascade-layers
  - onboarding
source:
  - src/state/theme.ts                 # ThemeId, THEMES
  - src/styles/themes/<id>.css         # the theme's token block
  - src/styles/theme.css               # Dark's values; the derived tokens
  - index.html                         # the theme's <link>
  - public/theme-boot.js               # the pre-paint copy of the registry
  - src/ui/onboarding/help-content.ts  # the Settings topic names every theme
  - tests/ui/theme-contrast.test.ts    # RULES: the theme's contrast rule
```

A repeatable **playbook** for a new named look. Every colour in the app is a
token named by its role, so a theme is one block of token values plus the four
places that must agree on its id. The worked instances are the seven themes
[ui-themes](../features/ui-themes.md) ships beside Dark: Light, Pastel, Vibrant,
Classic, Jungle, Race and High contrast. Vibrant (or Classic, Race) is the
closest model for a dark theme, Light for a light one, and Pastel or Jungle for
light faceplates on a dark chassis.

## Background / Why

The theme has to be on the page before the first paint, and the boot script
that puts it there cannot import the registry. So a theme's id lives in four
files, and the suite fails until they agree. Most of the work is not the
plumbing but the palette: the derived tokens (`--playing`, `--switch-on-*`,
`--keycap*`, …) were tuned for Dark. Each new palette has broken some of them,
so the contrast table is where a theme is really finished.

## Steps

### 1. Register it — `src/state/theme.ts`

Add the id to `ThemeId` and a row to `THEMES`, in picker order:

```ts
{ id: 'dusk', name: 'Dusk', metaColor: '#1c1830', colorScheme: 'dark',
  swatch: ['#1c1830', '#e8e0ff', '#ff9e64', '#7dcfff'] },
```

- `metaColor` is the browser's own chrome around the app: use the theme's page
  colour, or its header.
- `colorScheme` picks native scrollbars and form controls.
- The four `swatch` chips are the picker tile. Each must be a colour the theme
  file itself declares (`tests/ui/theme.test.ts`).

### 2. Write its block — `src/styles/themes/<id>.css`

Copy the nearest shipped theme and change the values. Keep it one `@layer theme`
block on `:root[data-theme="<id>"]`:

```css
@layer theme {
  :root[data-theme="dusk"] {
    --bg: #110e1e;
    --panel: …;
    /* every base token */
  }
}
```

- **Base tokens** hold a value of their own, and the block must declare every
  one (`tests/ui/theme-tokens.test.ts` lists any it misses).
- **Derived tokens** (`var()` or `color-mix()` on `:root`) follow your base
  values by themselves. Redeclare one only when its derivation fails your
  palette (see Gotchas).
- **Faces:** set `--serif` (display) and `--sans` (content) to system stacks. Never
  `--mono`: it is the only face with tabular figures
  ([typography](../features/typography.md) REQ-mono-is-readouts-and-pasted-text).
- **Screens** (`--screen*`, the patch bay, the model badge) stay dark in every
  theme so far (ui-themes.md REQ-screens-are-their-own-family).
- **Section colours:** the `--panel-tint-*` tokens colour each synth section,
  as Pastel does (REQ-pastel-tints-each-panel). Leave them alone for one face.

### 3. Load it — `index.html` and `public/theme-boot.js`

- `index.html`: a `<link rel="stylesheet" href="/src/styles/themes/<id>.css">`
  beside the other theme links, after `theme.css`.
- `public/theme-boot.js`: an entry in its `THEMES` map with the same
  `[metaColor, colorScheme]` as the registry row. (The file's second block is
  the UI scale's — [ui-scale](../features/ui-scale.md); leave it alone.)

### 4. State its contrast — `tests/ui/theme-contrast.test.ts`

Add a row to `RULES` naming the REQ it meets. The floor is WCAG AA: body text
4.5:1 and small print 3:1 on every flat surface its type sits on. Widen
`surfaces` if the theme prints type on something new (Pastel adds its tints);
raise the numbers for an accessibility theme. Then add that REQ to
[ui-themes](../features/ui-themes.md), in the shape of
REQ-vibrant-keeps-its-red-for-fills: what the theme is, and any rule its
palette needed.

### 5. Name it — the Settings help topic and the docs

- `help-content.ts`, the `settings` topic: one clause on what the theme
  looks like. `tests/ui/help-content.test.ts` fails until every theme's name
  is there.
- The CHANGELOG under `[Unreleased]`. For a README shot, add one to
  `scripts/readme-screenshots.mjs` and run it with `--only <name>`.

### 6. Verify it

```bash
npm run typecheck
npx vitest run tests/ui/theme*.test.ts tests/ui/panel-tint.test.ts tests/ui/help-content.test.ts
npm test
```

Then look at it, in Firefox first, then Chrome. A theme isn't done until
someone has looked at it.

## Gotchas

- **Derived tokens break on a new palette.** Each of these was found by eye in a
  shipped theme, then pinned for every theme. When the suite names one, give it
  a value of its own in your block:
  - `--playing` with `--ink-strong`: the transport's playing bar.
  - `--keycap*`: the About card's shortcut keys.
  - `--lit-accent*`: a lit DJ button and the info badge.
  - `--switch-on-bed` and `--switch-on-ink`: if your on and off inks sit close,
    light the cap.
  - `--play-on-ink`: if you lit the cap, point it at `var(--switch-on-ink)`.
  - `--lit-text-shadow`: the shadow under a lit step's note name. Black lifts
    light type; under dark type it only blurs, so make it `transparent`.
  - `--veil`: on a light theme, fade it toward the panel, not black.
  - `--step-mark` with `--step-mark-edge`: ratchet ticks and the bend stroke.
    If your "selected" colour sits close to your lit step, draw the marks in
    white (Vibrant, Classic, Race, High contrast); the rim carries them on the
    other bed.
  - `--dj-lit-top` → `--dj-lit-bottom`: a lit DJ button's gradient. By default it
    is your accent into the foot of your lit step, which suits a theme whose two
    are one family and goes muddy where they are not (Jungle's rose over teal).
- **A palette's loudest colour may only work as a fill.** Vibrant's pure red
  reads below 3:1 as type on every surface. It colours LEDs, accented steps and
  the cheeks, and its red text uses a lighter coral.
- **Auto never picks a new theme.** Auto resolves only to High contrast, Light or
  Classic (REQ-auto-follows-the-system). Choosing a theme for a system setting
  means changing `resolveTheme()` **and** the boot script's copy of the rule.
- **Making it the default** means making it Auto's last step, because a device
  that never chose is on Auto (REQ-auto-is-the-default). That is `DEFAULT_THEME`
  plus the boot script's `'classic'` fallback. The boot test runs every stored
  value and system against `resolveTheme()`, so it fails if only one changes.
  Tell existing users: the look changes for everyone on Auto, including everyone
  who never chose a theme.
- **A module that recolours a control's state** can override the theme's
  token for it: a later layer wins. That is how the Play legend went amber on
  every lit cap. If your theme looks wrong in one place only, grep the
  modules for a hard-wired token on that state before changing the palette.
- **The fingerprint stays in Dark.** `npm run cascade:fingerprint` captures
  Dark, so a new theme cannot move a baseline. Pass `--theme <id>` to capture
  yours.

## Scenarios (BDD)

```gherkin
Scenario: a new theme is wired in four agreeing places
  Given a THEMES row, a themes/<id>.css block, its <link> and a theme-boot.js entry
  When the suite runs
  Then the picker offers it, a reload applies it before first paint, and the boot
    script resolves every stored value and system the same way as the registry
# pinned by: tests/ui/theme.test.ts

Scenario: a theme with a missing token or no contrast rule fails
  Given a theme block that skips a base token, or a theme with no RULES row
  When the suite runs
  Then theme-tokens.test.ts names the missing token, and theme-contrast.test.ts the theme
# pinned by: tests/ui/theme-tokens.test.ts, tests/ui/theme-contrast.test.ts
```

## Tests & verification

- `tests/ui/theme.test.ts`: the `<link>`, the boot entry and the swatch.
- `tests/ui/theme-tokens.test.ts`: every base token, no palette literal in a
  module.
- `tests/ui/theme-contrast.test.ts`: the theme's `RULES` row, plus the checks
  that run over every theme (type on its own fills, on switches, the Play
  legend).
- `tests/ui/help-content.test.ts`: the Settings topic names it.
- By eye in Firefox: these surfaces, played and stopped:
  - the synth, the FX rack, every machine tab and the keyboard;
  - the scope, the EQ and the sample waveform;
  - the Settings, About and Preset dialogs, an open menu and the tour;
  - the start screen's focus ring;
  - the Play button while playing.
