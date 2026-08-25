// The Keyboard Shortcuts section of the About modal (onboarding.md REQ-17): the
// canonical shortcut table, the keycap/keyboard-diagram DSL that draws it, and
// the keyboard-layout picker in its header.
//
// Split out of about.ts, which had grown five unrelated tenants. This one is
// self-contained — it renders a reference table and owns no app state — and it
// rides the lazy About chunk (runtime-performance.md REQ-1), which is also what
// keeps `dropdown.ts` and `state/keyboard-layout.ts` off the boot path here.
import { Modal } from './modal';
import { createButton } from './button';
import { createCollapseToggle } from './collapse-toggle';
import { NOTE_ROWS } from '../shortcuts';
import { Dropdown } from './dropdown';
import { UI_ICONS, type IconName } from './ui-icons';
import {
  LAYOUTS, labelFor, readLayoutPref, writeLayoutPref, resolveLayout, onLayoutChange,
  type LayoutId, type LayoutPref,
} from '../../state/keyboard-layout';
import styles from '../styles/modal.module.css';

/** One token of a combo: a bare string is a keycap, `t(...)` is literal text,
 *  `k(...)` is a keycap whose label is a drawn glyph rather than a character. */
type Token = string | { text: string } | { icon: IconName; name: string };
/** Literal text between caps — a `+`, a `(hold)`, a mouse action. Keep the
 *  spacing: flex layout trims it visually, and it keeps each cell's
 *  `textContent` reading the way a human would say the combo. */
const t = (text: string): { text: string } => ({ text });

/**
 * A keycap labelled with an icon (iconography.md REQ-1). `name` is not
 * decoration: the cap holds no text, so it is the only thing a screen reader
 * has to go on (REQ-3 there).
 */
const k = (icon: IconName, name: string): { icon: IconName; name: string } => ({ icon, name });

/** The two note rows are a keyboard diagram, not a token list (REQ-17c). */
const notes = (row: Record<string, number>): { notes: Record<string, number> } => ({ notes: row });

type Combo = Token[] | { notes: Record<string, number> };

/**
 * The canonical on-screen shortcut reference (onboarding.md REQ-17) — it must
 * name every global key. The first `SHORTCUTS_SHOWN` rows are what a first-time
 * player needs; the rest are folded away behind the section header (REQ-17b),
 * so the cut point below is load-bearing, not cosmetic.
 *
 * Combos are token lists so only *keys* are drawn as keys (REQ-17c): in
 * `Shift + drag` the cap ends at Shift, which is what stops "drag" reading as
 * keyboard input.
 */
const SHORTCUTS: Array<[Combo, string]> = [
  [notes(NOTE_ROWS.lower), 'Play notes — lower octave'],
  [notes(NOTE_ROWS.upper), 'Play notes — upper octave'],
  [[k('arrowLeft', 'Left arrow'), k('arrowRight', 'Right arrow')], 'Shift keyboard octave down / up'],
  // Two rows, not one: the keys are stacked vertically on the board, so the
  // list stacks them too (input-control.md REQ-12).
  [["'"], 'Pitch bend up'],
  [['/'], 'Pitch bend down'],
  [['Space'], 'Play / stop transport'],
  // ---- folded by default; everything above ends at Space (REQ-17b) ----
  [['Home'], 'Move the playhead to bar 1'],
  [['Shift', t(' + '), k('arrowLeft', 'Left arrow'), k('arrowRight', 'Right arrow')], 'Move the playhead one bar'],
  [['F', t(' (hold)')], 'Drum fill'],
  [['Shift', t(' + '), 'R'], 'Open / close the Record window'],
  [['Esc'], 'Panic — all notes off'],
  [['Delete'], 'Clear the selected step'],
  [['Ctrl/Cmd', t(' + '), 'Z'], 'Undo the last grid edit'],
  [['?'], 'Show / hide the info badges'],
  [['Shift', t(' + drag')], 'Fine knob control'],
];

/** Rows visible before the fold. The rule is "through `Space`", not the number
 *  itself — it went 5 → 6 when pitch bend became one row per key. */
const SHORTCUTS_SHOWN = 6;

/** One keycap. `variant` tints the two ranks of the note diagram apart. */
function cap(label: string, variant?: 'natural' | 'sharp'): HTMLElement {
  const el = document.createElement('span');
  el.className = styles.cap!;
  if (variant === 'natural') el.classList.add(styles.capNatural!);
  if (variant === 'sharp') el.classList.add(styles.capSharp!);
  el.textContent = label;
  return el;
}

