import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, startAudio, makeWavBuffer } from './helpers';

/*
 * sample-persistence.md v3 — sampler clips belong to a session, in a real
 * IndexedDB (jsdom has none, so the key ranges and the v1 → v2 upgrade can only
 * be pinned here).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Seconds of audio in a slot — decodeAudioData resamples, so compare durations, not lengths. */
const slotSeconds = (page: Page, slot: number): Promise<number | null> =>
  page.evaluate((s) => (window as any).__synth.engine.sampler.buffers[s]?.duration ?? null, slot);

/** This tab's session key, as session-autosave.ts names it. */
const ownSession = (page: Page): Promise<string> =>
  page.evaluate(() => `websynth.session.${sessionStorage.getItem('websynth.session.tab')}`);

/** Every [session, slot] key in the clip store, read through a second connection. */
const clipKeys = (page: Page): Promise<[string, number][]> =>
  page.evaluate(() => new Promise<[string, number][]>((resolve, reject) => {
    const r = indexedDB.open('websynth');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('sessionClips')) { db.close(); resolve([]); return; }
      const all = db.transaction('sessionClips').objectStore('sessionClips').getAllKeys();
      all.onsuccess = () => { db.close(); resolve(all.result as unknown as [string, number][]); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  }));

/** Fill slot 0 and wait until both the session and its clip are stored. */
async function loadAndPersist(page: Page, name: string, seconds: number): Promise<string> {
  await page.getByTestId('tab-sampler').click();
  await page.getByTestId('sampler-file-0').setInputFiles({
    name, mimeType: 'audio/wav', buffer: makeWavBuffer(seconds),
  });
  await expect(page.getByTestId('sampler-name-0')).toHaveText(name);
  const session = await ownSession(page);
  // The session (1.5 s) carries the name; its clip is written once the session exists.
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k) !== null, session), { timeout: 5000 }).toBe(true);
  await expect.poll(async () => (await clipKeys(page)).some(([s, slot]) => s === session && slot === 0), { timeout: 5000 })
    .toBe(true);
  return session;
}

test.describe('sampler clips per session', () => {
  // REQ-clips-belong-to-a-session (regression): the last tab to write used to own every slot.
  test('two tabs keep their own audio across a reload', async ({ page, context }) => {
    await gotoAndStart(page);
    const sessionA = await loadAndPersist(page, 'a.wav', 0.1);

    // A second tab: same storage, its own sessionStorage, so its own session.
    const other = await context.newPage();
    await gotoAndStart(other);
    const sessionB = await loadAndPersist(other, 'b.wav', 0.3);
    expect(sessionB).not.toBe(sessionA);

    await page.reload();
    await startAudio(page);
    await page.getByTestId('tab-sampler').click();
    await expect(page.getByTestId('sampler-name-0')).toHaveText('a.wav');
    await expect.poll(() => slotSeconds(page, 0)).toBeCloseTo(0.1, 2);
    // …and B's audio is still stored for B.
    expect((await clipKeys(page)).some(([s, slot]) => s === sessionB && slot === 0)).toBe(true);
  });

  // REQ-legacy-clips-are-adopted-once: a database from before v3 is upgraded and its clip adopted.
  test('a clip saved before v3 is adopted by the restored session', async ({ page }) => {
    await gotoAndStart(page);
    const session = await loadAndPersist(page, 'beep.wav', 0.1);

    // Put the database back as a v1 install would have left it: store `clips`,
    // one record per slot, holding a clip of a different length.
    const legacy = [...makeWavBuffer(0.25)];
    await page.evaluate((bytes) => new Promise<void>((resolve, reject) => {
      const del = indexedDB.deleteDatabase('websynth'); // the app's connection steps aside on versionchange
      del.onerror = () => reject(del.error);
      del.onsuccess = () => {
        const r = indexedDB.open('websynth', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('clips', { keyPath: 'slot' }); };
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction('clips', 'readwrite');
          tx.objectStore('clips').put({ slot: 0, data: new Uint8Array(bytes) });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      };
    }), legacy);

    await page.reload();
    await startAudio(page);
    await page.getByTestId('tab-sampler').click();
    await expect(page.getByTestId('sampler-name-0')).not.toHaveClass(/needs-reload/);
    await expect.poll(() => slotSeconds(page, 0)).toBeCloseTo(0.25, 2);

    // Stored under this tab's session now, and the legacy record is gone.
    await expect.poll(async () => {
      const keys = await clipKeys(page);
      return keys.some(([s, slot]) => s === session && slot === 0) && !keys.some(([s]) => s === 'legacy');
    }, { timeout: 5000 }).toBe(true);
    const stores = await page.evaluate(() => new Promise<string[]>((resolve) => {
      const r = indexedDB.open('websynth');
      r.onsuccess = () => { const names = [...r.result.objectStoreNames]; r.result.close(); resolve(names); };
    }));
    expect(stores).toEqual(['sessionClips']);
  });
});
