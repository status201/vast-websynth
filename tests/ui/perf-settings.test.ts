import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import { createPerfSettingsButton } from '../../src/ui/components/perf-settings';
import { readPerfPref } from '../../src/state/perf-mode';

const sel = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('createPerfSettingsButton', () => {
  beforeEach(() => {
    installLocalStorageMock();
    // A capable desktop → 'auto' resolves to inactive at boot.
    vi.stubGlobal('navigator', { hardwareConcurrency: 12, deviceMemory: 16, userAgent: 'Windows' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('opens a modal with a three-way Auto/On/Off control defaulting to the stored pref', () => {
    const btn = createPerfSettingsButton();
    expect(sel('perf-mode')).toBeNull(); // closed until clicked

    btn.click();
    expect(sel('perf-mode')).not.toBeNull();
    // Default pref is 'auto'.
    expect(sel('perf-mode-auto')!.classList.contains('active')).toBe(true);
    expect(sel('perf-mode-on')!.classList.contains('active')).toBe(false);
  });

  it('persists the chosen preference and moves the active marker', () => {
    const btn = createPerfSettingsButton();
    btn.click();

    sel('perf-mode-on')!.click();
    expect(readPerfPref()).toBe('on');
    expect(sel('perf-mode-on')!.classList.contains('active')).toBe(true);
    expect(sel('perf-mode-auto')!.classList.contains('active')).toBe(false);
  });

  it('shows the reload hint only when the choice changes the booted active state', () => {
    const btn = createPerfSettingsButton();
    btn.click(); // booted with auto→inactive (capable desktop)

    // 'on' diverges from the inactive boot state → needs reload.
    sel('perf-mode-on')!.click();
    expect(sel('perf-reload-hint')!.classList.contains('hidden')).toBe(false);
    expect(sel('perf-reload')!.classList.contains('hidden')).toBe(false);

    // Back to a choice that resolves to the booted state → no reload needed.
    sel('perf-mode-off')!.click();
    expect(sel('perf-reload-hint')!.classList.contains('hidden')).toBe(true);
    expect(sel('perf-reload')!.classList.contains('hidden')).toBe(true);
  });
});
