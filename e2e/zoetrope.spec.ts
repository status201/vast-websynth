import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, busGet, busSet, dragKnobUp } from './helpers';

/**
 * The Zoetrope module at the bottom of the FX rack. As with the compressors,
 * the audible result isn't asserted (no deterministic program material under
 * headless Chromium) — state is verified through the ParamBus and the dev-only
 * `window.__synth` bridge, per house style.
 */

const ROOT = 'fxgroup-fx.zoetrope';

/** The FX rack auto-collapses on narrow viewports; make sure it is open. */
async function openFxRack(page: Page): Promise<void> {
  const section = page.getByTestId('fx');
  if (await section.evaluate((el) => el.classList.contains('collapsed'))) {
    await page.getByText('FX', { exact: true }).first().click();
  }
  await expect(page.getByTestId(ROOT)).toBeVisible();
}

test.describe('zoetrope', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAndStart(page);
    await openFxRack(page);
  });

  test('boots bypassed, showing only its header', async ({ page }) => {
    expect(await busGet(page, 'fx.zoetrope.on')).toBe(0);
    await expect(page.getByTestId('switch-fx.zoetrope.on')).toBeVisible();
    // The body is in the DOM but collapsed while bypassed.
    await expect(page.getByTestId('knob-fx.zoetrope.scatter')).toBeAttached();
    await expect(page.getByTestId('knob-fx.zoetrope.scatter')).toBeHidden();
    await expect(page.getByTestId('zoetrope-strip')).toBeHidden();
  });

  test('engaging it reveals the controls and the cycle library', async ({ page }) => {
    await page.getByTestId('switch-fx.zoetrope.on').click();
    expect(await busGet(page, 'fx.zoetrope.on')).toBe(1);

    for (const k of ['scatter', 'chaos', 'smear', 'sieve', 'mix']) {
      await expect(page.getByTestId(`knob-fx.zoetrope.${k}`)).toBeVisible();
    }
    await expect(page.getByTestId('stepper-fx.zoetrope.depth')).toBeVisible();
    await expect(page.getByTestId('seg-fx.zoetrope.source')).toBeVisible();
    await expect(page.getByTestId('zoetrope-freeze')).toBeVisible();
    await expect(page.getByTestId('zoetrope-strip')).toBeVisible();
  });

  test('its knobs drive the bus params', async ({ page }) => {
    await page.getByTestId('switch-fx.zoetrope.on').click();

    expect(await busGet(page, 'fx.zoetrope.scatter')).toBe(0);
    await dragKnobUp(page, 'knob-fx.zoetrope.scatter');
    expect(await busGet(page, 'fx.zoetrope.scatter')).toBeGreaterThan(0);

    // Sieve is bipolar and starts dead centre.
    expect(await busGet(page, 'fx.zoetrope.sieve')).toBe(0);
    await dragKnobUp(page, 'knob-fx.zoetrope.sieve');
    expect(await busGet(page, 'fx.zoetrope.sieve')).toBeGreaterThan(0);
  });

  test('the depth readout drags through whole cycle counts', async ({ page }) => {
    await page.getByTestId('switch-fx.zoetrope.on').click();
    const stepper = page.getByTestId('stepper-fx.zoetrope.depth');
    await stepper.scrollIntoViewIfNeeded();
    const box = (await stepper.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 60, { steps: 6 });
    await page.mouse.up();

    const depth = await busGet(page, 'fx.zoetrope.depth');
    expect(depth).toBeGreaterThan(12);
    expect(Number.isInteger(depth)).toBe(true);
  });

  test('Freeze latches on a click and is momentary when held', async ({ page }) => {
    await page.getByTestId('switch-fx.zoetrope.on').click();
    const freeze = page.getByTestId('zoetrope-freeze');
    await freeze.scrollIntoViewIfNeeded();
    const box = (await freeze.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // A click latches it on, and it stays on.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.up();
    expect(await busGet(page, 'fx.zoetrope.freeze')).toBe(1);

    // Clicking again releases the latch.
    await page.mouse.down();
    await page.mouse.up();
    expect(await busGet(page, 'fx.zoetrope.freeze')).toBe(0);

    // Held past the threshold, it releases on pointerup instead.
    await page.mouse.down();
    expect(await busGet(page, 'fx.zoetrope.freeze')).toBe(1);
    await page.waitForTimeout(400);
    await page.mouse.up();
    expect(await busGet(page, 'fx.zoetrope.freeze')).toBe(0);
  });

  test('the source toggle switches between the synth and the drum bus', async ({ page }) => {
    await page.getByTestId('switch-fx.zoetrope.on').click();
    expect(await busGet(page, 'fx.zoetrope.source')).toBe(0);
    await page.getByTestId('seg-fx.zoetrope.source-1').click();
    expect(await busGet(page, 'fx.zoetrope.source')).toBe(1);
  });

  test('pitch lock is on by default and can be dropped', async ({ page }) => {
    expect(await busGet(page, 'fx.zoetrope.pitchlock')).toBe(1);
    await page.getByTestId('switch-fx.zoetrope.pitchlock').click();
    expect(await busGet(page, 'fx.zoetrope.pitchlock')).toBe(0);
  });

  test('the advanced expander stays shut until opened', async ({ page }) => {
    await page.getByTestId('switch-fx.zoetrope.on').click();
    await expect(page.getByTestId('stepper-fx.zoetrope.taps')).toBeHidden();
    await page.getByTestId('zoetrope-adv-toggle').click();
    await expect(page.getByTestId('stepper-fx.zoetrope.taps')).toBeVisible();
    await expect(page.getByTestId('stepper-fx.zoetrope.xfadeFloor')).toBeVisible();
    await expect(page.getByTestId('switch-fx.zoetrope.clearOnNote')).toBeVisible();
  });

  test('its help badge is reachable while bypassed', async ({ page }) => {
    // Badges are position: fixed and reflow on scroll, so scroll the ANCHOR and
    // the badge follows (see compressor.spec.ts).
    await page.getByTestId(ROOT).scrollIntoViewIfNeeded();
    await page.getByTestId('help-button').click();
    await page.getByTestId('help-toggle-badges').click();
    const badge = page.getByTestId('help-badge-fx.zoetrope');
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(page.getByRole('dialog', { name: 'Zoetrope' })).toBeVisible();
  });

  test('the cycle library reports the tracked pitch while a note sounds', async ({ page }) => {
    await busSet(page, 'fx.zoetrope.on', 1);
    // Hold a note (the same bus entry point every input source uses,
    // input-control.md REQ-1) so the worklet has cycles to store and a pitch to
    // lock to. Never released — the telemetry has to arrive while it sounds.
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    await page.evaluate(() => (window as any).__synth.bus.noteOn(57, 0.9));
    await expect(page.getByTestId('zoetrope-hz')).toHaveText(/tracking \d+ hz/, { timeout: 5000 });
    await expect(page.getByTestId('zoetrope-reading')).toHaveText(/reading -\d+/);
  });
});