/**
 * A keycap whose label is a drawn glyph. Until v17 these were arrow *characters*
 * re-faced to the UI sans, because the monospace cap face has no arrow — which
 * worked until Android, where the sans face has none either and the character
 * fell through to a symbol font at its own weight and baseline
 * (iconography.md). The cap is textless, so it carries the accessible name.
 */
function iconCap(name: IconName, label: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `${styles.cap!} ${styles.iconCap!}`;
  el.innerHTML = UI_ICONS[name];
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  return el;
}

/**
 * A cap standing for a *physical* key: its label is whatever the active layout
 * prints there (keyboard-layout.md REQ-1). `data-code` is what lets a layout
 * switch relabel it in place — the diagram's structure is the piano's and never
 * varies, so only these text nodes move (onboarding.md REQ-17c).
 */
function codeCap(code: string, variant?: 'natural' | 'sharp'): HTMLElement {
  const el = cap(labelFor(code).toUpperCase(), variant);
  el.dataset.code = code;
  return el;
}

/** Re-read every physical-key cap's label after a layout change. */
function relabelCaps(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-code]')) {
    el.textContent = labelFor(el.dataset.code!).toUpperCase();
  }
}

/** A cap-sized hole. The two note ranks stay aligned because the gaps occupy a
 *  real box, so neither rank needs positioning maths (REQ-17c). */
function capBlank(): HTMLElement {
  const el = document.createElement('span');
  el.className = `${styles.cap!} ${styles.capBlank!}`;
  return el;
}

/** Semitone → index among the naturals of an octave (C=0 … B=6); -1 for a
 *  sharp. The gaps at E–F and B–C fall out of this table, which is exactly the
 *  visual break that makes the diagram read as a keyboard. */
const NATURAL_INDEX = [0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6];

const naturalColumn = (rel: number): number =>
  Math.floor(rel / 12) * 7 + NATURAL_INDEX[rel % 12]!;

/**
 * The two-row keyboard diagram, derived from the real code→semitone map so it
 * can never disagree with the bindings it documents (REQ-17c). The *labels*
 * come from the active layout; the shape never does.
 *
 * Naturals form the lower rank in order; each sharp sits in the gap *after* the
 * natural below it, and the rank is shifted half a cap right, so a sharp lands
 * between its two neighbours the way it does on a piano.
 */
function notesCell(row: Record<string, number>): HTMLElement {
  const base = Math.min(...Object.values(row));
  const naturals: string[] = [];
  const sharps: Array<string | null> = [];

  for (const [code, semitone] of Object.entries(row)) {
    const rel = semitone - base;
    if (NATURAL_INDEX[rel % 12]! >= 0) naturals[naturalColumn(rel)] = code;
    else sharps[naturalColumn(rel - 1)] = code;
  }

  const cell = document.createElement('div');
  cell.className = `${styles.combo!} ${styles.notes!}`;

  const sharpRow = document.createElement('div');
  sharpRow.className = `${styles.notesRow!} ${styles.notesSharps!}`;
  // One slot per gap between naturals; the two without a sharp are blanks.
  for (let i = 0; i < naturals.length - 1; i++) {
    sharpRow.appendChild(sharps[i] ? codeCap(sharps[i]!, 'sharp') : capBlank());
  }

  const naturalRow = document.createElement('div');
  naturalRow.className = styles.notesRow!;
  for (const code of naturals) naturalRow.appendChild(codeCap(code, 'natural'));

  cell.appendChild(sharpRow);
  cell.appendChild(naturalRow);
  return cell;
}

function comboCell(combo: Combo): HTMLElement {
  if ('notes' in combo) return notesCell(combo.notes);
  const cell = document.createElement('div');
  cell.className = styles.combo!;
  for (const token of combo) {
    if (typeof token === 'string') cell.appendChild(cap(token));
    else if ('icon' in token) cell.appendChild(iconCap(token.icon, token.name));
    else cell.appendChild(document.createTextNode(token.text));
  }
  return cell;
}

/**
 * The Keyboard Shortcuts section: a foldable header plus the two-column key
 * grid, cut to `SHORTCUTS_SHOWN` rows by default (onboarding.md REQ-17b).
 *
 * The overflow rows live in the **same** grid as the visible ones and are merely
 * `display: none` — a second grid would size its own columns and the key column
 * would visibly jump width on expand. And the fold is `createCollapseToggle`,
 * the very component the Debug section below uses, so the chevron is literally
 * the same glyph and rotation rather than a lookalike.
 */
