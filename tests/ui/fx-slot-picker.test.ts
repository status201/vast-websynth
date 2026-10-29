import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { buildFxRack } from '../../src/ui/panels/fx-rack';
import { createFxSlot, initialFxView, type FxSlotView } from '../../src/ui/components/fx-slot-picker';
import { fxGroup, fxGroupParts } from '../../src/ui/components/fx-group';
import { dimWhileModeSet } from '../../src/ui/components/knob';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { CHORUS_MODE_LABELS, CHORUS_MODE_OVERRIDES } from '../../src/state/chorus';
import fxStyles from '../../src/ui/styles/fx-rack.module.css';

function bus(): ParamBus {
  const b = new ParamBus();
  registerDefaults(b);
  return b;
}

/** The synth rack, mounted so outside clicks and Escape reach the document. */
function rack(b: ParamBus) {
  const { el } = buildFxRack(b);
  document.body.appendChild(el);
  const $ = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return {
    el,
    $,
    phaser: $('fxview-fx.phaser')!,
    chorus: $('fxview-fx.chorus')!,
    caret: () => $('fxpick-fx.phaser')!,
    item: (prefix: string) => $(`fxpick-fx.phaser-${prefix}`)!,
    menuOpen: () => $('fxpick-fx.phaser')!.parentElement!.classList.contains('open'),
  };
}

// jsdom has no matchMedia; the rack's fold asks it whether the viewport is compact.
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** What a song load does to the bus (song.ts Song.apply). */
function load(b: ParamBus, params: Record<string, number>): void {
  b.resetDefaults();
  b.restore(params);
}

