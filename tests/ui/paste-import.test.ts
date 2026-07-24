import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildPasteImport, openPasteImportModal } from '../../src/ui/components/paste-import';

/**
 * paste-import.md REQ-5..REQ-8 — the fragment renders and routes; it never
 * validates or applies anything itself.
 */

const AUTHOR = '{"format":"websynth-song-author","version":1,"name":"Night Drive"}';
const BANK =
  '{"format":"websynth-preset-bank","version":1,"name":"mine",' +
  '"presets":{"lead":{"filter.cutoff":80},"bass":{"filter.cutoff":50}}}';

const input = () => document.querySelector('[data-testid="paste-input"]') as HTMLTextAreaElement;
const status = () => document.querySelector('[data-testid="paste-status"]') as HTMLElement;
const confirm = () => document.querySelector('[data-testid="paste-confirm"]') as HTMLButtonElement;

/** Type into the textarea the way a paste does — value + an input event. */
function paste(text: string): void {
  input().value = text;
  input().dispatchEvent(new Event('input'));
}

function mount(overrides: Partial<Parameters<typeof buildPasteImport>[0]> = {}) {
  const onSong = vi.fn(async () => true);
  const onPresets = vi.fn();
  const onDone = vi.fn();
  const frag = buildPasteImport({ onSong, onPresets, onDone, ...overrides });
  document.body.appendChild(frag.el);
  return { onSong, onPresets, onDone };
}

describe('paste import fragment', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { document.body.innerHTML = ''; });

  it('starts empty, silent and disabled', () => {
    mount();
    expect(status().textContent).toBe('');
    expect(confirm().disabled).toBe(true);
  });

  it('names what it recognized and states the action (REQ-6)', () => {
    mount();
    paste('```json\n' + AUTHOR + '\n```');
    expect(status().textContent).toContain('Night Drive');
    expect(status().textContent).toContain('author dialect');
    expect(confirm().disabled).toBe(false);
    expect(confirm().textContent).toBe('Load song');

    paste(BANK);
    expect(status().textContent).toContain('2 sounds');
    expect(confirm().textContent).toBe('Review 2 presets');
  });

  it('shows the refusal reason and stays disabled on junk (REQ-4/REQ-6)', () => {
    mount();
    paste('Sorry, I can only describe the song in words.');
    expect(status().textContent).toContain('No JSON');
    expect(confirm().disabled).toBe(true);
  });

  it('routes a song to onSong as encoded bytes (REQ-7)', async () => {
    const { onSong, onPresets, onDone } = mount();
    paste('prose\n```json\n' + AUTHOR + '\n```\nmore prose');
    confirm().click();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

    expect(onPresets).not.toHaveBeenCalled();
    const [bytes, name] = onSong.mock.calls[0] as unknown as [Uint8Array, string];
    // The prose and fences are gone — only the object reaches the importer.
    expect(new TextDecoder().decode(bytes)).toBe(AUTHOR);
    expect(name).toBe('pasted-song.json');
  });

  it('routes a bank to onPresets as a parsed payload (REQ-7)', async () => {
    const { onSong, onPresets, onDone } = mount();
    paste(BANK);
    confirm().click();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

    expect(onSong).not.toHaveBeenCalled();
    const parse = onPresets.mock.calls[0]![0] as { ok: boolean; presets: Record<string, unknown> };
    expect(parse.ok).toBe(true);
    expect(Object.keys(parse.presets)).toEqual(['lead', 'bass']);
  });

  // REQ-8 — a rejected song keeps the text so the user can fix a line.
  it('keeps the pasted text when the import refuses it', async () => {
    const onSong = vi.fn(async () => false);
    const { onDone } = mount({ onSong });
    paste(AUTHOR);
    confirm().click();
    await vi.waitFor(() => expect(onSong).toHaveBeenCalled());

    expect(onDone).not.toHaveBeenCalled();
    expect(input().value).toBe(AUTHOR);
    expect(confirm().disabled).toBe(false);
  });

  it('opens as a modal with a Cancel that closes it (REQ-5)', () => {
    openPasteImportModal({ onSong: vi.fn(async () => true), onPresets: vi.fn() });
    const body = document.querySelector('[data-testid="paste-modal"]');
    expect(body).not.toBeNull();
    expect(input()).not.toBeNull();

    const backdrop = body!.closest('[class*="backdrop"]')!;
    expect(backdrop.classList.contains('hidden')).toBe(false);
    (document.querySelector('[data-testid="paste-cancel"]') as HTMLButtonElement).click();
    expect(backdrop.classList.contains('hidden')).toBe(true);
  });
});
