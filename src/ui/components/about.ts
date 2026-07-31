// The header's "?" button + the About modal behind it: the guided tour, version,
// copyright, keyboard shortcuts, and a collapsible Debug section (live state +
// the actions that act on it — see debug-panel.md).
//
// Since v15 this is the app's single help door (onboarding.md REQ-20) — the ⓘ
// button beside it does one thing only, toggle the badges. Hence the ? glyph:
// the tour and the shortcut list are help, not credits.
import { Modal } from './modal';
import { createButton, setButtonLabel } from './button';
import { createBrand } from './brand';
import { confirmDialog } from './dialog';
import { HEADER_ICONS } from './header-icons';
import { createCollapseToggle } from './collapse-toggle';
import { copyText, flashCopied } from '../clipboard';
import { isIOS } from '../../platform/ios';
import { perfDiagnostics } from '../../state/perf-mode';
import { restoreFactorySettings } from '../../state/factory-reset';
import { SessionAutosave } from '../../state/session-autosave';
import { SampleAutosave } from '../../state/sample-autosave';
import { storageUsage } from '../../state/slot-store';
import { SAMPLER_SLOT_COUNT } from '../../state/patterns';
import { NOTE_ROWS } from '../shortcuts';
import { Dropdown } from './dropdown';
import {
  LAYOUTS, labelFor, readLayoutPref, writeLayoutPref, resolveLayout, onLayoutChange,
  type LayoutId, type LayoutPref,
} from '../../state/keyboard-layout';
import type { StudioApi } from '../studio-api';
import switchStyles from '../styles/switch.module.css';
import dialogStyles from '../styles/dialog.module.css';
import styles from '../styles/modal.module.css';

declare const __APP_VERSION__: string;

/** One token of a combo: a bare string is a keycap, `t(...)` is literal text. */
type Token = string | { text: string };
/** Literal text between caps — a `+`, a `(hold)`, a mouse action. Keep the
 *  spacing: flex layout trims it visually, and it keeps each cell's
 *  `textContent` reading the way a human would say the combo. */
const t = (text: string): { text: string } => ({ text });

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
  [['←', '→'], 'Shift keyboard octave down / up'],
  // Two rows, not one: the keys are stacked vertically on the board, so the
  // list stacks them too (input-control.md REQ-12).
  [["'"], 'Pitch bend up'],
  [['/'], 'Pitch bend down'],
  [['Space'], 'Play / stop transport'],
  // ---- folded by default; everything above ends at Space (REQ-17b) ----
  [['Home'], 'Move the playhead to bar 1'],
  [['Shift', t(' + '), '←', '→'], 'Move the playhead one bar'],
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

/**
 * Arrows and other symbols have no glyph in the monospace face, so the browser
 * falls back per character and draws them much smaller than their neighbours —
 * unreadable at the key row's size. Such a cap is drawn in the UI sans instead
 * (onboarding.md REQ-17).
 */
const SYMBOL = /^[←→↑↓⌫⏮]+$/;

/** One keycap. `variant` tints the two ranks of the note diagram apart. */
function cap(label: string, variant?: 'natural' | 'sharp'): HTMLElement {
  const el = document.createElement('span');
  el.className = styles.cap!;
  if (SYMBOL.test(label)) el.classList.add(Modal.glyphClass);
  if (variant === 'natural') el.classList.add(styles.capNatural!);
  if (variant === 'sharp') el.classList.add(styles.capSharp!);
  el.textContent = label;
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
    else cell.appendChild(document.createTextNode(token.text));
  }
  return cell;
}

/**
 * Late-bound source for the Debug panel's "Sampler clips" row — `main.ts` binds
 * it to the `SampleAutosave` it owns (sample-persistence.md REQ-12). Same
 * late-bound-hook idiom as app.ts's live scope knobs; unbound it reads as "n/a",
 * which is exactly right in a build where clip persistence never started.
 */
let clipStats: (() => { count: number; bytes: number }) | null = null;
export function setClipStatsSource(fn: () => { count: number; bytes: number }): void {
  clipStats = fn;
}

