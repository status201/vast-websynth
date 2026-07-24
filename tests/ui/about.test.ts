import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAboutButton, setClipStatsSource } from '../../src/ui/components/about';
import { restoreFactorySettings } from '../../src/state/factory-reset';
import { installLocalStorageMock } from '../storage-mock';
import type { StudioApi } from '../../src/ui/studio-api';
import type { IosAudioDiagnostics } from '../../src/audio/ios-audio-session';

// The About modal wires the factory-reset button to this helper; the helper's
// own behaviour (clear + reload) is pinned by tests/state/factory-reset.test.ts.
vi.mock('../../src/state/factory-reset', () => ({ restoreFactorySettings: vi.fn() }));

const INERT_IOS: IosAudioDiagnostics = { active: false, status: 'n/a', routed: false, paused: null, currentTime: null };

/** Minimal StudioApi — createAboutButton only reads `engine.ctx` and `engine.iosAudio`. */
function stubEngine(state: AudioContextState = 'running', iosAudio: IosAudioDiagnostics = INERT_IOS) {
  const ctx = {
    state,
    sampleRate: 48000,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { engine: { ctx, iosAudio } as unknown as StudioApi, ctx };
}

const debugSection = () => document.querySelector('[data-testid="debug-section"]') as HTMLElement | null;
const ctxStateRow = () => document.querySelector('[data-testid="debug-ctx-state"]') as HTMLElement | null;
const unlockRow = () => document.querySelector('[data-testid="debug-ios-unlock"]') as HTMLElement | null;
const clipsRow = () => document.querySelector('[data-testid="debug-sampler-clips"]') as HTMLElement | null;

/** Close any open modal so its refresh interval / capturing keydown listener don't leak. */
function closeOpenModal(): void {
  const closeBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Close');
  closeBtn?.click();
}

describe('About modal — Debug section', () => {
  beforeEach(() => {
    installLocalStorageMock();
    document.body.innerHTML = '';
    vi.mocked(restoreFactorySettings).mockClear();
  });
  afterEach(() => closeOpenModal());

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

  it('renders the iOS audio-unlock diagnostics row', () => {
    const ios: IosAudioDiagnostics = { active: true, status: 'playing', routed: true, paused: false, currentTime: 1.2 };
    const { engine } = stubEngine('running', ios);
    const btn = createAboutButton(engine);
    document.body.appendChild(btn);
    btn.click();

    expect(unlockRow()?.textContent).toBe('playing · routed');
  });

  // debug-panel.md REQ-4/REQ-5 — the late-bound row idiom, used by
  // sample-persistence.md for the IndexedDB clip store.
  it('reads the sampler-clip row from its late-bound source, or n/a when unbound', () => {
    const { engine } = stubEngine('running');
    document.body.appendChild(createAboutButton(engine)).click();
    expect(clipsRow()?.textContent).toBe('n/a');

    closeOpenModal();
    document.body.innerHTML = '';
    setClipStatsSource(() => ({ count: 2, bytes: 4_200_000 }));
    document.body.appendChild(createAboutButton(engine)).click();
    expect(clipsRow()?.textContent).toBe('2 · 4.2 MB');
  });

  it('places the factory-reset button between the shortcuts grid and Debug', () => {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine));
    (document.body.firstElementChild as HTMLButtonElement).click();

    const reset = document.querySelector('[data-testid="factory-reset"]') as HTMLElement;
    expect(reset).not.toBeNull();
    expect(reset.textContent).toBe('Restore to Factory Settings');
    // Preceded by the shortcuts key/value grid, followed by the Debug header.
    expect(reset.previousElementSibling?.textContent).toContain('Play / stop transport');
    expect(reset.nextElementSibling?.textContent).toContain('Debug');
  });

  it('confirming the factory-reset dialog restores factory settings', async () => {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine));
    (document.body.firstElementChild as HTMLButtonElement).click();

    (document.querySelector('[data-testid="factory-reset"]') as HTMLButtonElement).click();
    // The styled confirm carries the Nintendo exit line, italic via .detail.
    const detail = document.querySelector('[data-testid="dialog-detail"]') as HTMLElement;
    expect(detail.textContent).toBe('“Everything not saved will be lost.”');

    (document.querySelector('[data-testid="dialog-confirm"]') as HTMLButtonElement).click();
    await Promise.resolve(); // let the awaited confirmDialog promise settle
    expect(restoreFactorySettings).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the confirm, not the About modal beneath it', async () => {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine));
    (document.body.firstElementChild as HTMLButtonElement).click();

    (document.querySelector('[data-testid="factory-reset"]') as HTMLButtonElement).click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await Promise.resolve();

    // The confirm resolved false (no restore) and its backdrop is fading out…
    expect(restoreFactorySettings).not.toHaveBeenCalled();
    const dialogBackdrop = document
      .querySelector('[data-testid="dialog-confirm"]')!
      .closest('[class*="backdrop"]')!;
    expect(dialogBackdrop.classList.contains('hidden')).toBe(true);
    // …while the About modal underneath stays open.
    const aboutBackdrop = debugSection()!.closest('[class*="backdrop"]')!;
    expect(aboutBackdrop.classList.contains('hidden')).toBe(false);
  });

  it('cancelling the factory-reset dialog changes nothing', async () => {
    const { engine } = stubEngine();
    document.body.appendChild(createAboutButton(engine));
    (document.body.firstElementChild as HTMLButtonElement).click();

    (document.querySelector('[data-testid="factory-reset"]') as HTMLButtonElement).click();
    (document.querySelector('[data-testid="dialog-cancel"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(restoreFactorySettings).not.toHaveBeenCalled();
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
