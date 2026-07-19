import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showToast } from '../../src/ui/components/toast';

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const clickId = (id: string) => (byId(id) as HTMLButtonElement).click();

describe('toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = ''; // drops any leaked host; ensureHost re-appends
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders message, action, and dismiss with stable testids', () => {
    showToast({ message: 'Loaded Demo', actionLabel: 'Undo' });
    expect(byId('toast-host')).not.toBeNull();
    expect(byId('toast')!.textContent).toContain('Loaded Demo');
    expect(byId('toast-action')!.textContent).toBe('Undo');
    expect(byId('toast-dismiss')).not.toBeNull();
    expect(byId('toast')!.getAttribute('role')).toBe('status');
  });

  it('omits the action button without actionLabel and honours a custom testId', () => {
    showToast({ message: 'x', testId: 'song-undo-toast' });
    expect(byId('song-undo-toast')).not.toBeNull();
    expect(byId('toast')).toBeNull();
    expect(byId('toast-action')).toBeNull();
  });

  it('fires the action at most once, then dismisses', () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    const t = showToast({ message: 'x', actionLabel: 'Undo', onAction });
    t.onDismiss(onDismiss);
    const btn = byId('toast-action') as HTMLButtonElement;
    btn.click();
    btn.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(byId('toast')).toBeNull();
  });

  it('auto-dismisses after durationMs and fires onDismiss once', () => {
    const onDismiss = vi.fn();
    showToast({ message: 'x', durationMs: 5000 }).onDismiss(onDismiss);
    vi.advanceTimersByTime(4999);
    expect(byId('toast')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(byId('toast')).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('durationMs 0 is sticky until manually dismissed', () => {
    const onDismiss = vi.fn();
    showToast({ message: 'x', durationMs: 0 }).onDismiss(onDismiss);
    vi.advanceTimersByTime(60_000);
    expect(byId('toast')).not.toBeNull();
    clickId('toast-dismiss');
    expect(byId('toast')).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a new toast replaces the previous one, dismissing it first', () => {
    const first = vi.fn();
    showToast({ message: 'first' }).onDismiss(first);
    showToast({ message: 'second' });
    expect(first).toHaveBeenCalledTimes(1);
    const host = byId('toast-host')!;
    expect(host.children).toHaveLength(1);
    expect(host.textContent).toContain('second');
  });

  it('programmatic dismiss is idempotent and cancels the timer', () => {
    const onDismiss = vi.fn();
    const t = showToast({ message: 'x', durationMs: 1000 });
    t.onDismiss(onDismiss);
    t.dismiss();
    t.dismiss();
    vi.advanceTimersByTime(2000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a stale dismissed toast does not kill its replacement', () => {
    const a = showToast({ message: 'a', durationMs: 1000 });
    showToast({ message: 'b' }); // dismisses a
    a.dismiss(); // stale handle — must be a no-op for b
    expect(byId('toast-host')!.textContent).toContain('b');
  });
});
