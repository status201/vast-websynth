import { describe, it, expect } from 'vitest';
import { BankBar } from '../../src/ui/components/bank-bar';
import { BANK_LABELS, MIN_BANK_COUNT, MAX_BANK_COUNT } from '../../src/state/patterns';

function harness(opts?: {
  play?: number;
  filled?: (i: number) => boolean;
  resting?: () => boolean;
  /** Starting bank count; omitted means the default floor. */
  count?: number;
  /** Supply the grow/shrink arms. Omitted = a bar that cannot resize. */
  resizable?: boolean;
  removeBlockedBy?: () => string | null;
}) {
  let edit = 0;
  let play = opts?.play ?? 0;
  let count = opts?.count ?? MIN_BANK_COUNT;
  const editListeners = new Set<() => void>();
  const playListeners = new Set<() => void>();
  const countListeners = new Set<() => void>();
  const calls = {
    setEdit: [] as number[],
    copy: [] as Array<[number, number]>,
    addBank: 0,
    removeBank: 0,
  };
  const resize = opts?.resizable
    ? {
      addBank: () => {
        calls.addBank++;
        if (count < MAX_BANK_COUNT) count++;
        countListeners.forEach((l) => l());
      },
      removeBank: () => {
        calls.removeBank++;
        if (count > MIN_BANK_COUNT) count--;
        countListeners.forEach((l) => l());
      },
      removeBlockedBy: opts.removeBlockedBy ?? (() => null),
    }
    : {};
  const bar = new BankBar({
    getEdit: () => edit,
    setEdit: (i) => { calls.setEdit.push(i); edit = i; editListeners.forEach((l) => l()); },
    copy: (from, to) => { calls.copy.push([from, to]); },
    onEditChange: (fn) => { editListeners.add(fn); return () => editListeners.delete(fn); },
    getPlay: () => play,
    onPlayChange: (fn) => { playListeners.add(fn); return () => playListeners.delete(fn); },
    ...(opts?.resting ? { resting: opts.resting } : {}),
    hasContent: (i) => (opts?.filled ?? ((j) => j === 0))(i),
    onContentChange: () => () => {},
    bankCount: () => count,
    onBankCountChange: (fn) => { countListeners.add(fn); return () => countListeners.delete(fn); },
    ...resize,
    testidPrefix: 'seq',
  });
  // By testid, never by position: the bar's button order now depends on the
  // bank count AND on whether the resize arms are present, so an index-based
  // harness breaks for reasons that have nothing to do with what is being tested.
  const pick = (id: string) =>
    bar.el.querySelector(`[data-testid="bank-seq-${id}"]`) as HTMLButtonElement | null;
  const bankBtns = (): HTMLButtonElement[] =>
    [...bar.el.querySelectorAll('[data-testid^="bank-seq-"]')]
      .filter((b) => /^bank-seq-\d+$/.test((b as HTMLElement).dataset.testid ?? ''))
      .map((b) => b as HTMLButtonElement);
  /** Advance the "arrangement" to a new play bank and notify. */
  const setPlay = (i: number) => { play = i; playListeners.forEach((l) => l()); };
  return {
    bar, calls, setPlay, pick, bankBtns,
    get banks() { return bankBtns(); },
    get copyBtn() { return pick('copy')!; },
    get followBtn() { return pick('follow')!; },
    getEdit: () => edit,
    getCount: () => count,
  };
}

