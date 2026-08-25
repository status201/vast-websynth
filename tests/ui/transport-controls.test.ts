// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  buildTransportControls, bindSeekAvailability, createTransportWindowLauncher,
} from '../../src/ui/components/transport-controls';
import { PatternStore, SEQ_LENGTH } from '../../src/state/patterns';
import { UiBridge } from '../../src/ui/ui-bridge';
import { TestClock } from '../audio/transport/test-clock';
import { Arrangement } from '../../src/audio/transport/arrangement';
import type { StudioApi } from '../../src/ui/studio-api';

function harness(over: { canSeek?: boolean } = {}) {
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
    // 4/4 — what `registerDefaults` resolves the meter params to, so every
    // assertion in this file still describes a 16-tick bar (meter.md REQ-6).
    barTicks: SEQ_LENGTH,
    seekTo,
    canSeek: () => over.canSeek !== false,
    sync: { onStatus: () => () => {} },
    recorder: { onPhase: () => () => {} },
    bankRender: { onState: () => () => {} },
  } as unknown as StudioApi;

  return { clock, arrangement, api, bridge, seekTo, toggleTransport };
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
  it('compact drops Play/Stop; full carries it (REQ-1)', () => {
    const { api, bridge } = harness();
    const compact = host(buildTransportControls(api, bridge, { compact: true }));
    expect(byId(compact, 'transport-toggle')).toBeNull();
    expect(byId(compact, 'transport-tostart')).toBeTruthy();
    expect(byId(compact, 'transport-readout')).toBeTruthy();
    expect(byId(compact, 'transport-scrub')).toBeTruthy();

    const full = host(buildTransportControls(api, bridge));
    expect(byId(full, 'transport-toggle')).toBeTruthy();
  });

  // REQ-2 — the header owns BPM/SWING. A copy here would be a second control
  // for one param that does NOT know to disable itself while slaved.
  it('mints no BPM or SWING knob on either surface', () => {
    const { api, bridge } = harness();
    for (const els of [
      buildTransportControls(api, bridge, { compact: true }),
      buildTransportControls(api, bridge),
    ]) {
      const root = host(els);
      expect(root.querySelector('[data-testid="knob-transport.bpm"]')).toBeNull();
      expect(root.querySelector('[data-testid="knob-transport.swing"]')).toBeNull();
    }
  });

  it('namespaces every testid so two instances coexist (REQ-1)', () => {
    const { api, bridge } = harness();
    const w = host(buildTransportControls(api, bridge, { testIdPrefix: 'transportw' }));
    expect(byId(w, 'transportw-toggle')).toBeTruthy();
    expect(byId(w, 'transportw-readout')).toBeTruthy();
  });

  // REQ-5 — never a second source of truth for the transport.
  it('routes Play through the UiBridge, not the clock', () => {
    const { api, bridge, clock, toggleTransport } = harness();
    const root = host(buildTransportControls(api, bridge));
    (byId(root, 'transport-toggle') as HTMLButtonElement).click();
    expect(toggleTransport).toHaveBeenCalledTimes(1);
    expect(clock.playing).toBe(false); // the bridge owns it — we did not
  });

  it('mirrors the clock state on its Play label (REQ-5)', () => {
    const { api, bridge, clock } = harness();
    const root = host(buildTransportControls(api, bridge));
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
    const { api, bridge, clock, arrangement } = harness();
    const root = host(buildTransportControls(api, bridge, { compact: true }));
    expect(byId(root, 'transport-readout').textContent).toBe('1.01');

    arrangement.setDrumChain([0, 1, 2, 3], true); // bar 3 has to exist to be shown
    clock.fireSeek(SEQ_LENGTH * 2 + 8); // bar 3, step 9
    expect(byId(root, 'transport-readout').textContent).toBe('3.09');

    // Stopped, the readout follows the cue rather than where playback halted.
    clock.fireStart();
    clock.step = 999;
    clock.fireStop();
    expect(byId(root, 'transport-readout').textContent).toBe('3.09');
  });

  // REQ-6 (regression) — the readout used to print the ABSOLUTE bar, so a
  // one-bar song counted 1.01, 2.01, 3.01 … next to a single lit scrubber cell.
  it('wraps the bar at song length — never a bar the song does not have', () => {
    const { api, bridge, clock, arrangement } = harness();
    const root = host(buildTransportControls(api, bridge, { compact: true }));
    const readout = byId(root, 'transport-readout');

    // Nothing enabled: the song is one repeating bar, whatever the step counter says.
    clock.fireSeek(SEQ_LENGTH * 36 + 4);
    expect(readout.textContent).toBe('1.05');

    // With a three-bar chain, bar 5 is slot 2 — the same cell the scrubber lights.
    arrangement.setSeqChain([0, 1, 2], true);
    clock.fireSeek(SEQ_LENGTH * 4);
    expect(readout.textContent).toBe('2.01');
    expect(scrubCells(root).findIndex((c) => c.classList.contains('playing'))).toBe(1);
  });

  // REQ-7 — the scrubber is the song, not the bar.
  it('shows one cell per bar of the longest enabled chain', () => {
    const { api, bridge, arrangement } = harness();
    const root = host(buildTransportControls(api, bridge, { compact: true }));
    expect(scrubCells(root)).toHaveLength(1); // nothing enabled: one repeating bar

    arrangement.setDrumChain([0, 1, 2, 3, 0, 1], true);
    expect(scrubCells(root)).toHaveLength(6);

    arrangement.setSeqChain([0, 1], true); // shorter: does not shrink the song
    expect(scrubCells(root)).toHaveLength(6);
  });

  it('rebuilds the cells only when the length changes (REQ-7)', () => {
    const { api, bridge, arrangement, clock } = harness();
    const root = host(buildTransportControls(api, bridge, { compact: true }));
    arrangement.setDrumChain([0, 1, 2], true);
    const before = scrubCells(root);

    clock.fireStart();
    for (let i = 0; i < SEQ_LENGTH * 2; i++) clock.fireTick(0);

    const after = scrubCells(root);
    expect(after[0]).toBe(before[0]); // same nodes — no teardown per tick
  });

  it('clicking a scrubber cell seeks to the top of that bar (REQ-7)', () => {
    const { api, bridge, arrangement, seekTo } = harness();
    const root = host(buildTransportControls(api, bridge, { compact: true }));
    arrangement.setSeqChain([0, 0, 1, 0], true);

    scrubCells(root)[2]!.click();
    expect(seekTo).toHaveBeenLastCalledWith(SEQ_LENGTH * 2);
    // …and the chain followed it (arrangement.md REQ-7).
    expect(arrangement.seqPlayBank).toBe(1);
  });

  it('lights the current bar and wraps with the chain', () => {
    const { api, bridge, arrangement, clock } = harness();
    const root = host(buildTransportControls(api, bridge, { compact: true }));
    arrangement.setSeqChain([0, 1, 2], true);
    const lit = () => scrubCells(root).findIndex((c) => c.classList.contains('playing'));
    expect(lit()).toBe(0);

    clock.fireSeek(SEQ_LENGTH * 1);
    expect(lit()).toBe(1);
    clock.fireSeek(SEQ_LENGTH * 4); // bar 5 of a 3-bar song wraps: 4 % 3 = 1
    expect(lit()).toBe(1);
  });

  // REQ-11 — the timeline is one scrolling line, so the lit cell can leave the
  // view. jsdom has no layout: stub the three metrics the math reads (and
  // scrollLeft, which jsdom pins at 0) so the arithmetic itself is under test.
  it('scrolls the lit cell back into view, and only on a bar change', () => {
    const { api, bridge, arrangement, clock } = harness();
    const root = host(buildTransportControls(api, bridge, { compact: true }));
    arrangement.setDrumChain([...Array(40).keys()].map((i) => i % 4), true);

    const scrub = byId(root, 'transport-scrub');
    let scrollLeft = 0;
    Object.defineProperty(scrub, 'scrollLeft', {
      get: () => scrollLeft,
      set: (v: number) => { scrollLeft = v; },
    });
    Object.defineProperty(scrub, 'clientWidth', { get: () => 200 });
    scrubCells(root).forEach((c, i) => {
      Object.defineProperty(c, 'offsetLeft', { get: () => i * 25 });
      Object.defineProperty(c, 'offsetWidth', { get: () => 24 });
    });

    clock.fireSeek(SEQ_LENGTH * 20); // bar 21: cell 20 spans 500..524, far right
    expect(scrub.scrollLeft).toBe(326); // 524 - 200 + 2
    const before = scrub.scrollLeft;
    clock.fireTick(0); // same bar — no layout write
    expect(scrub.scrollLeft).toBe(before);

    clock.fireSeek(0); // back left, clamped at the origin rather than -2
    expect(scrub.scrollLeft).toBe(0);
  });

  it('⏮ returns to the top (REQ-4)', () => {
    const { api, bridge, clock, seekTo } = harness();
    const root = host(buildTransportControls(api, bridge, { compact: true }));
    clock.fireSeek(SEQ_LENGTH * 7 + 3);
    (byId(root, 'transport-tostart') as HTMLButtonElement).click();
    expect(seekTo).toHaveBeenLastCalledWith(0);
    expect(byId(root, 'transport-readout').textContent).toBe('1.01');
  });

  // REQ-8 — the one guard, surfaced.
  it('marks the row inert while seeking is refused', () => {
    const { api, bridge, seekTo } = harness({ canSeek: false });
    const root = host(buildTransportControls(api, bridge, { compact: true }));
    bindSeekAvailability(api, root);
    expect(root.className).toContain('off');

    (byId(root, 'transport-tostart') as HTMLButtonElement).click();
    expect(seekTo).toHaveReturnedWith(false);
  });
});

describe('createTransportWindowLauncher', () => {
  it('opens a TRANSPORT window carrying the full control set (REQ-2/REQ-3)', () => {
    const { api, bridge } = harness();
    const b = createTransportWindowLauncher(api, bridge);
    expect(b.dataset.testid).toBe('transport-open');
    expect(b.getAttribute('aria-label')).toBe('Open TRANSPORT window');
    expect(b.querySelector('svg.ui-icon')).not.toBeNull(); // the "opens a window" glyph

    b.click();
    const win = document.querySelector('[data-testid="transport-window"]') as HTMLElement;
    expect(win).toBeTruthy();
    expect(win.querySelector('[data-testid="transportw-toggle"]')).toBeTruthy();
    expect(win.querySelector('[data-testid="transportw-scrub"]')).toBeTruthy();
    expect(win.querySelector('[data-testid="knob-transport.bpm"]')).toBeNull();
    expect(b.classList.contains('on')).toBe(true);

    b.click(); // toggles closed
    expect(b.classList.contains('on')).toBe(false);
  });
});
