import { describe, it, expect, beforeEach } from 'vitest';
import { createCollapseToggle } from '../../src/ui/components/collapse-toggle';
import { installLocalStorageMock } from '../storage-mock';

const KEY = 'websynth.collapse.test';

describe('createCollapseToggle', () => {
  beforeEach(() => installLocalStorageMock());

  it('toggles the .collapsed class on the target and persists the choice', () => {
    const target = document.createElement('div');
    const c = createCollapseToggle(target, KEY);
    expect(target.classList.contains('collapsed')).toBe(false);

    c.el.click();
    expect(target.classList.contains('collapsed')).toBe(true);
    expect(localStorage.getItem(KEY)).toBe('1');

    c.el.click();
    expect(target.classList.contains('collapsed')).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('0');
  });

  it('restores a previously stored collapsed state', () => {
    localStorage.setItem(KEY, '1');
    const target = document.createElement('div');
    createCollapseToggle(target, KEY);
    expect(target.classList.contains('collapsed')).toBe(true);
  });

  it('uses defaultCollapsed only when no stored preference exists', () => {
    const target = document.createElement('div');
    createCollapseToggle(target, KEY, { defaultCollapsed: () => true });
    expect(target.classList.contains('collapsed')).toBe(true);
  });

  it('a stored preference wins over defaultCollapsed', () => {
    localStorage.setItem(KEY, '0');
    const target = document.createElement('div');
    createCollapseToggle(target, KEY, { defaultCollapsed: () => true });
    expect(target.classList.contains('collapsed')).toBe(false);
  });

  it('expand() opens a collapsed panel', () => {
    localStorage.setItem(KEY, '1');
    const target = document.createElement('div');
    const c = createCollapseToggle(target, KEY);
    c.expand();
    expect(target.classList.contains('collapsed')).toBe(false);
  });

  it('a trigger element toggles, except clicks matching ignoreSelector', () => {
    const target = document.createElement('div');
    const trigger = document.createElement('div');
    const tab = document.createElement('button');
    tab.className = 'tab';
    trigger.appendChild(tab);
    createCollapseToggle(target, KEY, { trigger, ignoreSelector: '.tab' });

    trigger.click(); // bare trigger click toggles
    expect(target.classList.contains('collapsed')).toBe(true);

    tab.click(); // ignored selector → no toggle
    expect(target.classList.contains('collapsed')).toBe(true);
  });
});
