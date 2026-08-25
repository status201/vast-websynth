# Typography (the type rule)

```yaml
id: typography
status: implemented
version: 2  # v2: REQ-1 carve-out — a panel-heading tab takes the heading's face
owner: ui
related:
  - architecture
  - brand              # the display serif's flagship consumer
  - dropdown           # the filter row that broke the rule
  - dialog             # the `font-family: inherit` pattern for text fields
  - webrtc-sync        # where the rule used to live
  - transport-window   # the tabular-figures case (REQ-6 there)
source:
  - src/styles/theme.css      # the three tokens
  - src/styles/base.css       # the app default (sans)
  - src/ui/styles/            # every opt-in to a non-default face
  - tests/ui/typography.test.ts
```

Which of the three faces a piece of text gets, and why — one rule, in one place.

## Background / Why

The app ships three faces as `:root` custom properties — `--serif` (Georgia),
`--sans` (Inter), `--mono` — and `base.css` defaults everything to `--sans`, so
every serif in the tree is a deliberate opt-in. What was never written down is
what each face is *for*. The serif is the faceplate voice: it is what makes the
app read as an instrument rather than a web form, so it spread by imitation —
a new rule got `var(--serif)` because the rule above it had one.

That is exactly how it landed on a text field. The dropdown's live filter
([dropdown](dropdown.md) REQ-7) is a 10 px `<input>` the user *types into*, and
it was given Georgia at `letter-spacing: 0.08em` because the sibling `.option`
and `.empty` rules it was copied from have it. At that size the result is close
to unreadable, and nothing anywhere disagreed with it.