describe('BankBar', () => {
  it('renders Follow, one button per bank, and Copy', () => {
    const { followBtn, banks, copyBtn } = harness();
    expect(followBtn.textContent).toBe('Follow');
    expect(banks.length).toBe(MIN_BANK_COUNT);
    expect(banks[0]?.textContent).toContain('A');
    expect(copyBtn.textContent).toBe('Copy');
  });

  it('marks edit bank active and play bank playing', () => {
    const { banks, followBtn } = harness({ play: 2 });
    // Follow is on by default, but no play *change* has fired yet — the
    // initial render just shows the split.
    expect(followBtn.classList.contains('on')).toBe(true);
    expect(banks[0]?.classList.contains('active')).toBe(true);
    expect(banks[2]?.classList.contains('playing')).toBe(true);
  });

  it('marks banks with content as filled', () => {
    const { banks } = harness({ filled: (i) => i === 1 });
    expect(banks[1]?.classList.contains('filled')).toBe(true);
    expect(banks[0]?.classList.contains('filled')).toBe(false);
  });

  it('flags the root as resting so CSS recolours the play-bank dot (REQ-four-tracks-per-bank)', () => {
    // While a lane rests, the play bank is a safe index 0 and no bank truly
    // plays; the root's `resting` class recolours A's playing dot amber, but A
    // stays selected/playing on the button itself.
    const { bar, banks } = harness({ play: 0, resting: () => true });
    expect(bar.el.classList.contains('resting')).toBe(true);
    expect(banks[0]?.classList.contains('playing')).toBe(true);
    expect(banks[0]?.classList.contains('active')).toBe(true);
  });

  it('is not resting by default (no resting hook)', () => {
    const { bar } = harness();
    expect(bar.el.classList.contains('resting')).toBe(false);
  });

  it('click selects a bank for editing', () => {
    const { banks, calls } = harness();
    banks[2]?.click();
    expect(calls.setEdit).toEqual([2]);
    expect(banks[2]?.classList.contains('active')).toBe(true);
  });

  it('Copy arms, then a bank click clones and selects', () => {
    const { banks, copyBtn, calls } = harness();
    copyBtn.click();
    expect(copyBtn.classList.contains('on')).toBe(true);
    banks[3]?.click();
    expect(calls.copy).toEqual([[0, 3]]);
    expect(calls.setEdit).toEqual([3]);
    expect(copyBtn.classList.contains('on')).toBe(false); // disarmed after use
  });

  it('follows the play bank across changes by default', () => {
    const { setPlay, calls, getEdit } = harness();
    setPlay(1);
    expect(calls.setEdit).toEqual([1]);
    setPlay(3);
    expect(calls.setEdit).toEqual([1, 3]);
    expect(getEdit()).toBe(3);
  });

  it('a play notify without a bank change is a no-op', () => {
    const { setPlay, calls } = harness();
    setPlay(0); // arrangement notifies every bar even when the bank holds
    expect(calls.setEdit).toEqual([]);
  });

  it('toggling Follow off stops tracking; back on syncs immediately', () => {
    const { followBtn, setPlay, calls, getEdit } = harness();
    followBtn.click(); // off
    expect(followBtn.classList.contains('on')).toBe(false);
    setPlay(2);
    expect(calls.setEdit).toEqual([]); // view stays put while editing
    followBtn.click(); // on again — jumps to the playing bank at once
    expect(followBtn.classList.contains('on')).toBe(true);
    expect(calls.setEdit).toEqual([2]);
    expect(getEdit()).toBe(2);
  });

  it('clicking a non-playing bank turns Follow off', () => {
    const { banks, followBtn, setPlay, calls } = harness();
    setPlay(1); // following → edit bank now 1
    banks[3]?.click(); // manual pick of a different bank = editing intent
    expect(followBtn.classList.contains('on')).toBe(false);
    expect(calls.setEdit).toEqual([1, 3]);
    setPlay(2); // no longer followed
    expect(calls.setEdit).toEqual([1, 3]);
  });

  // sequencer.md REQ-a-take-is-bank-pinned — a panel drops Follow on the user's behalf so an
  // armed Step Input take can't be moved to another bank mid-recording.
  it('setFollowing pins the edit bank and notifies, like a manual bank click', () => {
    const { bar, followBtn, setPlay, calls } = harness();
    const seen: boolean[] = [];
    bar.onFollowChange(() => seen.push(bar.following));

    bar.setFollowing(false);
    expect(bar.following).toBe(false);
    expect(followBtn.classList.contains('on')).toBe(false);
    expect(seen).toEqual([false]);

    setPlay(2); // the arrangement advances — the edit bank must not move
    expect(calls.setEdit).toEqual([]);

    bar.setFollowing(true); // re-enabling still syncs immediately
    expect(calls.setEdit).toEqual([2]);
    expect(seen).toEqual([false, true]);
  });

  it('exposes follow state and notifies on every flip', () => {
    const { bar, followBtn, banks, setPlay } = harness();
    const seen: boolean[] = [];
    const off = bar.onFollowChange(() => seen.push(bar.following));
    expect(bar.following).toBe(true);
    followBtn.click(); // off via the button
    expect(bar.following).toBe(false);
    expect(seen).toEqual([false]);
    followBtn.click(); // back on
    expect(seen).toEqual([false, true]);
    // Auto-off from a manual non-playing bank click notifies too.
    setPlay(1);
    banks[3]?.click();
    expect(bar.following).toBe(false);
    expect(seen).toEqual([false, true, false]);
    off();
    followBtn.click();
    expect(seen).toEqual([false, true, false]); // unsubscribed
  });

  it('clicking the playing bank keeps Follow on', () => {
    const { banks, followBtn, setPlay, calls } = harness();
    setPlay(1);
    banks[1]?.click(); // re-picking the bank that's already playing
    expect(followBtn.classList.contains('on')).toBe(true);
    setPlay(2);
    expect(calls.setEdit).toEqual([1, 1, 2]); // click re-sets 1, then follow → 2
  });
});

