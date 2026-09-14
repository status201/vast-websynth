import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resumeOfflineRedownload, watchOfflineRuns } from '../../src/ui/components/offline-notices';
import { buildOfflineSection } from '../../src/ui/components/about-offline';
import { showToast } from '../../src/ui/components/toast';
import {
  OFFLINE_REDOWNLOAD_KEY,
  offlineRedownloadPending,
  requestOfflineRedownload,
  takeOfflineRedownload,
} from '../../src/state/offline-redownload';
import type { OfflineState } from '../../src/utils/offline-copy';
import { installSessionStorageMock } from '../storage-mock';
import { StubOfflineCopy } from '../fixtures/offline-fakes';

/**
 * The offline-copy toasts and the re-download a factory reset asks for
 * (specs/features/play-offline.md REQ-8, REQ-12). The toast module is mocked so
 * a test can count raises, not just read the one toast the single-slot host
 * keeps.
 */

vi.mock('../../src/ui/components/toast', () => ({
  showToast: vi.fn(() => ({ el: document.createElement('div'), dismiss: () => {}, onDismiss: () => {} })),
}));

const messages = () => vi.mocked(showToast).mock.calls.map(([o]) => o.message);
const downloading: OfflineState = { kind: 'downloading', doneFiles: 1, totalFiles: 2, doneBytes: 1, totalBytes: 2 };
const complete: OfflineState = { kind: 'complete', files: 2, totalBytes: 2, persisted: true };

let session: Map<string, string>;

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(showToast).mockClear();
  session = installSessionStorageMock();
});

describe('the re-download intent (factory-reset.md REQ-8)', () => {
  it('is requested, read without being consumed, then taken once', () => {
    expect(offlineRedownloadPending()).toBe(false);
    requestOfflineRedownload();
    expect(session.get(OFFLINE_REDOWNLOAD_KEY)).toBe('1');
    expect(offlineRedownloadPending()).toBe(true);
    expect(offlineRedownloadPending()).toBe(true);
    expect(takeOfflineRedownload()).toBe(true);
    expect(takeOfflineRedownload()).toBe(false);
  });

  it('reads as absent when storage is blocked', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(() => requestOfflineRedownload()).not.toThrow();
    expect(offlineRedownloadPending()).toBe(false);
    expect(takeOfflineRedownload()).toBe(false);
  });
});

describe('resumeOfflineRedownload (REQ-12)', () => {
  it('consumes the intent before starting, says so, and reports the end', () => {
    requestOfflineRedownload();
    const copy = new StubOfflineCopy();
    copy.start.mockImplementation(async () => {
      // Consumed first: a reload from here on must not start it again.
      expect(session.has(OFFLINE_REDOWNLOAD_KEY)).toBe(false);
    });

    expect(resumeOfflineRedownload(copy.asCopy, vi.fn())).toBe(true);
    expect(copy.start).toHaveBeenCalledTimes(1);
    expect(messages()).toEqual(['Downloading the offline copy again…']);

    copy.emit(downloading);
    copy.emit(complete);
    expect(messages()).toEqual(['Downloading the offline copy again…', 'Ready to play offline.']);
  });

  it('does nothing without an intent', () => {
    const copy = new StubOfflineCopy();
    expect(resumeOfflineRedownload(copy.asCopy, vi.fn())).toBe(false);
    expect(copy.start).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('watchOfflineRuns (REQ-8)', () => {
  it('announces one run once, with the resumed watcher and a hidden About section on one copy', () => {
    const copy = new StubOfflineCopy();
    requestOfflineRedownload();
    resumeOfflineRedownload(copy.asCopy, vi.fn());

    const card = document.createElement('div');
    card.className = 'hidden';
    card.appendChild(buildOfflineSection(copy.asCopy, vi.fn()).root);
    document.body.appendChild(card);

    copy.emit(downloading);
    copy.emit(complete);
    expect(messages().filter((m) => m === 'Ready to play offline.')).toHaveLength(1);
  });

  it('stands down while the inline view is showing', () => {
    const copy = new StubOfflineCopy();
    watchOfflineRuns(copy.asCopy, vi.fn()).setInlineView(() => true);
    copy.emit(downloading);
    copy.emit(complete);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('is the same watcher on every call for one copy', () => {
    const copy = new StubOfflineCopy().asCopy;
    expect(watchOfflineRuns(copy, vi.fn())).toBe(watchOfflineRuns(copy, vi.fn()));
  });
});
