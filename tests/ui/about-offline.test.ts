import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildOfflineSection } from '../../src/ui/components/about-offline';
import type { OfflineState } from '../../src/utils/offline-copy';
import { StubOfflineCopy } from '../fixtures/offline-fakes';
import styles from '../../src/ui/styles/about-offline.module.css';

/**
 * The About card's Play offline section (specs/features/play-offline.md REQ-1,
 * REQ-3, REQ-8), rendered against a stub state machine — the real one is pinned
 * by tests/utils/offline-copy.test.ts.
 */

const byId = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.querySelector(`[data-testid="${id}"]`) as T;

/** Mount the section inside a stand-in card; `hidden` mimics a closed About. */
function mount(opts: { hidden?: boolean } = {}) {
  const copy = new StubOfflineCopy();
  const reload = vi.fn();
  const section = buildOfflineSection(copy.asCopy, reload);
  const card = document.createElement('div');
  if (opts.hidden) card.className = 'hidden';
  card.appendChild(section.root);
  document.body.appendChild(card);
  return { copy, reload, section, card };
}

const button = () => byId<HTMLButtonElement>('play-offline-button');
const status = () => byId('play-offline-status');
const bar = () => byId('play-offline-progress');

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('rendering each state (REQ-3)', () => {
  it('holds a disabled button while checking, with no bar', () => {
    mount();
    expect(button().textContent).toBe('Play offline');
    expect(button().disabled).toBe(true);
    expect(status().textContent).toBe('Checking this device…');
    expect(bar().hidden).toBe(true);
  });

  it('pitches the download with the remaining size', () => {
    const { copy } = mount();
    copy.emit({ kind: 'none', totalBytes: 7_138_386, remainingBytes: 5_200_000 });
    expect(button().textContent).toBe('Play offline');
    expect(button().disabled).toBe(false);
    expect(button().querySelector('svg.ui-icon')).not.toBeNull();
    expect(status().textContent).toBe(
      'Saves everything on this device — demos, dialogs and help — so it plays with no connection · 5.2 MB',
    );

    copy.emit({ kind: 'none', totalBytes: null, remainingBytes: null });
    expect(status().textContent).toMatch(/so it plays with no connection\.$/);
  });

  it('shows Preparing with a striped bar before the list is known', () => {
    const { copy } = mount();
    copy.emit({ kind: 'downloading', doneFiles: 0, totalFiles: 0, doneBytes: 0, totalBytes: 0 });
    expect(button().textContent).toBe('Cancel');
    expect(status().textContent).toBe('Preparing…');
    expect(bar().hidden).toBe(false);
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
  });

  it('counts files and megabytes while downloading, with a determinate bar', () => {
    const { copy } = mount();
    copy.emit({ kind: 'downloading', doneFiles: 23, totalFiles: 61, doneBytes: 3_100_000, totalBytes: 7_100_000 });
    expect(button().textContent).toBe('Cancel');
    expect(status().textContent).toBe('Downloading 23 of 61 files · 3.1 / 7.1 MB');
    expect(bar().hidden).toBe(false);
    expect(bar().getAttribute('aria-valuenow')).toBe('44');
  });

  it('confirms a complete copy, and warns when storage is not persisted', () => {
    const { copy } = mount();
    copy.emit({ kind: 'complete', files: 61, totalBytes: 7_100_000, persisted: true });
    expect(button().textContent).toBe('Ready to play offline');
    expect(status().textContent).toBe('All 61 files (7.1 MB) are on this device. New versions update it automatically.');
    expect(status().classList.contains(styles.ok!)).toBe(true);
    expect(bar().hidden).toBe(true);

    copy.emit({ kind: 'complete', files: 61, totalBytes: 7_100_000, persisted: false });
    expect(status().textContent).toMatch(/The browser may clear it if storage runs low\.$/);
  });

  it('words each failure and offers Try again', () => {
    const { copy } = mount();
    copy.emit({ kind: 'error', reason: 'files', failed: 3 });
    expect(button().textContent).toBe('Try again');
    expect(status().textContent).toBe("Couldn't download 3 files — check your connection. The rest is saved.");
    expect(status().classList.contains(styles.bad!)).toBe(true);

    copy.emit({ kind: 'error', reason: 'files', failed: 1 });
    expect(status().textContent).toMatch(/^Couldn't download 1 file —/);
    copy.emit({ kind: 'error', reason: 'offline', failed: 0 });
    expect(status().textContent).toBe("Couldn't reach the server — check your connection and try again.");
    copy.emit({ kind: 'error', reason: 'storage', failed: 0 });
    expect(status().textContent).toBe('Not enough free storage on this device.');
    copy.emit({ kind: 'error', reason: 'worker', failed: 0 });
    expect(status().textContent).toBe("The offline helper didn't start — reload the page and try again.");
  });

  it('asks for a reload, and explains itself when unsupported', () => {
    const { copy } = mount();
    copy.emit({ kind: 'needs-reload' });
    expect(button().textContent).toBe('Reload');
    expect(status().textContent).toBe('A new version was installed — reload first.');

    copy.emit({ kind: 'unsupported', reason: 'dev' });
    expect(button().disabled).toBe(true);
    expect(status().textContent).toBe('Offline play comes with the published app, not the dev server.');
    copy.emit({ kind: 'unsupported', reason: 'browser' });
    expect(status().textContent).toBe("This browser can't keep an offline copy (a private window can't).");
  });

  it('on the dev server, the real instance reports itself unsupported', async () => {
    const section = buildOfflineSection();
    document.body.appendChild(section.root);
    section.refresh();
    await vi.waitFor(() => expect(status().textContent).toMatch(/not the dev server/));
    expect(button().disabled).toBe(true);
  });
});

describe('the button acts on the state (gesture inventory)', () => {
  it('starts from none, error and complete; cancels mid-download; reloads when asked', () => {
    const { copy, reload } = mount();
    for (const s of [
      { kind: 'none', totalBytes: 1, remainingBytes: 1 },
      { kind: 'error', reason: 'files', failed: 1 },
      { kind: 'complete', files: 1, totalBytes: 1, persisted: true },
    ] as OfflineState[]) {
      copy.emit(s);
      button().click();
    }
    expect(copy.start).toHaveBeenCalledTimes(3);

    copy.emit({ kind: 'downloading', doneFiles: 1, totalFiles: 2, doneBytes: 1, totalBytes: 2 });
    button().click();
    expect(copy.cancel).toHaveBeenCalledTimes(1);

    copy.emit({ kind: 'needs-reload' });
    button().click();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(copy.start).toHaveBeenCalledTimes(3);
  });

  it('refresh() re-reads the device', () => {
    const { copy, section } = mount();
    section.refresh();
    expect(copy.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('a run that ends behind a closed About (REQ-8)', () => {
  const downloading: OfflineState = { kind: 'downloading', doneFiles: 1, totalFiles: 2, doneBytes: 1, totalBytes: 2 };

  it('says it is ready', () => {
    const { copy } = mount({ hidden: true });
    copy.emit(downloading);
    copy.emit({ kind: 'complete', files: 2, totalBytes: 2, persisted: true });
    expect(byId('play-offline-toast').textContent).toContain('Ready to play offline.');
  });

  it('reports a failure with a Retry that restarts the run', () => {
    const { copy } = mount({ hidden: true });
    copy.emit(downloading);
    copy.emit({ kind: 'error', reason: 'files', failed: 2 });
    const toast = byId('play-offline-toast');
    expect(toast.textContent).toContain("Offline download stopped — 2 files couldn't be downloaded.");
    (toast.querySelector('[data-testid="toast-action"]') as HTMLButtonElement).click();
    expect(copy.start).toHaveBeenCalledTimes(1);
  });

  it('offers a Reload when a new version took over', () => {
    const { copy, reload } = mount({ hidden: true });
    copy.emit(downloading);
    copy.emit({ kind: 'needs-reload' });
    (byId('play-offline-toast').querySelector('[data-testid="toast-action"]') as HTMLButtonElement).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('raises nothing while the card is open, or for a cancel', () => {
    const open = mount();
    open.copy.emit(downloading);
    open.copy.emit({ kind: 'complete', files: 2, totalBytes: 2, persisted: true });
    expect(byId('play-offline-toast')).toBeNull();

    document.body.innerHTML = '';
    const closed = mount({ hidden: true });
    closed.copy.emit(downloading);
    closed.copy.emit({ kind: 'none', totalBytes: 2, remainingBytes: 1 });
    expect(byId('play-offline-toast')).toBeNull();
  });
});
