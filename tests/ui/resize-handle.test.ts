import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ResizeHandle } from '../../src/ui/components/resize-handle';
import {
  SCOPE_H_MIN, SCOPE_H_MAX, SCOPE_H_DEFAULT, SCOPE_H_STEP,
} from '../../src/state/scope-height';

/**
 * One case per row of the gesture inventory in `specs/features/scope.md`,
 * plus the REQ-21 listener-hygiene contract.
 */

/** jsdom runs rAF on a real timer; capture the queue so writes flush on demand. */
function stubRaf(): { pending: number; flush(): void } {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => void frames.delete(id));
  return {
    get pending() {
      return frames.size;
    },
    flush() {
      const cbs = [...frames.values()];
      frames.clear();
      for (const cb of cbs) cb(0);
    },
  };
}

const pointer = (type: string, clientY: number): PointerEvent => {
  const e = new MouseEvent(type, { clientY, bubbles: true, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e as PointerEvent;
};

interface Harness {
  target: HTMLElement;
  handle: ResizeHandle;
  commits: number[];
  raf: { pending: number; flush(): void };
  height(): number;
}

function mount(initial = SCOPE_H_DEFAULT): Harness {
  const raf = stubRaf();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const commits: number[] = [];
  const handle = new ResizeHandle({
    target,
    cssVar: '--scope-h',
    min: SCOPE_H_MIN,
    max: SCOPE_H_MAX,
    initial,
    defaultValue: SCOPE_H_DEFAULT,
    step: SCOPE_H_STEP,
    onCommit: (px) => commits.push(px),
    testId: 'scope-resize-handle',
    label: 'Scope height',
    title: 'Drag to resize the scope — double-click to reset',
  });
  target.appendChild(handle.el);
  return {
    target,
    handle,
    commits,
    raf,
    height: () => Number.parseInt(target.style.getPropertyValue('--scope-h'), 10),
  };
}

/** A full press → move → release stroke. `dy` is upward pixels (up = taller). */
function drag(h: Harness, dy: number, from = 500): void {
  h.handle.el.dispatchEvent(pointer('pointerdown', from));
  window.dispatchEvent(pointer('pointermove', from - dy));
  h.raf.flush();
  window.dispatchEvent(pointer('pointerup', from - dy));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ResizeHandle — mount', () => {
  it('writes the initial height and the ARIA splitter contract', () => {
    const h = mount(186);
    expect(h.height()).toBe(186);
    expect(h.handle.el.dataset.testid).toBe('scope-resize-handle');
    expect(h.handle.el.getAttribute('role')).toBe('separator');
    expect(h.handle.el.getAttribute('aria-orientation')).toBe('horizontal');
    expect(h.handle.el.getAttribute('aria-valuenow')).toBe('186');
    expect(h.handle.el.getAttribute('aria-valuemin')).toBe(String(SCOPE_H_MIN));
    expect(h.handle.el.getAttribute('aria-valuemax')).toBe(String(SCOPE_H_MAX));
    expect(h.handle.el.tabIndex).toBe(0);
    expect(h.handle.el.title).toContain('Drag');
  });
});

// Row: drag ↕
describe('ResizeHandle — drag', () => {
  it('dragging up makes it taller by the pointer distance', () => {
    const h = mount(SCOPE_H_DEFAULT);
    drag(h, 60);
    expect(h.handle.value).toBe(SCOPE_H_DEFAULT + 60);
    expect(h.height()).toBe(SCOPE_H_DEFAULT + 60);
  });

  it('dragging down makes it shorter', () => {
    const h = mount(200);
    drag(h, -40);
    expect(h.handle.value).toBe(160);
  });

  it('clamps at the floor and the ceiling', () => {
    const down = mount(200);
    drag(down, -9999);
    expect(down.handle.value).toBe(SCOPE_H_MIN);

    const up = mount(200);
    drag(up, 9999);
    expect(up.handle.value).toBe(SCOPE_H_MAX);
    expect(up.handle.value).toBe(SCOPE_H_MIN * 2); // the feature's promise
  });

  it('coalesces a burst of moves into a single frame, landing on the last one', () => {
    const h = mount(SCOPE_H_DEFAULT);
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointermove', 490));
    window.dispatchEvent(pointer('pointermove', 480));
    window.dispatchEvent(pointer('pointermove', 470));
    expect(h.raf.pending).toBe(1); // REQ-21: one write per frame, not per event
    h.raf.flush();
    expect(h.handle.value).toBe(SCOPE_H_DEFAULT + 30);
  });

  it('a release flushes a still-pending frame, so it lands on the final value', () => {
    const h = mount(SCOPE_H_DEFAULT);
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointermove', 450));
    window.dispatchEvent(pointer('pointerup', 450)); // no flush() in between
    expect(h.handle.value).toBe(SCOPE_H_DEFAULT + 50);
    expect(h.commits).toEqual([SCOPE_H_DEFAULT + 50]);
  });

  it('commits once on release, never per move', () => {
    const h = mount(SCOPE_H_DEFAULT);
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointermove', 480));
    h.raf.flush();
    window.dispatchEvent(pointer('pointermove', 460));
    h.raf.flush();
    expect(h.commits).toEqual([]); // nothing persisted mid-stroke
    window.dispatchEvent(pointer('pointerup', 460));
    expect(h.commits).toEqual([SCOPE_H_DEFAULT + 40]);
  });

  it('a cancelled stroke still tears down cleanly', () => {
    const h = mount(SCOPE_H_DEFAULT);
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointermove', 470));
    h.raf.flush();
    window.dispatchEvent(pointer('pointercancel', 470));
    // A further move must not move it — the stroke is over.
    window.dispatchEvent(pointer('pointermove', 300));
    h.raf.flush();
    expect(h.handle.value).toBe(SCOPE_H_DEFAULT + 30);
  });
});

// Row: tap / click — "—"
describe('ResizeHandle — a press that does not move', () => {
  it('leaves the height alone and writes nothing', () => {
    const h = mount(186);
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointerup', 500));
    expect(h.handle.value).toBe(186);
    expect(h.commits).toEqual([]);
  });
});

// Row: double-tap
describe('ResizeHandle — double-tap', () => {
  it('resets to the default and persists it', () => {
    const h = mount(240);
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointerup', 500));
    h.handle.el.dispatchEvent(pointer('pointerdown', 500)); // within DOUBLE_TAP_MS
    expect(h.handle.value).toBe(SCOPE_H_DEFAULT);
    expect(h.height()).toBe(SCOPE_H_DEFAULT);
    expect(h.commits).toEqual([SCOPE_H_DEFAULT]);
  });

  it('does not fire for two presses further apart than the window', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(10_000);
    const h = mount(240);
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointerup', 500));
    now.mockReturnValue(11_000); // well past the 350ms window
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointerup', 500));
    expect(h.handle.value).toBe(240);
    expect(h.commits).toEqual([]);
  });

  it('the very first press is never a double-tap, even at page load', () => {
    // lastTap starts at -Infinity, not 0 — at 0 a press inside the first 350ms
    // of the page's life would read as a second tap and reset the height.
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const h = mount(240);
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    expect(h.handle.value).toBe(240);
    expect(h.commits).toEqual([]);
  });

  it('a third tap does not re-trigger off the second', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(10_000);
    const h = mount(240);
    h.handle.el.dispatchEvent(pointer('pointerdown', 500)); // tap 1
    window.dispatchEvent(pointer('pointerup', 500));
    h.handle.el.dispatchEvent(pointer('pointerdown', 500)); // tap 2 -> reset
    expect(h.commits).toEqual([SCOPE_H_DEFAULT]);
    h.handle.el.dispatchEvent(pointer('pointerdown', 500)); // tap 3 -> a fresh first tap
    window.dispatchEvent(pointer('pointerup', 500));
    expect(h.commits).toEqual([SCOPE_H_DEFAULT]); // no second reset
  });
});