describe('the Phaser panel is a slot (fx-slot-picker.md)', () => {
  it('shows the Phaser by default, its title intact, with a caret right after it', () => {
    const r = rack(bus());
    expect(r.phaser.hidden).toBe(false);
    expect(r.chorus.hidden).toBe(true);
    const title = r.phaser.querySelector(`.${fxStyles.fxTitle!}`)!;
    expect(title.textContent).toBe('Phaser');
    // Nothing but the text in the title element itself (REQ-the-title-is-unchanged-plus-a-caret).
    expect(title.children).toHaveLength(0);
    // The caret is the title's next sibling, an SVG icon (never a typed glyph).
    const caret = r.caret();
    expect(title.nextElementSibling?.contains(caret)).toBe(true);
    expect(caret.querySelector('svg.ui-icon')).not.toBeNull();
    expect(caret.textContent).toBe('');
  });

  it('keeps each effect\'s own switch and knobs', () => {
    const r = rack(bus());
    expect(r.phaser.querySelector('[data-testid="switch-fx.phaser.on"]')).not.toBeNull();
    expect(r.chorus.querySelector('[data-testid="switch-fx.chorus.on"]')).not.toBeNull();
    for (const k of ['rate', 'depth', 'mode', 'mix']) {
      expect(r.chorus.querySelector(`[data-testid="knob-fx.chorus.${k}"]`), k).not.toBeNull();
    }
  });

  it('the caret opens a menu that swaps the view and closes', () => {
    const r = rack(bus());
    r.caret().click();
    expect(r.menuOpen()).toBe(true);
    expect(r.item('fx.phaser').textContent).toBe('Phaser');
    expect(r.item('fx.chorus').textContent).toBe('Chorus');
    r.item('fx.chorus').click();
    expect(r.menuOpen()).toBe(false);
    expect(r.chorus.hidden).toBe(false);
    expect(r.phaser.hidden).toBe(true);
    // The caret travelled with the view, so it sits after the Chorus title now.
    expect(r.chorus.contains(r.caret())).toBe(true);
  });

  it('lamps a running effect and marks the shown one (REQ-the-menu-lists-every-effect-in-the-slot)', () => {
    const b = bus();
    const r = rack(b);
    b.set('fx.chorus.on', 1);
    r.caret().click();
    expect(r.item('fx.chorus').classList.contains('lit')).toBe(true);
    expect(r.item('fx.phaser').classList.contains('lit')).toBe(false);
    expect(r.item('fx.phaser').classList.contains('active')).toBe(true);
    expect(r.item('fx.chorus').classList.contains('active')).toBe(false);
  });

  it('the title opens the menu too, and follows the view (REQ-the-title-opens-the-menu)', () => {
    const r = rack(bus());
    const title = (view: HTMLElement) => view.querySelector<HTMLElement>(`.${fxStyles.fxTitle!}`)!;
    title(r.phaser).click();
    expect(r.menuOpen()).toBe(true);
    title(r.phaser).click();
    expect(r.menuOpen()).toBe(false);
    r.caret().click();
    r.item('fx.chorus').click();
    title(r.chorus).click();
    expect(r.menuOpen()).toBe(true);
    // Not a focus stop: the caret is the keyboard path.
    expect(title(r.chorus).hasAttribute('tabindex')).toBe(false);
  });

  it('the title opens the menu in a sampler-style group too', () => {
    const b = bus();
    const view = (prefix: string): FxSlotView => {
      const host = document.createElement('span');
      const g = fxGroupParts(b, prefix, prefix, [], { afterTitle: host });
      document.body.appendChild(g.el);
      return { prefix, title: prefix, el: g.el, caretHost: host, titleEl: g.label };
    };
    const views = [view('fx.sampler.phaser'), view('fx.sampler.chorus')];
    createFxSlot(b, views);
    views[0]!.titleEl.click();
    expect(document.querySelector('[data-testid="fxpick-fx.sampler.phaser"]')!.parentElement!.classList.contains('open')).toBe(true);
  });

  it('opening by title or caret closes another open menu (dropdown.md v12)', () => {
    const b = bus();
    const r = rack(b);
    // A second slot, as the sampler header has, standing in for "another menu".
    const view = (prefix: string): FxSlotView => {
      const host = document.createElement('span');
      const g = fxGroupParts(b, prefix, prefix, [], { afterTitle: host });
      document.body.appendChild(g.el);
      return { prefix, title: prefix, el: g.el, caretHost: host, titleEl: g.label };
    };
    const views = [view('fx.sampler.phaser'), view('fx.sampler.chorus')];
    createFxSlot(b, views);
    const otherOpen = () =>
      document.querySelector('[data-testid="fxpick-fx.sampler.phaser"]')!.parentElement!.classList.contains('open');
    views[0]!.titleEl.click();
    expect(otherOpen()).toBe(true);
    r.phaser.querySelector<HTMLElement>(`.${fxStyles.fxTitle!}`)!.click();
    expect(r.menuOpen()).toBe(true);
    expect(otherOpen()).toBe(false);
    // The other title in turn closes this one; then the caret swaps them back.
    views[0]!.titleEl.click();
    expect(r.menuOpen()).toBe(false);
    expect(otherOpen()).toBe(true);
    r.caret().click();
    expect(r.menuOpen()).toBe(true);
    expect(otherOpen()).toBe(false);
  });

  it('Escape and an outside click close without choosing (edge)', () => {
    const r = rack(bus());
    r.caret().click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(r.menuOpen()).toBe(false);
    r.caret().click();
    document.body.click();
    expect(r.menuOpen()).toBe(false);
    expect(r.phaser.hidden).toBe(false);
  });
});

