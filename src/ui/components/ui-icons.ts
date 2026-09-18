/**
 * The app's general icon set (iconography.md REQ-a-control-glyph-is-inline-svg/REQ-one-icon-builder-four-sets) — every glyph that
 * labels a control, drawn rather than typed.
 *
 * These used to be Unicode characters set as text, which quietly made the
 * browser's font-fallback chain part of the design. `--sans` names Inter, but
 * Inter is not bundled (no `@font-face` anywhere, and the CSP pins
 * `font-src 'self'`), so on Android it resolves to Roboto, arrows fall through
 * to Noto Sans Symbols at their own weight and baseline, and `💡 🎲 ✨ ✕ ✓ ⚙`
 * come back as full-colour emoji. Drawing them ends the whole class of bug.
 *
 * Modeled on `rest-glyph.ts` rather than `header-icons.ts`: no per-context
 * stylesheet is required, because `base.css` strokes `svg.ui-icon` globally and
 * sizes it in `em` — so one icon renders correctly on a keycap, in a button and
 * inside a help paragraph, at each one's own font-size (REQ-compact-drops-text-not-icon).
 *
 * No inline colour anywhere: `currentColor` is what lets a state class tint a
 * glyph that knows nothing about that state. Solid sub-shapes opt out of the
 * stroke with `class="fill"`, the escape hatch `switch.module.css` established.
 */

/** Wrap one glyph's shapes. `aria-hidden` always — the name lives on the
 *  control, never on the drawing (REQ-heading-is-icon-then-text). */
export const icon = (inner: string): string =>
  `<svg class="ui-icon" viewBox="0 0 16 16" aria-hidden="true">${inner}</svg>`;

/**
 * The ⓘ mark's shapes, shared with `header-icons.ts` so the button in the
 * header and the one help copy points at are the same drawing (REQ-heading-icons-share-one-x). The part
 * classes are hooks `tour.module.css` recolours on the *header* copy only —
 * they are inert here, as they are there until the badges show.
 */
export const INFO_SHAPE =
  '<circle class="disc" cx="8" cy="8" r="6"/>'
  + '<path class="stem" d="M8 7.5 V11.2"/>'
  + '<circle class="fill dot" cx="8" cy="5" r="1"/>';

