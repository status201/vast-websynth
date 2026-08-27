import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, makeWavBuffer } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const slotLoaded = (page: Page, slot: number): Promise<boolean> =>
  page.evaluate((s) => (window as any).__synth.engine.sampler.buffers[s] != null, slot);

/**
 * Loading a WAV via the hidden file input decodes it (decodeAudioData), fills
 * the slot's AudioBuffer, updates the filename label, and reveals the ✎ edit
 * button (hidden until a buffer is present).
 */
test.describe('sampler', () => {
  test('loading a WAV file fills the slot', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await expect(page.getByTestId('sampler-edit-0')).toBeHidden();

    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'beep.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });

    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');
    await expect(page.getByTestId('sampler-edit-0')).toBeVisible();

    expect(await slotLoaded(page, 0)).toBe(true);
  });

  /**
   * sample-persistence.md — the clip itself (not just its name) is persisted in
   * IndexedDB, so a reload brings the audio back with no `.needs-reload` hint
   * and nothing to re-pick from disk.
   */
  test('a loaded clip survives a reload', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'beep.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });
    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');

    // The session autosave (1.5 s) carries the NAME; the clip store (0.8 s)
    // carries the audio. Both must have landed before the reload.
    await expect
      .poll(
        () =>
          // Per-tab key since v8 (session-autosave.md REQ-12) — scan, don't name.
          page.evaluate(
            () => Object.keys(localStorage).find((k) => k.startsWith('websynth.session.')) ?? null,
          ),
        { timeout: 5000 },
      )
      .not.toBeNull();

    // Same context ⇒ localStorage and IndexedDB both survive.
    await page.reload();
    await page.getByRole('button', { name: 'Tap to start' }).click();
    await page.getByTestId('tab-sampler').click();

    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');
    await expect(page.getByTestId('sampler-name-0')).not.toHaveClass(/needs-reload/);
    await expect(page.getByTestId('sampler-edit-0')).toBeVisible();
    expect(await slotLoaded(page, 0)).toBe(true);
    // …and the user is told the audio came from storage, not the song file.
    await expect(page.getByTestId('clips-restored-toast')).toContainText('1 sampler clip');
  });

  /**
   * sampler.md REQ-9 — the Clear ▾ row item is labelled with the FILENAME, so it
   * removes the file. Before v5 it cleared steps only, which left no gesture at
   * all that could empty a slot: the name stayed on screen and kept riding along
   * in every saved song. This drives the real panel, so it also pins that
   * `sampler-panel.ts` wires the eject row rather than the old step-only one.
   */
  test('Clear ▾ on a named slot ejects the sample, and Undo brings it back', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'beep.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });
    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');

    // Slot 0 is the selected row on open, so the item is this slot's.
    await page.getByTestId('clear-sampler').click();
    const row = page.getByTestId('clear-sampler-row-0');
    await expect(row).toHaveText('Clear beep.wav'); // it names the file it takes
    await row.click();

    await expect(page.getByTestId('sampler-name-0')).toHaveText('S1 …'); // placeholder
    await expect(page.getByTestId('sampler-edit-0')).toBeHidden();
    expect(await slotLoaded(page, 0)).toBe(false);
    expect(await page.evaluate(() =>
      (window as any).__synth.patterns.sampleNames[0])).toBeNull();

    // Instantly reversible, which is what buys the no-confirmation rule
    // (step-grid-editing.md REQ-6): name and audio both return.
    await page.getByTestId('clear-toast-sampler').getByTestId('toast-action').click();
    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');
    await expect(page.getByTestId('sampler-name-0')).not.toHaveClass(/needs-reload/);
    expect(await slotLoaded(page, 0)).toBe(true);
  });
});

/**
 * sampler.md REQ-12/REQ-13 — the selected-slot strip.
 *
 * The strip is one shared row bound to the grid cursor's slot, so the thing that
 * can break is the binding, not the knobs: point it at slot 3 and every control
 * must be addressing `sampler.t3.*`, or a player would be tuning the wrong sample
 * while looking at the right one.
 */