/** Late-bound MIDI port counts — `main.ts` binds it once `initMIDI` resolves an
 *  access handle (the audio layer must not import UI). Unbound = "n/a": before
 *  the start gesture there is deliberately no MIDI permission prompt. */
let midiStats: (() => { inputs: number; outputs: number }) | null = null;
export function setMidiStatsSource(fn: () => { inputs: number; outputs: number }): void {
  midiStats = fn;
}

/** Late-bound wake-lock state — bound by `main.ts`, which owns the manager. */
let wakeState: (() => { supported: boolean; held: boolean }) | null = null;
export function setWakeLockSource(fn: () => { supported: boolean; held: boolean }): void {
  wakeState = fn;
}

/** What the modal needs from the onboarding layer, injected so `about.ts` never
 *  imports it (onboarding.md REQ-20, the same rule the tour's `TourCtx` follows). */
export interface AboutDeps {
  startTour: () => void;
}

export function createAboutButton(engine: StudioApi, deps: AboutDeps): HTMLButtonElement {
  // `open` is a hoisted function declaration, so wiring it here is safe.
  const btn = createButton({
    label: 'Help & About',
    icon: HEADER_ICONS.help,
    title: 'Help & About',
    testId: 'about-button',
    onClick: open,
  });

  let backdrop: HTMLElement | null = null;
  let refreshDebug: (() => void) | null = null;
  let disposeDebug: (() => void) | null = null;
  let closeTimer: number | undefined;
  let refreshTimer: number | undefined;

  // A dialog stacked on top (the factory-reset confirm) owns Escape: its own
  // capture listener registered later would be starved by this one's
  // stopImmediatePropagation, so yield while any other backdrop is visible.
  const dialogOnTop = (): boolean =>
    [...document.querySelectorAll(`.${Modal.backdropClass}`)]
      .some((el) => el !== backdrop && !el.classList.contains('hidden'));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !dialogOnTop()) {
      // Beat the global Escape→panic handler in shortcuts.ts.
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };

  // Keep the live Debug readout current only while the modal is open — and,
  // inside it, only while the section is expanded (the hook is a gated tick).
  const onState = () => refreshDebug?.();

  function close(): void {
    if (!backdrop) return;
    window.removeEventListener('keydown', onKey, true);
    engine.ctx.removeEventListener('statechange', onState);
    window.clearInterval(refreshTimer);
    // A test tone still ringing must not outlive the panel (debug-panel REQ-9).
    disposeDebug?.();
    backdrop.classList.add('hidden');
    const el = backdrop;
    closeTimer = window.setTimeout(() => el.remove(), 200);
  }

  function open(): void {
    window.clearTimeout(closeTimer);
    if (!backdrop) {
      const built = buildModal(close, engine, deps);
      backdrop = built.backdrop;
      refreshDebug = built.refreshDebug;
      disposeDebug = built.disposeDebug;
    }
    document.body.appendChild(backdrop);
    // Force reflow so the opacity transition runs from the .hidden state.
    void backdrop.offsetWidth;
    backdrop.classList.remove('hidden');
    refreshDebug?.();
    window.addEventListener('keydown', onKey, true);
    engine.ctx.addEventListener('statechange', onState);
    // Poll while open so values that change without an event (e.g. the silent
    // loop's currentTime advancing) visibly tick. Cleared in close(), and a
    // no-op whenever the Debug section is collapsed.
    refreshTimer = window.setInterval(() => refreshDebug?.(), 500);
  }

  return btn;
}