describe('BankBar grow/shrink arms (banks.md REQ-a-bank-is-added-on-demand)', () => {
  it('shows no arms at all on a bar that cannot resize', () => {
    const h = harness();
    expect(h.pick('add')).toBeNull();
    expect(h.pick('remove')).toBeNull();
    expect(h.banks.length).toBe(MIN_BANK_COUNT);
  });

  it('+ appends one bank and the row follows', () => {
    const h = harness({ resizable: true });
    expect(h.banks.length).toBe(MIN_BANK_COUNT);
    expect(h.pick(String(MIN_BANK_COUNT))).toBeNull();
    h.pick('add')!.click();
    expect(h.calls.addBank).toBe(1);
    expect(h.banks.length).toBe(MIN_BANK_COUNT + 1);
    const fresh = h.pick(String(MIN_BANK_COUNT))!;
    expect(fresh.textContent).toContain(BANK_LABELS[MIN_BANK_COUNT]);
  });

  it('the + arm names the letter it will mint, never the sign', () => {
    // The glyph is drawn SVG, so the accessible name is the only label there is
    // (iconography.md REQ-a-control-glyph-is-inline-svg).
    const h = harness({ resizable: true });
    const plus = h.pick('add')!;
    expect(plus.getAttribute('aria-label')).toBe(`Add bank ${BANK_LABELS[MIN_BANK_COUNT]}`);
    expect(plus.textContent).not.toContain('+');
    expect(plus.querySelector('svg')).not.toBeNull();
  });

  it('+ disappears at the ceiling rather than sitting there dead', () => {
    const h = harness({ count: MAX_BANK_COUNT, resizable: true });
    expect(h.banks.length).toBe(MAX_BANK_COUNT);
    expect(h.pick('add')).toBeNull();
  });

  it('- is disabled with the reason when the top bank is in use', () => {
    const h = harness({
      count: 5, resizable: true,
      removeBlockedBy: () => 'Bank E has steps - clear it first',
    });
    const minus = h.pick('remove')!;
    expect(minus.disabled).toBe(true);
    expect(minus.title).toContain('clear it first');
    // The reason has to reach a screen reader too: a title is never announced,
    // and the aria-label is minted once when the row is built (banks.md
    // REQ-a-bank-is-removed-only-when-unused).
    expect(minus.getAttribute('aria-label')).toContain('clear it first');
    minus.click();
    expect(h.calls.removeBank).toBe(0);
  });

  it('- drops the top bank once it is free', () => {
    const h = harness({ count: 5, resizable: true });
    const minus = h.pick('remove')!;
    expect(minus.disabled).toBe(false);
    minus.click();
    expect(h.calls.removeBank).toBe(1);
    expect(h.banks.length).toBe(MIN_BANK_COUNT);
  });

  it('a rebuild keeps Copy armed and still copies into the new bank', () => {
    // The row is torn down and rebuilt on every count change; the armed state
    // lives on the bar, not on the buttons, and must survive that.
    const h = harness({ resizable: true });
    h.copyBtn.click();
    expect(h.bar.el.classList.contains('copy-armed')).toBe(true);
    h.pick('add')!.click();
    expect(h.bar.el.classList.contains('copy-armed')).toBe(true);
    h.pick(String(MIN_BANK_COUNT))!.click();
    expect(h.calls.copy).toEqual([[0, MIN_BANK_COUNT]]);
    expect(h.bar.el.classList.contains('copy-armed')).toBe(false);
  });

  it('re-evaluates the - arm on every repaint, not just on a rebuild', () => {
    // The blocker depends on CONTENT and on the chain, which change far more
    // often than the count does. Computing it only while rebuilding the row left
    // a stale enabled arm sitting over a bank that had just been filled.
    let blocked: string | null = null;
    const h = harness({ count: 5, resizable: true, removeBlockedBy: () => blocked });
    expect(h.pick('remove')!.disabled).toBe(false);
    blocked = 'Bank E has steps - clear it first';
    h.setPlay(1); // any repaint, no count change
    expect(h.pick('remove')!.disabled).toBe(true);
    expect(h.pick('remove')!.title).toContain('clear it first');
    blocked = null;
    h.setPlay(0);
    expect(h.pick('remove')!.disabled).toBe(false);
  });

  it('a rebuilt row still paints active/playing/filled', () => {
    const h = harness({ play: 1, resizable: true, filled: (i) => i === 2 });
    h.pick('add')!.click();
    expect(h.banks[0]!.classList.contains('active')).toBe(true);
    expect(h.banks[1]!.classList.contains('playing')).toBe(true);
    expect(h.banks[2]!.classList.contains('filled')).toBe(true);
    expect(h.banks[MIN_BANK_COUNT]!.classList.contains('filled')).toBe(false);
  });
});
