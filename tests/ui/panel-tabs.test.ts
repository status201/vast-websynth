import { describe, it, expect } from 'vitest';
import { createPanelTabs, type PanelTabs } from '../../src/ui/components/panel-tabs';
import { createPanel, createTabbedPanel } from '../../src/ui/components/panel';

/**
 * The in-title tab strip (panel-tabs.md).
 *
 * State rides on global classes (`active`, `visible`, `lit`) and `data-testid`,
 * never on a hashed module class — CSS Modules resolve to `undefined` under
 * Vitest, so a module class is unreadable here by construction.
 */

function makeTabs(): PanelTabs {
  const one = document.createElement('div'); one.textContent = 'page one';
  const two = document.createElement('div'); two.textContent = 'page two';
  return createPanelTabs({
    prefix: 'demo',
    pages: [
      { id: '1', label: '1', content: one },
      { id: '2', label: '2', content: two },
    ],
  });
}

const tab = (t: PanelTabs, id: string) =>
  t.bar.querySelector<HTMLButtonElement>(`[data-testid="ptab-demo-${id}"]`)!;
const page = (t: PanelTabs, id: string) =>
  t.body.querySelector<HTMLElement>(`[data-testid="ppage-demo-${id}"]`)!;

describe('PanelTabs', () => {
  it('returns the strip and the page stack as separate elements (REQ-1)', () => {
    const t = makeTabs();
    expect(t.bar).not.toBe(t.body);
    expect(t.bar.contains(t.body)).toBe(false);
    // No panel chrome of its own: the caller places both inside a real panel.
    expect(t.bar.querySelectorAll('button')).toHaveLength(2);
    expect(t.body.children).toHaveLength(2);
  });

  it('mints prefix-namespaced testids and no bare tab-<id> (REQ-3)', () => {
    const t = makeTabs();
    expect(tab(t, '1')).not.toBeNull();
    expect(page(t, '2')).not.toBeNull();
    // `tab-<id>` / `panel-<id>` belong to TabContainer and are anchored by the
    // e2e suite, the tour and showTab — a panel page must not shadow them.
    for (const root of [t.bar, t.body]) {
      expect(root.querySelector('[data-testid="tab-1"]')).toBeNull();
      expect(root.querySelector('[data-testid="panel-1"]')).toBeNull();
    }
  });

  it('activates the first page when no initialId is given', () => {
    const t = makeTabs();
    expect(t.activeId).toBe('1');
    expect(tab(t, '1').classList.contains('active')).toBe(true);
    expect(page(t, '1').classList.contains('visible')).toBe(true);
    expect(page(t, '2').classList.contains('visible')).toBe(false);
  });

  it('honours initialId', () => {
    const one = document.createElement('div');
    const two = document.createElement('div');
    const t = createPanelTabs({
      prefix: 'demo',
      initialId: '2',
      pages: [{ id: '1', label: '1', content: one }, { id: '2', label: '2', content: two }],
    });
    expect(t.activeId).toBe('2');
  });

  it('clicking a tab routes active + visible, and fires onChange', () => {
    const t = makeTabs();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    tab(t, '2').click();

    expect(t.activeId).toBe('2');
    expect(tab(t, '2').classList.contains('active')).toBe(true);
    expect(tab(t, '1').classList.contains('active')).toBe(false);
    expect(page(t, '2').classList.contains('visible')).toBe(true);
    expect(page(t, '1').classList.contains('visible')).toBe(false);
    expect(seen).toEqual(['2']);
  });

  it('keeps every page mounted across a switch (REQ-5)', () => {
    const t = makeTabs();
    tab(t, '2').click();
    // Hidden, not unmounted — the page keeps its bus subscriptions so it is
    // already repainted when a song load lands.
    expect(page(t, '1').isConnected || t.body.contains(page(t, '1'))).toBe(true);
    expect(page(t, '1').textContent).toBe('page one');
    expect(t.body.children).toHaveLength(2);
  });

  it('re-clicking the active tab is a no-op', () => {
    const t = makeTabs();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));
    tab(t, '1').click();
    expect(seen).toEqual([]);
    expect(t.activeId).toBe('1');
  });

  it('paints the off-screen-active lamp (REQ-6)', () => {
    const t = makeTabs();
    expect(tab(t, '2').classList.contains('lit')).toBe(false);

    t.setLit('2', true);
    expect(tab(t, '2').classList.contains('lit')).toBe(true);
    expect(tab(t, '2').getAttribute('aria-label')).toContain('active');

    t.setLit('2', false);
    expect(tab(t, '2').classList.contains('lit')).toBe(false);
  });

  it('keeps the lamp out of the label so neither wipes the other', () => {
    const t = makeTabs();
    t.setLit('1', true);
    expect(tab(t, '1').textContent).toBe('1');
    expect(tab(t, '1').children).toHaveLength(2); // lamp span + label span
  });

  it('gives each tab a title naming the outcome (ADR-014 law 1)', () => {
    const t = makeTabs();
    expect(tab(t, '2').title).toBe('Show the 2 page');
  });
});

describe('createTabbedPanel', () => {
  const twoPage = (help?: string) => createTabbedPanel({
    prefix: 'lfo', help,
    pages: [
      { id: '1', label: 'LFO 1', build: (b) => { b.textContent = 'one'; } },
      { id: '2', label: 'LFO 2', build: (b) => { b.textContent = 'two'; } },
    ],
  });

  it('puts data-help on the tab row, never on a tab (REQ-7)', () => {
    const { el, tabs } = twoPage('lfo');
    const helped = el.querySelectorAll('[data-help]');
    expect(helped).toHaveLength(1);
    expect(helped[0]).toBe(tabs.bar);
    expect(el.querySelector('[data-testid="ptab-lfo-1"]')!.hasAttribute('data-help')).toBe(false);
  });

  it('builds every page before the strip activates', () => {
    const { el } = twoPage();
    // The hidden page is present and built — that is what REQ-5 buys.
    expect(el.querySelector('[data-testid="ppage-lfo-2"]')!.textContent).toBe('two');
  });

  it('is a header row plus a page stack, with no leftover empty body (REQ-9)', () => {
    const { el, tabs } = twoPage();
    // The strip REPLACES the title; an orphaned .panelBody sibling would be the
    // blank-panel trap in src/ui/CLAUDE.md.
    expect([...el.children]).toEqual([tabs.bar, tabs.body]);
  });

  it('names each page in full, since the tabs are the heading', () => {
    const { el } = twoPage();
    expect(el.querySelector('[data-testid="ptab-lfo-2"]')!.textContent).toBe('LFO 2');
  });

  it('leaves the untabbed panel shape unchanged (REQ-8)', () => {
    const el = createPanel('MIXER', (b) => { b.textContent = 'knobs'; }, 'mixer');
    expect(el.children).toHaveLength(2);
    expect(el.children[0]!.textContent).toBe('MIXER');
    expect(el.children[0]!.getAttribute('data-help')).toBe('mixer');
    expect(el.children[1]!.textContent).toBe('knobs');
    expect(el.querySelector('button')).toBeNull(); // no strip
  });
});
