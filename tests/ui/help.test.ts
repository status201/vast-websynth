import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHelpButton, type HelpDeps } from '../../src/ui/components/help';

/**
 * The Help button's gesture inventory (specs/features/onboarding.md REQ-19).
 * A modifier-click or a press-and-hold toggles the badges and must NEVER open
 * the chooser modal; a plain click keeps its two existing outcomes (REQ-8).
 */
describe('Help button gestures (onboarding.md REQ-19)', () => {
  let active = false;
  let deps: HelpDeps;
  let toggle: ReturnType<typeof vi.fn>;
  let onChange: ((a: boolean) => void) | null = null;

  const HOLD_MS = 350;

  /** The chooser modal is what a plain click opens; its Take the tour button is
   *  the marker that it did. */
  const modalOpen = (): boolean =>
    document.querySelector('[data-testid="help-start-tour"]') !== null;

  const down = (btn: HTMLElement, x = 0, y = 0): void => {
    btn.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0 }),
    );
  };
  const move = (x: number, y: number): void => {
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
  };
  const up = (): void => {
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  };
  const click = (btn: HTMLElement, init: MouseEventInit = {}): void => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    active = false;
    onChange = null;
    toggle = vi.fn(() => {
      active = !active;
      onChange?.(active);
    });
    deps = {
      startTour: vi.fn(),
      toggleHelpMode: toggle as unknown as () => void,
      isHelpModeActive: () => active,
      onHelpModeChange: (cb) => { onChange = cb; },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const mount = (): HTMLButtonElement => {
    const btn = createHelpButton(deps);
    document.body.appendChild(btn);
    return btn;
  };

  it('names the shortcut in its idle tooltip, and the off-switch when active', () => {
    const btn = mount();
    expect(btn.title).toMatch(/Shift\+click or hold/i);
    toggle(); // flips `active` and notifies
    expect(btn.title).toBe('Turn off help badges');
  });

  it('Shift+click toggles the badges and opens no modal', () => {
    const btn = mount();
    click(btn, { shiftKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(modalOpen()).toBe(false);
  });

  it('Shift+click while the badges show toggles them off, still without a modal', () => {
    const btn = mount();
    active = true;
    click(btn, { shiftKey: true });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(active).toBe(false);
    expect(modalOpen()).toBe(false);
  });

  it('Ctrl and Meta are aliases of Shift (desktop conventions differ)', () => {
    const btn = mount();
    click(btn, { ctrlKey: true });
    click(btn, { metaKey: true });
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(modalOpen()).toBe(false);
  });

  it('a plain click still opens the chooser when the badges are off', () => {
    const btn = mount();
    click(btn);
    expect(toggle).not.toHaveBeenCalled();
    expect(modalOpen()).toBe(true);
  });

  it('a long press toggles the badges and its trailing click is swallowed', () => {
    const btn = mount();
    down(btn);
    vi.advanceTimersByTime(HOLD_MS);
    expect(toggle).toHaveBeenCalledTimes(1);
    up();
    click(btn); // the release's own click
    expect(toggle).toHaveBeenCalledTimes(1); // not toggled twice
    expect(modalOpen()).toBe(false); // and no modal behind the badges
  });

  it('a click after a completed hold gesture behaves normally again', () => {
    const btn = mount();
    down(btn);
    vi.advanceTimersByTime(HOLD_MS);
    up();
    click(btn); // swallowed
    click(btn); // a fresh, plain click — badges are on, so this turns them off
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(modalOpen()).toBe(false);
  });

  it('a hold whose release misses the button cannot eat a later click (edge)', () => {
    const btn = mount();
    down(btn);
    vi.advanceTimersByTime(HOLD_MS);
    up(); // released off the button: no click event follows at all
    expect(toggle).toHaveBeenCalledTimes(1);
    // A later, unrelated press-and-click must not be swallowed by a stale flag.
    down(btn);
    up();
    click(btn);
    expect(toggle).toHaveBeenCalledTimes(2); // badges were on → click turned them off
  });

  it('a press that travels past the slop is a drag, not a hold (edge)', () => {
    const btn = mount();
    down(btn, 0, 0);
    move(40, 0); // beyond the 6px slop → cancels the timer
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(toggle).not.toHaveBeenCalled();
    up();
    click(btn);
    expect(modalOpen()).toBe(true); // the click behaved normally
  });

  it('a short press is not a hold — it falls through to the click', () => {
    const btn = mount();
    down(btn);
    vi.advanceTimersByTime(HOLD_MS - 50);
    up();
    vi.advanceTimersByTime(HOLD_MS); // the cancelled timer must not fire late
    click(btn);
    expect(toggle).not.toHaveBeenCalled();
    expect(modalOpen()).toBe(true);
  });
});