// Rows: ArrowUp / ArrowDown / Home
describe('ResizeHandle — keyboard', () => {
  const key = (el: HTMLElement, k: string): void => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  };

  it('ArrowUp and ArrowDown step by SCOPE_H_STEP and keep aria in sync', () => {
    const h = mount(200);
    key(h.handle.el, 'ArrowUp');
    expect(h.handle.value).toBe(200 + SCOPE_H_STEP);
    expect(h.handle.el.getAttribute('aria-valuenow')).toBe(String(200 + SCOPE_H_STEP));
    key(h.handle.el, 'ArrowDown');
    expect(h.handle.value).toBe(200);
    expect(h.commits).toEqual([200 + SCOPE_H_STEP, 200]);
  });

  it('Home resets to the default', () => {
    const h = mount(240);
    key(h.handle.el, 'Home');
    expect(h.handle.value).toBe(SCOPE_H_DEFAULT);
    expect(h.commits).toEqual([SCOPE_H_DEFAULT]);
  });

  it('clamps, and a key that changes nothing commits nothing', () => {
    const h = mount(SCOPE_H_MAX);
    key(h.handle.el, 'ArrowUp');
    expect(h.handle.value).toBe(SCOPE_H_MAX);
    expect(h.commits).toEqual([]);
  });

  it('ignores keys outside the inventory', () => {
    const h = mount(200);
    key(h.handle.el, 'Delete');
    key(h.handle.el, 'End');
    key(h.handle.el, 'a');
    expect(h.handle.value).toBe(200);
    expect(h.commits).toEqual([]);
  });
});

