// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStudioTransport } from '../../src/ui/components/studio-transport';
import type { StudioApi } from '../../src/ui/studio-api';
import type { Metronome, Beat } from '../../src/audio/metronome';
import { audibleTimeline } from '../../src/ui/audible';

/** sample-recorder.md REQ-the-transport-is-in-reach — the studio's transport strip. */
function setup() {
  const subs = { start: 0, stop: 0, beat: 0 };
  const clock = {
    bpm: 120, playing: false, step: 0,
    toggle: vi.fn(),
    onTick: () => () => {},
    onStart: () => { subs.start++; return () => { subs.start--; }; },
    onStop: () => { subs.stop++; return () => { subs.stop--; }; },
  };
  let beat: ((b: Beat) => void) | null = null;
  let click = false;
  const metronome = {
    get click() { return click; },
    setClick: vi.fn((on: boolean) => { click = on; }),
    onBeat: (fn: (b: Beat) => void) => { subs.beat++; beat = fn; return () => { subs.beat--; beat = null; }; },
  } as unknown as Metronome;
  const engine = { clock, ctx: { currentTime: 10 } } as unknown as StudioApi;
  // The shared audible timeline subscribes once per clock, for the page's life
  // (audible.ts) — the baseline the strip must return to.
  audibleTimeline(engine);
  const baseline = { ...subs };
  const toggleTransport = vi.fn();
  const onClickChange = vi.fn();
  const t = createStudioTransport({ engine, metronome, toggleTransport, onClickChange });
  document.body.appendChild(t.el);
  return { t, clock, subs, baseline, toggleTransport, onClickChange, fire: (b: Beat) => beat?.(b) };
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

describe('studio transport strip', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('Play goes through the header, never the clock (REQ-play-pause-is-not-a-second-truth)', () => {
    const s = setup();
    q('rec-transport-toggle').click();
    expect(s.toggleTransport).toHaveBeenCalledTimes(1);
    expect(s.clock.toggle).not.toHaveBeenCalled();
    s.t.destroy();
  });

  it('CLICK flips the metronome and reports the choice', () => {
    const s = setup();
    q('rec-click').click();
    expect(s.onClickChange).toHaveBeenCalledWith(true);
    expect(q('rec-click').getAttribute('aria-pressed')).toBe('true');
    s.t.destroy();
  });

  it('hands heard beats on, and destroy() takes every subscription off', () => {
    const s = setup();
    const heard: number[] = [];
    s.t.onHeardBeat((b) => heard.push(b.index));
    // `when` already past: painted at once.
    s.fire({ when: 9, downbeat: true, index: 0, playing: false });
    expect(heard).toEqual([0]);
    expect(q('rec-beat-led').dataset.beat).toBe('1');
    s.t.destroy();
    expect(s.subs).toEqual(s.baseline);
  });
});
