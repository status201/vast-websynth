import { describe, it, expect, beforeEach } from 'vitest';
import { confirmDialog, promptDialog, alertDialog } from '../../src/ui/components/dialog';

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const clickId = (id: string) => (byId(id) as HTMLButtonElement).click();
const card = () => document.querySelector('[role="dialog"]') as HTMLElement | null;

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

  it('confirmDialog applies the danger style to the affirmative button', () => {
    void confirmDialog({ title: 'Wipe?', message: 'x', danger: true, confirmLabel: 'Clear' });
    const confirm = byId('dialog-confirm')!;
    expect(confirm.className).toMatch(/danger/);
    expect(confirm.textContent).toBe('Clear');
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
});