export const UI_ICONS = {
  /** ← — the octave-shift keycaps, "Back", help copy naming the key. */
  arrowLeft: icon('<path d="M13 8 H3"/><path d="M6.5 4.5 L3 8 L6.5 11.5"/>'),
  /** → — its pair. Kept as a separate glyph rather than a rotated one, so the
   *  two are legible at the same stroke weight without a transform. */
  arrowRight: icon('<path d="M3 8 H13"/><path d="M9.5 4.5 L13 8 L9.5 11.5"/>'),

  /** ‹ — the playhead ruler's one-bar-back nav. */
  chevronLeft: icon('<path d="M10 3.5 L5.5 8 L10 12.5"/>'),
  /** › — one bar forward. */
  chevronRight: icon('<path d="M6 3.5 L10.5 8 L6 12.5"/>'),

  /** ◀ — move the selected chain slot one place left. */
  triangleLeft: icon('<path class="fill" d="M10.5 3 L4.5 8 L10.5 13 Z"/>'),
  /** ▶ — one place right; also the "Play a demo" button. */
  triangleRight: icon('<path class="fill" d="M5.5 3 L11.5 8 L5.5 13 Z"/>'),

  /** ⏮ — back to bar 1. */
  toStart: icon('<path d="M4 3.5 V12.5"/><path class="fill" d="M12.5 3.5 L6 8 L12.5 12.5 Z"/>'),

  /** ▾ — the dropdown caret and every fold header. Solid, as the character was:
   *  `dropdown.module.css` and `tabs.module.css` rotate it, which works on an
   *  `<svg>` unchanged. */
  caretDown: icon('<path class="fill" d="M4.6 6.7 L8 10.2 L11.4 6.7 Z"/>'),
  /** ▸ — the same caret folded (the seq panel draws it explicitly rather than
   *  rotating, because its label sits beside it). */
  caretRight: icon('<path class="fill" d="M6.7 4.6 L10.2 8 L6.7 11.4 Z"/>'),

  /** ✕ — close a floating window, dismiss a toast, remove a chain slot. */
  close: icon('<path d="M4 4 L12 12"/><path d="M12 4 L4 12"/>'),
  /** ✓ — "Linked", and the tour's confirmation. */
  check: icon('<path d="M3.5 8.5 L6.5 11.5 L12.5 4.5"/>'),

  /** ⚙ — the in-panel "reveals a setting" affordance (About's keyboard layout,
   *  the XY Pad's axis assignment). Teeth as radial ticks, because a toothed
   *  outline turns to mush below ~14px — but they start *on* the hub (3.6 to a
   *  3.4 radius), or the gap makes the whole thing read as a sun. */
  gear: icon(
    '<circle cx="8" cy="8" r="3.4"/>' +
    '<path d="M11.6 8 H14.1"/><path d="M1.9 8 H4.4"/>' +
    '<path d="M8 11.6 V14.1"/><path d="M8 1.9 V4.4"/>' +
    '<path d="M10.55 10.55 L12.31 12.31"/><path d="M3.69 3.69 L5.45 5.45"/>' +
    '<path d="M5.45 10.55 L3.69 12.31"/><path d="M12.31 3.69 L10.55 5.45"/>',
  ),

  /** ❐ — "this opens in a floating window". Two overlapping frames. */
  popOut: icon('<path d="M2.5 5.5 H10.5 V13.5 H2.5 Z"/><path d="M5.5 10.5 V2.5 H13.5 V10.5 H5.5"/>'),

  /** ✎ — re-open a loaded sample in the editor. */
  edit: icon(
    '<path d="M11.3 2.4 L13.6 4.7 L5.6 12.7 L2.4 13.6 L3.3 10.4 Z"/>' +
    '<path d="M9.9 3.8 L12.2 6.1"/>',
  ),

  /** ☰ — the responsive header's menu toggle. */
  menu: icon('<path d="M2.5 4.5 H13.5"/><path d="M2.5 8 H13.5"/><path d="M2.5 11.5 H13.5"/>'),

  /** ✨ — the AI Prompt button. Two four-point stars, since one reads as a
   *  rating star and the pair reads as "generated". */
  sparkle: icon(
    '<path class="fill" d="M6.6 2.6 L7.9 6.9 L12.2 8.2 L7.9 9.5 L6.6 13.8 ' +
    'L5.3 9.5 L1 8.2 L5.3 6.9 Z"/>' +
    '<path class="fill" d="M12.4 1.4 L13 3.3 L14.9 3.9 L13 4.5 L12.4 6.4 ' +
    'L11.8 4.5 L9.9 3.9 L11.8 3.3 Z"/>',
  ),

  /** 🎲 — the drum randomiser. */
  dice: icon(
    '<rect x="2.5" y="2.5" width="11" height="11" rx="2.2"/>' +
    '<circle class="fill" cx="5.6" cy="5.6" r="0.95"/>' +
    '<circle class="fill" cx="8" cy="8" r="0.95"/>' +
    '<circle class="fill" cx="10.4" cy="10.4" r="0.95"/>',
  ),

  /** 💡 — the pairing wizard's hint line. */
  bulb: icon(
    '<circle cx="8" cy="6.4" r="3.9"/>' +
    '<path d="M6.3 11.4 H9.7"/><path d="M7 13.4 H9"/>',
  ),

  /** ↺ — "go back to the inherited value" on a motion lane. Three quarters of
   *  a circle drawn anticlockwise from the top, so the head lands on the right
   *  pointing up: a smaller head or one tangent to the arc reads as a nub
   *  rather than an arrow at this size. */
  reset: icon(
    '<path d="M8 3.5 A4.5 4.5 0 1 0 12.5 8"/>' +
    '<path class="fill" d="M12.5 5.2 L14.7 8.7 L10.3 8.7 Z"/>',
  ),

  /** ⓘ — the info-badges toggle, where help copy names it. */
  info: icon(INFO_SHAPE),

  /** ↗ — a Song-tab card jumping to its machine's chain. */
  launch: icon('<path d="M4.5 11.5 L11.5 4.5"/><path d="M6.5 4.5 H11.5 V9.5"/>'),

  /** Download — an arrow landing in a tray: About's Play offline, which saves
   *  the whole app on the device (play-offline.md REQ-one-offline-state-machine-many-views). */
  download: icon('<path d="M8 2.5 V9.5"/><path d="M4.8 6.6 L8 9.8 L11.2 6.6"/><path d="M2.5 10.5 V13 H13.5 V10.5"/>'),

  // — section headings (section-title.md REQ-heading-is-icon-then-text). No character stood in for
  //   these; they are drawn at ~14px, which is what the detail is sized for. —

  /** FX — one burst of sound on a scope: a flat line in, a run of narrow peaks
   *  at different heights (the tallest right of centre, after the deepest
   *  trough), a flat line out. Traced from the user's reference drawing, then
   *  made taller, with narrower peaks, so they keep ~1px apart at 14px. It replaced
   *  a stompbox, a hard-clipped sine and a sine with a spike, none of which read
   *  at this size (section-title.md REQ-heading-is-icon-then-text). */
  waveBurst: icon('<path d="M0.8 8.4 H1.9 C2.2 8.4 2.6 10.78 2.9 10.78 C3.46 10.78 4.22 6.4 4.78 6.4 C5.38 6.4 6.17 11.84 6.77 11.84 C7.55 11.84 8.59 3.03 9.37 3.03 C9.87 3.03 10.53 11.4 11.03 11.4 C11.71 11.4 12.62 6.65 13.3 6.65 C13.6 6.65 14 8.4 14.3 8.4 H15.2"/>'),

  /** MACHINES — a groovebox seen from above: a landscape body, a display and a
   *  knob across the top, a row of three pads below. The silhouette of the thing
   *  the row holds. Landscape on purpose: an upright box with a display over a 2x2
   *  pad block reads as a calculator at 14px, and a step grid read as noise
   *  (section-title.md REQ-heading-is-icon-then-text). */
  padMachine: icon(
    '<rect x="0.8" y="3" width="14.4" height="10" rx="1.8"/>' +
    '<rect class="fill" x="3" y="5" width="5.2" height="2" rx="0.4"/>' +
    '<circle class="fill" cx="11.9" cy="6" r="1.15"/>' +
    '<rect class="fill" x="2.9" y="8.7" width="2.6" height="2.3" rx="0.45"/>' +
    '<rect class="fill" x="6.7" y="8.7" width="2.6" height="2.3" rx="0.45"/>' +
    '<rect class="fill" x="10.5" y="8.7" width="2.6" height="2.3" rx="0.45"/>',
  ),

  /** EQUALIZER — three faders, each cap at its own height. */
  sliders: icon(
    '<path d="M4 2 V14"/><path d="M8 2 V14"/><path d="M12 2 V14"/>' +
    '<rect class="fill" x="2.2" y="8.6" width="3.6" height="2.2" rx="0.6"/>' +
    '<rect class="fill" x="6.2" y="3.6" width="3.6" height="2.2" rx="0.6"/>' +
    '<rect class="fill" x="10.2" y="6.6" width="3.6" height="2.2" rx="0.6"/>',
  ),
} as const;

