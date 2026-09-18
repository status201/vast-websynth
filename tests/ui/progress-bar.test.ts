import { describe, it, expect } from 'vitest';
import { createProgressBar } from '../../src/ui/components/progress-bar';
import styles from '../../src/ui/styles/progress-bar.module.css';

/** The shared progress bar (specs/features/progress-bar.md). */

const fillOf = (el: HTMLElement): HTMLElement => el.firstElementChild as HTMLElement;

describe('createProgressBar', () => {
  it('is a labelled 0–100 progressbar carrying its testid (REQ-determinate-announces-value, REQ-progress-testid-and-label)', () => {
    const bar = createProgressBar({ testId: 'thing-progress', label: 'Thing' });
    expect(bar.el.getAttribute('role')).toBe('progressbar');
    expect(bar.el.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.el.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.el.dataset.testid).toBe('thing-progress');
    expect(bar.el.getAttribute('aria-label')).toBe('Thing');
  });

  it('sets the width and the value from a ratio, clamped (REQ-determinate-announces-value)', () => {
    const bar = createProgressBar();
    bar.set(0.5);
    expect(fillOf(bar.el).style.width).toBe('50%');
    expect(bar.el.getAttribute('aria-valuenow')).toBe('50');

    bar.set(2);
    expect(fillOf(bar.el).style.width).toBe('100%');
    expect(bar.el.getAttribute('aria-valuenow')).toBe('100');

    bar.set(Number.NaN);
    expect(fillOf(bar.el).style.width).toBe('0%');
    expect(bar.el.getAttribute('aria-valuenow')).toBe('0');
  });

  it('drops the value while indeterminate, and set() restores it after (REQ-indeterminate-drops-valuenow)', () => {
    const bar = createProgressBar();
    bar.set(0.4);
    bar.setIndeterminate(true);
    expect(bar.el.classList.contains(styles.indeterminate!)).toBe(true);
    expect(bar.el.hasAttribute('aria-valuenow')).toBe(false);
    expect(fillOf(bar.el).style.width).toBe('100%');

    bar.setIndeterminate(false);
    expect(bar.el.classList.contains(styles.indeterminate!)).toBe(false);
    bar.set(0.7);
    expect(bar.el.getAttribute('aria-valuenow')).toBe('70');
  });
});