describe('a load shows the running effect (REQ-a-load-shows-the-running-effect)', () => {
  const cases: Array<[phaser: number, chorus: number, view: 'phaser' | 'chorus']> = [
    [0, 0, 'phaser'],
    [1, 0, 'phaser'],
    [1, 1, 'phaser'],
    [0, 1, 'chorus'],
  ];

  it.each(cases)('phaser %i, chorus %i -> %s', (phaser, chorus, view) => {
    const b = bus();
    const r = rack(b);
    // Start on the other view, so the rule has to move it.
    r.caret().click();
    r.item(view === 'phaser' ? 'fx.chorus' : 'fx.phaser').click();
    load(b, { 'fx.phaser.on': phaser, 'fx.chorus.on': chorus });
    expect(r[view].hidden).toBe(false);
    expect(r[view === 'phaser' ? 'chorus' : 'phaser'].hidden).toBe(true);
  });

  it('applies the rule at build time, which is how a restored session lands', () => {
    const b = bus();
    load(b, { 'fx.chorus.on': 1 });
    const r = rack(b);
    expect(r.chorus.hidden).toBe(false);
  });

  it('a plain toggle never moves the view (edge)', () => {
    const b = bus();
    const r = rack(b);
    b.set('fx.chorus.on', 1);
    b.set('fx.phaser.on', 1);
    b.set('fx.phaser.on', 0);
    expect(r.phaser.hidden).toBe(false);
  });

  it('a bulk apply that touches none of the slot\'s switches leaves it alone (edge)', () => {
    const b = bus();
    const view = (prefix: string): FxSlotView => {
      const host = document.createElement('span');
      const g = fxGroupParts(b, prefix, prefix, [], { afterTitle: host });
      return { prefix, title: prefix, el: g.el, caretHost: host, titleEl: g.label };
    };
    const views = [view('fx.sampler.phaser'), view('fx.sampler.chorus')];
    b.set('fx.sampler.phaser.on', 1);
    b.set('fx.sampler.chorus.on', 1);
    const slot = createFxSlot(b, views);
    slot.show('fx.sampler.chorus');
    // A synth preset load: a restore naming only synth ids.
    b.restore({ 'fx.phaser.on': 0, 'fx.chorus.on': 0 });
    expect(slot.current).toBe('fx.sampler.chorus');
  });

  it('initialFxView prefers the primary unless only another is on', () => {
    const b = bus();
    const v = [{ prefix: 'fx.phaser' }, { prefix: 'fx.chorus' }];
    expect(initialFxView(b, v)).toBe('fx.phaser');
    b.set('fx.chorus.on', 1);
    expect(initialFxView(b, v)).toBe('fx.chorus');
    b.set('fx.phaser.on', 1);
    expect(initialFxView(b, v)).toBe('fx.phaser');
  });
});

describe('a preset MODE dims RATE and DEPTH (chorus.md REQ-the-chorus-mode-overrides-rate-and-depth)', () => {
  const disabled = (el: HTMLElement | null) => el?.getAttribute('aria-disabled') === 'true';

  it('in the synth rack', () => {
    const b = bus();
    const r = rack(b);
    const rate = r.$('knob-fx.chorus.rate');
    const depth = r.$('knob-fx.chorus.depth');
    const mix = r.$('knob-fx.chorus.mix');
    expect(disabled(rate)).toBe(false);
    b.set('fx.chorus.mode', CHORUS_MODE_LABELS.indexOf('I+II'));
    expect(disabled(rate)).toBe(true);
    expect(disabled(depth)).toBe(true);
    expect(disabled(mix)).toBe(false);
    b.set('fx.chorus.mode', 0);
    expect(disabled(rate)).toBe(false);
    expect(disabled(depth)).toBe(false);
  });

  it('through fxGroupParts, as the sampler header does — picked by param, not position', () => {
    const b = bus();
    // MIX first: a positional pick of the first two would dim the wrong knob.
    const g = fxGroupParts(b, 'CHORUS', 'fx.sampler.chorus', [
      { id: 'fx.sampler.chorus.mix', label: 'MIX' },
      { id: 'fx.sampler.chorus.rate', label: 'RATE' },
      { id: 'fx.sampler.chorus.depth', label: 'DEPTH' },
    ]);
    dimWhileModeSet(b, 'fx.sampler.chorus', CHORUS_MODE_OVERRIDES, g.knobs);
    b.set('fx.sampler.chorus.mode', 1);
    const dimmed = g.knobs.filter((k) => k.el.getAttribute('aria-disabled') === 'true').map((k) => k.paramId);
    expect(dimmed).toEqual(['fx.sampler.chorus.rate', 'fx.sampler.chorus.depth']);
  });
});

describe('fxGroup hosts a title companion (fx-group.md REQ-a-group-can-host-a-title-companion)', () => {
  it('places afterTitle between the title and the switch', () => {
    const host = document.createElement('span');
    const el = fxGroup(bus(), 'PHASER', 'fx.sampler.phaser', [], { afterTitle: host });
    const sw = el.querySelector('[data-testid="switch-fx.sampler.phaser.on"]')!;
    expect(host.parentElement).toBe(el);
    expect(host.nextElementSibling).toBe(sw);
    expect(host.previousElementSibling?.textContent).toBe('PHASER');
  });
});
