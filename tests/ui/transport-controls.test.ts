// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  buildTransportControls, bindSeekAvailability, createTransportWindowLauncher,
} from '../../src/ui/components/transport-controls';
import { PatternStore, SEQ_LENGTH } from '../../src/state/patterns';
import { UiBridge } from '../../src/ui/ui-bridge';
import { TestClock } from '../audio/transport/test-clock';
import { Arrangement } from '../../src/audio/transport/arrangement';
import { TransportLoop } from '../../src/audio/transport/transport-loop';
import type { StudioApi } from '../../src/ui/studio-api';

function harness(over: { canSeek?: boolean } = {}) {
  const clock = new TestClock();
  const loop = new TransportLoop();
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
    loop,
    // 4/4 — what `registerDefaults` resolves the meter params to, so every
    // assertion in this file still describes a 16-tick bar (meter.md REQ-bar-ticks-is-the-arrangement-bar-line).
    barTicks: SEQ_LENGTH,
    seekTo,
    canSeek: () => over.canSeek !== false,
    sync: { onStatus: () => () => {} },
    recorder: { onPhase: () => () => {} },
    bankRender: { onState: () => () => {} },
  } as unknown as StudioApi;

  return { clock, arrangement, loop, api, bridge, seekTo, toggleTransport };
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
  // REQ-a-song-captures-the-whole-session/REQ-legacy-step-cells-still-sound-right (v5) — the Song row is no longer compact: same set as the window.
  it('renders Play/Pause, ⏮, readout, Loop and scrubber, in that order', () => {
    const { api, bridge } = harness();
    const root = host(buildTransportControls(api, bridge));
    const ids = [...root.children].map((c) => (c as HTMLElement).dataset.testid);
    expect(ids).toEqual([
      'transport-toggle', 'transport-tostart', 'transport-readout', 'transport-loop', 'transport-scrub',
    ]);
  });

  // REQ-song-file-is-a-versioned-union — the header owns BPM/SWING. A copy here would be a second control
  // for one param that does NOT know to disable itself while slaved.
  it('mints no BPM or SWING knob on either surface', () => {
    const { api, bridge } = harness();
    for (const els of [
      buildTransportControls(api, bridge),
      buildTransportControls(api, bridge, { testIdPrefix: 'transportw' }),
    ]) {
      const root = host(els);
      expect(root.querySelector('[data-testid="knob-transport.bpm"]')).toBeNull();
      expect(root.querySelector('[data-testid="knob-transport.swing"]')).toBeNull();
    }
  });

  it('namespaces every testid so two instances coexist (REQ-a-song-captures-the-whole-session)', () => {
    const { api, bridge } = harness();
    const w = host(buildTransportControls(api, bridge, { testIdPrefix: 'transportw' }));
    expect(byId(w, 'transportw-toggle')).toBeTruthy();
    expect(byId(w, 'transportw-readout')).toBeTruthy();
  });

  // REQ-audio-is-never-embedded-in-the-json — never a second source of truth for the transport.
  it('routes Play through the UiBridge, not the clock', () => {
    const { api, bridge, clock, toggleTransport } = harness();
    const root = host(buildTransportControls(api, bridge));
    (byId(root, 'transport-toggle') as HTMLButtonElement).click();
    expect(toggleTransport).toHaveBeenCalledTimes(1);
    expect(clock.playing).toBe(false); // the bridge owns it — we did not
  });

  // REQ-audio-is-never-embedded-in-the-json/REQ-sync-and-audio-pair-up (v5) — Pause is the clock's; the header's click means Stop.
  it('pauses through the clock while playing, never through the bridge', () => {
    const { api, bridge, clock, toggleTransport } = harness();
    const root = host(buildTransportControls(api, bridge));
    const pause = vi.spyOn(clock, 'pause');
    clock.fireStart();
    clock.step = 37;
    (byId(root, 'transport-toggle') as HTMLButtonElement).click();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(toggleTransport).not.toHaveBeenCalled();
    expect(clock.playing).toBe(false);
    // Stopped, the readout shows where Play continues — the resume point (REQ-mute-and-solo-share-one-rule).
    expect(byId(root, 'transport-readout').textContent).toBe('1.06');
  });

  it('mirrors the clock state on its Play / Pause label (REQ-audio-is-never-embedded-in-the-json)', () => {
    const { api, bridge, clock } = harness();
    const root = host(buildTransportControls(api, bridge));
    const play = byId(root, 'transport-toggle');
    expect(play.textContent).toBe('Play');
    clock.fireStart();
    expect(play.textContent).toBe('Pause');
    expect(play.classList.contains('on')).toBe(true);
    clock.pause();
    expect(play.textContent).toBe('Play');
    expect(play.title).toMatch(/where you paused/);
    clock.start(); // resumes, and the pause is spent
    clock.stop();
    expect(play.title).not.toMatch(/paused/);
  });

  // REQ-mute-and-solo-share-one-rule — the readout and the machine-tab rulers must agree.
  it('reads bar.step, 1-based, and shows the CUE while stopped', () => {
    const { api, bridge, clock, arrangement } = harness();
    const root = host(buildTransportControls(api, bridge));
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

  // REQ-mute-and-solo-share-one-rule (regression) — the readout used to print the ABSOLUTE bar, so a
  // one-bar song counted 1.01, 2.01, 3.01 … next to a single lit scrubber cell.
  it('wraps the bar at song length — never a bar the song does not have', () => {
    const { api, bridge, clock, arrangement } = harness();
    const root = host(buildTransportControls(api, bridge));
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

  // REQ-play-banks-settle-before-the-machines-read — the scrubber is the song, not the bar.
  it('shows one cell per bar of the longest enabled chain', () => {
    const { api, bridge, arrangement } = harness();
    const root = host(buildTransportControls(api, bridge));
    expect(scrubCells(root)).toHaveLength(1); // nothing enabled: one repeating bar

    arrangement.setDrumChain([0, 1, 2, 3, 0, 1], true);
    expect(scrubCells(root)).toHaveLength(6);

    arrangement.setSeqChain([0, 1], true); // shorter: does not shrink the song
    expect(scrubCells(root)).toHaveLength(6);
  });

  it('rebuilds the cells only when the length changes (REQ-play-banks-settle-before-the-machines-read)', () => {
    const { api, bridge, arrangement, clock } = harness();
    const root = host(buildTransportControls(api, bridge));
    arrangement.setDrumChain([0, 1, 2], true);
    const before = scrubCells(root);

    clock.fireStart();
    for (let i = 0; i < SEQ_LENGTH * 2; i++) clock.fireTick(0);

    const after = scrubCells(root);
    expect(after[0]).toBe(before[0]); // same nodes — no teardown per tick
  });

  it('clicking a scrubber cell seeks to the top of that bar (REQ-play-banks-settle-before-the-machines-read)', () => {
    const { api, bridge, arrangement, seekTo } = harness();
    const root = host(buildTransportControls(api, bridge));
    arrangement.setSeqChain([0, 0, 1, 0], true);

    scrubCells(root)[2]!.click();
    expect(seekTo).toHaveBeenLastCalledWith(SEQ_LENGTH * 2);
    // …and the chain followed it (arrangement.md REQ-a-mid-play-seek-re-seeks-every-lane).
    expect(arrangement.seqPlayBank).toBe(1);
  });

  it('lights the current bar and wraps with the chain', () => {
    const { api, bridge, arrangement, clock } = harness();
    const root = host(buildTransportControls(api, bridge));
    arrangement.setSeqChain([0, 1, 2], true);
    const lit = () => scrubCells(root).findIndex((c) => c.classList.contains('playing'));
    expect(lit()).toBe(0);

    clock.fireSeek(SEQ_LENGTH * 1);
    expect(lit()).toBe(1);
    clock.fireSeek(SEQ_LENGTH * 4); // bar 5 of a 3-bar song wraps: 4 % 3 = 1
    expect(lit()).toBe(1);
  });

  // REQ-song-lane-titles-navigate — the timeline is one scrolling line, so the lit cell can leave the
  // view. jsdom has no layout: stub the three metrics the math reads (and
  // scrollLeft, which jsdom pins at 0) so the arithmetic itself is under test.
  it('scrolls the lit cell back into view, and only on a bar change', () => {
    const { api, bridge, arrangement, clock } = harness();
    const root = host(buildTransportControls(api, bridge));
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

  it('⏮ returns to the top (REQ-legacy-step-cells-still-sound-right)', () => {
    const { api, bridge, clock, seekTo } = harness();
    const root = host(buildTransportControls(api, bridge));
    clock.fireSeek(SEQ_LENGTH * 7 + 3);
    (byId(root, 'transport-tostart') as HTMLButtonElement).click();
    expect(seekTo).toHaveBeenLastCalledWith(0);
    expect(byId(root, 'transport-readout').textContent).toBe('1.01');
  });

  // REQ-an-imported-file-is-validated-first — the one guard, surfaced.
  it('marks the row inert while seeking is refused', () => {
    const { api, bridge, seekTo } = harness({ canSeek: false });
    const root = host(buildTransportControls(api, bridge));
    bindSeekAvailability(api, root);
    expect(root.className).toContain('off');

    (byId(root, 'transport-tostart') as HTMLButtonElement).click();
    expect(seekTo).toHaveReturnedWith(false);
  });
});

describe('createTransportWindowLauncher', () => {
  it('opens a TRANSPORT window carrying the full control set (REQ-song-file-is-a-versioned-union/REQ-apply-resets-to-defaults-first)', () => {
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

// transport-loop.md — the Loop button and the scrubber picks.
describe('transport loop controls', () => {
  const loopBtn = (root: HTMLElement) => byId(root, 'transport-loop') as HTMLButtonElement;

  // REQ-a-song-captures-the-whole-session — lit, pressed, and titled by state.
  it('toggles Loop and mirrors it on the button', () => {
    const { api, bridge, loop } = harness();
    const root = host(buildTransportControls(api, bridge));
    expect(loopBtn(root).getAttribute('aria-pressed')).toBe('false');
    loopBtn(root).click();
    expect(loop.enabled).toBe(true);
    expect(loopBtn(root).classList.contains('on')).toBe(true);
    expect(loopBtn(root).getAttribute('aria-pressed')).toBe('true');
    expect(loopBtn(root).title).toMatch(/first and last bar/);
  });

  // REQ-song-file-is-a-versioned-union — Loop on turns a click into a pick, and says so on the cells.
  it('while Loop is on, a scrubber click picks instead of seeking', () => {
    const { api, bridge, arrangement, loop, seekTo } = harness();
    const root = host(buildTransportControls(api, bridge));
    arrangement.setSeqChain([0, 1, 2, 3], true);
    expect(scrubCells(root)[1]!.title).toBe('Jump to bar 2');

    loopBtn(root).click();
    expect(scrubCells(root)[1]!.title).toBe('Loop from bar 2');
    scrubCells(root)[2]!.click();
    expect(seekTo).not.toHaveBeenCalled();
    expect(loop.anchor).toBe(2);
    expect(scrubCells(root)[2]!.classList.contains('loop-anchor')).toBe(true);
    expect(scrubCells(root)[0]!.title).toBe('Loop bars 1–3');

    scrubCells(root)[1]!.click();
    expect(loop.range).toEqual({ start: 1, end: 2 });
    expect(scrubCells(root).map((c) => c.classList.contains('loop'))).toEqual([false, true, true, false]);
    expect(root.querySelector('.loop-anchor')).toBeNull();
    expect(loopBtn(root).title).toMatch(/Looping bars 2–3/);
  });

  // REQ-song-file-is-a-versioned-union — the old range stays drawn until the second pick replaces it.
  it('a first pick on a looping range keeps the range drawn', () => {
    const { api, bridge, arrangement } = harness();
    const root = host(buildTransportControls(api, bridge));
    arrangement.setSeqChain([0, 1, 2, 3], true);
    loopBtn(root).click();
    scrubCells(root)[1]!.click();
    scrubCells(root)[2]!.click();
    scrubCells(root)[3]!.click(); // a new anchor
    expect(scrubCells(root).map((c) => c.classList.contains('loop'))).toEqual([false, true, true, false]);
    expect(scrubCells(root)[3]!.classList.contains('loop-anchor')).toBe(true);
  });

  // REQ-audio-is-never-embedded-in-the-json — off keeps the range, drawn dimmed; clicks seek again.
  it('Loop off keeps the range on the cells and restores seeking', () => {
    const { api, bridge, arrangement, seekTo } = harness();
    const root = host(buildTransportControls(api, bridge));
    arrangement.setSeqChain([0, 1, 2, 3], true);
    loopBtn(root).click();
    scrubCells(root)[1]!.click();
    scrubCells(root)[2]!.click();
    loopBtn(root).click(); // off

    expect(scrubCells(root)[1]!.classList.contains('loop')).toBe(true);
    const scrub = byId(root, 'transport-scrub');
    expect(scrub.className).toMatch(/loopIdle/);
    expect(scrub.className).not.toMatch(/picking/);
    expect(loopBtn(root).title).toMatch(/Loop bars 2–3 again/);
    scrubCells(root)[3]!.click();
    expect(seekTo).toHaveBeenLastCalledWith(SEQ_LENGTH * 3);
  });

  // REQ-play-banks-settle-before-the-machines-read — a shorter song clamps what is drawn, not what was picked.
  it('draws the range clamped to the song length', () => {
    const { api, bridge, arrangement, loop } = harness();
    const root = host(buildTransportControls(api, bridge));
    arrangement.setSeqChain([0, 1, 2, 3, 0, 1], true);
    loop.setEnabled(true);
    loop.pick(2);
    loop.pick(5);
    arrangement.setSeqChain([0, 1, 2, 3], true);
    expect(scrubCells(root).map((c) => c.classList.contains('loop'))).toEqual([false, false, true, true]);
    expect(loop.range).toEqual({ start: 2, end: 5 });
  });

  // REQ-mute-and-solo-share-one-rule — a wrap is a seek; where seeking is refused, so is looping.
  it('the Loop button and the picks do nothing while seeking is refused', () => {
    const { api, bridge, arrangement, loop } = harness({ canSeek: false });
    const root = host(buildTransportControls(api, bridge));
    arrangement.setSeqChain([0, 1, 2, 3], true);
    loopBtn(root).click();
    expect(loop.enabled).toBe(false);

    loop.setEnabled(true); // engaged before the refusal began
    scrubCells(root)[1]!.click();
    expect(loop.anchor).toBeNull();
  });

  it('both surfaces mirror one loop', () => {
    const { api, bridge, loop } = harness();
    const row = host(buildTransportControls(api, bridge));
    const win = host(buildTransportControls(api, bridge, { testIdPrefix: 'transportw' }));
    loopBtn(row).click();
    expect(loop.enabled).toBe(true);
    expect(byId(win, 'transportw-loop').classList.contains('on')).toBe(true);
  });
});