function buildModal(close: () => void, engine: StudioApi, deps: AboutDeps): {
  backdrop: HTMLElement;
  refreshDebug: () => void;
  disposeDebug: () => void;
} {
  const backdrop = document.createElement('div');
  backdrop.className = `${Modal.backdropClass} hidden`;
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });

  const card = document.createElement('div');
  card.className = Modal.cardClass;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'About VAST G1-J5');

  // The real faceplate, not a flattened restatement of it (brand.md REQ-1).
  const brand = createBrand();

  const meta = document.createElement('div');
  meta.className = Modal.metaClass;
  const version = document.createElement('div');
  version.innerHTML = `Version <strong>${__APP_VERSION__}</strong>`;
  const copyright = document.createElement('div');
  copyright.innerHTML = `&copy; ${new Date().getFullYear()} <strong>Gijs Oliemans</strong>`;
  const source = document.createElement('div');
  const link = document.createElement('a');
  link.href = 'https://github.com/status201/vast-websynth';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'github.com/status201/vast-websynth';
  source.appendChild(link);
  meta.appendChild(version);
  meta.appendChild(copyright);
  meta.appendChild(source);

  // The one action in an otherwise reference-only modal, so it sits above the
  // reference (onboarding.md REQ-20). It is the app's only tour-replay route.
  const tourBtn = createButton({
    label: 'Take the guided tour',
    className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
    testId: 'start-tour',
    onClick: () => {
      close();
      deps.startTour();
    },
  });

  const shortcuts = buildShortcuts();

  const factoryReset = buildFactoryResetButton();

  const debug = buildDebugSection(engine);

  const closeBtn = createButton({
    label: 'Close',
    className: `${switchStyles.root!} ${Modal.closeBtnClass}`,
    onClick: close,
  });

  card.appendChild(brand);
  card.appendChild(meta);
  card.appendChild(tourBtn);
  card.appendChild(shortcuts.header);
  card.appendChild(shortcuts.row);
  card.appendChild(shortcuts.keys);
  card.appendChild(factoryReset);
  card.appendChild(debug.header);
  card.appendChild(debug.body);
  card.appendChild(closeBtn);
  backdrop.appendChild(card);
  return { backdrop, refreshDebug: debug.refresh, disposeDebug: debug.dispose };
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
function buildShortcuts(): { header: HTMLElement; row: HTMLElement; keys: HTMLElement } {
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

  // The same `⚙` the XY Pad's axis-assignment gear uses, not one of the
  // header's inline-SVG glyphs — this is the in-panel "reveals a setting"
  // affordance, and it should look like the one the app already has.
  let open = false;
  const gear = createButton({
    label: 'Keyboard layout',
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
  gear.textContent = '⚙';
  gear.setAttribute('aria-label', 'Keyboard layout');
  gear.setAttribute('aria-expanded', 'false');

  return { gear, row };
}

/**
 * Destructive "Restore to Factory Settings" — wipes all origin-local storage
 * and reloads (specs/features/factory-reset.md). Guarded by the styled
 * confirm, whose italic detail line is the classic Nintendo exit dialog.
 */
function buildFactoryResetButton(): HTMLButtonElement {
  return createButton({
    label: 'Restore to Factory Settings',
    className: `${switchStyles.root!} ${Modal.closeBtnClass} ${dialogStyles.danger!}`,
    testId: 'factory-reset',
    onClick: async () => {
      const ok = await confirmDialog({
        title: 'Restore to Factory Settings',
        message: 'Are you sure? This erases all presets, songs, and settings saved on this device, then reloads the app.',
        detail: '“Everything not saved will be lost.”',
        confirmLabel: 'Restore',
        danger: true,
      });
      // Async only because the sampler-clip store is IndexedDB-backed; the
      // reload happens inside, so nothing here needs the result.
      if (ok) void restoreFactorySettings();
    },
  });
}

/** An inline action button attached to a row's value cell (REQ-6). */
interface RowAction {
  label: string;
  testId: string;
  onClick: () => void;
  /** Destructive: styled red and confirmed before it runs. */
  danger?: boolean;
  /** Confirm copy — required when `danger`. */
  confirm?: { title: string; message: string; confirmLabel: string };
}

const MB = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;

/** "3 min ago" / "just now" — enough to tell a stale autosave from a live one. */
function ago(at: number | null): string {
  if (at === null) return 'unknown age';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/**
 * Default-collapsed Debug section (debug-panel.md). Cross-platform and
 * intentionally minimal + extensible — a feature adds a row (and, since v3, an
 * action) without a contract change.
 *
 * The actions exist because a remote device has no console: on a borrowed phone
 * or a BrowserStack session, *observing* a wedged AudioContext or a poisoned
 * autosave is only half of what you need — you also have to be able to do
 * something about it, and "Restore to Factory Settings" is far too big a hammer.
 */
function buildDebugSection(engine: StudioApi): {
  header: HTMLElement;
  body: HTMLElement;
  refresh: () => void;
  dispose: () => void;
} {
  const header = document.createElement('div');
  header.className = `${Modal.secClass} ${styles.secFold!}`;
  const label = document.createElement('span');
  label.className = styles.secFoldLabel!;
  label.textContent = 'Debug';
  header.appendChild(label);

  // The section body wraps the key/value grid AND the actions row, so collapsing
  // hides both and the grid keeps its own two-column layout.
  const body = document.createElement('div');
  body.className = styles.debugBody!;
  body.dataset.testid = 'debug-section';

  const grid = document.createElement('div');
  grid.className = Modal.keysClass;
  body.appendChild(grid);

  /** Every row, in order — the source for the copyable report (REQ-7). */
  const rows: Array<{ name: string; el: HTMLElement }> = [];

  const rowButton = (action: RowAction): HTMLButtonElement => createButton({
    label: action.label,
    className: `${switchStyles.root!} ${styles.debugBtn!}${action.danger ? ` ${dialogStyles.danger!}` : ''}`,
    testId: action.testId,
    onClick: () => {
      if (!action.confirm) { action.onClick(); return; }
      const c = action.confirm;
      void confirmDialog({ ...c, danger: action.danger ?? false }).then((ok) => {
        if (ok) action.onClick();
      });
    },
  });

  const addRow = (name: string, action?: RowAction): HTMLElement => {
    const k = document.createElement('div');
    k.className = Modal.keyClass;
    k.textContent = name;
    const v = document.createElement('div');
    v.className = Modal.actClass;
    grid.appendChild(k);
    grid.appendChild(v);
    if (!action) {
      rows.push({ name, el: v });
      return v;
    }
    // The value lives in its own span so `refresh` writing textContent can
    // never wipe the button beside it.
    v.classList.add(styles.debugActRow!);
    const val = document.createElement('span');
    v.appendChild(val);
    v.appendChild(rowButton(action));
    rows.push({ name, el: val });
    return val;
  };

  const stateVal = addRow('AudioContext');
  stateVal.dataset.testid = 'debug-ctx-state';
  const rateVal = addRow('Sample rate');
  const latencyVal = addRow('Latency');
  latencyVal.dataset.testid = 'debug-latency';
  // Transport: the clock's OWN bpm, which a slaved clock writes directly —
  // a disagreement with `transport.bpm` is the bug worth seeing (sync).
  const transportVal = addRow('Transport');
  transportVal.dataset.testid = 'debug-transport';
  const iosVal = addRow('iOS');
  // Device / performance-mode diagnostics (owned by performance-mode.md).
  const tierVal = addRow('Perf tier');
  tierVal.dataset.testid = 'debug-perf-tier';
  const coresVal = addRow('CPU cores');
  const memVal = addRow('Device memory');
  const mobileVal = addRow('Mobile UA');
  const profileVal = addRow('Audio profile');
  // Persisted sampler audio (owned by sample-persistence.md) — in-memory
  // bookkeeping, so opening About never touches IndexedDB.
  const clipsClear: RowAction = {
    label: 'Clear',
    testId: 'debug-clips-clear',
    danger: true,
    confirm: {
      title: 'Clear stored sampler clips',
      message: 'Empty every sampler slot and delete the audio kept on this device. The song itself is not touched.',
      confirmLabel: 'Clear clips',
    },
    onClick: () => {
      // Nulling the slots is what the autosaver watches, so it deletes them
      // too; the explicit wipe also clears any orphan the session never named.
      for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) engine.sampler.setBuffer(i, null);
      void SampleAutosave.clear();
    },
  };
  const clipsVal = addRow('Sampler clips', clipsClear);
  clipsVal.dataset.testid = 'debug-sampler-clips';
  const clipsBtn = clipsVal.nextElementSibling as HTMLButtonElement;
  // Session autosave (owned by session-autosave.md) — clearing it is the small
  // hammer for a session the app chokes on.
  const sessionVal = addRow('Session autosave', {
    label: 'Clear',
    testId: 'debug-session-clear',
    danger: true,
    confirm: {
      title: 'Clear the autosaved session',
      message: 'Forget the working session restored at boot. Saved songs and presets are untouched; the app reloads.',
      confirmLabel: 'Clear session',
    },
    onClick: () => { SessionAutosave.clear(); location.reload(); },
  });
  sessionVal.dataset.testid = 'debug-session';
  const storageVal = addRow('Local storage');
  storageVal.dataset.testid = 'debug-storage';
  // Service worker (owned by pwa-install.md) — a stale cache is the classic
  // "why am I not seeing the new version?" on an installed PWA.
  const swVal = addRow('Service worker', {
    label: 'Unregister',
    testId: 'debug-sw-unregister',
    danger: true,
    confirm: {
      title: 'Unregister the service worker',
      message: 'Drop the offline cache and reload. The app will re-register it on the next visit.',
      confirmLabel: 'Unregister',
    },
    onClick: () => { void unregisterServiceWorkers(); },
  });
  swVal.dataset.testid = 'debug-sw';
  const midiVal = addRow('MIDI ports');
  midiVal.dataset.testid = 'debug-midi';
  const wakeVal = addRow('Wake lock');
  wakeVal.dataset.testid = 'debug-wake';
  // iOS audio-session diagnostics (owned by ios-audio.md; inert off iOS).
  const unlockVal = addRow('Audio unlock');
  unlockVal.dataset.testid = 'debug-ios-unlock';
  const loopVal = addRow('Silent loop');
  loopVal.dataset.testid = 'debug-ios-loop';
  // Android keep-alive (owned by media-session.md; inert off Android).
  const mediaVal = addRow('Media session');
  mediaVal.dataset.testid = 'debug-media-session';
  // What the audio thread reports about itself while the page is hidden — the
  // one reading that says whether a background crackle is ours (audio-lifecycle).
  const bgVal = addRow('Background audio');
  bgVal.dataset.testid = 'debug-background';

  // ---- service-worker state (async, so polled far slower than the rows) ----
  let swText = 'unsupported';
  let swChecked = 0;
  const readSw = (): void => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistrations().then((regs) => {
      swText = regs.length === 0
        ? 'none registered'
        : `${regs.length} registered${navigator.serviceWorker.controller ? ' · controlling' : ''}`;
      swVal.textContent = swText;
    }).catch(() => { swText = 'unavailable'; });
  };

  // ---- actions (REQ-7) ----
  const actions = document.createElement('div');
  actions.className = styles.debugActions!;
  actions.dataset.testid = 'debug-actions';

  const ctxToggle = createButton({
    label: 'Resume',
    className: `${switchStyles.root!} ${styles.debugBtn!}`,
    testId: 'debug-ctx-toggle',
    onClick: () => {
      // Suspending is how you prove a stuck note is the graph and not the
      // device; resuming is the escape hatch when the OS suspended us.
      if (engine.ctx.state === 'running') void engine.ctx.suspend();
      else void engine.resume();
    },
  });

  const panicBtn = createButton({
    label: 'Panic',
    className: `${switchStyles.root!} ${styles.debugBtn!}`,
    testId: 'debug-panic',
    onClick: () => engine.panic(),
  });

  let stopTone: (() => void) | null = null;
  const toneBtn = createButton({
    label: 'Test tone',
    className: `${switchStyles.root!} ${styles.debugBtn!}`,
    testId: 'debug-test-tone',
    onClick: () => {
      stopTone?.();
      try {
        stopTone = playTestTone(engine.ctx, () => {
          stopTone = null;
          setButtonLabel(toneBtn, 'Test tone');
        });
        setButtonLabel(toneBtn, 'Playing…');
      } catch {
        setButtonLabel(toneBtn, 'Failed');
      }
    },
  });

  const report = (): string => [
    `VAST G1-J5 ${__APP_VERSION__}`,
    new Date().toISOString(),
    navigator.userAgent,
    '',
    ...rows.map((r) => `${r.name}: ${r.el.textContent ?? ''}`),
  ].join('\n');

  const copyBtn = createButton({
    label: 'Copy report',
    className: `${switchStyles.root!} ${styles.debugBtn!}`,
    testId: 'debug-copy',
    // The whole point of the panel on a device with no console: hand the
    // readout to someone else in one gesture.
    onClick: () => flashCopied(copyBtn, 'Copy report', copyText(report())),
  });

  actions.append(ctxToggle, panicBtn, toneBtn, copyBtn);
  body.appendChild(actions);

  // ---- polling tiers (REQ-11) ---------------------------------------------
  // The rows differ wildly in cost. Most are plain field reads, but the storage
  // and session rows walk (and JSON.parse) localStorage *synchronously* — far
  // too expensive to run at the interval's rate behind a playing audio graph.
  // A row that isn't due simply keeps the text it already has.
  const SLOW_MS = 2000;
  const SW_MS = 5000;
  let slowChecked = 0;

  const refresh = (force = false): void => {
    // ---- every tick: cheap field reads ----
    stateVal.textContent = engine.ctx.state;
    setButtonLabel(ctxToggle, engine.ctx.state === 'running' ? 'Suspend' : 'Resume');
    rateVal.textContent = `${engine.ctx.sampleRate} Hz`;
    const base = engine.ctx.baseLatency;
    const out = engine.ctx.outputLatency;
    latencyVal.textContent =
      `base ${base != null ? `${(base * 1000).toFixed(1)} ms` : '—'} · ` +
      `output ${out ? `${(out * 1000).toFixed(1)} ms` : '—'}`;
    transportVal.textContent =
      `${engine.clock.playing ? 'playing' : 'stopped'} · ` +
      `${engine.clock.bpm.toFixed(1)} BPM · sync ${engine.sync.mode} · ` +
      // The only on-device evidence that the wakeup source stalled — the phone
      // this happens on has no console (audio-lifecycle.md REQ-7).
      `${engine.clock.dropouts} dropouts`;
    iosVal.textContent = isIOS() ? 'yes' : 'no';
    const clips = clipStats?.();
    clipsVal.textContent = clips ? `${clips.count} · ${MB(clips.bytes)}` : 'n/a';
    // REQ-8 — an action whose source never bound is disabled, not broken.
    clipsBtn.disabled = clips === undefined;
    const midi = midiStats?.();
    midiVal.textContent = midi ? `${midi.inputs} in · ${midi.outputs} out` : 'n/a';
    const wake = wakeState?.();
    wakeVal.textContent = wake ? (wake.supported ? (wake.held ? 'held' : 'released') : 'unsupported') : 'n/a';
    const ios = engine.iosAudio;
    unlockVal.textContent = ios.status
      + (ios.routed ? ' · routed' : '')
      + (ios.audioSessionSet ? ' · session:playback' : '');
    // The reason the tick is as fast as it is: this clock visibly advances.
    loopVal.textContent = ios.paused === null
      ? (ios.active ? 'idle' : 'n/a')
      : (ios.paused ? 'paused' : `playing t=${(ios.currentTime ?? 0).toFixed(1)}`);
    // Android: did the session actually form? The keep-alive loop's own clock
    // advances beside it, which is what says the element is really playing.
    const bg = engine.backgroundAudio;
    const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
    bgVal.textContent =
      `${bg.watching ? 'watching' : 'idle'} · `
      + (bg.supported ? `underrun ${pct(bg.underrunRatio)} (worst ${pct(bg.worstUnderrunRatio)})` : 'underrun n/a')
      + ` · clock ${pct(bg.driftRatio)} · ${bg.suspensions} suspends`;
    const media = engine.mediaSession;
    mediaVal.textContent = !media.active
      ? 'n/a'
      : `${media.status} · ${media.playbackState} · ${media.handlers} actions`
        + (media.paused === false ? ` · t=${(media.currentTime ?? 0).toFixed(1)}` : '');

    const now = Date.now();

    // ---- ~2 s: synchronous localStorage walks + near-static device info ----
    if (force || now - slowChecked > SLOW_MS) {
      slowChecked = now;
      // Near-static, but re-read so a live Perf-modal change still shows up.
      const perf = perfDiagnostics();
      tierVal.textContent = `${perf.tier} (${perf.pref === 'auto' ? 'auto' : 'forced'})`;
      coresVal.textContent = perf.cores != null ? String(perf.cores) : 'unknown';
      memVal.textContent = perf.memoryGb != null ? `${perf.memoryGb} GB` : 'unknown';
      mobileVal.textContent = perf.mobile ? 'yes' : 'no';
      const p = perf.profile;
      profileVal.textContent =
        `${p.latencyHint} · ${p.voiceCount} voices · ${p.fps} fps · ` +
        `lookahead ${Math.round(p.scheduleAheadS * 1000)}ms · IR ≤${p.reverbIrMaxS}s · ` +
        `oversample ${p.fxOversample ? 'on' : 'off'}`;
      const session = SessionAutosave.stats();
      sessionVal.textContent = session
        ? `${MB(session.bytes)} · ${ago(session.savedAt)}`
        : 'none';
      const store = storageUsage();
      storageVal.textContent = `${store.keys} keys · ${MB(store.bytes)}`;
    }

    // ---- ~5 s: getRegistrations() is async, so it caches and rewrites ----
    if (force || now - swChecked > SW_MS) { swChecked = now; readSw(); }
    swVal.textContent = swText;
  };
  refresh(true);

  // Whole-header click toggles (chevron included), persisted; default collapsed.
  // Folded shut, the rows aren't merely invisible — they go unread (REQ-3):
  // someone who opened About for the credits shouldn't pay for a readout that
  // isn't on screen. `onChange` also fires once here with the stored/default
  // state, so `visible` is correct from the start without a second source.
  let visible = false;
  const toggle = createCollapseToggle(body, 'websynth.debug.about', {
    defaultCollapsed: () => true,
    trigger: header,
    onChange: (collapsed) => {
      visible = !collapsed;
      // Repaint every tier on expand, so the panel is never shown stale.
      if (visible) refresh(true);
    },
  });
  header.appendChild(toggle.el);

  /** What the modal's interval and `statechange` drive — gated per REQ-3. */
  const tick = (): void => { if (visible) refresh(); };

  // REQ-9 — nothing an action started may outlive the modal.
  const dispose = (): void => {
    stopTone?.();
    stopTone = null;
    setButtonLabel(toneBtn, 'Test tone');
  };

  return { header, body, refresh: tick, dispose };
}

/**
 * A 1 s A440 straight to `ctx.destination`, deliberately **bypassing** the
 * master chain: this answers "is this device making any sound at all?", which a
 * muted mix or a closed filter would otherwise hide. Returns a stopper.
 */
function playTestTone(ctx: AudioContext, onEnded: () => void): () => void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const t = ctx.currentTime;
  osc.frequency.value = 440;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.2, t + 0.02);
  gain.gain.setValueAtTime(0.2, t + 0.9);
  gain.gain.linearRampToValueAtTime(0, t + 1);
  osc.connect(gain).connect(ctx.destination);
  osc.onended = () => { gain.disconnect(); onEnded(); };
  osc.start(t);
  osc.stop(t + 1);
  return () => {
    try { osc.stop(); } catch { /* already stopped */ }
    osc.disconnect();
    gain.disconnect();
  };
}

/** Drop every service-worker registration, then reload into an uncached app. */
async function unregisterServiceWorkers(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    // no service worker / storage blocked — the reload below is still correct
  }
  location.reload();
}