The rule *did* exist: as a sub-bullet of REQ-5 in
[webrtc-sync](webrtc-sync.md), announcing itself as "applies app-wide" from
inside a spec about serverless pairing. It was written there because that is the
one time a typography change happened to touch gated `.ts` code — `sdd-guard`
allowlists `*.css` and `**/styles/**` (see [README](../README.md) "Enforcement &
exemptions"), so a typeface regression is invisible to every gate in the repo.
This spec is that rule's real home, and its drift pin (REQ-6) is the gate CSS
otherwise never gets.

## Requirements

- **REQ-1** — **`--serif` (Georgia) is display type only.** It is for text the
  reader **recognises at a glance**, never text they read for content or type
  into. Two families qualify:
  - **Identity and headings** — the [brand](brand.md) block, modal titles, step
    headings/subtitles, taglines (`Modal.titleClass` / `Modal.tagClass`).
  - **Faceplate legends** — the short, usually uppercase, letter-spaced control
    captions that make the app look like hardware: tab labels, segmented
    switches, step buttons, drum/seq track labels, the bank bar, dropdown
    toggles and options, keyboard key names, floating-window buttons.

  A legend is a *label on a control*, not the control's contents. The distinction
  that matters: `.toggle` (a legend showing the current value) is serif;
  `.filterInput` (a field holding the user's text) is not.

  **One carve-out: a tab that is a panel's heading.** "Tab labels" above means
  `TabContainer`'s machine tabs, which sit on the faceplate as legends.
  [panel-tabs](panel-tabs.md) tabs *replace* a `.panelTitle` (its REQ-9), and
  synth panel titles have always been sans — so those tabs declare no face and
  inherit it, because matching the heading they stand in for beats matching the
  other thing called a tab. The test cannot catch this either way (declaring
  nothing adds no allowlist entry), which is exactly why it is written down.

- **REQ-2** — **`--sans` (Inter) is content type.** Anything the user reads as
  prose or enters as data:
  - body / intro / instruction copy, hints, help text;
  - status, result and error lines — including "No match", "Linked ✓" and the
    like, which are sentences addressed to the user, not legends;
  - **every `<input>` and `<textarea>`** whose contents are prose or a name
    (code and pasted blobs take `--mono`, REQ-3).

  Sans is also the default: `base.css` sets `html, body` to Inter, so the
  correct face is usually the one you get by **not declaring one**.

- **REQ-3** — **`--mono` is readouts and pasted text**, and is the only face
  here with reliable tabular figures. Georgia ships proportional old-style
  figures with no `tnum`, so **any digit that changes in place** — a counter, a
  timer, a bar/step readout — must be `--mono`, never `--serif`, or it shifts
  sideways as it counts. This is the same finding
  [transport-window](transport-window.md) REQ-6 already made for the `bar.step`
  readout; it generalises.

- **REQ-4** — **A text-entry control never declares its own face.** It uses
  `font-family: inherit` (the `.input` pattern in `dialog.module.css`) or
  `var(--sans)` explicitly — never `var(--serif)`, and never nothing-at-all,
  since form controls do not inherit the document face by default. Related trap:
  `base.css` sets `button { font: inherit }`, so a *container* that gains
  `var(--serif)` silently re-faces every button under it.

- **REQ-5** — **This spec is the single home for the rule.** Other specs
  reference it rather than restating it, so there is one place to change when it
  changes. Its sibling is [iconography](iconography.md): a glyph that labels a
  control is **not type at all** and never reaches a face token — it is drawn.
  The two specs meet at the `←` keycap, which this rule could not save (the app
  bundles no font, so a face token is a request, not a guarantee). A spec may still record a *local* consequence (the way
  [webrtc-sync](webrtc-sync.md) notes that its body copy must not reuse
  `Modal.tagClass`).

- **REQ-6** — **The rule is pinned by `tests/ui/typography.test.ts`**, because
  nothing else can enforce it: CSS is exempt from `sdd-guard`, and the jsdom
  suite never resolves CSS Modules to real CSS. The pin reads the stylesheets as
  text and asserts that the set of selectors declaring `font-family:
  var(--serif)` **equals an explicit allowlist** in the test. A new serif use
  fails the suite until someone adds it to that list — which is the moment they
  read this spec. The list carries **no** standing exceptions: an entry that
  needs a "known deviation" note is a bug someone decided not to fix.

## Technical design

### Contract / public interface

`src/styles/theme.css`, in `:root`:

```yaml
--serif: "'Georgia', 'Times New Roman', serif"   # display: identity + legends
--sans:  "'Inter', system-ui, -apple-system, sans-serif"  # content (the default)
--mono:  "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"  # readouts
```

There is no fourth face and no size scale — sizes are set per component.

### Layer touchpoints & ordering

- `base.css` loads before `theme.css` (`index.html`), and sets the `html, body`
  face to the same stack `--sans` holds. Sans is therefore the inherited
  default, and **every** `var(--serif)` / `var(--mono)` in `src/ui/styles/` is an
  opt-in that this spec governs. Grepping `var(--serif)` enumerates them.
- Purely a styling contract: no bus param, no engine coupling, nothing to
  persist. It constrains `src/ui/styles/*.module.css` and the rare inline
  `style.fontFamily` (`sync-pair-modal.ts` sets both faces by hand, because its
  wizard frames are built without a module class).
- `<noscript>` in `index.html` inlines `Georgia, serif` — outside the app shell,
  where no custom property is available. Out of scope.

### Persistence

None.

## Scenarios (BDD)

```gherkin
Scenario: a text field is never rendered in the display serif (regression)
  Given the dropdown filter row, which the user types into
  Then its input and its "No match" status line use --sans, not --serif
# pinned by: tests/ui/typography.test.ts

Scenario: every serif use is a declared one (REQ-6)
  Given a CSS Module adds font-family: var(--serif) to a new selector
  Then the typography drift pin fails until that selector is declared display type
# pinned by: tests/ui/typography.test.ts

Scenario: a counter is never set in the display serif (regression, REQ-3)
  Given the two live position readouts — the transport's bar.step and the ruler's ‹ BAR n/N ›
  Then both are --mono, so their digits keep a fixed width as they count
# pinned by: tests/ui/typography.test.ts

Scenario: the allowlist cannot rot silently (edge, REQ-6)
  Given an allowlisted selector whose serif declaration is later removed
  Then the pin fails on the stale entry rather than passing on a shrinking set
# pinned by: tests/ui/typography.test.ts
```

## Tests & verification

- Unit: `tests/ui/typography.test.ts` — `npm test`
- Typecheck: `npm run typecheck`
- Manual: appearance is verified **by eye** — this rule is about legibility, and
  a passing pin only proves which token was named. Open an XY Pad axis picker
  (~198 options, so [dropdown](dropdown.md) REQ-7's filter row appears): the
  search field must read as a field, visibly distinct from the serif legends
  around it.

## Open questions / future

- The `‹ BAR n/N ›` ruler readout was the last REQ-3 holdout and is now `--mono`
  (see [transport-position](transport-position.md) REQ-15/REQ-16). The
  allowlist is exception-free as of v1 — keep it that way.
- The tour's info badge (`tour.module.css` `.badge`) is serif *italic* and stays
  that way: its content is the letter **`i`**, and the serif italic is what makes
  the mark read as "info". It looks like a numeral case at a glance and is not
  one — noted here so nobody re-files it as a REQ-3 bug.
- The `.option` list is allowlisted as a legend, but the XY Pad axis pickers
  render ~198 dotted param ids (`fx.drum.comp`) through it — data wearing a
  legend's clothes. Left serif deliberately, to keep the menu of one piece with
  its toggle; revisit if the ids grow longer.
- No type *scale* is specified (sizes range 7.5 px–26 px, set per component).
  Worth doing only if a second theme ever lands.
