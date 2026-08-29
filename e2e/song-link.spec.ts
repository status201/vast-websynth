import { test, expect, type Page } from '@playwright/test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { gotoAndStart, startAudio, busGet, busSet, sessionDisplay } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Node-side twin of encodeSongPayload: deflate-raw → base64url. */
const encodePayload = (json: string): string =>
  deflateRawSync(Buffer.from(json, 'utf8')).toString('base64url');

/** Node-side twin of decodeSongPayload for asserting clipboard links. */
const decodePayload = (payload: string): string =>
  payload.startsWith('j:')
    ? Buffer.from(payload.slice(2), 'base64url').toString('utf8')
    : inflateRawSync(Buffer.from(payload, 'base64url')).toString('utf8');

/** Boot the app on a #song= link and unlock audio. */
async function gotoLinkAndStart(page: Page, hash: string): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
      localStorage.setItem('websynth.perf', 'off');
    } catch { /* ignore */ }
  });
  await page.goto('/' + hash);
  await startAudio(page);
}

test.describe('song share links', () => {
  test('a #song= author-dialect payload loads at boot and clears the hash', async ({ page }) => {
    const payload = encodePayload(JSON.stringify({
      format: 'websynth-song-author',
      version: 1,
      name: 'Linked Author Song',
      params: { 'transport.bpm': 133, 'filter.resonance': 1.7 },
      seq: [['A2', null, 'A2', 'C3']],
      drums: [{ kick: [0, 4, 8, 12], snare: [4, 12] }],
      seqChain: 'AABA',
    }));
    await gotoLinkAndStart(page, `#song=${payload}`);

    await expect.poll(() => busGet(page, 'transport.bpm')).toBe(133);
    expect(await busGet(page, 'filter.resonance')).toBe(1.7);
    expect(await sessionDisplay(page)).toBe('Linked Author Song');
    // The dialect expanded: bank A step 0 carries A2 and the chain runs AABA.
    expect(await page.evaluate(() => (window as any).__synth.patterns.seqBanks[0][0][0].note)).toBe(45);
    expect(await page.evaluate(() => (window as any).__synth.engine.arrangement.seq.steps)).toEqual([0, 0, 1, 0]);
    // Success consumes the hash.
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
  });

  test('a #song= canonical payload loads too', async ({ page }) => {
    const seqCell = { on: false, note: 60, velocity: 0.85, gate: 0.5 };
    const canonical = {
      format: 'websynth-song',
      version: 3,
      name: 'Linked Canonical Song',
      params: { 'transport.bpm': 141 },
      seqBanks: Array.from({ length: 4 }, () => Array.from({ length: 16 }, () => ({ ...seqCell }))),
      drumBanks: Array.from({ length: 4 }, () =>
        Array.from({ length: 8 }, () => Array.from({ length: 16 }, () => ({ on: false })))),
      seqChain: { enabled: false, steps: [0] },
      drumChain: { enabled: false, steps: [0] },
    };
    await gotoLinkAndStart(page, `#song=${encodePayload(JSON.stringify(canonical))}`);

    await expect.poll(() => busGet(page, 'transport.bpm')).toBe(141);
    expect(await sessionDisplay(page)).toBe('Linked Canonical Song');
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
  });

  test('a bad payload shows the import dialog and leaves the hash intact', async ({ page }) => {
    // Valid base64url of INVALID song JSON → decodes fine, fails validation.
    const payload = 'j:' + Buffer.from('{"format":"nope"}', 'utf8').toString('base64url');
    await page.addInitScript(() => {
      try {
        localStorage.setItem('websynth.onboarding.done', '1');
        localStorage.setItem('websynth.perf', 'off');
      } catch { /* ignore */ }
    });
    await page.goto(`/#song=${payload}`);

    await expect(page.getByText('Import failed')).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe(`#song=${payload}`);
  });

  // untrusted-input.md REQ-7. Before this, a #songUrl= link made any visitor's
  // browser issue an attacker-chosen GET at page load, with no interaction.
  test('a #songUrl= link asks before it fetches, naming the origin', async ({ page }) => {
    let requested = 0;
    // Fail the test loudly if anything is requested before consent is given.
    await page.route('**/hosted-song.json', async (route) => {
      requested++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          format: 'websynth-song-author', version: 1, name: 'Hosted Song',
          params: { 'transport.bpm': 128 },
        }),
      });
    });
    await page.addInitScript(() => {
      try {
        localStorage.setItem('websynth.onboarding.done', '1');
        localStorage.setItem('websynth.perf', 'off');
      } catch { /* ignore */ }
    });

    // The prompt waits for the start gesture: raised at boot it would render
    // *under* the start modal, unreachable (main.ts).
    await gotoLinkAndStart(page, '#songUrl=https://songs.example.com/hosted-song.json');
    // The dialog names the ORIGIN — that is the whole point of the prompt.
    await expect(page.getByText('songs.example.com')).toBeVisible();
    expect(requested).toBe(0);

    await page.getByRole('button', { name: 'Download song' }).click();
    await expect.poll(() => busGet(page, 'transport.bpm')).toBe(128);
    expect(requested).toBe(1);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
  });

  test('declining a #songUrl= link fetches nothing and keeps the hash', async ({ page }) => {
    let requested = 0;
    await page.route('**/hosted-song.json', async (route) => {
      requested++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    const hash = '#songUrl=https://songs.example.com/hosted-song.json';
    await gotoLinkAndStart(page, hash);
    await page.getByRole('button', { name: 'Cancel' }).click();

    expect(requested).toBe(0);
    // The hash survives so the user can inspect or retry it (REQ-4).
    expect(await page.evaluate(() => window.location.hash)).toBe(hash);
  });

  test('Copy Link puts a decodable share URL on the clipboard', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await gotoAndStart(page);
    await busSet(page, 'transport.bpm', 97);

    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-export').click();
    const shareBtn = page.getByTestId('song-share-link');
    await shareBtn.click();
    await expect(shareBtn).toHaveText('Copied!');

    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url.startsWith(`${baseURL?.replace(/\/$/, '')}/#song=`)).toBe(true);
    const song = JSON.parse(decodePayload(url.split('#song=')[1]!)) as Record<string, unknown>;
    expect(song.format).toBe('websynth-song');
    expect((song.params as Record<string, number>)['transport.bpm']).toBe(97);
  });
});
