import { describe, it, expect } from 'vitest';
import { BankBar } from '../../src/ui/components/bank-bar';
import { BANK_LABELS } from '../../src/state/patterns';

function harness(opts?: { play?: number; filled?: (i: number) => boolean }) {
  let edit = 0;
  let play = opts?.play ?? 0;
  const editListeners = new Set<() => void>();
  const playListeners = new Set<() => void>();
  const calls = { setEdit: [] as number[], copy: [] as Array<[number, number]> };
  const bar = new BankBar({
    getEdit: () => edit,
    setEdit: (i) => { calls.setEdit.push(i); edit = i; editListeners.forEach((l) => l()); },
    copy: (from, to) => { calls.copy.push([from, to]); },
    onEditChange: (fn) => { editListeners.add(fn); return () => editListeners.delete(fn); },
    getPlay: () => play,
    onPlayChange: (fn) => { playListeners.add(fn); return () => playListeners.delete(fn); },
    hasContent: (i) => (opts?.filled ?? ((j) => j === 0))(i),
    onContentChange: () => () => {},
  });
  const buttons = [...bar.el.querySelectorAll('button')] as HTMLButtonElement[];
  const followBtn = buttons[0]!;
  const banks = buttons.slice(1, 1 + BANK_LABELS.length);
  const copyBtn = buttons[1 + BANK_LABELS.length]!;
  /** Advance the "arrangement" to a new play bank and notify. */
  const setPlay = (i: number) => { play = i; playListeners.forEach((l) => l()); };
  return { bar, calls, banks, copyBtn, followBtn, setPlay, getEdit: () => edit };
}

describe('BankBar', () => {
  it('renders Follow, one button per bank, and Copy', () => {
    const { followBtn, banks, copyBtn } = harness();
    expect(followBtn.textContent).toBe('Follow');
    expect(banks.length).toBe(BANK_LABELS.length);
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

  it('exposes follow state read-only and notifies on every flip', () => {
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
