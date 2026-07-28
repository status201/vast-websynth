import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildZoetropeRow } from '../../src/ui/components/zoetrope-row';
import { ParamBus, registerDefaults } from '../../src/state/params';
import type { StudioApi } from '../../src/ui/studio-api';
import type { CycleMeter } from '../../src/audio/zoetrope/node';
import '../storage-mock';

/** The only part of StudioApi this module touches. */
function fakeEngine() {
  let cb: ((m: CycleMeter) => void) | null = null;
  const metering: boolean[] = [];
  const zoetrope = {
    setMetering: vi.fn((on: boolean) => metering.push(on)),
    onCycles: (fn: (m: CycleMeter) => void) => { cb = fn; },
  };
  return {
    engine: { zoetrope } as unknown as StudioApi,
    metering,
    emit(m: CycleMeter) { cb?.(m); },
  };
}

function meter(over: Partial<CycleMeter> = {}): CycleMeter {
  return { peaks: new Float32Array(4).fill(0.5), head: 3, lag: 1, count: 4, hz: 146, ...over };
}

function build() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const fake = fakeEngine();
  const row = buildZoetropeRow(bus, fake.engine);
  document.body.appendChild(row.el);
  return { bus, row, ...fake };
}

const testid = (root: HTMLElement, id: string): HTMLElement | null =>
  root.querySelector(`[data-testid="${id}"]`);

describe('Zoetrope module row', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('anchors help and testids at the module root, fx-group style', () => {
    const { row } = build();
    expect(row.el.dataset.testid).toBe('fxgroup-fx.zoetrope');
    expect(row.el.dataset.help).toBe('fx.zoetrope');
  });

  it('boots collapsed, with the header still visible', () => {
    const { bus, row } = build();
    expect(bus.get('fx.zoetrope.on')).toBe(0);
    expect(row.el.classList.contains('collapsed')).toBe(true);
    // The switch and the chips survive the collapse so it can be re-engaged and
    // help stays reachable (fx-group.md REQ-5).
    expect(testid(row.el, 'switch-fx.zoetrope.on')).not.toBeNull();
    expect(testid(row.el, 'switch-fx.zoetrope.pitchlock')).not.toBeNull();
  });

  it('carries every control the module owns', () => {
    const { row } = build();
    for (const id of [
      'knob-fx.zoetrope.scatter',
      'knob-fx.zoetrope.chaos',
      'knob-fx.zoetrope.smear',
      'knob-fx.zoetrope.sieve',
      'knob-fx.zoetrope.mix',
      'stepper-fx.zoetrope.depth',
      'seg-fx.zoetrope.source',
      'zoetrope-freeze',
      'zoetrope-strip',
      'zoetrope-adv',
    ]) {
      expect(testid(row.el, id), id).not.toBeNull();
    }
  });

  it('expands when the effect is engaged', () => {
    const { bus, row } = build();
    bus.set('fx.zoetrope.on', 1);
    expect(row.el.classList.contains('collapsed')).toBe(false);
  });

  it('keeps the advanced expander shut by default', () => {
    const { row } = build();
    expect(testid(row.el, 'zoetrope-adv')!.classList.contains('collapsed')).toBe(true);
    expect(testid(row.el, 'zoetrope-adv-toggle')).not.toBeNull();
  });

  it('asks for telemetry only while engaged and visible', () => {
    const { bus, row, metering } = build();
    expect(metering).toEqual([]); // bypassed at boot — nothing requested

    bus.set('fx.zoetrope.on', 1);
    expect(metering).toEqual([true]);

    row.setSectionCollapsed(true); // the FX rack folded
    expect(metering).toEqual([true, false]);

    row.setSectionCollapsed(false);
    expect(metering).toEqual([true, false, true]);

    bus.set('fx.zoetrope.on', 0);
    expect(metering).toEqual([true, false, true, false]);
  });

  it('does not re-request telemetry it already has', () => {
    const { bus, row, metering } = build();
    bus.set('fx.zoetrope.on', 1);
    row.setSectionCollapsed(false);
    bus.set('fx.zoetrope.on', 1);
    expect(metering).toEqual([true]);
  });

  it('renders the tracked pitch and the read position from telemetry', () => {
    const { bus, row, emit } = build();
    bus.set('fx.zoetrope.on', 1);

    emit(meter({ hz: 146.4, lag: 8 }));
    expect(testid(row.el, 'zoetrope-hz')!.textContent).toBe('tracking 146 hz');
    expect(testid(row.el, 'zoetrope-reading')!.textContent).toBe('reading -7');

    emit(meter({ hz: 0, lag: 1 }));
    expect(testid(row.el, 'zoetrope-hz')!.textContent).toBe('tracking —');
    expect(testid(row.el, 'zoetrope-reading')!.textContent).toBe('reading -0');
  });

  it('blanks the readouts when telemetry stops', () => {
    const { bus, row, emit } = build();
    bus.set('fx.zoetrope.on', 1);
    emit(meter({ hz: 220 }));
    expect(testid(row.el, 'zoetrope-hz')!.textContent).toBe('tracking 220 hz');

    bus.set('fx.zoetrope.on', 0);
    expect(testid(row.el, 'zoetrope-hz')!.textContent).toBe('tracking —');
    expect(testid(row.el, 'zoetrope-reading')!.textContent).toBe('reading —');
  });

  it('stops following the bus after destroy', () => {
    const { bus, row } = build();
    row.destroy();
    bus.set('fx.zoetrope.on', 1);
    expect(row.el.classList.contains('collapsed')).toBe(true);
  });
});
