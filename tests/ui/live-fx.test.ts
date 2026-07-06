import { describe, it, expect, vi } from 'vitest';
import { buildLiveFxControls } from '../../src/ui/components/live-fx';
import type { StudioApi } from '../../src/ui/studio-api';

/** Minimal StudioApi stub — buildLiveFxControls only reaches into `engine.perf`. */
function mkEngine() {
  const perf = {
    setFill: vi.fn(),
    setStutter: vi.fn(),
    setStutterSize: vi.fn(),
    setDrop: vi.fn(),
    setTapeStop: vi.fn(),
  };
  return { engine: { perf } as unknown as StudioApi, perf };
}

const byTestId = (els: HTMLElement[], id: string): HTMLElement => {
  const wrap = document.createElement('div');
  els.forEach((e) => wrap.appendChild(e));
  return wrap.querySelector(`[data-testid="${id}"]`) as HTMLElement;
};

describe('buildLiveFxControls', () => {
  it('emits Fill / Stutter (+sizes) / Drop / Tape Stop with the default perf-* testids', () => {
    const { engine } = mkEngine();
    const els = buildLiveFxControls(engine);
    for (const id of ['perf-fill', 'perf-stutter', 'perf-stutter-size-1', 'perf-stutter-size-2',
      'perf-stutter-size-4', 'perf-drop', 'perf-tapestop']) {
      expect(byTestId(els, id)).not.toBeNull();
    }
  });

  it('prefixes every testid when testIdPrefix is given (no collision with the Song panel)', () => {
    const { engine } = mkEngine();
    const els = buildLiveFxControls(engine, { testIdPrefix: 'livefx' });
    expect(byTestId(els, 'livefx-fill')).not.toBeNull();
    expect(byTestId(els, 'livefx-tapestop')).not.toBeNull();
    expect(byTestId(els, 'perf-fill')).toBeNull();
  });

  it('momentary buttons drive engine.perf on pointerdown and release on pointerup', () => {
    const { engine, perf } = mkEngine();
    const els = buildLiveFxControls(engine);
    const fill = byTestId(els, 'perf-fill');

    fill.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(perf.setFill).toHaveBeenLastCalledWith(true);
    fill.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(perf.setFill).toHaveBeenLastCalledWith(false);

    const drop = byTestId(els, 'perf-drop');
    drop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(perf.setDrop).toHaveBeenLastCalledWith(true);

    const tape = byTestId(els, 'perf-tapestop');
    tape.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(perf.setTapeStop).toHaveBeenLastCalledWith(true);
  });

  it('stutter size selects a value on the engine and marks the active button', () => {
    const { engine, perf } = mkEngine();
    const els = buildLiveFxControls(engine);
    const one = byTestId(els, 'perf-stutter-size-1');
    const quarter = byTestId(els, 'perf-stutter-size-4');

    // Default active is 1/8 (index 1, size 2).
    expect(byTestId(els, 'perf-stutter-size-2').classList.contains('active')).toBe(true);

    quarter.click();
    expect(perf.setStutterSize).toHaveBeenLastCalledWith(4);
    expect(quarter.classList.contains('active')).toBe(true);
    expect(one.classList.contains('active')).toBe(false);
  });
});
