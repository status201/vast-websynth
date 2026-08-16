// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InfoBadges } from '../../src/ui/onboarding/info-badges';
import { ParamBus } from '../../src/state/params';

/**
 * onboarding.md REQ-5b — a badge is shown only where it can be reached. The
 * badges are `position: fixed`, so `position()` re-pins them on every scroll
 * frame and must bound the viewport at BOTH ends. The sticky-header half was
 * there from the start; the below-the-fold half was not, so scrolling a control
 * past the bottom left its badge pinned off-screen — in the layer, styled
 * visible, reachable by nothing.
 *
 * jsdom lays nothing out (every rect is 0×0, which is the *hidden anchor* case),
 * so anchors get stubbed rects and the viewport a fixed height.
 */

const VIEWPORT_H = 800;
const HEADER_H = 60;
/** Keep in sync with BADGE_SIZE in info-badges.ts / `.badge` in tour.module.css. */
const BADGE_SIZE = 20;

/** Stub `getBoundingClientRect` — position() reads top/height/right/width. */
function place(el: Element, top: number, height = 24, width = 100): void {
  el.getBoundingClientRect = () => ({
    top, bottom: top + height, height, left: 300, right: 300 + width, width,
    x: 300, y: top, toJSON: () => ({}),
  }) as DOMRect;
}

function anchor(testId: string, top: number): HTMLElement {
  const el = document.createElement('div');
  el.dataset.testid = testId;
  document.body.appendChild(el);
  place(el, top);
  return el;
}

let badges: InfoBadges | null = null;

function show(): void {
  badges = new InfoBadges(new ParamBus());
  badges.enable();
}

/** '' (shown) or 'none' (hidden) — the two values position() writes. */
const display = (topic: string): string | undefined =>
  document.querySelector<HTMLElement>(`[data-testid="info-badge-${topic}"]`)?.style.display;

beforeEach(() => {
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerHeight', { value: VIEWPORT_H, configurable: true });
  // Reflow is rAF-deferred; run it inline so a dispatched scroll is observable.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
  // jsdom has no ResizeObserver, and enable() observes the body unconditionally.
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  });

  // The sticky header, pinned at the top. Anchors inside it are exempt from the
  // upper band — they never scroll away.
  const header = document.createElement('div');
  header.dataset.testid = 'app-header';
  document.body.appendChild(header);
  place(header, 0, HEADER_H);
  const play = document.createElement('button');
  play.dataset.testid = 'transport-play';
  header.appendChild(play);
  place(play, 20, 24);
});

afterEach(() => {
  badges?.disable();
  badges = null;
  vi.unstubAllGlobals();
});

describe('InfoBadges.position visibility (onboarding.md REQ-5b)', () => {
  it('shows a badge whose anchor sits between the header and the fold', () => {
    anchor('keyboard', 400);
    show();
    expect(display('keyboard')).toBe('');
  });

  it('hides one scrolled up under the sticky header (the half that already worked)', () => {
    anchor('keyboard', 10);
    show();
    expect(display('keyboard')).toBe('none');
  });

  it('hides one scrolled below the fold instead of pinning it off-screen', () => {
    anchor('keyboard', VIEWPORT_H + 200);
    show();
    expect(display('keyboard')).toBe('none');
  });

  it('hides one only half past the bottom edge — any overlap, like the band above', () => {
    // 'corner' places the badge at anchor.top - 6, so this one straddles the
    // fold: top 787, bottom 807.
    anchor('keyboard', VIEWPORT_H + 6 - BADGE_SIZE + 1);
    show();
    expect(display('keyboard')).toBe('none');
  });

  it('keeps one whose badge ends exactly at the fold (touching is not overlapping)', () => {
    anchor('keyboard', VIEWPORT_H + 6 - BADGE_SIZE);
    show();
    expect(display('keyboard')).toBe('');
  });

  it('brings a badge back when its anchor scrolls into view again', () => {
    const el = anchor('keyboard', VIEWPORT_H + 200);
    show();
    expect(display('keyboard')).toBe('none');

    place(el, 300);
    window.dispatchEvent(new Event('scroll'));
    expect(display('keyboard')).toBe('');
  });

  it('leaves header badges alone — a header anchor is near neither edge', () => {
    show();
    expect(display('transport')).toBe('');
  });

  it('still hides a zero-size anchor (REQ-5a, no regression)', () => {
    const el = anchor('keyboard', 400);
    place(el, 0, 0, 0);
    show();
    expect(display('keyboard')).toBe('none');
  });
});
