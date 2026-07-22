import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gotoAndStart, busGet, busSet, sessionDisplay } from './helpers';

/**
 * Preset dropdown applies a snapshot to the ParamBus, and Save persists a new
 * preset to localStorage + the dropdown. Boot applies the "basic" factory
 * preset (env.amp.attack = 0.005); "pad" is dramatically different (1.5).
 */
test.describe('presets', () => {
  test('selecting a preset applies its parameters', async ({ page }) => {
    await gotoAndStart(page);
    expect(await busGet(page, 'env.amp.attack')).toBeCloseTo(0.005, 3);

    const select = page.getByTestId('preset-select');
    await select.click(); // open the popover
    await select.getByText('pad', { exact: true }).click();

    await expect.poll(() => busGet(page, 'env.amp.attack')).toBeGreaterThan(1);
  });

  test('saving a preset persists to localStorage and the dropdown', async ({ page }) => {
    await gotoAndStart(page);
    // The header button opens the manager; Save names the preset via the custom
    // prompt dialog (no native prompt) — presets.md REQ-9.
    await page.getByTestId('preset-save').click();
    await page.getByTestId('preset-mgr-save').click();
    await page.getByTestId('dialog-input').fill('e2e-preset');
    await page.getByTestId('dialog-confirm').click();

    const stored = await page.evaluate(() => localStorage.getItem('websynth.preset.e2e-preset'));
    expect(stored).not.toBeNull();
    await expect(page.getByTestId('preset-select')).toContainText('e2e-preset');
  });

  test('selector reflects edits (dirty marker) and resets on selection', async ({ page }) => {
    await gotoAndStart(page);
    const select = page.getByTestId('preset-select');
    // The dev bridge exposes the session; assert its exact display string
    // (the dropdown toggle also renders a caret, so DOM text isn't exact).
    const display = () => sessionDisplay(page);
    expect(await display()).toBe('basic');

    // A synth-patch edit flips the selector to the dirty marker.
    await busSet(page, 'filter.cutoff', 60);
    await expect.poll(display).toBe('basic *');
    await expect(select).toContainText('basic *');

    // A song-level edit (BPM) does NOT, by itself, change the dirty state.
    await busSet(page, 'transport.bpm', 200);
    expect(await display()).toBe('basic *');

    // Selecting a preset clears the dirty marker.
    await select.click();
    await select.getByText('pad', { exact: true }).click();
    await expect.poll(display).toBe('pad');
  });
});

/**
 * Preset / bank files — specs/features/presets.md REQ-7..REQ-12. Exercises the
 * real download + file-picker path; the import wizard's arithmetic itself is
 * unit-tested in tests/state/preset-file.test.ts.
 */
test.describe('preset files', () => {
  test('exporting a preset downloads a tagged .preset.websynth.json of the live sound', async ({ page }) => {
    await gotoAndStart(page);
    await busSet(page, 'filter.cutoff', 42);

    await page.getByTestId('preset-save').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('preset-mgr-export-preset').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.preset\.websynth\.json$/);

    const path = await download.path();
    const parsed = JSON.parse(await readFile(path!, 'utf8'));
    expect(parsed.format).toBe('websynth-preset');
    expect(parsed.params['filter.cutoff']).toBe(42);
  });

  test('the bank export scope counts only what the user made', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('preset-save').click();
    // Nothing saved yet: "Mine" is empty, so the bank row cannot be exported.
    await expect(page.getByTestId('preset-mgr-export-bank')).toBeDisabled();
    await page.getByTestId('preset-mgr-bank-scope-all').click();
    await expect(page.getByTestId('preset-mgr-export-bank')).toBeEnabled();
    await page.getByTestId('preset-mgr-close').click();
    await expect(page.getByTestId('preset-manager')).not.toBeAttached();

    await page.getByTestId('preset-save').click();
    await page.getByTestId('preset-mgr-save').click();
    await page.getByTestId('dialog-input').fill('mine-1');
    await page.getByTestId('dialog-confirm').click();

    // The manager stays open after a save and refreshes in place, so the newly
    // saved sound is immediately exportable without reopening it.
    await expect(page.getByTestId('preset-mgr-export-bank')).toBeEnabled();
    await expect(page.getByTestId('preset-manager')).toContainText('1 preset: mine-1');
  });

  test('importing a bank reviews first, renames clashes, and leaves the live sound alone', async ({ page }) => {
    await gotoAndStart(page);
    const before = await busGet(page, 'filter.cutoff');

    // A bank with one brand-new preset and one clashing with the factory "lead".
    const bank = JSON.stringify({
      format: 'websynth-preset-bank',
      version: 1,
      name: 'e2e',
      presets: {
        'e2e-new': { 'filter.cutoff': 55 },
        lead: { 'filter.cutoff': 21 },
      },
    });

    await page.getByTestId('preset-save').click();
    await page.getByTestId('preset-mgr-file').setInputFiles({
      name: 'e2e.bank.websynth.json',
      mimeType: 'application/json',
      buffer: Buffer.from(bank),
    });

    // Step 2: review — nothing is written yet.
    await expect(page.getByTestId('preset-import-review')).toBeVisible();
    await expect(page.getByTestId('preset-import-row-e2e-new')).toContainText('new');
    await expect(page.getByTestId('preset-import-row-lead')).toContainText('conflict');
    await expect(page.getByTestId('preset-import-row-lead')).toContainText('lead 2');
    expect(await page.evaluate(() => localStorage.getItem('websynth.preset.e2e-new'))).toBeNull();

    await page.getByTestId('preset-import-confirm').click();

    expect(await page.evaluate(() => localStorage.getItem('websynth.preset.e2e-new'))).not.toBeNull();
    // The rename kept the factory "lead" untouched (REQ-10).
    const lead = await page.evaluate(() => localStorage.getItem('websynth.preset.lead'));
    expect(JSON.parse(lead!)['filter.cutoff']).not.toBe(21);
    const renamed = await page.evaluate(() => localStorage.getItem('websynth.preset.lead 2'));
    expect(JSON.parse(renamed!)['filter.cutoff']).toBe(21);
    // The live patch is untouched (REQ-12).
    expect(await busGet(page, 'filter.cutoff')).toBe(before);
    await expect(page.getByTestId('preset-select')).toContainText('basic');
  });

  test('a preset file dropped on the song importer points at the right door', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-import-file').setInputFiles({
      name: 'oops.preset.websynth.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        format: 'websynth-preset', version: 1, name: 'oops', params: { 'filter.cutoff': 60 },
      })),
    });
    await expect(page.getByText('That is a preset file')).toBeVisible();
    await expect(page.getByText(/Preset button/)).toBeVisible();
  });
});
