# UI themes

```yaml
id: ui-themes
status: active
version: 1
owner: ui
related:
  - typography            # the faces a theme sets
  - css-cascade-layers    # theme files live in the `theme` layer; the fingerprint proves a token move
  - iconography           # glyphs take currentColor, so they follow a theme for free
  - performance-mode      # the device-scoped pref pattern this copies
  - runtime-performance   # canvases never resolve a colour per frame
  - architecture          # the persistence table
source:
  - src/styles/theme.css             # the default (Dark) token set — the one place a token is declared
  - src/styles/base.css              # html/body take var(--sans)
  - src/ui/styles/                   # every module colours through tokens
  - src/ui/theme-colors.ts           # canvases read the screen tokens through this
  - src/state/theme.ts               # the registry, the stored choice, Auto's resolution
  - src/ui/theme.ts                  # puts a theme on the document; follows the system under Auto
  - public/theme-boot.js             # applies the stored theme before first paint
  - index.html                       # loads theme-boot.js ahead of the stylesheets
  - public/sw.js                     # theme-boot.js is a CORE_ASSETS entry
  - src/ui/components/theme-picker.ts  # the Theme row of the Settings dialog
  - src/ui/components/perf-settings-modal.ts  # the Settings dialog that holds it
  - src/ui/components/scope.ts
  - src/ui/components/eq-graph.ts
  - src/ui/components/scratch-graph.ts
  - src/ui/components/record-sound-modal.ts
  - scripts/css-cascade/fingerprint.mjs  # --rendered: the zero-change proof for a token move
  - tests/ui/theme-tokens.test.ts
  - tests/ui/theme-colors.test.ts
  - tests/state/theme.test.ts
  - tests/ui/theme.test.ts
  - tests/ui/theme-picker.test.ts
```

