import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { buildFxRack } from '../../src/ui/panels/fx-rack';
import { delayFxGroup } from '../../src/ui/components/fx-group';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { DELAY_TYPE_LABELS } from '../../src/state/delay';
import ddStyles from '../../src/ui/styles/dropdown.module.css';

/**
 * delay-types.md REQ-type-is-a-header-dropdown-and-char-a-knob and
 * REQ-delay-type-testids — the synth rack's Delay panel, and the header group the
 * drum and sampler panels both build through `delayFxGroup`.
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
  ['synth rack', 'fx.delay', (b) => buildFxRack(b).el],
  ['drum header', 'fx.drum.delay', (b) => delayFxGroup(b, 'fx.drum.delay')],
  ['sampler header', 'fx.sampler.delay', (b) => delayFxGroup(b, 'fx.sampler.delay')],
];

describe.each(surfaces)('the %s delay', (_name, prefix, build) => {
  function mount() {
    const b = bus();
    const el = build(b);
    document.body.appendChild(el);
    const $ = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return { b, el, $ };
  }

  it('has the TYPE dropdown and TIME · FB · CHAR · MIX', () => {
    const { $ } = mount();
    const dd = $(`dropdown-${prefix}.type`)!;
    expect(dd).not.toBeNull();
    expect(dd.querySelector(`.${ddStyles.label!}`)?.textContent).toBe('DIGITAL');
    for (const k of ['time', 'feedback', 'char', 'mix']) expect($(`knob-${prefix}.${k}`)).not.toBeNull();
  });

  it('choosing a type sets the param', () => {
    const { b, $ } = mount();
    const opts = [...$(`dropdown-${prefix}.type`)!.querySelectorAll<HTMLButtonElement>(`.${ddStyles.option!}`)];
    expect(opts.map((o) => o.textContent)).toEqual(DELAY_TYPE_LABELS);
    opts.find((o) => o.textContent === 'TAPE')!.click();
    expect(b.get(`${prefix}.type`)).toBe(2);
  });

  it('dims CHAR at DIGITAL only, and never TIME', () => {
    const { b, $ } = mount();
    const char = $(`knob-${prefix}.char`)!;
    expect(char.getAttribute('aria-disabled')).toBe('true');
    expect($(`knob-${prefix}.time`)!.getAttribute('aria-disabled')).not.toBe('true');
    b.set(`${prefix}.type`, 2);
    expect(char.getAttribute('aria-disabled')).toBe('false');
    b.set(`${prefix}.type`, 0);
    expect(char.getAttribute('aria-disabled')).toBe('true');
  });
});
