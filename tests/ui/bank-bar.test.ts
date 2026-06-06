import { describe, it, expect } from 'vitest';
import { BankBar } from '../../src/ui/components/bank-bar';
import { BANK_LABELS } from '../../src/state/patterns';

function harness(opts?: { play?: number; filled?: (i: number) => boolean }) {
  let edit = 0;
  const play = opts?.play ?? 0;
  const editListeners = new Set<() => void>();
  const calls = { setEdit: [] as number[], copy: [] as Array<[number, number]> };
  const bar = new BankBar({
    getEdit: () => edit,
    setEdit: (i) => { calls.setEdit.push(i); edit = i; editListeners.forEach((l) => l()); },
    copy: (from, to) => { calls.copy.push([from, to]); },
    onEditChange: (fn) => { editListeners.add(fn); return () => editListeners.delete(fn); },
    getPlay: () => play,
    onPlayChange: () => () => {},
    hasContent: (i) => (opts?.filled ?? ((j) => j === 0))(i),
    onContentChange: () => () => {},
  });
  const buttons = [...bar.el.querySelectorAll('button')] as HTMLButtonElement[];
  const banks = buttons.slice(0, BANK_LABELS.length);
  const copyBtn = buttons[BANK_LABELS.length]!;
  return { bar, calls, banks, copyBtn };
}

describe('BankBar', () => {
  it('renders one button per bank plus a Copy button', () => {
    const { banks, copyBtn } = harness();
    expect(banks.length).toBe(BANK_LABELS.length);
    expect(banks[0]?.textContent).toContain('A');
    expect(copyBtn.textContent).toBe('Copy');
  });

  it('marks the edit bank active and the play bank playing', () => {
    const { banks } = harness({ play: 2 });
    expect(banks[0]?.classList.contains('active')).toBe(true);
    expect(banks[2]?.classList.contains('playing')).toBe(true);
  });

  it('marks banks that have content as filled', () => {
    const { banks } = harness({ filled: (i) => i === 1 });
    expect(banks[1]?.classList.contains('filled')).toBe(true);
    expect(banks[0]?.classList.contains('filled')).toBe(false);
  });

  it('clicking a bank selects it for editing', () => {
    const { banks, calls } = harness();
    banks[2]?.click();
    expect(calls.setEdit).toEqual([2]);
    expect(banks[2]?.classList.contains('active')).toBe(true);
  });

  it('Copy arms, then the next bank click clones into it and selects it', () => {
    const { banks, copyBtn, calls } = harness();
    copyBtn.click();
    expect(copyBtn.classList.contains('on')).toBe(true);

    banks[3]?.click();
    expect(calls.copy).toEqual([[0, 3]]); // current edit bank (0) → target (3)
    expect(calls.setEdit).toEqual([3]);
    expect(copyBtn.classList.contains('on')).toBe(false); // disarmed after use
  });
});
