import { describe, it, expect, afterEach, vi } from 'vitest';
import { anchorMenu, dismissMenu } from '../../src/ui/components/menu-anchor';
import { createClearMenu } from '../../src/ui/components/clear-menu';
import { createFxSlot } from '../../src/ui/components/fx-slot-picker';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { Dropdown } from '../../src/ui/components/dropdown';
import { laneMeterControlsFor } from '../../src/ui/panels/step-panel-scaffold';

/**
 * dropdown.md REQ-every-fixed-menu-shares-one-anchor-and-dismiss (v11). The
 * anchor rule was written out four times, and two copies — the Clear menu and
 * the lane popover — closed on Escape without consuming it, so the keydown went
 * on to the window, where Escape is Panic: dismissing a menu stopped the song.
 */

afterEach(() => { document.body.innerHTML = ''; });

/** Whether an Escape keydown on the document reaches a window listener. */
function escapeReachesWindow(): boolean {
  const panic = vi.fn();
  window.addEventListener('keydown', panic);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  window.removeEventListener('keydown', panic);
  return panic.mock.calls.length > 0;
}

describe('dismissMenu', () => {
  it('consumes the Escape that closes an open menu, and only that one', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let open = true;
    dismissMenu(root, () => open, () => { open = false; });

    expect(escapeReachesWindow()).toBe(false);
    expect(open).toBe(false);
    // Closed: Escape is Panic again, untouched.
    expect(escapeReachesWindow()).toBe(true);
  });

  it('closes on a click outside, never on one inside', () => {
    const root = document.createElement('div');
    const inside = document.createElement('button');
    root.appendChild(inside);
    document.body.appendChild(root);
    let open = true;
    dismissMenu(root, () => open, () => { open = false; });
    inside.click();
    expect(open).toBe(true);
    document.body.click();
    expect(open).toBe(false);
  });
});

describe('anchorMenu never leaves the viewport-wide floor', () => {
  it.each([['toggle', '80px'], ['content', '0px']] as const)('%s -> min-width %s', (width, expected) => {
    const toggle = document.createElement('button');
    toggle.getBoundingClientRect = () => ({ left: 10, right: 90, top: 20, bottom: 40, width: 80, height: 20 }) as DOMRect;
    const menu = document.createElement('div');
    anchorMenu(toggle, menu, width);
    expect(menu.style.minWidth).toBe(expected);
    expect(menu.style.left).toBe('10px');
    expect(menu.style.top).toBe('46px');
  });
});

describe('the menus that used to let Escape through (regression)', () => {
  it('the Clear menu', () => {
    const root = createClearMenu({ lane: 'seq', bankLabel: () => 'A', onClearBank: () => {} });
    document.body.appendChild(root);
    root.querySelector<HTMLButtonElement>('[data-testid="clear-seq"]')!.click();
    expect(root.classList.contains('open')).toBe(true);
    expect(escapeReachesWindow()).toBe(false);
    expect(root.classList.contains('open')).toBe(false);
  });

  it('the FX slot picker', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const view = (prefix: string) => {
      const el = document.createElement('div');
      const titleEl = document.createElement('span');
      const caretHost = document.createElement('span');
      el.append(titleEl, caretHost);
      document.body.appendChild(el);
      return { prefix, title: prefix, el, caretHost, titleEl };
    };
    createFxSlot(bus, [view('fx.phaser'), view('fx.chorus')]);
    const caret = document.querySelector<HTMLButtonElement>('[data-testid="fxpick-fx.phaser"]')!;
    caret.click();
    expect(caret.parentElement!.classList.contains('open')).toBe(true);
    expect(escapeReachesWindow()).toBe(false);
    expect(caret.parentElement!.classList.contains('open')).toBe(false);
  });
});

describe('one menu is open at a time (dropdown.md REQ-one-menu-is-open-at-a-time, v13 regression)', () => {
  function bus(): ParamBus {
    const b = new ParamBus();
    registerDefaults(b);
    return b;
  }
  const isOpen = (root: Element) => root.classList.contains('open');

  function dropdown(): Dropdown {
    const d = new Dropdown(['a', 'b']);
    document.body.appendChild(d.el);
    return d;
  }
  const openDropdown = (d: Dropdown) => d.el.querySelector<HTMLButtonElement>('button')!.click();

  function clear(lane: 'seq' | 'drum'): HTMLElement {
    const root = createClearMenu({ lane, bankLabel: () => 'A', onClearBank: () => {} });
    document.body.appendChild(root);
    return root;
  }
  const openClear = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('button')!.click();

  /** A lane's Grid popover; open is its menu shown (it does not use the `open` class). */
  function grid(lane: 'drum' | 'motion', b: ParamBus) {
    const { el } = laneMeterControlsFor(b, lane);
    document.body.appendChild(el);
    const $ = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    return {
      toggle: $(`machine-${lane}-grid`),
      open: () => $(`machine-${lane}-grid`).getAttribute('aria-expanded') === 'true',
      len: $(`machine-${lane}-len`),
    };
  }

  it('a dropdown closes when another dropdown opens', () => {
    const [a, b] = [dropdown(), dropdown()];
    openDropdown(a);
    openDropdown(b);
    expect(isOpen(a.el)).toBe(false);
    expect(isOpen(b.el)).toBe(true);
  });

  it('across kinds: a dropdown, the Clear menu and back', () => {
    const d = dropdown();
    const c = clear('seq');
    openDropdown(d);
    openClear(c);
    expect(isOpen(d.el)).toBe(false);
    expect(isOpen(c)).toBe(true);
    openDropdown(d);
    expect(isOpen(c)).toBe(false);
    expect(isOpen(d.el)).toBe(true);
  });

  it('a dropdown inside the Grid popover leaves the popover open; another Grid closes both', () => {
    const b = bus();
    const g1 = grid('drum', b);
    const g2 = grid('motion', b);
    g1.toggle.click();
    g1.len.querySelector<HTMLButtonElement>('button')!.click();
    expect(g1.open()).toBe(true);
    expect(isOpen(g1.len)).toBe(true);
    g2.toggle.click();
    expect(g1.open()).toBe(false);
    expect(isOpen(g1.len)).toBe(false);
    expect(g2.open()).toBe(true);
  });

  it('closing the Grid popover by its own toggle closes the dropdown inside it', () => {
    const g = grid('drum', bus());
    g.toggle.click();
    g.len.querySelector<HTMLButtonElement>('button')!.click();
    g.toggle.click();
    expect(g.open()).toBe(false);
    expect(isOpen(g.len)).toBe(false);
  });

  it('a destroyed dropdown is forgotten, not closed later', () => {
    const d = dropdown();
    openDropdown(d);
    d.destroy();
    d.el.remove();
    expect(() => openClear(clear('drum'))).not.toThrow();
  });
});
