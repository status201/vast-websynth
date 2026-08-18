import { describe, it, expect, beforeEach } from 'vitest';
import { confirmDialog, promptDialog, alertDialog, chooseDialog } from '../../src/ui/components/dialog';

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const clickId = (id: string) => (byId(id) as HTMLButtonElement).click();
const card = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const countId = (id: string) => document.querySelectorAll(`[data-testid="${id}"]`).length;

describe('dialog', () => {
  // Every dialog closes itself on resolution (removing Modal's capturing Escape
  // listener); the body reset keeps a stray node from leaking between tests.
  beforeEach(() => { document.body.innerHTML = ''; });

  it('confirmDialog resolves true when the confirm button is clicked', async () => {
    const p = confirmDialog({ title: 'Sure?', message: 'Do it?' });
    clickId('dialog-confirm');
    expect(await p).toBe(true);
  });

  it('confirmDialog resolves false on Cancel', async () => {
    const p = confirmDialog({ title: 'Sure?', message: 'Do it?' });
    clickId('dialog-cancel');
    expect(await p).toBe(false);
  });

  it('confirmDialog resolves false on Escape', async () => {
    const p = confirmDialog({ title: 'Sure?', message: 'x' });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await p).toBe(false);
  });

  it('confirmDialog resolves false on a backdrop click', async () => {
    const p = confirmDialog({ title: 'Sure?', message: 'x' });
    const backdrop = card()!.parentElement!;
    backdrop.dispatchEvent(new Event('pointerdown')); // target === backdrop
    expect(await p).toBe(false);
  });

  it('the affirmative choice wins over the close-driven cancel (settles once)', async () => {
    // Clicking confirm resolves(true) then close() -> onClose -> resolveOnce(false),
    // which the settled latch ignores. The observed value must be true.
    const p = confirmDialog({ title: 'Sure?', message: 'x' });
    clickId('dialog-confirm');
    expect(await p).toBe(true);
  });

  it('confirmDialog applies the danger style to the affirmative button', async () => {
    // Closed at the end, not left open: an un-closed Modal keeps its CAPTURING
    // Escape listener on window, and that listener stopImmediatePropagation()s —
    // so it would eat the first Escape a later test dispatches at its own dialog.
    const p = confirmDialog({ title: 'Wipe?', message: 'x', danger: true, confirmLabel: 'Clear' });
    const confirm = byId('dialog-confirm')!;
    expect(confirm.className).toMatch(/danger/);
    expect(confirm.textContent).toBe('Clear');
    clickId('dialog-cancel');
    await p;
  });

  it('confirmDialog renders an italic detail line when provided', async () => {
    const p = confirmDialog({ title: 'Sure?', message: 'x', detail: 'fine print' });
    const detail = byId('dialog-detail')!;
    expect(detail).not.toBeNull();
    expect(detail.textContent).toBe('fine print');
    expect(detail.className).toMatch(/detail/);
    clickId('dialog-cancel');
    await p;
  });

  it('confirmDialog renders no detail element by default', async () => {
    const p = confirmDialog({ title: 'Sure?', message: 'x' });
    expect(byId('dialog-detail')).toBeNull();
    clickId('dialog-cancel');
    await p;
  });

  it('promptDialog returns the edited text on confirm', async () => {
    const p = promptDialog({ title: 'Name', defaultValue: 'old' });
    const input = byId('dialog-input') as HTMLInputElement;
    expect(input.value).toBe('old');
    input.value = 'new name';
    clickId('dialog-confirm');
    expect(await p).toBe('new name');
  });

  it('promptDialog resolves null on Cancel', async () => {
    const p = promptDialog({ title: 'Name', defaultValue: 'old' });
    clickId('dialog-cancel');
    expect(await p).toBeNull();
  });

  it('promptDialog confirms on Enter in the input', async () => {
    const p = promptDialog({ title: 'Name', defaultValue: 'x' });
    const input = byId('dialog-input') as HTMLInputElement;
    input.value = 'typed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(await p).toBe('typed');
  });

  it('alertDialog shows one OK button and resolves when it is clicked', async () => {
    const p = alertDialog({ title: 'Oops', message: 'line one\nline two' });
    expect(byId('dialog-cancel')).toBeNull();
    expect(card()!.textContent).toContain('line two');
    clickId('dialog-confirm');
    await expect(p).resolves.toBeUndefined();
  });

  // chooseDialog (REQ-8) — for a question whose answers are two positive
  // actions. Its reason to exist is the null: a confirm would have to spend
  // `false` on one of the answers, so dismissing it would silently DO something.
  const twoWays = { id: 'demo', label: 'Load the demo' };
  const orMine = { id: 'mine', label: 'Load mine' };

  it('chooseDialog resolves the id of the clicked choice', async () => {
    const p = chooseDialog({ title: 'Which?', message: 'x', choices: [twoWays, orMine] });
    clickId('dialog-choice-mine');
    expect(await p).toBe('mine');
  });

  it('chooseDialog resolves each choice by its own id', async () => {
    const p = chooseDialog({ title: 'Which?', message: 'x', choices: [twoWays, orMine] });
    clickId('dialog-choice-demo');
    expect(await p).toBe('demo');
  });

  it('chooseDialog resolves null on Escape — neither action runs', async () => {
    const p = chooseDialog({ title: 'Which?', message: 'x', choices: [twoWays, orMine] });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await p).toBeNull();
  });

  it('chooseDialog resolves null on a backdrop click', async () => {
    const p = chooseDialog({ title: 'Which?', message: 'x', choices: [twoWays, orMine] });
    card()!.parentElement!.dispatchEvent(new Event('pointerdown'));
    expect(await p).toBeNull();
  });

  // dialog.md REQ-6 (v4). These helpers settle their promise BEFORE
  // `modal.close()`, so the caller resumes while the answered dialog is still
  // mounted for its fade. Answering one and raising another inside that window
  // put two in the document, and every testid matched twice — which is what
  // made e2e/song.spec.ts's demo-shadow test fail intermittently on a Playwright
  // strict-mode violation. Deliberately no `document.body.innerHTML = ''`
  // between the two dialogs here: that reset is exactly what hid the leak.
  it('answering a dialog and raising another straight away leaves one', async () => {
    const first = chooseDialog({ title: 'Which?', message: 'x', choices: [twoWays, orMine] });
    clickId('dialog-choice-demo');
    expect(await first).toBe('demo');

    // No timers advanced: the answered dialog is still inside its fade.
    const second = chooseDialog({
      title: 'Which?', message: 'x', choices: [twoWays, orMine], cancelLabel: 'Cancel',
    });
    expect(countId('dialog-choice-mine')).toBe(1);
    expect(countId('dialog-choice-demo')).toBe(1);
    expect(countId('dialog-cancel')).toBe(1);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    clickId('dialog-choice-mine');
    expect(await second).toBe('mine');
  });

  it('the surviving dialog is the new one, and it still answers', async () => {
    const first = confirmDialog({ title: 'Sure?', message: 'x' });
    clickId('dialog-confirm');
    expect(await first).toBe(true);

    const second = promptDialog({ title: 'Name', message: 'x', defaultValue: 'hi' });
    expect(countId('dialog-input')).toBe(1);
    clickId('dialog-confirm');
    expect(await second).toBe('hi');
  });

  it('chooseDialog renders a dismiss button only when cancelLabel is given', async () => {
    const bare = chooseDialog({ title: 'Which?', message: 'x', choices: [twoWays, orMine] });
    expect(byId('dialog-cancel')).toBeNull();
    clickId('dialog-choice-demo');
    await bare;

    document.body.innerHTML = '';
    const p = chooseDialog({
      title: 'Which?', message: 'x', choices: [twoWays, orMine], cancelLabel: 'Cancel',
    });
    clickId('dialog-cancel');
    expect(await p).toBeNull();
  });

  it('chooseDialog focuses the last choice and honours detail + danger', async () => {
    const p = chooseDialog({
      title: 'Which?',
      message: 'x',
      detail: 'fine print',
      choices: [{ id: 'wipe', label: 'Wipe', danger: true }, orMine],
    });
    expect(byId('dialog-detail')!.textContent).toBe('fine print');
    expect(byId('dialog-choice-wipe')!.className).toMatch(/danger/);
    expect(document.activeElement).toBe(byId('dialog-choice-mine'));
    clickId('dialog-choice-mine');
    await p;
  });
});
