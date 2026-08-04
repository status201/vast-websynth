import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInfoBadgesButton, type InfoBadgesDeps } from '../../src/ui/components/info-badges-button';
import tourStyles from '../../src/ui/styles/tour.module.css';

/**
 * The ⓘ button's gesture inventory (specs/features/onboarding.md REQ-8/REQ-19).
 * One gesture, one outcome: a click toggles the badges in either state, and the
 * three gestures v13 bolted onto the old Help button are gone — a modifier-click
 * or a long press is now just a click. Those are the `—` rows of the inventory,
 * asserted here so they cannot quietly grow a second meaning again.
 */
describe('Info badges button (onboarding.md REQ-8/REQ-19)', () => {
  let active = false;
  let deps: InfoBadgesDeps;
  let toggle: ReturnType<typeof vi.fn>;
  let onChange: ((a: boolean) => void) | null = null;

  const HOLD_MS = 350;

  const down = (btn: HTMLElement, x = 0, y = 0): void => {
    btn.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0 }),
    );
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
      toggle: toggle as unknown as () => void,
      isActive: () => active,
      onChange: (cb) => { onChange = cb; },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const mount = (): HTMLButtonElement => {
    const btn = createInfoBadgesButton(deps);
    document.body.appendChild(btn);
    return btn;
  };

  it('carries the badges own ⓘ glyph and a testid of its own', () => {
    const btn = mount();
    expect(btn.dataset.testid).toBe('info-badges');
    expect(btn.querySelector('svg.hdr-icon')).not.toBeNull();
  });

  // REQ-8b: while the badges show, the glyph takes their colours — an accent
  // disc with `--bg-deep` ink. The colours themselves live in tour.module.css
  // (jsdom does not resolve CSS Modules, so e2e pins the computed fill); what
  // is pinned here is the half that lives in the markup: the three part hooks
  // those rules hang off, without which the active state silently does nothing.
  it('the ⓘ glyph exposes the part hooks the active state recolours (REQ-8b)', () => {
    const svg = mount().querySelector('svg.hdr-icon')!;
    expect(svg.querySelector('.disc')).not.toBeNull();
    expect(svg.querySelector('.stem')).not.toBeNull();
    // The tittle keeps `.fill` (switch.module's solid-shape escape hatch) and
    // adds its own hook, so it can be inked separately from the disc.
    expect(svg.querySelector('.fill.dot')).not.toBeNull();
  });

  it('a click toggles the badges, in either direction', () => {
    const btn = mount();
    click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(active).toBe(true);
    click(btn);
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(active).toBe(false);
  });

  it('reflects state in the orange class, aria-pressed and the tooltip', () => {
    const btn = mount();
    expect(btn.classList.contains(tourStyles.toggleActive!)).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Show info badges (?)');

    click(btn);
    expect(btn.classList.contains(tourStyles.toggleActive!)).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).toBe('Hide info badges (?)');

    click(btn);
    expect(btn.classList.contains(tourStyles.toggleActive!)).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('paints the current state at construction, not only on the next change', () => {
    active = true;
    const btn = mount();
    expect(btn.classList.contains(tourStyles.toggleActive!)).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('a modifier-click is just a click — the v13 gesture is gone (REQ-19)', () => {
    const btn = mount();
    click(btn, { shiftKey: true });
    click(btn, { ctrlKey: true });
    click(btn, { metaKey: true });
    expect(toggle).toHaveBeenCalledTimes(3);
  });

  it('a long press does nothing on its own, and never eats the click after it', () => {
    const btn = mount();
    down(btn);
    vi.advanceTimersByTime(HOLD_MS * 2);
    // No hold timer exists any more, so the press alone changes nothing…
    expect(toggle).not.toHaveBeenCalled();
    up();
    // …and the release's own click is a plain, un-swallowed toggle.
    click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(active).toBe(true);
  });
});
