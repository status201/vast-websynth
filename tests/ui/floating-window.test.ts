import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FloatingWindow } from '../../src/ui/components/floating-window';

const rootSel = `.${FloatingWindow.rootClass}`;
const inDoc = () => document.querySelector(rootSel) as HTMLElement | null;

describe('FloatingWindow', () => {
  let wins: FloatingWindow[] = [];
  const mk = (opts: ConstructorParameters<typeof FloatingWindow>[0]) => {
    const w = new FloatingWindow(opts);
    wins.push(w);
    return w;
  };

  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { wins.forEach((w) => w.close()); wins = []; });

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
});
