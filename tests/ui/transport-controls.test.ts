// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  buildTransportControls, bindSeekAvailability, createTransportWindowLauncher,
} from '../../src/ui/components/transport-controls';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore, SEQ_LENGTH } from '../../src/state/patterns';
import { UiBridge } from '../../src/ui/ui-bridge';
import { TestClock } from '../audio/transport/test-clock';
import { Arrangement } from '../../src/audio/transport/arrangement';
import type { StudioApi } from '../../src/ui/studio-api';

function harness(over: { canSeek?: boolean } = {}) {
  const bus = new ParamBus();
  registerDefaults(bus);
  const clock = new TestClock();
  const patterns = new PatternStore();
  const arrangement = new Arrangement(patterns, clock);
  const bridge = new UiBridge();
  const toggleTransport = vi.fn();
  bridge.toggleTransport = toggleTransport;

  const seekTo = vi.fn((step: number) => {
    if (over.canSeek === false) return false;
    clock.fireSeek(step);
    return true;
  });
  const api = {
    clock,
    arrangement,
    seekTo,
    canSeek: () => over.canSeek !== false,
    sync: { onStatus: () => () => {} },
    recorder: { onState: () => () => {} },
    bankRender: { onState: () => () => {} },
  } as unknown as StudioApi;

  return { bus, clock, arrangement, api, bridge, seekTo, toggleTransport };
}

const host = (els: HTMLElement[]): HTMLElement => {
  const d = document.createElement('div');
  for (const e of els) d.appendChild(e);
  return d;
};
const byId = (root: HTMLElement, id: string): HTMLElement =>
  root.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const scrubCells = (root: HTMLElement): HTMLButtonElement[] =>
  [...root.querySelectorAll('[data-testid="transport-scrub"] button')] as HTMLButtonElement[];

