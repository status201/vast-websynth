import { type Page, expect } from '@playwright/test';

/**
 * Navigate to the app and unlock audio via the trusted "Tap to start" click
 * (which resumes the AudioContext). Shared by specs that need a booted app.
 */
export async function gotoAndStart(page: Page): Promise<void> {
  // Suppress the first-visit onboarding tour so its overlay doesn't intercept
  // these specs (the dedicated onboarding spec clears this flag itself), and
  // pin Performance mode off so every spec boots the standard 8-voice /
  // interactive-latency config regardless of the host's navigator.hardwareConcurrency.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
      localStorage.setItem('websynth.perf', 'off');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  const startBtn = page.getByRole('button', { name: 'Tap to start' });
  await startBtn.click();
  await expect(startBtn).toBeHidden();
}

// State reads/writes go through the dev-only `window.__synth` bridge (main.ts).
// It's untyped in the page, so these test helpers cast — scoped to e2e only.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Read a ParamBus scalar from inside the page. */
export const busGet = (page: Page, id: string): Promise<number> =>
  page.evaluate((i) => (window as any).__synth.bus.get(i), id);

/** Set a ParamBus scalar from inside the page. */
export const busSet = (page: Page, id: string, value: number): Promise<void> =>
  page.evaluate((a) => (window as any).__synth.bus.set(a.id, a.value), { id, value });

/** Read the active preset/song label shown in the header selector. */
export const sessionDisplay = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).__synth.session.display as string);

/** Drag a knob upward (= increase) by its testid. */
export async function dragKnobUp(page: Page, testid: string): Promise<void> {
  const knob = page.getByTestId(testid);
  await expect(knob).toBeVisible();
  const box = await knob.boundingBox();
  if (!box) throw new Error(`${testid} has no bounding box`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 60, { steps: 6 }); // up = increase
  await page.mouse.up();
}

/**
 * Build a valid 16-bit PCM mono WAV as a Node Buffer — a fixture for
 * `setInputFiles` that the browser's `decodeAudioData` accepts. Default is a
 * short 440 Hz sine so there is real signal to decode.
 */
export function makeWavBuffer(durationSec = 0.1, sampleRate = 44100, freq = 440): Buffer {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataSize = numSamples * 2; // mono, 2 bytes/sample
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // channels
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    buf.writeInt16LE(Math.round(s * 0x3fff), 44 + i * 2); // ~half amplitude
  }
  return buf;
}
