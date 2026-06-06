import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Modal } from '../../src/ui/components/modal';

const backdropSel = `.${Modal.backdropClass}`;
const inDoc = () => document.querySelector(backdropSel) as HTMLElement | null;

describe('Modal', () => {
  // Track every modal so afterEach can close it — an open modal keeps a
  // capturing window keydown listener alive, and a stale one would
  // stopImmediatePropagation the Escape before a later test's modal sees it.
  let modals: Modal[] = [];
  const mk = (opts: ConstructorParameters<typeof Modal>[0]) => {
    const m = new Modal(opts);
    modals.push(m);
    return m;
  };

  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { modals.forEach((m) => m.close()); modals = []; });

  it('mounts a titled card and accepts content in its body', () => {
    const m = mk({ title: 'Hello' });
    const p = document.createElement('p');
    p.textContent = 'content';
    m.body.appendChild(p);
    m.open();

    const backdrop = inDoc()!;
    expect(backdrop).not.toBeNull();
    expect(backdrop.querySelector(`.${Modal.titleClass}`)?.textContent).toBe('Hello');
    expect(backdrop.querySelector(`.${Modal.bodyClass}`)?.textContent).toBe('content');
  });

  it('open() reveals the backdrop (removes the hidden class)', () => {
    const m = mk({ title: 'X' });
    m.open();
    expect(inDoc()?.classList.contains('hidden')).toBe(false);
  });

  it('close() hides, fires onClose, and removes the node after the fade', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const m = mk({ title: 'X', onClose });
    m.open();
    m.close();
    expect(inDoc()?.classList.contains('hidden')).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(inDoc()).toBeNull();
    vi.useRealTimers();
  });

  it('Escape closes the modal', () => {
    const m = mk({ title: 'X' });
    m.open();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(inDoc()?.classList.contains('hidden')).toBe(true);
  });

  it('clicking the backdrop (but not the card) closes it', () => {
    const m = mk({ title: 'X' });
    m.open();
    const backdrop = inDoc()!;
    backdrop.dispatchEvent(new Event('pointerdown')); // target === backdrop
    expect(backdrop.classList.contains('hidden')).toBe(true);
  });

  it('close() is idempotent — onClose fires only once', () => {
    const onClose = vi.fn();
    const m = mk({ title: 'X', onClose });
    m.open();
    m.close();
    m.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
