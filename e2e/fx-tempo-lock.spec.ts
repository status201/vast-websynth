import { test, expect } from '@playwright/test';
import { gotoAndStart, busGet, busSet } from './helpers';
import { SYNC_LABELS } from '../src/utils/tempo';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The FX tempo lock in a real browser — tempo-lock.md.
 *
 * Two things only a browser settles: that the lock actually reaches the
 * `DelayNode` through the whole ParamBus → Effect chain, and REQ-9's layout
 * claim, which is about measured boxes and therefore cannot be unit-tested (the
 * jsdom suite has no CSS at all).
 */

const EIGHTH = SYNC_LABELS.indexOf('1/8');

// Reaches `Delay`'s private `delay` node at runtime through an `any` cast, as
// `e2e/lfo-sync.spec.ts` reaches `engine.lfo.osc`. The delayTime is a
// `setTargetAtTime`, so it is polled to convergence rather than read once.
const delaySeconds = (page: any): Promise<number> =>
  page.evaluate(
    () => (window as any).__synth.engine.synthFx.fx.delay.delay.delayTime.value as number,
  );

/**
 * The division the chip is showing. Scoped to the toggle's label span, not the
 * chip: the chip also holds the (closed) menu, and the toggle also holds the
 * caret, which is `display: none` here but still counts towards `textContent`.
 */
const chipLabel = (page: any, paramId: string) =>
  page.getByTestId(`tempodiv-${paramId}`).locator('button > span').first();

/** The chip's toggle — what a user clicks to open the menu. */
const chipToggle = (page: any, paramId: string) =>
  page.getByTestId(`tempodiv-${paramId}`).getByRole('button').first();

/** The bounding boxes of the knobs in an FX panel, top-left first. */
async function knobBoxes(
  page: any,
  ids: string[],
): Promise<Array<{ x: number; y: number; h: number }>> {
  const out: Array<{ x: number; y: number; h: number }> = [];
  for (const id of ids) {
    const box = await page.getByTestId(id).boundingBox();
    out.push({ x: Math.round(box!.x), y: Math.round(box!.y), h: Math.round(box!.height) });
  }
  return out;
}

test.describe('FX tempo lock', () => {
  test('a locked delay takes its time from the tempo, and follows a tempo change', async ({ page }) => {
    await gotoAndStart(page);
    await busSet(page, 'fx.delay.on', 1);
    await busSet(page, 'transport.bpm', 120);
    await busSet(page, 'fx.delay.time', 0.42); // a deliberately unrelated knob value

    await busSet(page, 'fx.delay.sync', EIGHTH);
    // 1/8 at 120 BPM = 0.25 s.
    await expect.poll(() => delaySeconds(page), { timeout: 4000 }).toBeCloseTo(0.25, 2);

    await busSet(page, 'transport.bpm', 60);
    await expect.poll(() => delaySeconds(page), { timeout: 4000 }).toBeCloseTo(0.5, 2);

    // Free again: the stored value was never rewritten, so this is where it came from.
    await busSet(page, 'fx.delay.sync', 0);
    await expect.poll(() => delaySeconds(page), { timeout: 4000 }).toBeCloseTo(0.42, 2);
    expect(await busGet(page, 'fx.delay.time')).toBeCloseTo(0.42, 5);
  });

  test('the glyph locks the knob and the chip picks the division', async ({ page }) => {
    await gotoAndStart(page);
    await busSet(page, 'fx.delay.on', 1);
    await busSet(page, 'transport.bpm', 120);

    const chip = page.getByTestId('tempodiv-fx.delay.time');
    await expect(chip).toBeHidden();

    await page.getByTestId('tempolock-fx.delay.time').click();
    await expect(chip).toBeVisible();
    expect(await busGet(page, 'fx.delay.sync')).toBeGreaterThan(0);

    await chipToggle(page, 'fx.delay.time').click();
    await chip.getByText('1/8', { exact: true }).click();

    expect(SYNC_LABELS[await busGet(page, 'fx.delay.sync')]).toBe('1/8');
    await expect(chipLabel(page, 'fx.delay.time')).toHaveText('1/8');
    // The knob's own readout keeps showing what is heard.
    await expect(page.getByTestId('knob-fx.delay.time')).toContainText('250ms');
  });

  // REQ-9. `.fxKnobs` wraps, and the four-knob Phaser spends 220 px of its
  // ~246 px column, so a chip even slightly wider than the knob box it replaces
  // would drop a knob onto a second row — turning a space-saving feature into a
  // space-costing one at the exact moment it is used.
  test('locking the widest division does not reflow the Phaser row', async ({ page }) => {
    await gotoAndStart(page);
    await busSet(page, 'fx.phaser.on', 1);
    const ids = ['knob-fx.phaser.rate', 'knob-fx.phaser.depth',
      'knob-fx.phaser.feedback', 'knob-fx.phaser.mix'];

    const before = await knobBoxes(page, ids);
    // The longest label in the table, so this is the worst case.
    await busSet(page, 'fx.phaser.sync', SYNC_LABELS.indexOf('1/16 D'));
    await expect(chipLabel(page, 'fx.phaser.rate')).toHaveText('1/16D');

    const after = await knobBoxes(page, ids);
    expect(after).toEqual(before);
    // All four still share one row — the check that would fail on a wrap.
    expect(new Set(after.map((b) => b.y)).size).toBe(1);
  });

  // The machine tabs run 22 px knobs, so their cell is 30 px wide — narrow
  // enough that the glyph and the label do not fit on one line. When the label
  // wrapped, the RATE knob grew a second line and its dial dropped below its
  // neighbours' (tempo-lock.md REQ-10).
  test('a lockable knob stays aligned with its neighbours in a machine tab', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-drums').click();
    await page.getByTestId('switch-fx.drum.phaser.on').click();

    const ids = ['knob-fx.drum.phaser.rate', 'knob-fx.drum.phaser.depth',
      'knob-fx.drum.phaser.feedback', 'knob-fx.drum.phaser.mix'];
    const boxes = await knobBoxes(page, ids);

    // One row, one height: RATE is the only one carrying a lock, so any label
    // wrap shows up as a taller box and a lower top edge than the other three.
    expect(new Set(boxes.map((b) => b.y)).size).toBe(1);
    expect(new Set(boxes.map((b) => b.h)).size).toBe(1);

    // And the dials themselves line up, which is what the eye actually reads.
    const dialTops = await page.evaluate((testids) =>
      testids.map((id) => {
        const root = document.querySelector(`[data-testid="${id}"]`)!;
        // The dial is the knob's second child (label, dial, [chip], readout).
        const dial = root.children[1] as HTMLElement;
        return Math.round(dial.getBoundingClientRect().top);
      }), ids);
    expect(new Set(dialTops).size).toBe(1);
  });
});