describe('buildTransportControls', () => {
  it('compact drops Play, BPM and SWING; full carries them (REQ-1)', () => {
    const { api, bus, bridge } = harness();
    const compact = host(buildTransportControls(api, bus, bridge, { compact: true }));
    expect(byId(compact, 'transport-toggle')).toBeNull();
    expect(byId(compact, 'transport-tostart')).toBeTruthy();
    expect(byId(compact, 'transport-readout')).toBeTruthy();
    expect(byId(compact, 'transport-scrub')).toBeTruthy();
    expect(compact.querySelector('[data-testid="knob-transport.bpm"]')).toBeNull();

    const full = host(buildTransportControls(api, bus, bridge));
    expect(byId(full, 'transport-toggle')).toBeTruthy();
    expect(full.querySelector('[data-testid="knob-transport.bpm"]')).toBeTruthy();
    expect(full.querySelector('[data-testid="knob-transport.swing"]')).toBeTruthy();
  });

  it('namespaces every testid so two instances coexist (REQ-1)', () => {
    const { api, bus, bridge } = harness();
    const w = host(buildTransportControls(api, bus, bridge, { testIdPrefix: 'transportw' }));
    expect(byId(w, 'transportw-toggle')).toBeTruthy();
    expect(byId(w, 'transportw-readout')).toBeTruthy();
  });

  // REQ-5 — never a second source of truth for the transport.
  it('routes Play through the UiBridge, not the clock', () => {
    const { api, bus, bridge, clock, toggleTransport } = harness();
    const root = host(buildTransportControls(api, bus, bridge));
    (byId(root, 'transport-toggle') as HTMLButtonElement).click();
    expect(toggleTransport).toHaveBeenCalledTimes(1);
    expect(clock.playing).toBe(false); // the bridge owns it — we did not
  });

  it('mirrors the clock state on its Play label (REQ-5)', () => {
    const { api, bus, bridge, clock } = harness();
    const root = host(buildTransportControls(api, bus, bridge));
    const play = byId(root, 'transport-toggle');
    expect(play.textContent).toBe('Play');
    clock.fireStart();
    expect(play.textContent).toBe('Stop');
    expect(play.classList.contains('on')).toBe(true);
    clock.fireStop();
    expect(play.textContent).toBe('Play');
  });

  // REQ-6 — the readout and the machine-tab rulers must agree.
  it('reads bar.step, 1-based, and shows the CUE while stopped', () => {
    const { api, bus, bridge, clock } = harness();
    const root = host(buildTransportControls(api, bus, bridge, { compact: true }));
    expect(byId(root, 'transport-readout').textContent).toBe('1.01');

    clock.fireSeek(SEQ_LENGTH * 2 + 8); // bar 3, step 9
    expect(byId(root, 'transport-readout').textContent).toBe('3.09');

    // Stopped, the readout follows the cue rather than where playback halted.
    clock.fireStart();
    clock.step = 999;
    clock.fireStop();
    expect(byId(root, 'transport-readout').textContent).toBe('3.09');
  });

  // REQ-7 — the scrubber is the song, not the bar.
  it('shows one cell per bar of the longest enabled chain', () => {
    const { api, bus, bridge, arrangement } = harness();
    const root = host(buildTransportControls(api, bus, bridge, { compact: true }));
    expect(scrubCells(root)).toHaveLength(1); // nothing enabled: one repeating bar

    arrangement.setDrumChain([0, 1, 2, 3, 0, 1], true);
    expect(scrubCells(root)).toHaveLength(6);

    arrangement.setSeqChain([0, 1], true); // shorter: does not shrink the song
    expect(scrubCells(root)).toHaveLength(6);
  });

  it('rebuilds the cells only when the length changes (REQ-7)', () => {
    const { api, bus, bridge, arrangement, clock } = harness();
    const root = host(buildTransportControls(api, bus, bridge, { compact: true }));
    arrangement.setDrumChain([0, 1, 2], true);
    const before = scrubCells(root);

    clock.fireStart();
    for (let i = 0; i < SEQ_LENGTH * 2; i++) clock.fireTick(0);

    const after = scrubCells(root);
    expect(after[0]).toBe(before[0]); // same nodes — no teardown per tick
  });

  it('clicking a scrubber cell seeks to the top of that bar (REQ-7)', () => {
    const { api, bus, bridge, arrangement, seekTo } = harness();
    const root = host(buildTransportControls(api, bus, bridge, { compact: true }));
    arrangement.setSeqChain([0, 0, 1, 0], true);

    scrubCells(root)[2]!.click();
    expect(seekTo).toHaveBeenLastCalledWith(SEQ_LENGTH * 2);
    // …and the chain followed it (arrangement.md REQ-7).
    expect(arrangement.seqPlayBank).toBe(1);
  });

  it('lights the current bar and wraps with the chain', () => {
    const { api, bus, bridge, arrangement, clock } = harness();
    const root = host(buildTransportControls(api, bus, bridge, { compact: true }));
    arrangement.setSeqChain([0, 1, 2], true);
    const lit = () => scrubCells(root).findIndex((c) => c.classList.contains('playing'));
    expect(lit()).toBe(0);

    clock.fireSeek(SEQ_LENGTH * 1);
    expect(lit()).toBe(1);
    clock.fireSeek(SEQ_LENGTH * 4); // bar 5 of a 3-bar song wraps: 4 % 3 = 1
    expect(lit()).toBe(1);
  });

  it('⏮ returns to the top (REQ-4)', () => {
    const { api, bus, bridge, clock, seekTo } = harness();
    const root = host(buildTransportControls(api, bus, bridge, { compact: true }));
    clock.fireSeek(SEQ_LENGTH * 7 + 3);
    (byId(root, 'transport-tostart') as HTMLButtonElement).click();
    expect(seekTo).toHaveBeenLastCalledWith(0);
    expect(byId(root, 'transport-readout').textContent).toBe('1.01');
  });

  // REQ-8 — the one guard, surfaced.
  it('marks the row inert while seeking is refused', () => {
    const { api, bus, bridge, seekTo } = harness({ canSeek: false });
    const root = host(buildTransportControls(api, bus, bridge, { compact: true }));
    bindSeekAvailability(api, root);
    expect(root.className).toContain('off');

    (byId(root, 'transport-tostart') as HTMLButtonElement).click();
    expect(seekTo).toHaveReturnedWith(false);
  });
});

describe('createTransportWindowLauncher', () => {
  it('opens a TRANSPORT window carrying the full control set (REQ-2/REQ-3)', () => {
    const { api, bus, bridge } = harness();
    const b = createTransportWindowLauncher(api, bus, bridge);
    expect(b.dataset.testid).toBe('transport-open');
    expect(b.getAttribute('aria-label')).toBe('Open TRANSPORT window');
    expect(b.textContent).toContain('❐'); // the "opens a window" glyph

    b.click();
    const win = document.querySelector('[data-testid="transport-window"]') as HTMLElement;
    expect(win).toBeTruthy();
    expect(win.querySelector('[data-testid="transportw-toggle"]')).toBeTruthy();
    expect(win.querySelector('[data-testid="transportw-scrub"]')).toBeTruthy();
    expect(win.querySelector('[data-testid="knob-transport.bpm"]')).toBeTruthy();
    expect(b.classList.contains('on')).toBe(true);

    b.click(); // toggles closed
    expect(b.classList.contains('on')).toBe(false);
  });
});