test.describe('the selected-slot strip', () => {
  test('follows the grid cursor from slot to slot', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    // Slot 0 is selected on open.
    await expect(page.getByTestId('knob-sampler.t0.pitch')).toBeVisible();
    await expect(page.getByTestId('switch-sampler.t0.rev')).toBeVisible();
    await expect(page.getByTestId('knob-sampler.t3.pitch')).toHaveCount(0);

    // Long-press selects a cell without toggling it (step-grid-editing.md).
    await page.getByTestId('sampler-step-3-5').click({ button: 'right' });

    await expect(page.getByTestId('knob-sampler.t3.pitch')).toBeVisible();
    await expect(page.getByTestId('knob-sampler.t0.pitch')).toHaveCount(0);
    await expect(page.getByTestId('knob-sampler.t3.vol')).toBeVisible();
    await expect(page.getByTestId('knob-sampler.t3.end')).toBeVisible();
  });

  test('names the selected slot, and re-labels when the slot is filled', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    const strip = page.locator('[data-testid="sampler-slot-reset"]').locator('..');
    await expect(strip).toContainText('S1 — sound');

    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'beep.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });
    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');
    await expect(strip).toContainText('beep.wav — sound');
  });

  test('Reset returns the whole family to its no-op baseline', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await page.evaluate(() => {
      const bus = (window as any).__synth.bus;
      bus.set('sampler.t0.pitch', 7);
      bus.set('sampler.t0.vol', 0.3);
      bus.set('sampler.t0.rev', 1);
      bus.set('sampler.t0.end', 0.4);
      bus.set('sampler.t0.poly', 1);
      bus.set('sampler.t0.choke', 3);
    });
    await page.getByTestId('sampler-slot-reset').click();

    const values = await page.evaluate(() => {
      const bus = (window as any).__synth.bus;
      return {
        pitch: bus.get('sampler.t0.pitch'),
        vol: bus.get('sampler.t0.vol'),
        rev: bus.get('sampler.t0.rev'),
        end: bus.get('sampler.t0.end'),
        poly: bus.get('sampler.t0.poly'),
        choke: bus.get('sampler.t0.choke'),
      };
    });
    // Reset covers the whole family, switches and dropdown included — a Reset
    // that leaves a slot choking something is worse than none.
    expect(values).toEqual({ pitch: 0, vol: 1, rev: 0, end: 1, poly: 0, choke: 0 });
  });

  test('carries the choke group and mono switch too (REQ-14)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();

    await expect(page.getByTestId('switch-sampler.t0.poly')).toBeVisible();
    const choke = page.getByTestId('sampler-slot-reset').locator('..');
    await expect(choke).toContainText('CHOKE');

    // They follow the cursor like the rest of the strip.
    await page.getByTestId('sampler-step-2-0').click({ button: 'right' });
    await expect(page.getByTestId('switch-sampler.t2.poly')).toBeVisible();
    await expect(page.getByTestId('switch-sampler.t0.poly')).toHaveCount(0);
  });
});

/**
 * onboarding.md REQ-25 — the slot strip's info badges.
 *
 * The regression these exist for is invisible in a unit test: a `Knob` binds its
 * paramId at construction, so the strip rebuilds every control when the cursor
 * moves to another slot. `InfoBadges` resolves each anchor once and keeps the
 * element — so a badge pinned to the knob rather than to its persistent cell is
 * left holding a detached node, measures 0x0, and silently disappears. Nothing
 * throws; the help just stops being there.
 */
test.describe('the slot strip info badges', () => {
  const TOPICS = ['sampler.pitch', 'sampler.window', 'sampler.env', 'sampler.tone', 'sampler.choke'];

  /** A badge below the fold is pinned where nothing can click it, so `position()`
   *  hides it (onboarding.md REQ-5b). The strip sits low on the page — scroll it
   *  into view and let the scroll listener reflow before asserting. */
  const showStrip = async (page: Page): Promise<void> => {
    await page.getByTestId('sampler-slot-reset').scrollIntoViewIfNeeded();
  };

  test('all five resolve their anchors and open', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    await page.getByTestId('info-badges').click();
    await showStrip(page);

    for (const topic of TOPICS) {
      await expect(page.getByTestId(`info-badge-${topic}`), topic).toBeVisible();
    }

    await page.getByTestId('info-badge-sampler.choke').click();
    await expect(page.locator('.modal, [role="dialog"]').first()).toContainText('group');
  });

  test('they survive selecting another slot (regression)', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    await page.getByTestId('info-badges').click();
    await showStrip(page);
    await expect(page.getByTestId('info-badge-sampler.pitch')).toBeVisible();

    // Long-press/right-click selects a cell without toggling it, so the strip
    // rebinds to slot 3 — and every control in it is rebuilt.
    await page.getByTestId('sampler-step-3-5').click({ button: 'right' });
    await expect(page.getByTestId('knob-sampler.t3.pitch')).toBeVisible();

    // Force a reflow. `position()` only re-measures on scroll/resize, so without
    // this the badges keep the coordinates they were last given and a stale
    // anchor stays *looking* fine — the assertion below would pass while pinned
    // to a detached node, which is exactly the bug it exists to catch.
    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: vp.width - 1, height: vp.height });
    await showStrip(page);

    for (const topic of TOPICS) {
      await expect(page.getByTestId(`info-badge-${topic}`), topic).toBeVisible();
    }
  });

  test('they come back after leaving the tab and returning', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-sampler').click();
    await page.getByTestId('info-badges').click();
    await showStrip(page);
    await expect(page.getByTestId('info-badge-sampler.tone')).toBeVisible();

    // A hidden anchor measures 0x0 and its badge hides (onboarding.md REQ-5b);
    // the reflow observer is what brings it back.
    await page.getByTestId('tab-drums').click();
    await expect(page.getByTestId('info-badge-sampler.tone')).toBeHidden();
    await page.getByTestId('tab-sampler').click();
    await showStrip(page);
    await expect(page.getByTestId('info-badge-sampler.tone')).toBeVisible();
  });
});