export function buildShortcuts(): { header: HTMLElement; row: HTMLElement; keys: HTMLElement } {
  const header = document.createElement('div');
  header.className = `${Modal.secClass} ${styles.secFold!}`;

  // The gear belongs to the title, so they share a box and travel together —
  // loose in the header it would drift into the middle of the row.
  const layout = buildLayoutPicker();
  const title = document.createElement('div');
  title.className = styles.secFoldTitle!;
  const label = document.createElement('span');
  label.textContent = 'Keyboard Shortcuts';
  title.append(label, layout.gear);
  header.appendChild(title);

  // "Show all" / "Show less" — the verb matters: a bare "all" is a label the
  // reader has to interpret, where this says what the click does. The chevron
  // beside it is the same affordance, just wordless.
  const hint = document.createElement('span');
  hint.className = styles.secFoldHint!;
  header.appendChild(hint);

  const keys = document.createElement('div');
  keys.className = Modal.keysClass;
  SHORTCUTS.forEach(([combo, action], i) => {
    const k = comboCell(combo);
    const a = document.createElement('div');
    a.className = Modal.actClass;
    a.textContent = action;
    // Both cells of a row, or the grid would keep half of it.
    if (i >= SHORTCUTS_SHOWN) {
      k.classList.add(styles.keyOverflow!);
      a.classList.add(styles.keyOverflow!);
    }
    keys.appendChild(k);
    keys.appendChild(a);
  });

  const toggle = createCollapseToggle(keys, 'websynth.shortcuts.about', {
    defaultCollapsed: () => true,
    trigger: header,
    onChange: (collapsed) => { hint.textContent = collapsed ? 'Show all' : 'Show less'; },
  });
  // The component's generic "Collapse panel" would be a lie here — folded is the
  // resting state, and what the button offers is the rest of the list.
  toggle.el.setAttribute('aria-label', 'Show all keyboard shortcuts');
  header.appendChild(toggle.el);

  // Subscribed rather than wired to the picker's own change, so the diagram
  // also follows a layout settled by detection (keyboard-layout.md REQ-4) —
  // whatever moved it, the caps follow.
  onLayoutChange(() => relabelCaps(keys));

  return { header, row: layout.row, keys };
}

/**
 * The keyboard-layout picker (keyboard-layout.md): a gear in the section header
 * revealing a select. The gear must swallow its own click — the whole header is
 * the fold's `trigger`, so otherwise reaching for the layout would collapse the
 * list you opened it to read (the `xy-pad.ts` gear does the same).
 */
function buildLayoutPicker(): { gear: HTMLButtonElement; row: HTMLElement } {
  const ids = Object.keys(LAYOUTS) as LayoutId[];
  const AUTO = 'Auto-detect';
  const options = [AUTO, ...ids.map((id) => LAYOUTS[id].label)];

  const labelOf = (pref: LayoutPref): string =>
    pref === 'auto' ? AUTO : LAYOUTS[pref].label;
  const prefOf = (label: string): LayoutPref =>
    label === AUTO ? 'auto' : (ids.find((id) => LAYOUTS[id].label === label) ?? 'qwerty');

  const row = document.createElement('div');
  row.className = `${styles.layoutRow!} collapsed`;

  const caption = document.createElement('span');
  caption.className = styles.layoutLabel!;
  caption.textContent = 'Layout';

  // 'Auto-detect' resolves to something concrete — name it, so the picker is
  // never a claim the user cannot check. Hidden once they choose explicitly.
  const note = document.createElement('span');
  note.className = styles.layoutNote!;
  const showResolved = (): void => {
    note.textContent = `Detected: ${LAYOUTS[resolveLayout()].label}`;
    note.classList.toggle('hidden', readLayoutPref() !== 'auto');
  };
  showResolved();

  const dd = new Dropdown(options, labelOf(readLayoutPref()));
  dd.el.dataset.testid = 'shortcuts-layout-select';
  // Writing the pref notifies every consumer, the diagram included.
  dd.onChange((label) => {
    writeLayoutPref(prefOf(label));
    showResolved();
  });
  onLayoutChange(showResolved);

  row.append(caption, dd.el, note);

  // The same gear the XY Pad's axis-assignment button uses, not one of the
  // header's glyphs — this is the in-panel "reveals a setting" affordance, and
  // it should look like the one the app already has.
  let open = false;
  const gear = createButton({
    label: 'Keyboard layout',
    icon: UI_ICONS.gear,
    title: 'Keyboard layout',
    className: styles.gearBtn!,
    testId: 'shortcuts-layout-gear',
    onClick: (ev) => {
      ev.stopPropagation(); // never fold the list on the way to the picker
      open = !open;
      row.classList.toggle('collapsed', !open);
      gear.setAttribute('aria-expanded', String(open));
    },
  });
  gear.setAttribute('aria-expanded', 'false');

  return { gear, row };
}
