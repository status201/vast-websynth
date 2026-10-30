import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { buildFxRack } from '../../src/ui/panels/fx-rack';
import { dirtFxGroup } from '../../src/ui/components/fx-group';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { DIRT_TYPE_LABELS } from '../../src/state/dirt';
import ddStyles from '../../src/ui/styles/dropdown.module.css';
import fxStyles from '../../src/ui/styles/fx-rack.module.css';

/**
 * dirt-types.md REQ-dirt-type-is-the-panel-title and REQ-dirt-type-testids —
 * the synth rack's Dirt panel and the sampler's DIRT header group.
 */

function bus(): ParamBus {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const surfaces: Array<[name: string, prefix: string, build: (b: ParamBus) => HTMLElement]> = [
  ['synth rack', 'fx.dist', (b) => buildFxRack(b).el],
  ['sampler header', 'fx.sampler.dist', (b) => dirtFxGroup(b, 'fx.sampler.dist')],
];

describe.each(surfaces)('the %s Dirt', (_name, prefix, build) => {
  function mount() {
    const b = bus();
    const el = build(b);
    document.body.appendChild(el);
    const $ = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return { b, el, $ };
  }

  it('has the TYPE dropdown on DISTORTION, and DRIVE · TONE · MIX', () => {
    const { $ } = mount();
    const dd = $(`dropdown-${prefix}.type`)!;
    expect(dd).not.toBeNull();
    expect(dd.querySelector(`.${ddStyles.label!}`)?.textContent).toBe('DISTORTION');
    for (const k of ['drive', 'tone', 'mix']) expect($(`knob-${prefix}.${k}`)).not.toBeNull();
  });

  it('choosing FUZZ sets the param', () => {
    const { b, $ } = mount();
    const opts = [...$(`dropdown-${prefix}.type`)!.querySelectorAll<HTMLButtonElement>(`.${ddStyles.option!}`)];
    expect(opts.map((o) => o.textContent)).toEqual(DIRT_TYPE_LABELS);
    opts.find((o) => o.textContent === 'FUZZ')!.click();
    expect(b.get(`${prefix}.type`)).toBe(2);
  });

  it(prefix === 'fx.dist' ? 'is the panel title, with a Dirt legend' : 'carries no legend', () => {
    const { el, $ } = mount();
    const legend = $(`dropdown-${prefix}.type`)!.querySelector(`.${ddStyles.legend!}`);
    if (prefix === 'fx.dist') {
      expect(legend?.textContent).toBe('Dirt');
      const row = el.querySelector<HTMLElement>('[data-help="fx.dist"]')!;
      expect(row.firstElementChild?.getAttribute('data-testid')).toBe('dropdown-fx.dist.type');
      expect(row.querySelector(`.${fxStyles.fxTitle!}`)).toBeNull();
    } else {
      expect(legend).toBeNull();
    }
  });
});
