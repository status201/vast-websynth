import { describe, it, expect, afterEach, vi } from 'vitest';
import { anchorMenu, dismissMenu } from '../../src/ui/components/menu-anchor';
import { createClearMenu } from '../../src/ui/components/clear-menu';
import { createFxSlot } from '../../src/ui/components/fx-slot-picker';
import { ParamBus, registerDefaults } from '../../src/state/params';

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