// Scenario: Pressing the handle never resets the spectrum peak-hold (regression)
describe('ResizeHandle — sibling of the canvas (scope REQ-13)', () => {
  it('a stroke on the handle never reaches a sibling canvas click listener', () => {
    const raf = stubRaf();
    // Mirrors .scopeWrap: canvas and handle are siblings, not parent and child.
    const wrap = document.createElement('div');
    const canvas = document.createElement('canvas');
    const resetPeak = vi.fn();
    canvas.addEventListener('click', resetPeak);
    wrap.appendChild(canvas);
    document.body.appendChild(wrap);

    const handle = new ResizeHandle({
      target: wrap,
      cssVar: '--scope-h',
      min: SCOPE_H_MIN,
      max: SCOPE_H_MAX,
      initial: SCOPE_H_DEFAULT,
      defaultValue: SCOPE_H_DEFAULT,
      step: SCOPE_H_STEP,
      onCommit: () => {},
      testId: 'scope-resize-handle',
      label: 'Scope height',
      title: 't',
    });
    wrap.appendChild(handle.el);
    expect(canvas.contains(handle.el)).toBe(false);

    handle.el.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointermove', 450));
    raf.flush();
    window.dispatchEvent(pointer('pointerup', 450));
    handle.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(resetPeak).not.toHaveBeenCalled();
    expect(handle.value).toBe(SCOPE_H_DEFAULT + 50);
  });
});

// REQ-21: global listeners exist only for the duration of a gesture
describe('ResizeHandle — listener hygiene', () => {
  let added: string[];
  let removed: string[];

  beforeEach(() => {
    added = [];
    removed = [];
    // Bind the originals before spying, so the spies still wire real listeners.
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation(((
      t: string, l: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions,
    ) => {
      added.push(t);
      origAdd(t, l, o);
    }) as typeof window.addEventListener);
    vi.spyOn(window, 'removeEventListener').mockImplementation(((
      t: string, l: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions,
    ) => {
      removed.push(t);
      origRemove(t, l, o);
    }) as typeof window.removeEventListener);
  });

  it('registers no window pointermove listener at rest', () => {
    mount();
    expect(added).not.toContain('pointermove');
  });

  it('attaches for the stroke and detaches on release', () => {
    const h = mount();
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    expect(added).toContain('pointermove');
    expect(added).toContain('pointerup');
    expect(added).toContain('pointercancel');
    expect(removed).not.toContain('pointermove');
    window.dispatchEvent(pointer('pointerup', 500));
    expect(removed).toContain('pointermove');
    expect(removed).toContain('pointerup');
    expect(removed).toContain('pointercancel');
  });

  it('destroy() detaches the drag listeners and cancels a pending frame', () => {
    const h = mount();
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointermove', 470));
    expect(h.raf.pending).toBe(1);
    h.handle.destroy();
    expect(removed).toContain('pointermove');
    expect(h.raf.pending).toBe(0);
    // And the element's own listeners are gone too.
    const before = h.handle.value;
    h.handle.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    h.handle.el.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointermove', 300));
    expect(h.handle.value).toBe(before);
  });
});
