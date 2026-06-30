import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAboutButton } from '../../src/ui/components/about';
import { installLocalStorageMock } from '../storage-mock';
import type { StudioApi } from '../../src/ui/studio-api';

/** Minimal StudioApi — createAboutButton only reads `engine.ctx`. */
function stubEngine(state: AudioContextState = 'running') {
  const ctx = {
    state,
    sampleRate: 48000,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { engine: { ctx } as unknown as StudioApi, ctx };
}

const debugSection = () => document.querySelector('[data-testid="debug-section"]') as HTMLElement | null;
const ctxStateRow = () => document.querySelector('[data-testid="debug-ctx-state"]') as HTMLElement | null;

describe('About modal — Debug section', () => {
  beforeEach(() => {
    installLocalStorageMock();
    document.body.innerHTML = '';
  });

  it('opens with a default-collapsed Debug section showing the context state', () => {
    const { engine } = stubEngine('running');
    const btn = createAboutButton(engine);
    document.body.appendChild(btn);
    btn.click();

    const section = debugSection();
    expect(section).not.toBeNull();
    expect(section!.classList.contains('collapsed')).toBe(true);
    expect(ctxStateRow()?.textContent).toBe('running');
  });

  it('keeps the readout live via the ctx statechange listener while open', () => {
    const { engine, ctx } = stubEngine('suspended');
    const btn = createAboutButton(engine);
    document.body.appendChild(btn);
    btn.click();

    expect(ctxStateRow()?.textContent).toBe('suspended');

    const handler = ctx.addEventListener.mock.calls.find((c) => c[0] === 'statechange')?.[1] as (() => void) | undefined;
    expect(handler).toBeTypeOf('function');
    ctx.state = 'running';
    handler!();
    expect(ctxStateRow()?.textContent).toBe('running');
  });

  it('expands the Debug section when its header is clicked', () => {
    const { engine } = stubEngine();
    const btn = createAboutButton(engine);
    document.body.appendChild(btn);
    btn.click();

    const section = debugSection()!;
    expect(section.classList.contains('collapsed')).toBe(true);
    // The header (the .sec sibling carrying the chevron) is the click target.
    const header = section.previousElementSibling as HTMLElement;
    header.click();
    expect(section.classList.contains('collapsed')).toBe(false);
  });
});
