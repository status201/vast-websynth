import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Modal } from '../../src/ui/components/modal';

const backdropSel = `.${Modal.backdropClass}`;
const inDoc = () => document.querySelector(backdropSel) as HTMLElement | null;
const allInDoc = () => document.querySelectorAll(backdropSel);

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

  // The fade leaves a closed modal mounted for ~200ms, and dialog.ts settles its
  // promise BEFORE close() — so the caller runs while the corpse is still in the
  // document. Answering one dialog and raising another inside that window put two
  // in the DOM, which is what made e2e/song.spec.ts's demo-shadow test flaky:
  // every dialog testid matched twice. (add-a-modal-dialog.md v4, dialog.md REQ-6)
  describe('a closing modal never overlaps the one that replaces it', () => {
    it('reaps the fading modal when the next one opens', () => {
      vi.useFakeTimers();
      const a = mk({ title: 'A' });
      a.open();
      a.close();
      // Mid-fade: still mounted, which is the whole problem.
      vi.advanceTimersByTime(50);
      expect(allInDoc()).toHaveLength(1);

      const b = mk({ title: 'B' });
      b.open();
      expect(allInDoc()).toHaveLength(1);
      expect(inDoc()?.querySelector(`.${Modal.titleClass}`)?.textContent).toBe('B');
      vi.useRealTimers();
    });

    it('leaves no stale timer that could remove the new modal', () => {
      vi.useFakeTimers();
      const a = mk({ title: 'A' });
      a.open();
      a.close();
      const b = mk({ title: 'B' });
      b.open();
      // A's fade timer would have fired around here; B must survive it.
      vi.advanceTimersByTime(400);
      expect(allInDoc()).toHaveLength(1);
      expect(inDoc()?.querySelector(`.${Modal.titleClass}`)?.textContent).toBe('B');
      vi.useRealTimers();
    });

    it('reaps several corpses at once', () => {
      vi.useFakeTimers();
      for (const t of ['A', 'B', 'C']) { const m = mk({ title: t }); m.open(); m.close(); }
      const d = mk({ title: 'D' });
      d.open();
      expect(allInDoc()).toHaveLength(1);
      vi.useRealTimers();
    });

    it('leaves an OPEN modal alone — only the dying are collected', () => {
      // Dialogs legitimately stack on modals that are still open (a confirm
      // raised from the preset manager), so this must not become a
      // one-modal-at-a-time rule.
      const a = mk({ title: 'A' });
      a.open();
      const b = mk({ title: 'B' });
      b.open();
      expect(allInDoc()).toHaveLength(2);
    });

    it('still removes the modal on its own when nothing else opens', () => {
      vi.useFakeTimers();
      const a = mk({ title: 'A' });
      a.open();
      a.close();
      vi.advanceTimersByTime(200);
      expect(allInDoc()).toHaveLength(0);
      vi.useRealTimers();
    });
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

  it('dismissOnBackdrop:false ignores a backdrop click, but Escape still closes', () => {
    const m = mk({ title: 'X', dismissOnBackdrop: false });
    m.open();
    const backdrop = inDoc()!;
    backdrop.dispatchEvent(new Event('pointerdown'));
    expect(backdrop.classList.contains('hidden')).toBe(false); // stayed open
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(backdrop.classList.contains('hidden')).toBe(true);  // Escape still closes
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
