import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import { createPerfSettingsButton } from '../../src/ui/components/perf-settings';
import { readPerfPref } from '../../src/state/perf-mode';

const sel = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('createPerfSettingsButton', () => {
  beforeEach(() => {
    installLocalStorageMock();
    // A capable desktop → 'auto' resolves to 'strong' at boot.
    vi.stubGlobal('navigator', { hardwareConcurrency: 12, deviceMemory: 16, userAgent: 'Windows' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('opens a modal with a four-way Auto/Weak/Medium/Strong control defaulting to the stored pref', () => {
    const btn = createPerfSettingsButton();
    expect(sel('perf-mode')).toBeNull(); // closed until clicked

    btn.click();
    expect(sel('perf-mode')).not.toBeNull();
    for (const v of ['auto', 'weak', 'medium', 'strong']) {
      expect(sel(`perf-mode-${v}`)).not.toBeNull();
    }
    // Default pref is 'auto'.
    expect(sel('perf-mode-auto')!.classList.contains('active')).toBe(true);
    expect(sel('perf-mode-strong')!.classList.contains('active')).toBe(false);
  });

  it('persists the chosen preference and moves the active marker', () => {
    const btn = createPerfSettingsButton();
    btn.click();

    sel('perf-mode-weak')!.click();
    expect(readPerfPref()).toBe('weak');
    expect(sel('perf-mode-weak')!.classList.contains('active')).toBe(true);
    expect(sel('perf-mode-auto')!.classList.contains('active')).toBe(false);
  });

  it('applies the resolved tier fps live via the onTierPreview callback', () => {
    const onTierPreview = vi.fn();
    const btn = createPerfSettingsButton({ onTierPreview });
    btn.click();

    sel('perf-mode-medium')!.click();
    expect(onTierPreview).toHaveBeenLastCalledWith('medium');

    sel('perf-mode-weak')!.click();
    expect(onTierPreview).toHaveBeenLastCalledWith('weak');

    // 'auto' resolves to the detected tier ('strong' on this capable desktop).
    sel('perf-mode-auto')!.click();
    expect(onTierPreview).toHaveBeenLastCalledWith('strong');
  });

  it('shows the reload hint only when the choice changes the audio profile', () => {
    const btn = createPerfSettingsButton();
    btn.click(); // booted as 'strong' (capable desktop)

    // Weak changes buffer + voices → needs a reload.
    sel('perf-mode-weak')!.click();
    expect(sel('perf-reload-hint')!.classList.contains('hidden')).toBe(false);
    expect(sel('perf-reload')!.classList.contains('hidden')).toBe(false);

    // Medium shares the audio profile with the booted Strong → fps-only, no reload.
    sel('perf-mode-medium')!.click();
    expect(sel('perf-reload-hint')!.classList.contains('hidden')).toBe(true);
    expect(sel('perf-reload')!.classList.contains('hidden')).toBe(true);
  });

  it('states the resolved tier, disambiguating the Auto preference', () => {
    const btn = createPerfSettingsButton();
    btn.click(); // capable desktop, pref 'auto'

    const status = sel('perf-status')!;
    expect(status.textContent!.toLowerCase()).toContain('auto selected');
    expect(status.textContent!.toLowerCase()).toContain('strong');

    sel('perf-mode-weak')!.click();
    expect(status.textContent!.toLowerCase()).toContain('forced to');
    expect(status.textContent!.toLowerCase()).toContain('weak');
  });

  it('reflects the resolved tier on the header button itself', () => {
    const btn = createPerfSettingsButton(); // capable desktop, default pref 'auto' → strong
    expect(btn.dataset.perfTier).toBe('strong');
    expect(btn.dataset.perfPending).toBe('0');

    btn.click();
    sel('perf-mode-weak')!.click();
    expect(btn.dataset.perfTier).toBe('weak');
    expect(btn.dataset.perfPref).toBe('weak');
    // Weak crosses the audio boundary from the booted Strong → pending a reload.
    expect(btn.dataset.perfPending).toBe('1');

    // Medium shares Strong's audio profile → not pending.
    sel('perf-mode-medium')!.click();
    expect(btn.dataset.perfTier).toBe('medium');
    expect(btn.dataset.perfPending).toBe('0');
  });
});