export type IconName = keyof typeof UI_ICONS;

/**
 * An icon as an element. Pass `label` for an icon standing alone where no
 * button carries the name — a bare `<span>` is invisible to a screen reader,
 * so it needs both `role="img"` and the label (REQ-heading-is-icon-then-text).
 */
export function iconEl(name: IconName, label?: string): HTMLElement {
  const el = document.createElement('span');
  el.innerHTML = UI_ICONS[name];
  if (label !== undefined) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
  }
  return el;
}

/**
 * Icon + text as one markup string. The icon is `aria-hidden` and the text is
 * the accessible name, which deliberately **shortens** it: "AI Prompt", never
 * "sparkles AI Prompt" (REQ-heading-is-icon-then-text).
 */
export function iconLabel(
  name: IconName,
  text: string,
  pos: 'before' | 'after' = 'before',
): string {
  const glyph = UI_ICONS[name];
  const label = `<span class="icon-label">${text}</span>`;
  return pos === 'before' ? `${glyph}${label}` : `${label}${glyph}`;
}

/**
 * `iconLabel` as DOM rather than markup, for text that is **not** a literal —
 * a diagnostics hint, a filename, anything derived from input. Building the
 * node keeps the text a text node, so it can never be parsed as markup
 * (untrusted-input.md). Same `.icon-label` gap, so the two look identical.
 */
export function iconTextEl(
  name: IconName,
  text: string,
  pos: 'before' | 'after' = 'before',
): HTMLElement {
  const wrap = document.createElement('span');
  const label = document.createElement('span');
  label.className = 'icon-label';
  label.textContent = text;
  // The bare <svg>, not `iconEl`'s <span> around it: base.css spaces the pair
  // with `svg.ui-icon + .icon-label`, which only matches direct siblings. A
  // wrapper here silently dropped the gap on every caller (iconography.md v2).
  wrap.innerHTML = UI_ICONS[name];
  const glyph = wrap.firstElementChild!;
  if (pos === 'before') wrap.append(label);
  else wrap.insertBefore(label, glyph);
  return wrap;
}
