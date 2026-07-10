import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * WebRTC WiFi sync — real two-page loopback (webrtc-sync.md). Two pages in one
 * headless-Chromium context establish a DataChannel with empty iceServers
 * (host candidates, mDNS obfuscation disabled in playwright.config.ts). One is
 * Master, the other Slave; transport start/stop + tempo cross the link.
 *
 * Blobs are exchanged through the dev-only `window.__synth.engine.rtcSync`
 * bridge — the modal's copy-paste/QR is what a human does; the wire is the same.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const rtc = (p: Page, method: string, arg?: unknown) =>
  p.evaluate(([m, a]) => (window as any).__synth.engine.rtcSync[m as string](a), [method, arg] as const);
const clockPlaying = (p: Page) => p.evaluate(() => (window as any).__synth.engine.clock.playing as boolean);
const followedBpm = (p: Page) => p.evaluate(() => ((window as any).__synth.engine.sync.status.followedBpm ?? 0) as number);

test('two pages pair over WiFi and follow the master transport', async ({ page, context }) => {
  const pageB = await context.newPage();
  await gotoAndStart(page);
  await gotoAndStart(pageB);

  // Roles via the Song-tab UI: A master, B slave.
  for (const p of [page, pageB]) await p.getByRole('button', { name: 'Song', exact: true }).click();
  await page.getByTestId('sync-mode-master').click();
  await pageB.getByTestId('sync-mode-slave').click();

  // Serverless handshake: A offer → B answer → A completes.
  const offer = (await rtc(page, 'createLink')) as string;
  const answer = (await rtc(pageB, 'acceptOffer', offer)) as string;
  await rtc(page, 'acceptAnswer', answer);

  // Both status lines report the link.
  await expect(page.getByTestId('sync-status')).toHaveText(/WiFi: linked/);
  await expect(pageB.getByTestId('sync-status')).toHaveText(/WiFi: linked/);

  // Play on A starts B.
  await page.getByTestId('transport-play').click();
  await expect.poll(() => clockPlaying(pageB)).toBe(true);

  // A tempo change on A is followed by B (pulse estimate + explicit tempo).
  await page.evaluate(() => (window as any).__synth.bus.set('transport.bpm', 140));
  await expect.poll(() => followedBpm(pageB), { timeout: 10_000 }).toBeGreaterThan(139);

  // Stop on A stops B.
  await page.getByTestId('transport-play').click();
  await expect.poll(() => clockPlaying(pageB)).toBe(false);
});
