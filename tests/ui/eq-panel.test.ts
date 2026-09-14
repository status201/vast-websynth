import { describe, it, expect, beforeEach } from 'vitest';
import { buildEqPanel } from '../../src/ui/panels/eq-panel';
import { ParamBus, registerDefaults } from '../../src/state/params';
import type { StudioApi } from '../../src/ui/studio-api';
import { applyEqPreset } from '../../src/state/eq-presets';
import { UI_ICONS } from '../../src/ui/components/ui-icons';
import { readSource as read, cssDecl as decl } from '../css-source';

/**
 * The EQUALIZER section — `specs/features/equalizer.md` REQ-9/REQ-10/REQ-11/REQ-16.
 *
 * The panel is mostly wiring over `TabContainer`, so most of what is worth
 * pinning here is the wiring's *contract with the rest of the app*: that its
 * testids cannot shadow the pattern row's, that the lamp tells the truth about a
 * flat EQ, and that the fold defaults closed.
 */

/** The panel reads exactly one thing off the facade — the context's rate. */
const studio = { ctx: { sampleRate: 48000 } } as unknown as StudioApi;

function build() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const panel = buildEqPanel(bus, studio);
  document.body.appendChild(panel.el);
  return { bus, panel };
}

const q = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** The lamp inside a tab button — the span `setIndicator` writes `data-state` on. */
function lamp(root: HTMLElement, tabId: string): HTMLElement {
  const btn = q(root, `tab-${tabId}`)!;
  return [...btn.querySelectorAll('span')].find((s) => s.dataset.state !== undefined)!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('the section header (REQ-9)', () => {
  it('reads EQUALIZER, then the three lanes', () => {
    const { panel } = build();
    const bar = panel.el.firstElementChild!;
    expect(bar.firstElementChild!.textContent).toBe('Equalizer');
    const labels = [...bar.querySelectorAll('button')]
      .filter((b) => b.dataset.testid?.startsWith('tab-'))
      .map((b) => b.textContent);
    expect(labels).toEqual(['Sequencer', 'Drum Machine', 'Sampler']);
  });

  it('puts the title first and the fold caret last', () => {
    // Not cosmetic: the caret carries `margin-left: auto`, so a title appended
    // after it would be shoved to the right-hand edge.
    const { panel } = build();
    const bar = panel.el.firstElementChild!;
    expect(bar.firstElementChild!.tagName).toBe('SPAN');
    expect(bar.lastElementChild!.getAttribute('aria-expanded')).not.toBeNull();
  });

  it('leads the title with the sliders icon (section-title.md REQ-3)', () => {
    // Colour and type are the shared heading's business and pinned there; what
    // is this section's own is which glyph it wears.
    const { panel } = build();
    const title = panel.el.firstElementChild!.firstElementChild!;
    // Compared parsed-to-parsed: the DOM re-serialises `<path/>` as `<path></path>`.
    const expected = document.createElement('span');
    expected.innerHTML = UI_ICONS.sliders;
    expect(title.firstElementChild!.outerHTML).toBe(expected.firstElementChild!.outerHTML);
  });

  it('is folded on first load, and remembers being opened', () => {
    const first = build();
    expect(first.panel.el.classList.contains('collapsed')).toBe(true);

    // The whole bar is the fold trigger, off the tabs.
    (first.panel.el.firstElementChild as HTMLElement).click();
    expect(first.panel.el.classList.contains('collapsed')).toBe(false);

    // A stored choice beats `collapsedByDefault` on the next build.
    document.body.innerHTML = '';
    const second = build();
    expect(second.panel.el.classList.contains('collapsed')).toBe(false);
  });
});

describe('the tab lamp (REQ-10)', () => {
  it('reads off, then muted while flat, then on once shaping', () => {
    const { bus, panel } = build();
    const led = lamp(panel.el, 'eq-drums');
    expect(led.dataset.state).toBe('off');

    bus.set('fx.drum.eq.on', 1);
    expect(led.dataset.state, 'engaged but flat must be distinguishable').toBe('muted');

    bus.set('fx.drum.eq.b2', -6);
    expect(led.dataset.state).toBe('on');

    bus.set('fx.drum.eq.b2', 0);
    expect(led.dataset.state).toBe('muted');

    bus.set('fx.drum.eq.on', 0);
    expect(led.dataset.state).toBe('off');
  });

  it('follows a filter move too, not only a band', () => {
    const { bus, panel } = build();
    bus.set('fx.eq.on', 1);
    expect(lamp(panel.el, 'eq-seq').dataset.state).toBe('muted');
    bus.set('fx.eq.hp', 300);
    expect(lamp(panel.el, 'eq-seq').dataset.state).toBe('on');
  });

  it('is a span, not a control — the switch lives in the page', () => {
    const { panel } = build();
    const led = lamp(panel.el, 'eq-seq');
    expect(led.tagName).toBe('SPAN');
    expect(led.closest('button')!.dataset.testid).toBe('tab-eq-seq');
    // The real on/off, one per lane, minted from the param id by `Switch`.
    for (const p of ['fx.eq', 'fx.drum.eq', 'fx.sampler.eq']) {
      expect(q(panel.el, `switch-${p}.on`), p).not.toBeNull();
    }
  });

  it('keeps each lane independent', () => {
    const { bus, panel } = build();
    bus.set('fx.sampler.eq.on', 1);
    bus.set('fx.sampler.eq.b7', 5);
    expect(lamp(panel.el, 'eq-sampler').dataset.state).toBe('on');
    expect(lamp(panel.el, 'eq-seq').dataset.state).toBe('off');
    expect(lamp(panel.el, 'eq-drums').dataset.state).toBe('off');
  });
});

describe('testid namespace (REQ-11)', () => {
  it('never shadows the pattern row’s machine tabs', () => {
    const { panel } = build();
    for (const id of ['eq-seq', 'eq-drums', 'eq-sampler']) {
      expect(q(panel.el, `tab-${id}`), id).not.toBeNull();
      expect(q(panel.el, `panel-${id}`), id).not.toBeNull();
    }
    // The ids that belong to the machine row must not appear in this subtree.
    for (const id of ['tab-seq', 'tab-drums', 'tab-sampler', 'panel-seq', 'panel-drums']) {
      expect(q(panel.el, id), id).toBeNull();
    }
  });

  it('mints one graph, preset and reset per lane', () => {
    const { panel } = build();
    for (const lane of ['seq', 'drums', 'sampler']) {
      expect(q(panel.el, `eq-canvas-${lane}`), lane).not.toBeNull();
      expect(q(panel.el, `eq-preset-${lane}`), lane).not.toBeNull();
      expect(q(panel.el, `eq-reset-${lane}`), lane).not.toBeNull();
    }
  });

  it('exposes the HP/LP/Q knobs by their param ids', () => {
    const { panel } = build();
    for (const suffix of ['hp', 'lp', 'width']) {
      expect(q(panel.el, `knob-fx.eq.${suffix}`), suffix).not.toBeNull();
    }
  });
});

describe('the Q knob and the badge anchors (REQ-4 v3, REQ-19)', () => {
  it('labels the `.width` knob Q on every lane', () => {
    // Up is narrower: the value is the peaking Q, so "WIDTH" read backwards.
    // The id is unchanged — only what the player reads moved.
    const { panel } = build();
    for (const p of ['fx.eq', 'fx.drum.eq', 'fx.sampler.eq']) {
      const knob = q(panel.el, `knob-${p}.width`)!;
      expect(knob, p).not.toBeNull();
      const texts = [...knob.querySelectorAll('div')].map((d) => d.textContent?.trim());
      expect(texts, p).toContain('Q');
      expect(knob.textContent, p).not.toContain('WIDTH');
    }
  });

  it('gives each lane’s knob row its own badge anchor', () => {
    const { panel } = build();
    for (const lane of ['seq', 'drums', 'sampler']) {
      const row = panel.el.querySelector<HTMLElement>(`[data-help="eq.knobs.${lane}"]`);
      expect(row, lane).not.toBeNull();
      // Inside that lane's own page, holding its three knobs.
      expect(row!.closest(`[data-testid="panel-eq-${lane}"]`), lane).not.toBeNull();
      expect(row!.querySelectorAll('[data-testid^="knob-"]').length, lane).toBe(3);
    }
    // The orphan that shipped with the section: an attribute with no anchor.
    expect(panel.el.querySelector('[data-help="fx.eq"]')).toBeNull();
  });
});

describe('the preset control (REQ-15)', () => {
  const shown = (root: HTMLElement, lane: string) =>
    q(root, `eq-preset-${lane}`)!.querySelector('button')!.textContent;

  it('starts on Flat and names the preset that is applied', () => {
    const { bus, panel } = build();
    expect(shown(panel.el, 'seq')).toBe('Flat');
    applyEqPreset(bus, 'fx.eq', 'De-Harsh');
    expect(shown(panel.el, 'seq')).toBe('De-Harsh');
  });

  it('falls to Custom the moment the curve is edited away', () => {
    const { bus, panel } = build();
    applyEqPreset(bus, 'fx.eq', 'De-Harsh');
    bus.set('fx.eq.b1', 4);
    expect(shown(panel.el, 'seq')).toBe('Custom');
  });

  it('RESET flattens the lane and leaves its switch alone', () => {
    const { bus, panel } = build();
    applyEqPreset(bus, 'fx.drum.eq', 'Telephone');
    expect(bus.get('fx.drum.eq.on')).toBe(1);

    q(panel.el, 'eq-reset-drums')!.click();

    expect(bus.get('fx.drum.eq.on'), 'RESET is not an off switch').toBe(1);
    expect(bus.get('fx.drum.eq.b4')).toBe(0);
    expect(shown(panel.el, 'drums')).toBe('Flat');
  });
});

describe('teardown', () => {
  it('drops its bus subscriptions', () => {
    const { bus, panel } = build();
    const led = lamp(panel.el, 'eq-seq');
    panel.destroy();
    bus.set('fx.eq.on', 1);
    expect(led.dataset.state, 'a destroyed panel must stop repainting').toBe('off');
  });
});

describe('the bottom grid keeps its shape (REQ-16)', () => {
  const css = read('src/ui/styles/layout.module.css');

  it('declares three rows, with --scope-h still sizing only the first', () => {
    // The scope's ResizeHandle writes `--scope-h` on this element; if the EQ row
    // were ever folded into that track, dragging the scope would resize the EQ.
    const m = /\.bottom\s*\{[^}]*grid-template-rows:\s*([^;]+);/.exec(css);
    expect(m, '.bottom grid-template-rows not found').not.toBeNull();
    const rows = m![1]!.trim();
    expect(rows.startsWith('var(--scope-h, 130px)')).toBe(true);
    expect(rows).toContain('auto');
    // …and the keyboard floor is what absorbs an expanded EQ.
    expect(rows.endsWith('minmax(160px, 1fr)')).toBe(true);
  });
});

describe('the page mirrors the scope row (REQ-18)', () => {
  const layout = read('src/ui/styles/layout.module.css');
  const eqCss = read('src/ui/styles/eq.module.css');

  it('takes its gutter from the same custom property the wheels do', () => {
    // The whole point of REQ-18: "exactly as wide as the wheels". Two literal
    // 120px values would be equal only by coincidence and would drift the first
    // time anyone retuned the wheels — which is exactly the kind of thing no
    // screenshot review catches.
    expect(layout).toContain('--wheel-col: 120px;');
    expect(decl(layout, '.bottomTop', 'grid-template-columns'))
      .toBe('var(--wheel-col) 1fr');

    const eqCols = decl(eqCss, '.page', 'grid-template-columns');
    expect(eqCols).toContain('var(--wheel-col)');
    // …minus this section's own border, and nothing else: that 1px is what puts
    // the graph's left edge on the same x as the scope canvas.
    expect(eqCols).toBe('calc(var(--wheel-col) - 1px) 1fr');
  });

  it('uses the same 10px gap as the row it mirrors', () => {
    expect(decl(eqCss, '.page', 'gap')).toBe(decl(layout, '.bottomTop', 'gap'));
  });

  it('takes the graph height from the scope, not a literal of its own', () => {
    // So the scope's resize grip sizes both and they cannot drift apart.
    expect(decl(eqCss, '.graphWrap', 'height')).toBe('var(--scope-h, 130px)');
  });

  it('cancels the tab shell padding rather than changing it for every panel', () => {
    // `.content` is shared with the pattern row, so the override has to be
    // consumer-side — and only horizontal, since the vertical 10px is the gap
    // to the tab bar.
    expect(decl(eqCss, '.pageShell', 'padding-left')).toBe('0');
    expect(decl(eqCss, '.pageShell', 'padding-right')).toBe('0');
    expect(decl(eqCss, '.pageShell', 'padding-top')).toBeNull();
  });

  it('does not stack on a phone — the scope row does not either', () => {
    // Mirroring means mirroring at every width; the graph gets ~230px at 360px,
    // exactly as the scope does. A breakpoint that re-stacked the page would
    // silently un-mirror it on the devices where the alignment reads loudest.
    expect(eqCss).not.toContain('@media');
  });
});

describe('the control column fits the height the scope can shrink to (REQ-18)', () => {
  it('applies the knob size the 120px column can actually hold', () => {
    const { panel } = build();
    // Three knob roots are `knob-size + 8` each; with two 2px gaps that is
    // 3*(28+8) + 4 = 112px, the column's usable width. A bigger knob silently
    // overflows into the graph.
    const knob = q(panel.el, 'knob-fx.eq.hp')!;
    expect(knob.style.getPropertyValue('--knob-size')).toBe('28px');
  });

  it('puts ON and RESET on one row, above the preset and the knobs', () => {
    const { panel } = build();
    const page = q(panel.el, 'panel-eq-seq')!.firstElementChild!;
    expect(page.children).toHaveLength(2); // controls | graph
    const controls = page.firstElementChild!;
    const [switchRow, presetWrap, knobs] = [...controls.children];
    expect(switchRow!.contains(q(panel.el, 'switch-fx.eq.on')!)).toBe(true);
    expect(switchRow!.contains(q(panel.el, 'eq-reset-seq')!)).toBe(true);
    expect(presetWrap!.contains(q(panel.el, 'eq-preset-seq')!)).toBe(true);
    expect(knobs!.children).toHaveLength(3);
    // …and the graph is the grid's second cell, not nested in the controls.
    expect(page.lastElementChild!.contains(q(panel.el, 'eq-canvas-seq')!)).toBe(true);
  });
});

describe('destroy() is the whole teardown, not most of it', () => {
  it('releases the controls it built, not only its own subscriptions', () => {
    // `Dropdown` holds *document*-level click and keydown listeners for its
    // whole life, so a panel that drops its bus subs but leaves its dropdowns
    // attached is claiming a lifecycle it does not honour.
    const before = { click: 0, keydown: 0 };
    const orig = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    const count = { click: 0, keydown: 0 };
    document.addEventListener = ((t: string, ...rest: unknown[]) => {
      if (t === 'click' || t === 'keydown') count[t] += 1;
      return (orig as unknown as (...a: unknown[]) => void)(t, ...rest);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((t: string, ...rest: unknown[]) => {
      if (t === 'click' || t === 'keydown') count[t] -= 1;
      return (origRemove as unknown as (...a: unknown[]) => void)(t, ...rest);
    }) as typeof document.removeEventListener;

    try {
      const { panel } = build();
      expect(count.click, 'the three dropdowns each attach one').toBeGreaterThan(before.click);
      panel.destroy();
      expect(count.click, 'every document click listener is given back').toBe(before.click);
      expect(count.keydown).toBe(before.keydown);
    } finally {
      document.addEventListener = orig as typeof document.addEventListener;
      document.removeEventListener = origRemove as typeof document.removeEventListener;
    }
  });
});
