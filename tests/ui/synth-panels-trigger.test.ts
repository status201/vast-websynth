import { describe, it, expect } from 'vitest';
import { buildSynthPanels } from '../../src/ui/panels/synth-panels';
import { ParamBus, registerDefaults, VOICING_LABELS } from '../../src/state/params';

/**
 * The two MULTI | SINGLE switches only mean something to a mono voice, so POLY
 * dims them in place, the way LADDER dims SHAPE (voicing.md
 * REQ-the-trigger-switches-dim-in-poly).
 */
const MONO = VOICING_LABELS.indexOf('mono');
const POLY = VOICING_LABELS.indexOf('poly');

function build() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const el = buildSynthPanels(bus);
  const seg = (id: string) => el.querySelector<HTMLElement>(`[data-testid="seg-${id}"]`)!;
  const button = (id: string, i: number) =>
    el.querySelector<HTMLButtonElement>(`[data-testid="seg-${id}-${i}"]`)!;
  return { bus, seg, button };
}

describe('the envelope trigger switches dim in Poly (REQ-the-trigger-switches-dim-in-poly)', () => {
  it('are dimmed, disabled and say why while POLY (the default)', () => {
    const { bus, seg, button } = build();
    expect(Math.round(bus.get('voicing.mode'))).toBe(POLY);
    for (const id of ['env.amp.trigger', 'env.fil.trigger']) {
      expect(seg(id).getAttribute('aria-disabled')).toBe('true');
      expect(seg(id).title).toMatch(/mono only/i);
      expect(button(id, 1).disabled).toBe(true);
    }
  });

  it('take no click while dimmed', () => {
    const { bus, button } = build();
    button('env.amp.trigger', 1).click();
    expect(bus.get('env.amp.trigger')).toBe(0);
  });

  it('come back in MONO with the stored value untouched', () => {
    const { bus, seg, button } = build();
    bus.set('env.amp.trigger', 1); // set by a preset while POLY
    bus.set('voicing.mode', MONO);
    for (const id of ['env.amp.trigger', 'env.fil.trigger']) {
      expect(seg(id).getAttribute('aria-disabled')).toBe('false');
      expect(seg(id).hasAttribute('title')).toBe(false);
      expect(button(id, 1).disabled).toBe(false);
    }
    expect(button('env.amp.trigger', 1).classList.contains('active')).toBe(true);
    button('env.fil.trigger', 1).click();
    expect(bus.get('env.fil.trigger')).toBe(1);
  });
});
