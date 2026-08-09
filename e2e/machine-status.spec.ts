import { test, expect } from '@playwright/test';
import { gotoAndStart, busSet } from './helpers';

// machine-status.md — the Song tab's clickable lane titles and the tab bar's
// machine status LEDs.

const led = (page: import('@playwright/test').Page, tab: string) =>
  page.locator(`[data-testid="tab-${tab}"] span[data-state]`);

test.describe('machine status', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndStart(page);
    await page.locator('[data-testid="tab-song"]').click();
    await expect(page.locator('[data-testid="panel-song"]')).toBeVisible();
  });

  test('a lane title opens that machine tab (REQ-5)', async ({ page }) => {
    // The lane prefix is `drum` but the tab id is `drums` — the mapping is the
    // thing under test here.
    await page.locator('[data-testid="song-lane-title-drum"]').click();
    await expect(page.locator('[data-testid="panel-drums"]')).toBeVisible();
    await expect(page.locator('[data-testid="panel-song"]')).toBeHidden();

    // And back again from another lane title.
    await page.locator('[data-testid="tab-song"]').click();
    await page.locator('[data-testid="song-lane-title-motion"]').click();
    await expect(page.locator('[data-testid="panel-motion"]')).toBeVisible();
  });

  test('every machine lane title navigates (REQ-5)', async ({ page }) => {
    for (const [prefix, tab] of [
      ['seq', 'seq'],
      ['drum', 'drums'],
      ['sampler', 'sampler'],
      ['motion', 'motion'],
    ]) {
      await page.locator('[data-testid="tab-song"]').click();
      await page.locator(`[data-testid="song-lane-title-${prefix}"]`).click();
      await expect(page.locator(`[data-testid="panel-${tab}"]`)).toBeVisible();
    }
  });

  test('the tab LED tracks enable and mute state (REQ-2/REQ-4)', async ({ page }) => {
    await busSet(page, 'drum.on', 1);
    await busSet(page, 'drum.mute', 0);
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'on');

    // Enabled but silenced by its own mute.
    await busSet(page, 'drum.mute', 1);
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'muted');

    // Disabled wins over the mixer state.
    await busSet(page, 'drum.on', 0);
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'off');
    // State is never colour-only.
    await expect(page.locator('[data-testid="tab-drums"]')).toHaveAttribute(
      'aria-label', 'Drum Machine — off',
    );
  });

  test('another lane soloing mutes the others but not motion (REQ-2)', async ({ page }) => {
    for (const m of ['seq', 'drum', 'sampler', 'motion']) {
      await busSet(page, `${m}.on`, 1);
      await busSet(page, `${m}.mute`, 0);
    }
    await busSet(page, 'seq.solo', 1);

    await expect(led(page, 'seq')).toHaveAttribute('data-state', 'on');
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'muted');
    await expect(led(page, 'sampler')).toHaveAttribute('data-state', 'muted');
    // Motion is not an audio lane — a solo elsewhere must not silence it.
    await expect(led(page, 'motion')).toHaveAttribute('data-state', 'on');
  });

  // --- v2: the lane controls live on both surfaces (REQ-9) ---
  test('every machine header carries Chain / Mute / Solo, motion without Solo', async ({ page }) => {
    for (const [tab, lane] of [['seq', 'seq'], ['drums', 'drum'], ['sampler', 'sampler']] as const) {
      await page.getByTestId(`tab-${tab}`).click();
      const header = page.getByTestId(`panel-${tab}`);
      await expect(header.getByTestId(`machine-${lane}-chain`)).toBeVisible();
      await expect(header.getByTestId(`machine-${lane}-mute`)).toBeVisible();
      await expect(header.getByTestId(`machine-${lane}-solo`)).toBeVisible();
    }

    await page.getByTestId('tab-motion').click();
    await expect(page.getByTestId('machine-motion-chain')).toBeVisible();
    await expect(page.getByTestId('machine-motion-mute')).toBeVisible();
    // Motion is not an audio lane, so there is nothing to solo — same as its
    // Song-tab card (motion-sequencer.md REQ-6/REQ-12).
    await expect(page.getByTestId('machine-motion-solo')).toHaveCount(0);
  });

  test('the header controls and the Song tab drive the same state', async ({ page }) => {
    await busSet(page, 'drum.on', 1);
    await page.getByTestId('tab-drums').click();

    // Mute from the machine header: the tab LED and the Song tab must both agree,
    // because every surface binds the same `drum.mute` param.
    await page.getByTestId('machine-drum-mute').click();
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'muted');
    await page.getByTestId('tab-song').click();
    await expect(page.getByTestId('switch-drum.mute')).toHaveClass(/\bon\b/);

    // Chain from the machine header: one shared toggle, so the Song tab's Chain
    // button lights too (it is a different element on the same Arrangement state).
    await page.getByTestId('tab-drums').click();
    await page.getByTestId('machine-drum-chain').click();
    await expect(page.getByTestId('machine-drum-chain')).toHaveClass(/\bon\b/);
    await page.getByTestId('tab-song').click();
    await expect(page.getByTestId('song-chain-drum')).toHaveClass(/\bon\b/);

    // And back the other way — the Song tab's button drives the header's.
    await page.getByTestId('song-chain-drum').click();
    await page.getByTestId('tab-drums').click();
    await expect(page.getByTestId('machine-drum-chain')).not.toHaveClass(/\bon\b/);
  });

  // --- v4: the Arpeggiator's lamp (REQ-10) ---
  test('the arp LED follows arp.on from another tab', async ({ page }) => {
    // Still on the Song tab from beforeEach — the whole point is that the lamp
    // answers "am I armed?" without opening the Arpeggiator.
    await expect(led(page, 'arp')).toHaveAttribute('data-state', 'off');

    await busSet(page, 'arp.on', 1);
    await expect(led(page, 'arp')).toHaveAttribute('data-state', 'on');
    await expect(page.getByTestId('tab-arp')).toHaveAttribute('aria-label', 'Arpeggiator — on');

    // The arp is not a lane: no mixer state can dim it to 'muted'.
    await busSet(page, 'seq.solo', 1);
    await busSet(page, 'drum.mute', 1);
    await expect(led(page, 'arp')).toHaveAttribute('data-state', 'on');

    await busSet(page, 'arp.on', 0);
    await expect(led(page, 'arp')).toHaveAttribute('data-state', 'off');
  });

  test("the arp panel's own switch drives the lamp", async ({ page }) => {
    await page.getByTestId('tab-arp').click();
    await page.getByTestId('switch-arp.on').click();
    await expect(led(page, 'arp')).toHaveAttribute('data-state', 'on');
  });

  test('Song is the only tab without a lamp', async ({ page }) => {
    for (const t of ['arp', 'seq', 'drums', 'sampler', 'motion']) {
      await expect(led(page, t)).toHaveCount(1);
    }
    await expect(led(page, 'song')).toHaveCount(0);
  });

  test('the LED is inert — clicking it navigates and changes no param (REQ-3)', async ({ page }) => {
    await busSet(page, 'drum.on', 1);
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'on');

    // pointer-events:none means the click lands on the tab, not the dot.
    await led(page, 'drums').click({ force: true });
    await expect(page.locator('[data-testid="panel-drums"]')).toBeVisible();
    await expect(led(page, 'drums')).toHaveAttribute('data-state', 'on');
  });
});
