import { describe, it, expect } from 'vitest';
import { fxGroup } from '../../src/ui/components/fx-group';
import { ParamBus, registerDefaults } from '../../src/state/params';
import styles from '../../src/ui/styles/fx-group.module.css';

function bus() {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

const KNOBS = [
  { id: 'fx.drum.phaser.rate', label: 'RATE' },
  { id: 'fx.drum.phaser.depth', label: 'DEP' },
];

describe('fxGroup', () => {
  it('renders divider, title, switch and a knobs container with one knob per entry', () => {
    const el = fxGroup(bus(), 'PHASER', 'fx.drum.phaser', KNOBS);
    expect(el.dataset.testid).toBe('fxgroup-fx.drum.phaser');
    expect(el.querySelector(`.${styles.divider!}`)).not.toBeNull();
    expect(el.querySelector(`.${styles.label!}`)?.textContent).toBe('PHASER');
    expect(el.querySelector('[data-testid="switch-fx.drum.phaser.on"]')).not.toBeNull();
    const knobRow = el.querySelector(`.${styles.knobs!}`)!;
    expect(knobRow.querySelectorAll('[data-testid^="knob-"]').length).toBe(KNOBS.length);
  });

  it('boots collapsed while the effect is off (the default)', () => {
    const b = bus();
    expect(b.get('fx.drum.phaser.on')).toBe(0);
    const el = fxGroup(b, 'PHASER', 'fx.drum.phaser', KNOBS);
    expect(el.classList.contains('collapsed')).toBe(true);
  });

  it('engaging the param reveals the knobs; bypassing re-collapses', () => {
    const b = bus();
    const el = fxGroup(b, 'PHASER', 'fx.drum.phaser', KNOBS);
    b.set('fx.drum.phaser.on', 1);
    expect(el.classList.contains('collapsed')).toBe(false);
    b.set('fx.drum.phaser.on', 0);
    expect(el.classList.contains('collapsed')).toBe(true);
  });

  it('clicking the switch expands the group (param round-trip)', () => {
    const b = bus();
    const el = fxGroup(b, 'PHASER', 'fx.drum.phaser', KNOBS);
    (el.querySelector('[data-testid="switch-fx.drum.phaser.on"]') as HTMLElement).click();
    expect(b.get('fx.drum.phaser.on')).toBe(1);
    expect(el.classList.contains('collapsed')).toBe(false);
  });

  it('puts the trailing element inside the hidden knobs container', () => {
    const trailing = document.createElement('div');
    trailing.dataset.testid = 'trailing-meter';
    const el = fxGroup(bus(), 'COMP', 'fx.drum.comp', [{ id: 'fx.drum.comp.threshold', label: 'THR' }], { trailing });
    const knobRow = el.querySelector(`.${styles.knobs!}`)!;
    expect(knobRow.contains(trailing)).toBe(true); // hides with the knobs while off
  });
});

describe('a title companion (fx-group.md REQ-a-group-can-host-a-title-companion)', () => {
  it('collapses with the knobs only when it opts in (v5)', () => {
    const b = bus();
    const setting = document.createElement('span');
    const caret = document.createElement('span');
    const withSetting = fxGroup(b, 'DELAY', 'fx.drum.delay', [], { afterTitle: setting, afterTitleCollapses: true });
    fxGroup(b, 'PHASER', 'fx.drum.phaser', KNOBS, { afterTitle: caret });
    // The delay's TYPE is a setting: it goes with the knobs while bypassed.
    expect(setting.classList.contains(styles.collapsible!)).toBe(true);
    expect(withSetting.classList.contains('collapsed')).toBe(true);
    // The slot caret is navigation: it never collapses.
    expect(caret.classList.contains(styles.collapsible!)).toBe(false);
  });

  it('the stylesheet hides a collapsible companion under .collapsed, as it does the knobs', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/ui/styles/fx-group.module.css', 'utf8');
    expect(css).toMatch(/\.root:global\(\.collapsed\)\s+\.collapsible\s*\{\s*display:\s*none;/);
  });
});
