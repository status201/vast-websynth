// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { openExportSongModal } from '../../src/ui/components/export-song-modal';

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

afterEach(() => {
  document.body.replaceChildren();
});

describe('export-song-modal', () => {
  it('defaults to the Song (.json) kind with Copy Link enabled', () => {
    openExportSongModal({
      hasSamplerAudio: true,
      onExport: vi.fn(),
      makeShareUrl: () => Promise.resolve('https://x/#song=y'),
    });
    const share = byId('song-share-link') as HTMLButtonElement;
    expect(share).toBeTruthy();
    expect(share.disabled).toBe(false);
    expect(share.title).toBe('Copy a shareable URL that opens this song');
  });

  it('disables Copy Link with an explanatory title while Project (.zip) is selected (REQ-5 v2)', () => {
    openExportSongModal({
      hasSamplerAudio: true,
      onExport: vi.fn(),
      makeShareUrl: () => Promise.resolve('https://x/#song=y'),
    });
    const share = byId('song-share-link') as HTMLButtonElement;

    (byId('export-kind-project') as HTMLButtonElement).click();
    expect(share.disabled).toBe(true);
    expect(share.title).toMatch(/sampler audio/);
    expect(share.title).toMatch(/Song \(\.json\)/);

    (byId('export-kind-json') as HTMLButtonElement).click();
    expect(share.disabled).toBe(false);
    expect(share.title).toBe('Copy a shareable URL that opens this song');
  });

  it('renders no Copy Link without makeShareUrl and keeps the Project row gated', () => {
    openExportSongModal({ hasSamplerAudio: false, onExport: vi.fn() });
    expect(byId('song-share-link')).toBeNull();
    expect((byId('export-kind-project') as HTMLButtonElement).disabled).toBe(true);
  });
});
