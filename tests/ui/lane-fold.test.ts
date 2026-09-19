// @vitest-environment jsdom
// The shared per-lane fold (specs/features/lane-fold.md). Its whole reason to
// exist over `createCollapseToggle` is the three-state storage — folded, open,
// never touched — so most of what is pinned here is which of the three a given
// call produces, and which calls are allowed to write.
import { describe, it, expect, beforeEach } from 'vitest';
import { createLaneFold, type LaneFoldOptions } from '../../src/ui/components/lane-fold';
import { installLocalStorageMock } from '../storage-mock';

const KEY = 'websynth.ui.collapsed.testlane.0';
const FOLDED = 'folded-cls';

/** A row + body pair, wired the way both real panels wire theirs. */
function mount(opts: Partial<LaneFoldOptions> = {}): {
  fold: ReturnType<typeof createLaneFold>;
  row: HTMLElement;
  body: HTMLElement;
} {
  const row = document.createElement('div');
  const header = document.createElement('div');
  const picker = document.createElement('select');
  header.appendChild(picker);
  const body = document.createElement('div');
  row.append(header, body);
  const fold = createLaneFold({
    label: 'C',
    storeKey: KEY,
    row,
    foldedClass: FOLDED,
    foldClass: 'fold-cls',
    testId: 'lane-fold-0',
    defaultFolded: () => true,
    ...opts,
  });
  header.prepend(fold.el);
  // Mounted for real: `isConnected` below is the point of the header assertion.
  document.body.appendChild(row);
  return { fold, row, body };
}

const isFolded = (row: HTMLElement): boolean => row.classList.contains(FOLDED);

describe('createLaneFold', () => {
  beforeEach(() => {
    installLocalStorageMock();
    document.body.innerHTML = '';
  });

  it('starts folded when the lane is empty and open when it is not', () => {
    expect(isFolded(mount({ defaultFolded: () => true }).row)).toBe(true);
    expect(isFolded(mount({ defaultFolded: () => false }).row)).toBe(false);
  });

  it('a stored preference beats the default (REQ-a-lane-folds-on-a-stored-preference-first)', () => {
    localStorage.setItem(KEY, '0');
    // Still "empty", so the default would fold it — the user's answer wins.
    expect(isFolded(mount({ defaultFolded: () => true }).row)).toBe(false);

    localStorage.setItem(KEY, '1');
    expect(isFolded(mount({ defaultFolded: () => false }).row)).toBe(true);
  });

  it('only a click writes, so a default leaves the lane untouched', () => {
    const { fold, row } = mount({ defaultFolded: () => true });
    expect(localStorage.getItem(KEY)).toBeNull();

    fold.reveal();
    fold.setFolded(false, false);
    expect(localStorage.getItem(KEY)).toBeNull();

    fold.el.click();
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(isFolded(row)).toBe(true);

    fold.el.click();
    expect(localStorage.getItem(KEY)).toBe('0');
    expect(isFolded(row)).toBe(false);
  });

  it('reveal() opens an untouched lane that has gained content', () => {
    let empty = true;
    const { fold, row } = mount({ defaultFolded: () => empty });
    expect(isFolded(row)).toBe(true);

    empty = false;              // a song arrives and fills the lane
    fold.reveal();
    expect(isFolded(row)).toBe(false);
    // Still untouched: the reveal is not the user's statement about this lane.
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('reveal() leaves a deliberately folded lane alone', () => {
    localStorage.setItem(KEY, '1');
    const { fold, row } = mount({ defaultFolded: () => false });
    fold.reveal();
    expect(isFolded(row)).toBe(true);
  });

  it('reveal() never folds (REQ-an-untouched-lane-re-derives-its-default)', () => {
    let empty = false;
    const { fold, row } = mount({ defaultFolded: () => empty });
    expect(isFolded(row)).toBe(false);

    empty = true;               // the content goes away again
    fold.reveal();
    expect(isFolded(row)).toBe(false);
  });

  it('expand() opens and remembers, because it follows a deliberate gesture', () => {
    const { fold, row } = mount({ defaultFolded: () => true });
    fold.expand();
    expect(isFolded(row)).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('0');
  });

  it('a locked lane draws a disabled caret and never folds', () => {
    const { fold, row } = mount({
      locked: true,
      lockedTitle: 'Track 1 is always shown',
      defaultFolded: () => true,
    });
    expect(fold.el.disabled).toBe(true);
    expect(fold.el.title).toBe('Track 1 is always shown');
    expect(isFolded(row)).toBe(false);

    fold.el.click();
    fold.reveal();
    expect(isFolded(row)).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('keeps the header usable while folded (REQ-a-lane-fold-hides-the-body-not-the-header)', () => {
    const { fold, row } = mount({ defaultFolded: () => true });
    // The component hides nothing itself — the caller's CSS keys off the class —
    // so what matters is that the row is marked and the header is untouched.
    expect(isFolded(row)).toBe(true);
    const picker = row.querySelector('select');
    expect(picker).not.toBeNull();
    expect(picker!.isConnected).toBe(true);
    expect(fold.el.isConnected).toBe(true);
    expect(fold.el.disabled).toBe(false);
  });

  it('swaps an inline-SVG caret rather than a typed glyph (REQ-the-fold-caret-is-an-icon-not-a-glyph)', () => {
    const { fold } = mount({ defaultFolded: () => true });
    const foldedHtml = fold.el.innerHTML;
    expect(fold.el.querySelector('svg.ui-icon')).not.toBeNull();
    expect(fold.el.textContent).toBe('C');
    expect(foldedHtml).not.toMatch(/[▸▾▼►]/);

    fold.el.click();            // open it — the glyph is swapped, not rotated
    expect(fold.el.innerHTML).not.toBe(foldedHtml);
    expect(fold.el.querySelector('svg.ui-icon')).not.toBeNull();
    expect(fold.el.textContent).toBe('C');
  });

  it('mints the caller’s testid and reports its state', () => {
    const { fold } = mount({ defaultFolded: () => true });
    expect(fold.el.dataset.testid).toBe('lane-fold-0');
    expect(fold.el.type).toBe('button');
    expect(fold.folded).toBe(true);
    fold.el.click();
    expect(fold.folded).toBe(false);
  });

  it('reports every change through onChange, including the initial state', () => {
    const seen: boolean[] = [];
    const { fold } = mount({ defaultFolded: () => true, onChange: (f) => seen.push(f) });
    expect(seen).toEqual([true]);
    fold.el.click();
    expect(seen).toEqual([true, false]);
  });
});
