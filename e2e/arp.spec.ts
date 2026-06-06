import { test, expect } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * Arpeggiator transport ownership. With the arp engaged, holding a key should
 * auto-start the transport (so you hear the arpeggio without pressing Play) and
 * releasing the last key should stop it — but only when the arp itself started
 * it. Notes are injected through the dev `__synth.bus` bridge; the arp tab is
 * the default tab so its enable switch is already visible after boot.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const playing = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__synth.engine.clock.playing as boolean);
const noteOn = (page: import('@playwright/test').Page, n: number) =>
  page.evaluate((note) => (window as any).__synth.bus.noteOn(note), n);
const noteOff = (page: import('@playwright/test').Page, n: number) =>
  page.evaluate((note) => (window as any).__synth.bus.noteOff(note), n);

test.describe('arpeggiator', () => {
  test('a held key auto-starts the transport and release stops it', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('switch-arp.on').click();

    expect(await playing(page)).toBe(false);
    await noteOn(page, 60);
    expect(await playing(page)).toBe(true);
    await noteOff(page, 60);
    expect(await playing(page)).toBe(false);
  });

  test('does not stop a transport the user started with Play', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('switch-arp.on').click();
    await page.getByTestId('transport-play').click(); // user owns the transport
    expect(await playing(page)).toBe(true);

    await noteOn(page, 60);
    await noteOff(page, 60);
    expect(await playing(page)).toBe(true); // arp didn't take ownership
  });

  test('does not start the transport while the arp is disabled', async ({ page }) => {
    await gotoAndStart(page);
    // arp left off
    await noteOn(page, 60);
    expect(await playing(page)).toBe(false);
    await noteOff(page, 60);
  });
});
