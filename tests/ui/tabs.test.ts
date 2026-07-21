import { describe, it, expect } from 'vitest';
import { TabContainer } from '../../src/ui/components/tabs';

function makeTabs() {
  const a = document.createElement('div'); a.textContent = 'A body';
  const b = document.createElement('div'); b.textContent = 'B body';
  return new TabContainer([
    { id: 'a', label: 'Alpha', content: a },
    { id: 'b', label: 'Beta', content: b },
  ]);
}

const tabBtn = (tc: TabContainer, id: string) =>
  tc.el.querySelector<HTMLButtonElement>(`[data-testid="tab-${id}"]`)!;
const panel = (tc: TabContainer, id: string) =>
  tc.el.querySelector<HTMLElement>(`[data-testid="panel-${id}"]`)!;

describe('TabContainer', () => {
  it('mints tab and panel testids and activates the first tab by default', () => {
    const tc = makeTabs();
    expect(tabBtn(tc, 'a')).not.toBeNull();
    expect(panel(tc, 'b')).not.toBeNull();
    expect(tabBtn(tc, 'a').classList.contains('active')).toBe(true);
    expect(panel(tc, 'a').classList.contains('visible')).toBe(true);
    expect(panel(tc, 'b').classList.contains('visible')).toBe(false);
  });

  it('clicking a tab routes active + visible classes to it', () => {
    const tc = makeTabs();
    tabBtn(tc, 'b').click();
    expect(tabBtn(tc, 'b').classList.contains('active')).toBe(true);
    expect(tabBtn(tc, 'a').classList.contains('active')).toBe(false);
    expect(panel(tc, 'b').classList.contains('visible')).toBe(true);
    expect(panel(tc, 'a').classList.contains('visible')).toBe(false);
  });

  it('honours an explicit initial tab id', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    const tc = new TabContainer([
      { id: 'a', label: 'Alpha', content: a },
      { id: 'b', label: 'Beta', content: b },
    ], 'b');
    expect(tabBtn(tc, 'b').classList.contains('active')).toBe(true);
  });

  // sequencer.md REQ-5 — the surface a panel gates an off-screen mode on.
  describe('view visibility', () => {
    const collapsible = (key: string, collapsed = false) => new TabContainer([
      { id: 'a', label: 'Alpha', content: document.createElement('div') },
      { id: 'b', label: 'Beta', content: document.createElement('div') },
    ], 'a', { collapsibleStoreKey: key, collapsedByDefault: () => collapsed });

    it('isVisible is true only for the active tab', () => {
      const tc = makeTabs();
      expect(tc.isVisible('a')).toBe(true);
      expect(tc.isVisible('b')).toBe(false);
      tabBtn(tc, 'b').click();
      expect(tc.isVisible('a')).toBe(false);
      expect(tc.isVisible('b')).toBe(true);
    });

    it('isVisible is false for the active tab while the bar is collapsed', () => {
      // A fold hides the active panel just as surely as another tab would.
      const tc = collapsible('test.view.collapsed', true);
      expect(tc.activeId).toBe('a');
      expect(tc.isVisible('a')).toBe(false);
      tc.reveal('a');
      expect(tc.isVisible('a')).toBe(true);
    });

    it('onViewChange fires on a tab switch but not on re-activating the same tab', () => {
      const tc = makeTabs();
      let n = 0;
      tc.onViewChange(() => { n++; });
      tabBtn(tc, 'b').click();
      expect(n).toBe(1);
      // Already active — nothing on screen changed, so no emit.
      tabBtn(tc, 'b').click();
      expect(n).toBe(1);
      tabBtn(tc, 'a').click();
      expect(n).toBe(2);
    });

    it('onViewChange fires on a collapse toggle, and the disposer unsubscribes', () => {
      const tc = collapsible('test.view.toggle');
      let n = 0;
      const off = tc.onViewChange(() => { n++; });
      const chevron = tc.el.querySelector<HTMLButtonElement>('[aria-label="Collapse panel"]')!;
      chevron.click();
      expect(tc.el.classList.contains('collapsed')).toBe(true);
      expect(n).toBe(1);
      off();
      chevron.click();
      expect(n).toBe(1);
    });
  });

  // machine-status.md REQ-3/REQ-4/REQ-7
  describe('status indicators', () => {
    const withIndicator = () => new TabContainer([
      { id: 'a', label: 'Alpha', content: document.createElement('div'), indicator: true },
      { id: 'b', label: 'Beta', content: document.createElement('div') },
    ]);
    const led = (tc: TabContainer, id: string) =>
      tabBtn(tc, id).querySelector<HTMLElement>('span');

    it('renders an LED only on tabs that asked for one, keeping the label intact', () => {
      const tc = withIndicator();
      expect(led(tc, 'a')).not.toBeNull();
      expect(tabBtn(tc, 'a').textContent).toBe('Alpha');
      // A plain tab keeps its textContent label and grows no LED span.
      expect(led(tc, 'b')).toBeNull();
      expect(tabBtn(tc, 'b').textContent).toBe('Beta');
    });

    it('setIndicator paints the state and mirrors it into aria-label', () => {
      const tc = withIndicator();
      tc.setIndicator('a', 'muted');
      expect(led(tc, 'a')!.dataset.state).toBe('muted');
      // Never colour-only: the state must be readable by assistive tech.
      expect(tabBtn(tc, 'a').getAttribute('aria-label')).toBe('Alpha — muted');

      tc.setIndicator('a', 'off');
      expect(led(tc, 'a')!.dataset.state).toBe('off');
    });

    it('setIndicator is a no-op for a tab without an indicator', () => {
      const tc = withIndicator();
      expect(() => tc.setIndicator('b', 'on')).not.toThrow();
      expect(tabBtn(tc, 'b').hasAttribute('aria-label')).toBe(false);
    });

    it('reveal expands a collapsed bar before activating', () => {
      const tc = new TabContainer([
        { id: 'a', label: 'Alpha', content: document.createElement('div') },
        { id: 'b', label: 'Beta', content: document.createElement('div') },
      ], 'a', { collapsibleStoreKey: 'test.collapsed', collapsedByDefault: () => true });
      expect(tc.el.classList.contains('collapsed')).toBe(true);

      tc.reveal('b');
      // Plain activate() would leave the body hidden, so the click appears dead.
      expect(tc.el.classList.contains('collapsed')).toBe(false);
      expect(tc.activeId).toBe('b');
    });
  });
});
