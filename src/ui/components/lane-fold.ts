/**
 * The per-lane fold caret (specs/features/lane-fold.md).
 *
 * A step machine's OPTIONAL lanes cost their full grid height on every session
 * that does not use them. The sequencer met that first with tracks 2-4
 * (sequencer.md REQ-tracks-two-to-four-collapse) and the motion sequencer met
 * the identical problem going from two single-param lanes to four
 * (motion-sequencer.md REQ-an-empty-motion-lane-starts-folded), so the thirty
 * lines that solved it live here instead of in both panels.
 *
 * Not `createCollapseToggle` (lane-fold.md "Not createCollapseToggle"): that one
 * draws a BARE caret and rotates it in CSS, consults its default exactly once at
 * construction, and toggles the GLOBAL `.collapsed` class. A lane needs the
 * caret to double as its label (so the glyph is swapped, not rotated), needs to
 * re-derive its default when a song arrives (`reveal`), and lives inside a panel
 * that may itself sit in a collapsed section, so its state class is the caller's
 * own module class. Both components survive; they answer different questions.
 */
import { iconLabel } from './ui-icons';
import { readStoredCollapse, writeStoredCollapse } from './collapse-toggle';

export interface LaneFoldOptions {
  /** Drawn beside the caret — the lane's letter or number. */
  label: string;
  /** `websynth.ui.collapsed.<machine>track.<i>` (lane-fold.md "Persistence"). */
  storeKey: string;
  /** Carries `foldedClass`; the caller's CSS hides its body beneath that. */
  row: HTMLElement;
  /** The caller's CSS-Module class, never the global `.collapsed`. */
  foldedClass: string;
  /** The button's own class, from the caller's module. */
  foldClass: string;
  /** Minted whole by the caller (testids.md REQ-non-param-buttons-take-an-explicit-testid). */
  testId: string;
  /** A lane the machine always shows: the caret renders, disabled. */
  locked?: boolean;
  lockedTitle?: string;
  /** Tooltip per state; defaults to Show/Hide this lane. */
  title?: (folded: boolean) => string;
  /** Consulted ONLY when nothing is stored (REQ-a-lane-folds-on-a-stored-preference-first). */
  defaultFolded: () => boolean;
  onChange?: (folded: boolean) => void;
}

export interface LaneFold {
  readonly el: HTMLButtonElement;
  readonly folded: boolean;
  /** `persist: false` leaves storage untouched, so the lane stays "untouched". */
  setFolded(folded: boolean, persist: boolean): void;
  /** Open it now and remember that — for a gesture that implies the lane is wanted. */
  expand(): void;
  /** Re-derive the default, but only while nothing is stored, and only ever OPEN. */
  reveal(): void;
}

export function createLaneFold(opts: LaneFoldOptions): LaneFold {
  const { label, storeKey, row, foldedClass, foldClass, testId } = opts;

  const el = document.createElement('button');
  el.type = 'button';
  el.className = foldClass;
  el.dataset.testid = testId;

  let folded = false;

  const paint = (): void => {
    // The caret is inline SVG, never a typed glyph: the app bundles no font, so
    // a literal arrow falls through to whatever symbol face the device picks
    // (iconography.md REQ-a-control-glyph-is-inline-svg).
    el.innerHTML = iconLabel(folded ? 'caretRight' : 'caretDown', label);
    el.title = opts.title?.(folded) ?? (folded ? 'Show this lane' : 'Hide this lane');
  };

  const setFolded = (next: boolean, persist: boolean): void => {
    folded = next;
    row.classList.toggle(foldedClass, folded);
    paint();
    if (persist) writeStoredCollapse(storeKey, folded);
    opts.onChange?.(folded);
  };

  if (opts.locked) {
    // Drawn rather than omitted, so every lane's label sits on one vertical line
    // and the rows do not step sideways under each other
    // (REQ-a-locked-lane-draws-the-caret-disabled).
    el.innerHTML = iconLabel('caretDown', label);
    el.disabled = true;
    el.title = opts.lockedTitle ?? 'This lane is always shown';
  } else {
    // `null` — never toggled — is the whole reason this reads raw storage rather
    // than a boolean: it is what separates a default from a choice.
    const stored = readStoredCollapse(storeKey);
    setFolded(stored ?? opts.defaultFolded(), false);
    el.addEventListener('click', () => setFolded(!folded, true));
  }

  return {
    el,
    get folded(): boolean { return folded; },
    setFolded,
    expand: (): void => {
      if (!opts.locked && folded) setFolded(false, true);
    },
    reveal: (): void => {
      if (opts.locked) return;
      // A stored answer wins, so a lane the user folded on purpose stays folded
      // even when a song fills it. And this never FOLDS: the fold is a gesture
      // with a remembered answer, not a projection of the lane's content
      // (REQ-an-untouched-lane-re-derives-its-default).
      if (readStoredCollapse(storeKey) !== null) return;
      if (!opts.defaultFolded()) setFolded(false, false);
    },
  };
}
