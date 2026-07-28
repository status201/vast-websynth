import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FloatingWindow } from '../../src/ui/components/floating-window';

const rootSel = `.${FloatingWindow.rootClass}`;
const inDoc = () => document.querySelector(rootSel) as HTMLElement | null;

describe('FloatingWindow', () => {
  let wins: FloatingWindow[] = [];
  const ORIG_W = window.innerWidth;
  const ORIG_H = window.innerHeight;
  const setViewport = (w: number, h = window.innerHeight) => {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true, writable: true });
  };
  const mk = (opts: ConstructorParameters<typeof FloatingWindow>[0]) => {
    const w = new FloatingWindow(opts);
    wins.push(w);
    return w;
  };

  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { wins.forEach((w) => w.close()); wins = []; setViewport(ORIG_W, ORIG_H); });

  it('mounts a titled card and accepts content in its body', () => {
    const w = mk({ title: 'XY Pad', testId: 'xypad-window' });
    const p = document.createElement('p');
    p.textContent = 'content';
    w.body.appendChild(p);
    w.open();

    const root = inDoc()!;
    expect(root).not.toBeNull();
    expect(root.dataset.testid).toBe('xypad-window');
    expect(root.querySelector(`.${FloatingWindow.titleClass}`)?.textContent).toBe('XY Pad');
    expect(root.querySelector(`.${FloatingWindow.bodyClass}`)?.textContent).toBe('content');
  });

  it('has NO backdrop — the synth stays interactive', () => {
    const w = mk({ title: 'X' });
    w.open();
    // The only added node is the window root itself; nothing full-screen behind it.
    expect(document.body.children).toHaveLength(1);
    expect(inDoc()).toBe(document.body.firstElementChild);
  });

  it('open() reveals the window (removes the hidden class); isOpen tracks state', () => {
    const w = mk({ title: 'X' });
    expect(w.isOpen).toBe(false);
    w.open();
    expect(w.isOpen).toBe(true);
    expect(inDoc()?.classList.contains('hidden')).toBe(false);
  });

  it('close() hides, fires onClose once, and removes the node after the fade', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const w = mk({ title: 'X', onClose });
    w.open();
    w.close();
    expect(w.isOpen).toBe(false);
    expect(inDoc()?.classList.contains('hidden')).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(inDoc()).toBeNull();
    vi.useRealTimers();
  });

  it('is re-openable (open → close → open)', () => {
    vi.useFakeTimers();
    const w = mk({ title: 'X' });
    w.open();
    w.close();
    w.open();                    // cancels the pending removal, reveals again
    vi.advanceTimersByTime(200);
    expect(inDoc()).not.toBeNull();
    expect(inDoc()?.classList.contains('hidden')).toBe(false);
    expect(w.isOpen).toBe(true);
    vi.useRealTimers();
  });

  it('open()/close() are idempotent — onClose fires only once', () => {
    const onClose = vi.fn();
    const w = mk({ title: 'X', onClose });
    w.open();
    w.open();
    w.close();
    w.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT bind Escape — a non-modal tool must not steal the panic key', () => {
    const w = mk({ title: 'X' });
    w.open();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(inDoc()?.classList.contains('hidden')).toBe(false);
    expect(w.isOpen).toBe(true);
  });

  it('the close button closes the window', () => {
    const w = mk({ title: 'X' });
    w.open();
    const btn = inDoc()!.querySelector(`.${FloatingWindow.closeBtnClass}`) as HTMLButtonElement;
    btn.click();
    expect(w.isOpen).toBe(false);
  });

  it('renders a leading control after the minimise button and never drags from it', () => {
    const gear = document.createElement('button');
    gear.textContent = '⚙';
    const w = mk({ title: 'X', leading: gear, initial: { left: 100, top: 100 } });
    w.open();
    const bar = inDoc()!.querySelector(`.${FloatingWindow.titleBarClass}`)! as HTMLElement;

    // Inserted after the built-in minimise button, before the title.
    expect(bar.firstElementChild?.classList.contains(FloatingWindow.minBtnClass)).toBe(true);
    expect(bar.children[1]).toBe(gear);

    // A pointer-drag starting on the leading control must NOT move the window.
    gear.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 160, clientY: 140 }));
    const root = inDoc()!;
    expect(root.style.left).toBe('100px');
    expect(root.style.top).toBe('100px');
  });

  it('minimise button collapses and restores the body, flipping the glyph', () => {
    const w = mk({ title: 'X' });
    const p = document.createElement('p');
    p.textContent = 'content';
    w.body.appendChild(p);
    w.open();

    const bar = inDoc()!.querySelector(`.${FloatingWindow.titleBarClass}`)! as HTMLElement;
    const minBtn = bar.firstElementChild as HTMLButtonElement;
    expect(minBtn.classList.contains(FloatingWindow.minBtnClass)).toBe(true);
    expect(minBtn.textContent).toBe('−');
    expect(w.isCollapsed).toBe(false);

    minBtn.click();
    expect(w.isCollapsed).toBe(true);
    expect(inDoc()?.classList.contains('collapsed')).toBe(true);
    expect(minBtn.textContent).toBe('+');
    expect(minBtn.getAttribute('aria-expanded')).toBe('false');

    minBtn.click();
    expect(w.isCollapsed).toBe(false);
    expect(inDoc()?.classList.contains('collapsed')).toBe(false);
    expect(minBtn.textContent).toBe('−');
    expect(minBtn.getAttribute('aria-expanded')).toBe('true');
  });

  it('re-opening a minimised (then closed) window reveals it expanded', () => {
    vi.useFakeTimers();
    const w = mk({ title: 'X' });
    w.open();
    const minBtn = inDoc()!.querySelector(`.${FloatingWindow.minBtnClass}`) as HTMLButtonElement;
    minBtn.click();
    expect(w.isCollapsed).toBe(true);
    w.close();
    w.open();
    expect(w.isCollapsed).toBe(false);
    expect(inDoc()?.classList.contains('collapsed')).toBe(false);
    vi.useRealTimers();
  });

  it('dragging never starts from the minimise button', () => {
    const w = mk({ title: 'X', initial: { left: 100, top: 100 } });
    w.open();
    const minBtn = inDoc()!.querySelector(`.${FloatingWindow.minBtnClass}`) as HTMLButtonElement;
    minBtn.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 160, clientY: 140 }));
    const root = inDoc()!;
    expect(root.style.left).toBe('100px');
    expect(root.style.top).toBe('100px');
  });

  it('dragging the title bar moves the window', () => {
    const w = mk({ title: 'X', initial: { left: 100, top: 100 } });
    w.open();
    const bar = inDoc()!.querySelector(`.${FloatingWindow.titleBarClass}`)!;

    bar.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 150, clientY: 130 }));

    const root = inDoc()!;
    expect(root.style.left).toBe('150px');
    expect(root.style.top).toBe('130px');

    // After pointerup, further moves are ignored.
    window.dispatchEvent(new MouseEvent('pointerup', {}));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 500 }));
    expect(root.style.left).toBe('150px');
  });

  it('opening re-clamps a stale off-screen position into the viewport', () => {
    // A position saved for a wider/taller viewport must not survive off-screen.
    const w = mk({ title: 'X', initial: { left: 5000, top: 5000 } });
    w.open();
    const root = inDoc()!;
    // jsdom reports offsetWidth/Height as 0, so the bound is the viewport itself.
    expect(root.style.left).not.toBe('5000px');
    expect(root.style.top).not.toBe('5000px');
    expect(parseInt(root.style.left, 10)).toBeLessThanOrEqual(window.innerWidth);
    expect(parseInt(root.style.top, 10)).toBeLessThanOrEqual(window.innerHeight);
  });

  it('a resize / orientation change pulls an off-screen window back into view', () => {
    const w = mk({ title: 'X', initial: { left: 100, top: 100 } });
    w.open();
    const root = inDoc()!;
    expect(root.style.left).toBe('100px');

    // Shrink the viewport (portrait→landscape or a narrowed window) and fire resize.
    setViewport(50);
    window.dispatchEvent(new Event('resize'));
    expect(root.style.left).toBe('50px');

    // orientationchange re-clamps too.
    setViewport(30);
    window.dispatchEvent(new Event('orientationchange'));
    expect(root.style.left).toBe('30px');
  });

  // REQ-9 (v4) — the first window able to refuse its own close, for one holding
  // unsaved work. Until v4 the ✕ closed unconditionally and onClose was pure
  // after-the-fact cleanup, so there was nowhere to ask.
  describe('confirmClose (REQ-9)', () => {
    const closeBtn = () => inDoc()!.querySelector(`.${FloatingWindow.closeBtnClass}`) as HTMLButtonElement;

    it('a false answer aborts the close entirely', async () => {
      const onClose = vi.fn();
      let allow = false;
      const w = mk({ title: 'X', onClose, confirmClose: () => Promise.resolve(allow) });
      w.open();

      closeBtn().click();
      await Promise.resolve();
      expect(w.isOpen).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
      expect(inDoc()!.classList.contains('hidden')).toBe(false);

      // …and the very next click closes it once the answer flips.
      allow = true;
      closeBtn().click();
      await Promise.resolve();
      expect(w.isOpen).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('guards a caller-driven close too, not just the ✕', async () => {
      const w = mk({ title: 'X', confirmClose: () => Promise.resolve(false) });
      w.open();
      w.close(); // what a launcher toggle / keyboard shortcut calls
      await Promise.resolve();
      expect(w.isOpen).toBe(true);
    });

    it('stacks nothing when close is called again while the confirm is pending', async () => {
      let settle!: (ok: boolean) => void;
      const confirmClose = vi.fn(() => new Promise<boolean>((res) => { settle = res; }));
      const w = mk({ title: 'X', confirmClose });
      w.open();

      w.close();
      w.close();
      closeBtn().click();
      expect(confirmClose).toHaveBeenCalledTimes(1);

      settle(true);
      await Promise.resolve();
      expect(w.isOpen).toBe(false);
    });

    it('leaves a window without confirmClose synchronous (regression)', () => {
      const onClose = vi.fn();
      const w = mk({ title: 'X', onClose });
      w.open();
      w.close();
      expect(w.isOpen).toBe(false); // no await needed — the v3 path is untouched
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('stops re-clamping on resize once closed (listener removed)', () => {
    vi.useFakeTimers();
    const w = mk({ title: 'X', initial: { left: 100, top: 100 } });
    w.open();
    w.close();
    const root = inDoc()!;
    // The node lingers during the fade; a resize now must NOT move it.
    setViewport(50);
    window.dispatchEvent(new Event('resize'));
    expect(root.style.left).toBe('100px');
    vi.advanceTimersByTime(200);
    vi.useRealTimers();
  });
});
