// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { buildSyncSection } from '../../src/ui/components/sync-section';
import type { SyncController } from '../../src/audio/transport/sync/sync-controller';
import type { SyncMode, SyncStatus } from '../../src/audio/transport/sync/sync-types';

/** Structural stub — buildSyncSection only touches mode/setMode/status/onStatus. */
function stubController(status: Partial<SyncStatus> = {}) {
  let statusCb: ((s: SyncStatus) => void) | null = null;
  const state = {
    mode: 'off' as SyncMode,
    status: {
      mode: 'off', ports: null, playing: false, followedBpm: null, stalled: false,
      ...status,
    } as SyncStatus,
  };
  const ctrl = {
    get mode() { return state.mode; },
    get status() { return state.status; },
    setMode: vi.fn((m: SyncMode) => { state.mode = m; }),
    onStatus: (cb: (s: SyncStatus) => void) => { statusCb = cb; return () => {}; },
  };
  const push = (s: SyncStatus) => { state.status = s; statusCb?.(s); };
  return { ctrl: ctrl as unknown as SyncController, setMode: ctrl.setMode, push };
}

const q = (root: HTMLElement, testid: string) =>
  root.querySelector(`[data-testid="${testid}"]`) as HTMLElement;

describe('sync-section', () => {
  it('renders the three mode buttons and marks the current mode active', () => {
    const { ctrl } = stubController();
    const el = buildSyncSection(ctrl);
    for (const m of ['off', 'master', 'slave']) expect(q(el, `sync-mode-${m}`)).toBeTruthy();
    expect(q(el, 'sync-mode-off').classList.contains('active')).toBe(true);
  });

  it('clicking a mode calls setMode and moves the active class', () => {
    const { ctrl, setMode } = stubController();
    const el = buildSyncSection(ctrl);
    q(el, 'sync-mode-master').click();
    expect(setMode).toHaveBeenCalledWith('master');
    expect(q(el, 'sync-mode-master').classList.contains('active')).toBe(true);
    expect(q(el, 'sync-mode-off').classList.contains('active')).toBe(false);
  });

  it('shows "MIDI unavailable" when no transport is attached', () => {
    const { ctrl } = stubController({ ports: null });
    const el = buildSyncSection(ctrl);
    expect(q(el, 'sync-status').textContent).toBe('MIDI unavailable');
  });

  it('shows "No MIDI ports" when the transport has none', () => {
    const { ctrl } = stubController({ ports: { ins: 0, outs: 0 } });
    const el = buildSyncSection(ctrl);
    expect(q(el, 'sync-status').textContent).toBe('No MIDI ports');
  });

  it('re-renders on status pushes: ports, followed BPM, stall', () => {
    const { ctrl, push } = stubController();
    const el = buildSyncSection(ctrl);
    const base: SyncStatus = {
      mode: 'slave', ports: { ins: 2, outs: 1 }, playing: true,
      followedBpm: 120.44, stalled: false,
    };
    push(base);
    expect(q(el, 'sync-status').textContent).toContain('2 in');
    expect(q(el, 'sync-status').textContent).toContain('following 120.4 BPM');
    push({ ...base, stalled: true });
    expect(q(el, 'sync-status').textContent).toContain('stalled (free-running)');
    // A status push also repaints the mode (e.g. restored from persistence).
    expect(q(el, 'sync-mode-slave').classList.contains('active')).toBe(true);
  });
});
