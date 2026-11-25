// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mountSongPanel } from './song-panel-harness';
import { openPresetManagerModal } from '../../src/ui/components/preset-manager-modal';
import { storageFailureReason } from '../../src/ui/storage-failure';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PresetSession } from '../../src/state/preset-session';
import { Song, DEMO_SONGS } from '../../src/state/song';
import { installLocalStorageMock } from '../storage-mock';

/**
 * storage-failures.md REQ-a-failed-save-says-so (regression): a save the browser
 * refused used to throw out of the click handler — nothing stored, nothing said.
 */

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

/** From now on every write to localStorage is refused as a full quota. */
function fillStorage(): void {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw quota(); });
}

/** Answer the open prompt with `name` and confirm it. */
async function answerPrompt(name: string): Promise<void> {
  await vi.waitFor(() => expect(byId('dialog-input')).not.toBeNull());
  (byId('dialog-input') as HTMLInputElement).value = name;
  byId('dialog-confirm')!.click();
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('storageFailureReason', () => {
  it('names a full quota, in Blink and in Gecko', () => {
    expect(storageFailureReason(quota())).toBe('storage is full');
    expect(storageFailureReason(new DOMException('x', 'NS_ERROR_DOM_QUOTA_REACHED'))).toBe('storage is full');
    expect(storageFailureReason(new DOMException('x', 'SecurityError'))).toBe('the browser would not store it');
  });
});

describe('a save the browser refuses says so (REQ-a-failed-save-says-so)', () => {
  it('song Save still downloads, says it is not stored, and leaves the slot list alone', async () => {
    const { panel } = mountSongPanel();
    const download = vi.spyOn(Song, 'download').mockImplementation(() => {});
    fillStorage();

    byId('song-save')!.click();
    await answerPrompt('Full Song');

    await vi.waitFor(() => expect(document.body.textContent).toContain('storage is full'));
    expect(document.body.textContent).toContain('"Full Song" was downloaded as a file');
    expect(download).toHaveBeenCalledOnce();
    expect(Song.hasSlot('Full Song')).toBe(false);
    void panel;
  });

  it('song import keeps the song and says only the slot was not saved — never "failed to apply"', async () => {
    const { panel } = mountSongPanel();
    fillStorage();
    const file = { ...Object.values(DEMO_SONGS)[0]!, name: 'Imported Tune' };
    const bytes = new TextEncoder().encode(Song.toJSON(file));

    // Not awaited: the import resolves once the dialog it raises is dismissed.
    void panel.importBytes(bytes, 'imported.websynth.json');

    await vi.waitFor(() => expect(document.body.textContent).toContain('is loaded, but could not be kept'));
    expect(document.body.textContent).not.toContain('failed to apply');
  });

  it('preset Save says it was not saved and shows no "Saved" toast', async () => {
    installLocalStorageMock();
    const bus = new ParamBus();
    registerDefaults(bus);
    openPresetManagerModal({ bus, session: new PresetSession(), onPresetsChanged: () => {} });
    fillStorage();

    byId('preset-mgr-save')!.click();
    await answerPrompt('Full Pad');

    await vi.waitFor(() => expect(document.body.textContent).toContain('"Full Pad" could not be saved — storage is full'));
    expect(byId('preset-toast')).toBeNull();
  });
});
