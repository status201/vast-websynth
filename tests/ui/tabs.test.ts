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
});
