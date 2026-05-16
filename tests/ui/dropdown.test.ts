import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Dropdown } from '../../src/ui/components/dropdown';

describe('Dropdown', () => {
  let dd: Dropdown | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    // Drop the document-level listeners so instances don't leak across tests.
    dd?.destroy();
    dd = undefined;
  });

  const toggleOf = (d: Dropdown) =>
    d.el.querySelector<HTMLButtonElement>('.dropdown-toggle')!;

  it('renders a toggle and one option per entry, marking the active one', () => {
    dd = new Dropdown(['A', 'B', 'C'], 'B');
    document.body.appendChild(dd.el);
    expect(dd.el.classList.contains('dropdown')).toBe(true);
    expect(dd.el.querySelectorAll('.dropdown-option').length).toBe(3);
    expect(dd.value).toBe('B');
    expect(dd.el.querySelector('.dropdown-label')?.textContent).toBe('B');
    expect(dd.el.querySelector('.dropdown-option.active')?.textContent).toBe('B');
  });

  it('toggles the open class when the toggle is clicked', () => {
    dd = new Dropdown(['A', 'B']);
    document.body.appendChild(dd.el);
    toggleOf(dd).click();
    expect(dd.el.classList.contains('open')).toBe(true);
    toggleOf(dd).click();
    expect(dd.el.classList.contains('open')).toBe(false);
  });

  it('selecting an option sets the value, closes, and invokes onChange', () => {
    dd = new Dropdown(['A', 'B', 'C'], 'A');
    document.body.appendChild(dd.el);
    const cb = vi.fn();
    dd.onChange(cb);
    toggleOf(dd).click();
    const optB = [
      ...dd.el.querySelectorAll<HTMLButtonElement>('.dropdown-option'),
    ].find((b) => b.textContent === 'B')!;
    optB.click();
    expect(dd.value).toBe('B');
    expect(dd.el.classList.contains('open')).toBe(false);
    expect(cb).toHaveBeenCalledWith('B');
  });

  it('setValue updates the toggle label and active classes', () => {
    dd = new Dropdown(['A', 'B'], 'A');
    dd.setValue('B');
    expect(dd.el.querySelector('.dropdown-label')?.textContent).toBe('B');
    expect(dd.el.querySelector('.dropdown-option.active')?.textContent).toBe('B');
  });

  it('closes on outside click and on Escape', () => {
    dd = new Dropdown(['A', 'B']);
    document.body.appendChild(dd.el);

    toggleOf(dd).click();
    expect(dd.el.classList.contains('open')).toBe(true);
    document.body.click(); // outside the dropdown
    expect(dd.el.classList.contains('open')).toBe(false);

    toggleOf(dd).click();
    expect(dd.el.classList.contains('open')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dd.el.classList.contains('open')).toBe(false);
  });

  it('destroy removes the document listeners', () => {
    dd = new Dropdown(['A', 'B']);
    document.body.appendChild(dd.el);
    toggleOf(dd).click(); // open
    dd.destroy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    // listener gone → still open (state unchanged since destroy)
    expect(dd.el.classList.contains('open')).toBe(true);
  });
});
