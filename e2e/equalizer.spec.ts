import { test, expect, type Page } from '@playwright/test';
import { gotoAndStart } from './helpers';

/**
 * The EQUALIZER section — `specs/features/equalizer.md`.
 *
 * One of these cases is the reason this file exists at all. REQ-14 claims the
 * drawn curve is **exact**: `eqResponseDb` computes the RBJ coefficients that
 * `BiquadFilterNode` is specified to use, so the picture is the filter rather
 * than a model of it. jsdom has no biquads, so that claim is uncheckable in the
 * unit suite — here it is checked against a real one.
 */

/** Read a param off the dev bridge. */
const param = (page: Page, id: string): Promise<number> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.evaluate((p) => (window as any).__synth.bus.get(p) as number, id);

const setParam = (page: Page, id: string, v: number): Promise<void> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.evaluate(([p, x]) => (window as any).__synth.bus.set(p, x), [id, v] as [string, number]);

/** The curve the panel drew, sampled at the eight band centres. */
const drawnCurve = (page: Page, lane: string): Promise<number[]> =>
  page.evaluate((l) => {
    const v = document.querySelector<HTMLElement>(`[data-testid="eq-graph-${l}"]`)
      ?.dataset.eqCurve;
    return v ? v.split(',').map(Number) : [];
  }, lane);

/** Wait for two animation frames, so a coalesced repaint has landed. */
const settleFrames = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((r) => {
    requestAnimationFrame(() => requestAnimationFrame(() => r()));
  }));

/** Open the section (it ships folded) and select a lane. */
async function openLane(page: Page, lane: 'seq' | 'drums' | 'sampler'): Promise<void> {
  const section = page.getByTestId('eq-section');
  if (await section.evaluate((el) => el.classList.contains('collapsed'))) {
    // Clicking a tab expands and activates in one gesture.
    await page.getByTestId(`tab-eq-${lane}`).click();
  }
  await page.getByTestId(`tab-eq-${lane}`).click();
  await expect(page.getByTestId(`panel-eq-${lane}`)).toBeVisible();
}