A named look for the whole app — a colour palette and two type faces — chosen per
device. **Dark** (today's walnut-and-amber faceplate) is the default; **High
contrast**, **Light** and **Pastel** are the others.

## Background / Why

`theme.css` has always held the palette as `:root` custom properties, but the
modules stopped using it: ~340 colour literals had been copied into 47 CSS Modules
and ~35 more into the canvas painters, most of them the palette by hand
(`rgba(244, 205, 94, 0.07)` is `--accent-secondary` at 7 %). Overriding the tokens
alone would leave islands of brown and orange, so a theme is two jobs: first make
every colour go through a token (no visible change), then give the tokens other
values. The first job is also what makes the second cheap to keep correct: a
drift pin fails any new literal, and fails a theme that forgets a token.

Fonts are system stacks only — the app bundles no font file
([iconography](iconography.md) explains why), and a theme does not change that.

## Requirements

- **REQ-a-theme-is-a-palette-and-two-faces** — A theme is an id, a display name,
  and a value for every colour token plus `--serif` (display) and `--sans`
  (content). [typography](typography.md) still decides *which* face a piece of
  text gets; a theme only decides what each face *is*.
- **REQ-mono-is-not-themed** — `--mono` is the same in every theme: it is the
  one face with tabular figures ([typography](typography.md)
  REQ-mono-is-readouts-and-pasted-text), and a theme must not make a counter jitter.
- **REQ-every-colour-is-a-token** — No stylesheet under `src/ui/styles/` or
  `src/styles/` writes a colour literal outside a theme block. The only literals
  allowed are **neutral shadow and shine** — black or white at an alpha
  (`rgba(0, 0, 0, a)`, `rgba(255, 255, 255, a)`), which read correctly on any
  surface — plus `transparent`, `currentColor`, and the `<noscript>` page
  (`.noscript-page`, `.noscript-link`), which renders before any theme exists.
- **REQ-tokens-are-named-by-role** — A token names what it colours (`--well`,
  `--lit-top`, `--screen-ink`), never the colour it happens to be. Two places that
  share a value but not a role get two tokens, so a theme can part them.
- **REQ-an-alpha-derives-from-its-base** — A translucent variant of a palette
  colour is written `color-mix(in srgb, var(--base) N%, transparent)`, not as a
  second literal, so a theme that changes a base gets every alpha of it for free.
  (Mixing with `transparent` in sRGB is exact: the result is the base at alpha N %.)
- **REQ-every-theme-defines-every-token** — A theme block declares every token the
  default `:root` declares, so no theme silently inherits one Dark colour.
- **REQ-screens-are-their-own-family** — The display windows (scope, EQ graph,
  sample waveform, scratch graph, FX patch bay) colour through the `--screen-*`
  family, separate from the panel surfaces, so a light theme can keep its screens
  dark the way hardware does.
- **REQ-canvas-reads-the-screen-tokens** — A canvas painter takes its colours from
  `screenPalette()` in `src/ui/theme-colors.ts`, which resolves the `--screen-*`
  tokens once, caches them, and resolves again only on a theme change. Nothing
  resolves a colour per frame ([runtime-performance](runtime-performance.md)).
  An alpha is applied in code with `rgba()`, from the same base
  (REQ-an-alpha-derives-from-its-base's rule, on a canvas).
- **REQ-the-pairing-qr-stays-black-on-white** — The sync-pairing QR code is
  painted pure black on white in every theme: a scanner needs the contrast, and
  it is a code, not decoration.
- **REQ-a-token-move-is-proven-by-fingerprint** — Moving literals into tokens is
  proven to change nothing on screen by `fingerprint.mjs --compare … --rendered`:
  the cascade fingerprint with custom properties left out (a token's raw text is
  not a pixel) and colours compared as numbers, so `color(srgb …)` and the
  `rgba()` it equals are one colour. A deliberate merge of two near-identical
  literals into one token shows up there by name, and is listed in the change.
- **REQ-the-theme-is-a-device-preference** — The chosen theme is stored under
  `localStorage['websynth.ui.theme']` as one of `dark | light | contrast | pastel |
  auto`, like the perf tier: per device, never in a song, a preset or a share
  link. Only a theme the registry (`THEMES`) lists is accepted: a missing,
  unknown or not-yet-shipped value means `dark`
  ([untrusted-input](untrusted-input.md)).
- **REQ-the-theme-applies-before-first-paint** — The stored theme is on
  `<html data-theme>` before the first frame, so a reload never flashes Dark
  first. A tiny external classic script in `<head>`, ahead of the stylesheets,
  does it (the shipped CSP allows no inline script), and it is a `CORE_ASSETS`
  entry so it works offline. `<meta name="theme-color">` (the browser's own
  chrome) and `<meta name="color-scheme">` (native scrollbars and form controls)
  follow the theme.
- **REQ-the-boot-script-agrees-with-the-registry** — `public/theme-boot.js` is
  outside the bundle and cannot import `src/state/theme.ts`, so it carries its
  own copy of the shipped ids, their meta values and Auto's rule. A test runs the
  script for every stored value under every system setting and fails if it puts a
  different theme, or different meta values, on the page than `resolveTheme()`
  and the registry would.
- **REQ-auto-follows-the-system** — `auto` resolves to `contrast` under
  `prefers-contrast: more`, else to `light` under `prefers-color-scheme: light`,
  else `dark` — each step only if that theme ships — and re-resolves live when the
  system setting changes. Under `forced-colors: active` the app leaves the
  system's colours alone.
- **REQ-choosing-a-theme-previews-it** — Picking a theme applies it at once and
  stores it; there is no Apply step, so a wrong choice is undone by picking again.
  The picker is the **Theme** section of the header's **Settings** dialog — the
  former Performance dialog, which keeps its Performance section below it, since
  both are how this device runs the app rather than part of the music. Under
  Auto a status line names the theme the system setting picked.
- **REQ-a-theme-change-repaints-the-canvases** — A theme change drops the cached
  screen palette and tells every open canvas (`onPaletteChange`), which repaints
  once: the EQ graph, the scratch graph and the sample waveform draw only on
  demand, and a sleeping scope is woken, so none of them keeps the old theme's
  colours until something else happens to redraw it. A canvas unsubscribes when
  it is destroyed.
- **REQ-pastel-tints-each-panel** — Each machine panel carries a `data-tint`
  naming its section, and its chrome paints `var(--panel-tint, var(--panel))`.
  Every theme maps each `--panel-tint-<section>` token; Dark, Light and High
  contrast map them all to `--panel`, Pastel gives each section its own colour with
  dark legends on it.

## Technical design

### Contract / public interface

```yaml
theme_ids: dark | light | contrast | pastel      # `auto` is a stored choice, not a theme
theme_selector: ":root[data-theme=\"<id>\"]"     # dark is also plain :root (the default)
theme_files: src/styles/themes/<id>.css           # one @layer theme block each
THEMES: "readonly ThemeInfo[] — the shipped themes, in picker order"   # src/state/theme.ts
ThemeInfo_id: ThemeId
ThemeInfo_name: the picker label
ThemeInfo_metaColor: the <meta name="theme-color"> value
ThemeInfo_colorScheme: "dark | light — the <meta name=\"color-scheme\"> value"
ThemeInfo_swatch: "[--bg, --text, --accent, --accent-secondary] — the picker tile's chips, pinned equal to the theme's tokens"
THEME_KEY: websynth.ui.theme
readThemePref: "() => ThemePref — dark when missing or not shipped"
resolveTheme: "(pref, matches) => ThemeId — auto resolved against the system queries"
applyTheme: "(id) => void — data-theme + both metas; on a change, invalidateScreenPalette()"  # src/ui/theme.ts
startTheme: "() => void — boot: apply, then follow the system while the choice is auto"
setThemePref: "(pref) => ThemeId — store, apply, return what it resolved to"
onPaletteChange: "(fn) => () => void — fn runs after each invalidation; the return unsubscribes"  # src/ui/theme-colors.ts
screenPalette: "() => ScreenPalette — cached; re-resolved on a theme change"
ScreenPalette_ink: the screen's grid, labels, curves in the amber of the default  # --screen-ink
ScreenPalette_trace: the main trace / curve                                       # --screen-trace
ScreenPalette_hot: clip and cut marks                                             # --screen-hot
ScreenPalette_highlight: a grabbed handle                                         # --screen-highlight
ScreenPalette_cue: a cue point                                                    # --screen-cue
rgba: "(c: Rgb, alpha) => string — a canvas fillStyle/strokeStyle from a base"
```

### Token families

`theme.css` is the owner of the full list and of every Dark value; it groups them
under these roles (by REQ-tokens-are-named-by-role):

| Family | Colours |
| --- | --- |
| `--bg`, `--panel*`, `--rule`, `--wood*` | the chassis: page, panel faces and borders, hairlines, cheeks |
| `--text*` | type: body, dim/faint, soft/label/hint, error/bad/good |
| `--accent*`, `--led-*` | the amber/orange voice, status LEDs |
| `--well*`, `--tray`, `--recess*`, `--raised*`, `--menu*`, `--handle-*` | control surfaces: a button's bed, the bed a row of buttons sits in, a tab strip's bed, a selected control, a popover, a grip |
| `--lit*`, `--ink*` | a lit (on) control in its three colours (accent, bad, warm), and the dark type printed on a lit fill |
| `--key-*` | the playable keyboard and the musical-role colours |
| `--screen*`, `--patch-*`, `--cable-*` | display windows, the FX patch bay and its cables |
| `--scrim-ink`, `--scrollbar-*`, `--start-btn`, `--motion*`, `--meter-hot` | overlays, scrollbars, the start button, the motion sequencer's own amber, the gain-reduction meter's hot end |

### Layer touchpoints & ordering

- Theme files sit in the `theme` layer ([css-cascade-layers](css-cascade-layers.md)),
  after `theme.css`. `:root[data-theme="x"]` outranks plain `:root` by
  specificity inside the one layer, so file order inside the layer does not matter.
- A token that is itself derived (`--accent-glow` as a `color-mix` of `--accent`)
  is declared once, on `:root`; a theme that redefines the base changes it without
  redeclaring it. REQ-every-theme-defines-every-token counts only the *base*
  tokens, the ones that hold a colour value of their own.
- `base.css` loads before `theme.css`; `html, body` reads `var(--sans)`, so the
  content face follows a theme.

### Persistence

`websynth.ui.theme` (see [architecture](../architecture.md) "Persistence").
Wiped by a factory reset like every other device preference. Not persisted: a
theme in a song, preset or share link — on purpose: a theme is how this device
looks, not part of the music.

## Gesture inventory

The theme picker (one row of theme tiles, per ADR-014) — a radio group: the row
is `role="radiogroup"`, each tile a `role="radio"` button with its colour chips
and name, Auto first.

| Gesture | Target | Result |
| --- | --- | --- |
| click / tap | a tile | that theme applies at once and is stored (REQ-choosing-a-theme-previews-it) |
| ←/↑, →/↓ | a focused tile | moves to the previous / next tile, wrapping, and selects it |
| Home / End | a focused tile | moves to the first / last tile and selects it |
| Enter / Space | a focused tile | selects it (the native button click) |
| Tab | the row | one stop for the row — the selected tile (roving `tabindex`) |
| Escape | anywhere in it | not consumed: the dialog closes |

The keys the row handles stop there ([input-control](input-control.md)): no
arrow reaches the global shortcuts. Testids: `theme-picker` (the row),
`theme-<id>` and `theme-auto` (the tiles), `theme-status`.

## Scenarios (BDD)

```gherkin
Scenario: a colour literal in a module fails the suite (REQ-every-colour-is-a-token)
  Given a CSS Module that writes `color: #e2705a`
  Then the theme-token pin fails until it goes through a token
# pinned by: tests/ui/theme-tokens.test.ts

Scenario: neutral shadow and shine stay literal (REQ-every-colour-is-a-token)
  Given a module that writes `box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5)`
  Then the pin accepts it
# pinned by: tests/ui/theme-tokens.test.ts

Scenario: a token reference must resolve (edge, REQ-every-colour-is-a-token)
  Given a module that writes `var(--wel-top)` (a typo)
  Then the pin fails: every var(--x) a module reads is declared in theme.css or in the module itself
# pinned by: tests/ui/theme-tokens.test.ts

Scenario: tokenizing changes nothing on screen (REQ-a-token-move-is-proven-by-fingerprint)
  Given a baseline fingerprint captured before the literals moved
  When the same states are captured after, with --rendered
  Then the only differences are the merges this change lists
# by design: run by hand — npm run cascade:fingerprint -- --compare base.ndjson.gz --rendered (dev and build)

Scenario: canvases resolve their colours once (REQ-canvas-reads-the-screen-tokens)
  Given screenPalette() has been read
  When it is read again with no theme change in between
  Then it returns the cached palette without touching the DOM
# pinned by: tests/ui/theme-colors.test.ts

Scenario: an unresolvable token falls back rather than throwing (edge, REQ-canvas-reads-the-screen-tokens)
  Given an environment where a custom property does not resolve to a colour
  Then screenPalette() returns the Dark values
# pinned by: tests/ui/theme-colors.test.ts

Scenario: the canvas fallback cannot drift from theme.css (REQ-canvas-reads-the-screen-tokens)
  Given the Dark values screenPalette() falls back to
  Then each equals the value theme.css resolves that --screen-* token to
# pinned by: tests/ui/theme-colors.test.ts

Scenario: a stored theme survives a reload (REQ-the-theme-is-a-device-preference)
  Given the user picked a theme
  Then websynth.ui.theme holds its id, and the next boot resolves to it
# pinned by: tests/state/theme.test.ts

Scenario: an unknown or unshipped stored value means Dark (edge, REQ-the-theme-is-a-device-preference)
  Given websynth.ui.theme holds "neon", "__proto__", or the id of a theme not in THEMES
  Then readThemePref() is "dark" and the boot script puts data-theme="dark" on the page
# pinned by: tests/state/theme.test.ts, tests/ui/theme.test.ts

Scenario: Auto follows the system's contrast, then its light/dark setting (REQ-auto-follows-the-system)
  Given the stored choice is auto
  Then prefers-contrast: more gives contrast, prefers-color-scheme: light gives light, else dark
  And a theme that does not ship is skipped to the next rule
# pinned by: tests/state/theme.test.ts

Scenario: Auto re-resolves when the system setting changes (REQ-auto-follows-the-system)
  Given the stored choice is auto and the app has started
  When the system's colour-scheme query fires a change
  Then the page's theme is resolved again; with a concrete choice it is left alone
# pinned by: tests/ui/theme.test.ts

Scenario: the boot script and the registry agree (REQ-the-boot-script-agrees-with-the-registry)
  Given every stored value (missing, each id, auto, unknown) under every system setting
  When public/theme-boot.js runs
  Then data-theme, the theme-color meta and the color-scheme meta equal what resolveTheme() and THEMES give
# pinned by: tests/ui/theme.test.ts

Scenario: the boot script runs before the stylesheets, and offline (REQ-the-theme-applies-before-first-paint)
  Given index.html and the service worker
  Then a classic theme-boot.js script precedes the first stylesheet link, and CORE_ASSETS lists it
# pinned by: tests/ui/theme.test.ts

Scenario: a picker tile's chips are its theme's colours (REQ-a-theme-is-a-palette-and-two-faces)
  Given a theme in THEMES
  Then its swatch equals the --bg, --text, --accent and --accent-secondary its theme file declares
# pinned by: tests/ui/theme.test.ts

Scenario: picking a theme applies and stores it at once (REQ-choosing-a-theme-previews-it)
  Given the Settings dialog is open
  When the user clicks a theme tile
  Then <html data-theme> changes, websynth.ui.theme is written, and the tile is aria-checked
# pinned by: tests/ui/theme-picker.test.ts

Scenario: the picker is one radio group for the keyboard (REQ-choosing-a-theme-previews-it)
  Given focus on the selected tile
  When the user presses → (or End)
  Then the next (or last) tile is selected and focused, the key does not propagate, and only that tile has tabindex 0
# pinned by: tests/ui/theme-picker.test.ts

Scenario: a theme change repaints a canvas once, and a destroyed one is not told (REQ-a-theme-change-repaints-the-canvases)
  Given a subscriber to onPaletteChange
  When the theme changes
  Then it runs once and the next screenPalette() resolves afresh; after it unsubscribes it does not run
# pinned by: tests/ui/theme-colors.test.ts, tests/ui/theme.test.ts
```

## Tests & verification

- Unit: `tests/ui/theme-tokens.test.ts` (the literal pin, the var() resolution
  pin), `tests/ui/theme-colors.test.ts`, `tests/state/theme.test.ts` (registry,
  stored choice, Auto), `tests/ui/theme.test.ts` (applying, following the
  system, the boot script against the registry), `tests/ui/theme-picker.test.ts`
  — `npm test`
- No flash on reload: by hand against `npm run build && npx vite preview` (the
  shipped CSP), with a non-Dark theme stored — an e2e lands with the first
  theme that is not Dark, when there is something to see.
- Typecheck: `npm run typecheck`
- Zero-change proof for a token move: `npm run cascade:fingerprint -- --out
  base.ndjson.gz` on the old tree, then `--compare base.ndjson.gz --rendered` on
  the new one, on **both** `--server dev` and the build (they order CSS differently).
- By eye, Firefox first then Chrome: each theme across synth, drums, sampler,
  song, a modal, an open menu, the EQ, the scope and the sample waveform.

## Open questions / future

- **Delivery is staged.** Shipped: the tokens (REQ-every-colour-is-a-token through
  REQ-a-token-move-is-proven-by-fingerprint), and the mechanism — the registry,
  the stored choice, the boot script, Auto and the picker. `THEMES` lists Dark
  only, so the picker offers Auto and Dark and Auto always lands on Dark. Still to
  build, in order: High contrast and Light (each a `THEMES` row, a theme file and
  a boot-script entry); Pastel and the panel `data-tint` hook
  (REQ-pastel-tints-each-panel).
- The header button keeps its gauge icon and its tier colour, because the perf
  tier is the one setting worth seeing at a glance; its label says "Settings".
- Light's key-role colours need light variants that still read as the same four
  roles on a pale key ([scale-quantization](scale-quantization.md)).
