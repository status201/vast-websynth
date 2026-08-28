import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart, makeWavBuffer } from './helpers';

/**
 * sample-recorder.md REQ-9 — the Edit Sample modal's three sections are one
 * shape: a title on the left, a caret on the right, a body the whole header
 * folds, and all three closed on a first open.
 *
 * This is the only spec that asserts the folds themselves; `sample-chop.spec.ts`,
 * `time-stretch.spec.ts` and `scratch.spec.ts` unfold and get on with their own
 * feature. The alignment is asserted by GEOMETRY rather than by DOM order,
 * because the bug it regresses was a CSS auto margin acting on an append order
 * that read correctly in the source: the caret's class carries
 * `margin-left: auto`, so appending it first ate the free space to its left and
 * dragged the title to the right edge with it.
 */
const SECTIONS = [
  { base: 'chop', title: 'Chop' },
  { base: 'stretch', title: 'Fit & Shift' },
  { base: 'scratch', title: 'Scratch' },
] as const;

/** Load a clip into slot 0 and open it in the editor, touching no fold. */
async function openEditor(page: Page): Promise<void> {
  await gotoAndStart(page);
  await page.getByTestId('tab-sampler').click();
  await page.getByTestId('sampler-file-0').setInputFiles({
    name: 'break.wav', mimeType: 'audio/wav', buffer: makeWavBuffer(2.0),
  });
  await expect(page.getByTestId('sampler-name-0')).toHaveText('break.wav');
  await page.getByTestId('sampler-edit-0').click();
  await expect(page.getByTestId('chop-section')).toBeVisible();
}

test.describe('edit sample — section folds', () => {
  test('all three sections open folded, and say what they are (REQ-9)', async ({ page }) => {
    await openEditor(page);

    for (const { base, title } of SECTIONS) {
      await expect(page.getByTestId(`${base}-head`)).toHaveText(title);
      await expect(page.getByTestId(`${base}-body`)).toBeHidden();
    }
  });

  test('every title sits at the left, every caret at the right (REQ-9, regression)', async ({ page }) => {
    await openEditor(page);

    for (const { base, title } of SECTIONS) {
      const head = page.getByTestId(`${base}-head`);
      const caret = page.getByTestId(`${base}-toggle`);
      const label = head.locator('span').first();
      await expect(label).toHaveText(title);

      const [h, l, c] = await Promise.all([
        head.boundingBox(), label.boundingBox(), caret.boundingBox(),
      ]);
      if (!h || !l || !c) throw new Error(`${base}: header, title or caret has no box`);

      // Each at its own end of the row, not merely in order: with the bug BOTH
      // sat at the right, so an order-only assertion is the one that still
      // passed. A tenth of the row is the slack — enough for the caret button's
      // own padding, nowhere near enough to swallow a title pushed across.
      const slack = h.width * 0.1;
      expect(l.x - h.x, `${base} title starts at the left of its header`).toBeLessThan(slack);
      expect((h.x + h.width) - (c.x + c.width), `${base} caret ends at the right of its header`)
        .toBeLessThan(slack);
      expect(l.x + l.width, `${base} title ends before its caret`).toBeLessThanOrEqual(c.x);
    }
  });

  test('a header folds its own section and no other (REQ-9)', async ({ page }) => {
    await openEditor(page);

    // Clicked mid-row, between the title and the caret: the whole header is the
    // hit target, not just the 18 px chevron (ADR-014 law 6).
    await page.getByTestId('stretch-head').click();
    await expect(page.getByTestId('stretch-body')).toBeVisible();
    await expect(page.getByTestId('chop-body')).toBeHidden();
    await expect(page.getByTestId('scratch-body')).toBeHidden();

    // One fold carries both rows — they are the same question asked twice
    // (time-stretch.md REQ-18).
    await expect(page.getByTestId('fit-row')).toBeVisible();
    await expect(page.getByTestId('shift-row')).toBeVisible();

    // The caret does the same one thing the header does, and only that
    // (ADR-014 law 2).
    await page.getByTestId('stretch-toggle').click();
    await expect(page.getByTestId('stretch-body')).toBeHidden();
  });

  test('each section remembers its own fold across a reopen (REQ-9)', async ({ page }) => {
    await openEditor(page);
    await page.getByTestId('chop-head').click();
    await expect(page.getByTestId('chop-body')).toBeVisible();

    await page.getByTestId('mic-close').click();
    await page.getByTestId('sampler-edit-0').click();

    await expect(page.getByTestId('chop-body')).toBeVisible();
    await expect(page.getByTestId('stretch-body')).toBeHidden();
    await expect(page.getByTestId('scratch-body')).toBeHidden();
  });
});
