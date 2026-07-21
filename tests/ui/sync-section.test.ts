// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { buildSyncSection } from '../../src/ui/components/sync-section';
import type { SyncController } from '../../src/audio/transport/sync/sync-controller';
import type { SyncMode, SyncStatus, SyncLink } from '../../src/audio/transport/sync/sync-types';
import type { WebRtcSyncTransport } from '../../src/audio/webrtc-sync-transport';

/** Structural stub — buildSyncSection only touches mode/setMode/status/onStatus. */
function stubController(status: Partial<SyncStatus> = {}) {
  let statusCb: ((s: SyncStatus) => void) | null = null;
  const state = {
    mode: (status.mode ?? 'off') as SyncMode,
    status: {
      mode: 'off', activeMode: 'off', links: [] as SyncLink[], playing: false,
      followedBpm: null, stalled: false,
      ...status,
    } as SyncStatus,
  };
  const ctrl = {
    get mode() { return state.mode; },
    get status() { return state.status; },
    // The real controller re-emits status on every setMode, so `status.mode`
    // moves with the selection — the section paints from status.
    setMode: vi.fn((m: SyncMode) => {
      state.mode = m;
      state.status = { ...state.status, mode: m };
      statusCb?.(state.status);
    }),
    onStatus: (cb: (s: SyncStatus) => void) => { statusCb = cb; return () => {}; },
  };
  const push = (s: SyncStatus) => { state.status = s; statusCb?.(s); };
  return { ctrl: ctrl as unknown as SyncController, setMode: ctrl.setMode, push };
}

/** WiFi transport stub — only `onPortsChange`/`linked` are touched on open. */
const rtcStub = { linked: false, onPortsChange: () => () => {} } as unknown as WebRtcSyncTransport;

const q = (root: HTMLElement, testid: string) =>
  root.querySelector(`[data-testid="${testid}"]`) as HTMLElement;

describe('sync-section', () => {
  it('renders the three mode buttons and marks the current mode active', () => {
    const { ctrl } = stubController();
    const el = buildSyncSection(ctrl, rtcStub);
    for (const m of ['off', 'master', 'slave']) expect(q(el, `sync-mode-${m}`)).toBeTruthy();
    expect(q(el, 'sync-mode-off').classList.contains('active')).toBe(true);
  });

  it('clicking a mode calls setMode and moves the active class', () => {
    const { ctrl, setMode } = stubController();
    const el = buildSyncSection(ctrl, rtcStub);
    q(el, 'sync-mode-master').click();
    expect(setMode).toHaveBeenCalledWith('master');
    expect(q(el, 'sync-mode-master').classList.contains('active')).toBe(true);
    expect(q(el, 'sync-mode-off').classList.contains('active')).toBe(false);
  });

  it('renders a WiFi link button (opens the pair modal)', () => {
    const { ctrl } = stubController();
    const el = buildSyncSection(ctrl, rtcStub);
    expect(q(el, 'sync-wifi-link')).toBeTruthy();
  });

  it('shows "MIDI unavailable" when no transport has links', () => {
    const { ctrl } = stubController({ links: [] });
    const el = buildSyncSection(ctrl, rtcStub);
    expect(q(el, 'sync-status').textContent).toBe('MIDI unavailable');
  });

  it('shows "No MIDI ports" when the MIDI transport has none', () => {
    const { ctrl } = stubController({ links: [{ id: 'midi', ins: 0, outs: 0 }] });
    const el = buildSyncSection(ctrl, rtcStub);
    expect(q(el, 'sync-status').textContent).toBe('No MIDI ports');
  });

  it('appends the WiFi link state to the status line', () => {
    const { ctrl } = stubController({
      links: [{ id: 'midi', ins: 1, outs: 1 }, { id: 'wifi', ins: 0, outs: 0 }],
    });
    const el = buildSyncSection(ctrl, rtcStub);
    expect(q(el, 'sync-status').textContent).toContain('WiFi: not linked');

    const { ctrl: linked } = stubController({
      links: [{ id: 'midi', ins: 1, outs: 1 }, { id: 'wifi', ins: 1, outs: 1 }],
    });
    expect(q(buildSyncSection(linked, rtcStub), 'sync-status').textContent).toContain('WiFi: linked');
  });

  // v4 (midi-clock-sync REQ-22): a selected-but-unconnected mode stays the
  // *selected* segment (so the setting visibly persists) but reads as armed.
  it('marks a selected-but-inactive mode armed, keeping it selected', () => {
    const { ctrl } = stubController({ mode: 'slave', activeMode: 'off' });
    const el = buildSyncSection(ctrl, rtcStub);
    const slave = q(el, 'sync-mode-slave');
    expect(slave.classList.contains('active')).toBe(true);
    expect(slave.classList.contains('armed')).toBe(true);
    expect(slave.title).toContain('Remembered');
  });

  it('does not mark an active role armed', () => {
    const { ctrl } = stubController({
      mode: 'slave', activeMode: 'slave', links: [{ id: 'midi', ins: 1, outs: 0 }],
    });
    const el = buildSyncSection(ctrl, rtcStub);
    expect(q(el, 'sync-mode-slave').classList.contains('armed')).toBe(false);
    expect(q(el, 'sync-status').textContent).not.toContain('armed');
  });

  it('spells out why an armed mode is inert', () => {
    const noLink = stubController({ mode: 'slave', activeMode: 'off', links: [{ id: 'midi', ins: 0, outs: 0 }] });
    expect(q(buildSyncSection(noLink.ctrl, rtcStub), 'sync-status').textContent)
      .toContain('Slave armed — no link');

    // Ports present but nothing arriving — the lingering-virtual-cable case.
    const noClock = stubController({ mode: 'slave', activeMode: 'off', links: [{ id: 'midi', ins: 1, outs: 1 }] });
    expect(q(buildSyncSection(noClock.ctrl, rtcStub), 'sync-status').textContent)
      .toContain('Slave armed — no clock');

    const master = stubController({ mode: 'master', activeMode: 'off', links: [{ id: 'midi', ins: 1, outs: 0 }] });
    expect(q(buildSyncSection(master.ctrl, rtcStub), 'sync-status').textContent)
      .toContain('Master armed — nothing connected');
  });

  it('re-renders on status pushes: ports, followed BPM, stall', () => {
    const { ctrl, push } = stubController();
    const el = buildSyncSection(ctrl, rtcStub);
    const base: SyncStatus = {
      mode: 'slave', activeMode: 'slave', links: [{ id: 'midi', ins: 2, outs: 1 }], playing: true,
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
