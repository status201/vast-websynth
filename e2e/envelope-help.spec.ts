import { test, expect } from '@playwright/test';
import { startAudio } from './helpers';

/**
 * The ADSR graph under the AMP / FILTER ENV info badges (envelope-help-graph.md):
 * the badge opens on a live graph of the current envelope, labelled with the
 * knobs' own readouts.
 */

type Bridge = { __synth: { bus: { set(id: string, v: number): void } } };

test('AMP ENV and FILTER ENV badges draw the current envelope', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1'); // suppress auto-tour
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  await startAudio(page);
  await expect(page.getByTestId('tour-callout')).toBeHidden();
  await page.evaluate(() => {
    const bus = (window as unknown as Bridge).__synth.bus;
    bus.set('env.amp.attack', 0.5);
    bus.set('env.amp.sustain', 0.25);
  });

  await page.getByTestId('info-badges').click();

  await page.getByTestId('info-badge-ampenv').click();
  const amp = page.getByRole('dialog', { name: 'Amp Envelope (ADSR)' });
  const graph = amp.getByRole('img', { name: /Amp envelope/ });
  await expect(graph).toBeVisible();
  await expect(graph).toHaveAttribute('aria-label', /attack 500ms.*sustain 25%/);
  await expect(amp).toContainText('Sustain (level, not a time)');
  await page.keyboard.press('Escape');
  await expect(amp).toBeHidden();

  await page.getByTestId('info-badge-filterenv').click();
  const fil = page.getByRole('dialog', { name: 'Filter Envelope (ADSR)' });
  await expect(fil.getByRole('img', { name: /Filter envelope/ })).toBeVisible();
  await expect(fil).toContainText('opens the cutoff');
});