test.describe('EQUALIZER section', () => {
  test('ships folded, opens on a tab click, and switches lane', async ({ page }) => {
    await gotoAndStart(page);
    const section = page.getByTestId('eq-section');
    await expect(section).toHaveClass(/collapsed/);
    await expect(page.getByTestId('panel-eq-seq')).toBeHidden();

    await page.getByTestId('tab-eq-drums').click();
    await expect(section).not.toHaveClass(/collapsed/);
    await expect(page.getByTestId('panel-eq-drums')).toBeVisible();

    await page.getByTestId('tab-eq-sampler').click();
    await expect(page.getByTestId('panel-eq-sampler')).toBeVisible();
    await expect(page.getByTestId('panel-eq-drums')).toBeHidden();
  });

  test('the header reads EQUALIZER over the three lanes, in caps', async ({ page }) => {
    await gotoAndStart(page);
    const bar = page.getByTestId('eq-section').locator('> div').first();

    // The source text is title-case; the caps come from CSS, and
    // `text-transform` never touches `textContent` — so asserting the rendered
    // capitals means asserting the property that produces them.
    await expect(bar).toContainText('Equalizer');
    for (const t of ['Sequencer', 'Drum Machine', 'Sampler']) {
      await expect(bar).toContainText(t);
    }

    const cased = await bar.evaluate((el) => {
      const title = el.firstElementChild as HTMLElement;
      const tab = el.querySelector<HTMLElement>('[data-testid="tab-eq-seq"]')!;
      return {
        title: getComputedStyle(title).textTransform,
        tab: getComputedStyle(tab).textTransform,
        order: title.textContent,
      };
    });
    expect(cased.title).toBe('uppercase');
    expect(cased.tab).toBe('uppercase');
    // …and the title is the bar's first child, ahead of every tab (REQ-9).
    expect(cased.order).toBe('Equalizer');
  });

  test('the switch engages the lane and lights its tab lamp', async ({ page }) => {
    await gotoAndStart(page);
    await openLane(page, 'drums');

    const lamp = page.getByTestId('tab-eq-drums').locator('span').first();
    await expect(lamp).toHaveAttribute('data-state', 'off');

    await page.getByTestId('switch-fx.drum.eq.on').click();
    expect(await param(page, 'fx.drum.eq.on')).toBe(1);
    // Engaged but flat — the state that would otherwise be invisible (REQ-10).
    await expect(lamp).toHaveAttribute('data-state', 'muted');

    await setParam(page, 'fx.drum.eq.b2', -8);
    await expect(lamp).toHaveAttribute('data-state', 'on');
  });

  test('a preset writes the curve and engages the EQ (REQ-15)', async ({ page }) => {
    await gotoAndStart(page);
    await openLane(page, 'seq');
    expect(await param(page, 'fx.eq.on')).toBe(0);

    await page.getByTestId('eq-preset-seq').locator('button').first().click();
    await page.getByRole('button', { name: 'Hiss Removal', exact: true }).click();

    expect(await param(page, 'fx.eq.on')).toBe(1);
    expect(await param(page, 'fx.eq.lp')).toBeLessThan(20000);
    expect(await param(page, 'fx.eq.b6')).toBeLessThan(0);
  });

  test('dragging the graph writes band gains (REQ-12)', async ({ page }) => {
    await gotoAndStart(page);
    await openLane(page, 'seq');

    const canvas = page.getByTestId('eq-canvas-seq');
    const box = (await canvas.boundingBox())!;
    // A sweep across the middle of the plot, below the zero line.
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.75, { steps: 8 });
    await page.mouse.up();

    const gains = await Promise.all(
      [2, 3, 4, 5].map((i) => param(page, `fx.eq.b${i}`)),
    );
    expect(gains.some((g) => g < -1), `drew nothing: ${gains.join(',')}`).toBe(true);
  });

  test('a wheel over the graph writes nothing (REQ-12)', async ({ page }) => {
    await gotoAndStart(page);
    await openLane(page, 'seq');
    await setParam(page, 'fx.eq.b3', -6);

    const canvas = page.getByTestId('eq-canvas-seq');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);

    expect(await param(page, 'fx.eq.b3')).toBe(-6);
  });

  /**
   * REQ-14, the pin that matters: build the very same filter chain in a real
   * `OfflineAudioContext` and ask the browser what its response is. If the
   * drawing and the audio ever disagree, the panel is confidently lying about
   * what the instrument sounds like — and nothing else in the suite can see it.
   */
  test('the drawn curve matches a real BiquadFilterNode within 0.5 dB', async ({ page }) => {
    await gotoAndStart(page);
    await openLane(page, 'seq');

    // A curve that exercises both shelves, several peaks, a non-default WIDTH
    // and both filters — i.e. every stage the response math has to get right.
    const curve: Record<string, number> = {
      'fx.eq.b0': 7, 'fx.eq.b1': -9, 'fx.eq.b2': 4, 'fx.eq.b3': -12,
      'fx.eq.b4': 6, 'fx.eq.b5': -5, 'fx.eq.b6': 3, 'fx.eq.b7': -8,
      'fx.eq.width': 2.5, 'fx.eq.hp': 60, 'fx.eq.lp': 12000,
    };
    for (const [id, v] of Object.entries(curve)) await setParam(page, id, v);
    // The graph coalesces a burst of writes into one frame (REQ-13), so the
    // mirror is a frame behind the last `set`. Let two land before reading it.
    await settleFrames(page);

    const drawn = await drawnCurve(page, 'seq');
    expect(drawn, 'the graph published no curve').toHaveLength(8);

    const measured = await page.evaluate(async (settings) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sampleRate = (window as any).__synth.engine.ctx.sampleRate as number;
      const bands: Array<[number, BiquadFilterType]> = [
        [60, 'lowshelf'], [150, 'peaking'], [400, 'peaking'], [900, 'peaking'],
        [2000, 'peaking'], [5000, 'peaking'], [8000, 'peaking'], [12000, 'highshelf'],
      ];
      const ctx = new OfflineAudioContext(1, 128, sampleRate);
      const stages: BiquadFilterNode[] = [];

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = settings.hp;
      hp.Q.value = 0.7;
      stages.push(hp);

      bands.forEach(([hz, type], i) => {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = hz;
        f.gain.value = settings.gains[i]!;
        if (type === 'peaking') f.Q.value = settings.width;
        stages.push(f);
      });

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = settings.lp;
      lp.Q.value = 0.7;
      stages.push(lp);

      // Series filters multiply in magnitude, i.e. sum in dB.
      const at = new Float32Array(bands.map(([hz]) => hz));
      const mag = new Float32Array(at.length);
      const phase = new Float32Array(at.length);
      const total = new Array<number>(at.length).fill(0);
      for (const s of stages) {
        s.getFrequencyResponse(at, mag, phase);
        for (let i = 0; i < at.length; i++) total[i]! += 20 * Math.log10(mag[i]!);
      }
      return total;
    }, { gains: [7, -9, 4, -12, 6, -5, 3, -8], width: 2.5, hp: 60, lp: 12000 });

    const diffs = drawn.map((d, i) => d - measured[i]!);
    const report = diffs
      .map((d, i) => `b${i}: drawn ${drawn[i]!.toFixed(2)} vs measured ${measured[i]!.toFixed(2)} (${d >= 0 ? '+' : ''}${d.toFixed(2)})`)
      .join('\n');
    expect(Math.max(...diffs.map(Math.abs)), '\n' + report).toBeLessThan(0.5);
  });

  /**
   * REQ-18. The EQ page reuses the bottom row's own grid, so its graph should
   * sit exactly under the scope. Only a browser can see this: the alignment is
   * the product of a shared custom property, a grid, two paddings and a border,
   * and every one of those is invisible to a jsdom assertion.
   */
  test('the graph lines up with the scope above it (REQ-18)', async ({ page }) => {
    await gotoAndStart(page);
    await openLane(page, 'seq');

    const eq = (await page.getByTestId('eq-canvas-seq').boundingBox())!;
    const scope = (await page.getByTestId('scope-canvas').boundingBox())!;

    // The two dark screens, not the panels around them — the edges a reader
    // actually sees. One pixel of slack: the EQ page sits inside a bordered
    // section and the scope does not.
    expect(Math.abs(eq.x - scope.x), `eq ${eq.x} vs scope ${scope.x}`)
      .toBeLessThanOrEqual(1);
    expect(Math.abs(eq.width - scope.width), `eq ${eq.width} vs scope ${scope.width}`)
      .toBeLessThanOrEqual(2);
  });

  test('the control column is exactly the wheels\' width (REQ-18)', async ({ page }) => {
    await gotoAndStart(page);
    await openLane(page, 'seq');

    const wheels = (await page.getByTestId('strip-master.pitchBend')
      .locator('xpath=..').boundingBox())!;
    const controls = (await page.getByTestId('switch-fx.eq.on')
      .locator('xpath=..').locator('xpath=..').boundingBox())!;

    // Same left edge and same width as the PITCH/OCT/MOD box, to the pixel the
    // section's own border costs.
    expect(Math.abs(controls.x - wheels.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(controls.width - wheels.width)).toBeLessThanOrEqual(1);
  });

  test('resizing the scope resizes the EQ graph with it (REQ-18)', async ({ page }) => {
    await gotoAndStart(page);
    await openLane(page, 'seq');
    const before = (await page.getByTestId('eq-canvas-seq').boundingBox())!.height;

    // Write the property the resize grip writes, on the element it writes it to.
    await page.evaluate(() => {
      const section = document.querySelector('[data-testid="eq-section"]')!;
      (section.parentElement as HTMLElement).style.setProperty('--scope-h', '220px');
    });

    await expect.poll(async () =>
      (await page.getByTestId('eq-canvas-seq').boundingBox())!.height,
    ).toBeGreaterThan(before + 60);

    // …and the two screens are still the same height as each other.
    const eq = (await page.getByTestId('eq-canvas-seq').boundingBox())!;
    const scope = (await page.getByTestId('scope-canvas').boundingBox())!;
    expect(Math.abs(eq.height - scope.height)).toBeLessThanOrEqual(2);
  });

  test('every lane keeps its own curve', async ({ page }) => {
    await gotoAndStart(page);
    await setParam(page, 'fx.eq.b1', -10);
    await setParam(page, 'fx.drum.eq.b6', 8);

    expect(await param(page, 'fx.drum.eq.b1')).toBe(0);
    expect(await param(page, 'fx.sampler.eq.b1')).toBe(0);
    expect(await param(page, 'fx.eq.b6')).toBe(0);
  });
});
