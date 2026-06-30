import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAboutButton } from '../../src/ui/components/about';
import { installLocalStorageMock } from '../storage-mock';
import type { StudioApi } from '../../src/ui/studio-api';
import type { IosAudioDiagnostics } from '../../src/audio/ios-audio-session';

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

/** Close any open modal so its refresh interval / capturing keydown listener don't leak. */
function closeOpenModal(): void {
  const closeBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Close');
  closeBtn?.click();
}

describe('About modal — Debug section', () => {
  beforeEach(() => {
    installLocalStorageMock();
    document.body.innerHTML = '';
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
