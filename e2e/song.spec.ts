import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoAndStart, sessionDisplay, makeWavBuffer } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const seqOn = (page: import('@playwright/test').Page, i: number): Promise<boolean> =>
  page.evaluate((idx) => (window as any).__synth.patterns.seq[0][idx].on, i);

test.describe('song mode', () => {
  test('save → new → load round-trips pattern state via localStorage', async ({ page }) => {
    await gotoAndStart(page);

    // Make the pattern non-default.
    await page.getByTestId('tab-seq').click();
    await page.getByTestId('seq-step-5').click();
    expect(await seqOn(page, 5)).toBe(true);

    await page.getByTestId('tab-song').click();

    // Save names the song via the custom prompt dialog and also downloads a JSON copy.
    const jsonDownload = page.waitForEvent('download');
    await page.getByTestId('song-save').click();
    await page.getByTestId('dialog-input').fill('e2e-song');
    await page.getByTestId('dialog-confirm').click();
    await jsonDownload; // consume the JSON download so it doesn't dangle
    const stored = await page.evaluate(() => localStorage.getItem('websynth.song.e2e-song'));
    expect(stored).not.toBeNull();

    // Wait for the Save dialog to fully detach (200ms fade) before opening New, so
    // the next getByTestId('dialog-confirm') isn't ambiguous between the two dialogs.
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);

    // New clears all banks/chains (custom confirm dialog). The slot dropdown keeps
    // the saved name selected, so Load reloads it.
    await page.getByTestId('song-new').click();
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(() => seqOn(page, 5)).toBe(false);

    await page.getByTestId('song-load').click();
    await expect.poll(() => seqOn(page, 5)).toBe(true);
  });

  /**
   * song-mode.md REQ-3b / sampler.md REQ-7 (regression): a slot's audio belongs
   * to the name beside it. Loading a song that doesn't name slot 0 used to leave
   * the previous sample loaded and playable under the new song's label.
   */
  test('loading a song evicts sampler audio it does not name', async ({ page }) => {
    await gotoAndStart(page);

    // Save a song while every sampler slot is empty — its sampleNames are all null.
    await page.getByTestId('tab-song').click();
    const jsonDownload = page.waitForEvent('download');
    await page.getByTestId('song-save').click();
    await page.getByTestId('dialog-input').fill('no-samples');
    await page.getByTestId('dialog-confirm').click();
    await jsonDownload;
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);

    // Now load a clip into slot 0.
    await page.getByTestId('tab-sampler').click();
    await page.getByTestId('sampler-file-0').setInputFiles({
      name: 'beep.wav',
      mimeType: 'audio/wav',
      buffer: makeWavBuffer(),
    });
    await expect(page.getByTestId('sampler-name-0')).toHaveText('beep.wav');
    await expect(page.getByTestId('sampler-edit-0')).toBeVisible();

    // Load the sample-less song back: the slot must come back empty, not keep
    // playing beep.wav under a blank label.
    await page.getByTestId('tab-song').click();
    await page.getByTestId('song-load').click();

    await page.getByTestId('tab-sampler').click();
    await expect(page.getByTestId('sampler-name-0')).toHaveText('S1 …');
    await expect(page.getByTestId('sampler-edit-0')).toBeHidden();
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const loaded = await page.evaluate(() => (window as any).__synth.engine.sampler.buffers[0] != null);
    expect(loaded).toBe(false);
  });

  /**
   * song-mode.md REQ-14 (regression): a song carries no playhead, so an apply
   * that leaves the old one in place hands the incoming song a position it never
   * had. New was the worst case — the readout kept quoting a bar number from the
   * song it had just cleared, beside a scrubber that now had one cell.
   */
  test('New and a demo load both return the playhead to bar 1', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    const readout = page.getByTestId('transport-readout');
    const cue = () => page.evaluate(() => (window as any).__synth.engine.clock.cue);

    // An 8-bar chain so bar 5 genuinely exists, then move there.
    const toBar5 = async (): Promise<void> => {
      await page.evaluate(() => {
        const s = (window as any).__synth;
        s.engine.arrangement.setSeqChain([0, 1, 2, 3, 0, 1, 2, 3], true);
        s.engine.seekTo(4 * 16);
      });
      await expect(readout).toHaveText('5.01');
    };

    await toBar5();
    await page.getByTestId('song-new').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(readout).toHaveText('1.01');
    expect(await cue()).toBe(0);

    // …and the same for a load. (Dismiss New's Undo toast target by waiting the
    // confirm out first, as the round-trip test above does.)
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    await toBar5();
    await page.getByTestId('song-demo-Apex Twin').click();
    await expect(readout).toHaveText('1.01');
    expect(await cue()).toBe(0);
    // The incoming chain starts at its own slot 0, not wherever the old one was.
    expect(
      await page.evaluate(() => (window as any).__synth.engine.arrangement.seqChainPos),
    ).toBe(0);
  });

  test('per-lane Clear confirms before wiping the arrangement chain', async ({ page }) => {
    await gotoAndStart(page);
    const seqSteps = () =>
      page.evaluate(() => (window as any).__synth.engine.arrangement.seq.steps.length);

    // Build a multi-step chain so Clear has something to lose.
    await page.evaluate(() => (window as any).__synth.engine.arrangement.setSeqChain([0, 1, 2, 3], false));
    await page.getByTestId('tab-song').click();
    expect(await seqSteps()).toBe(4);

    // Cancelling the confirm leaves the chain intact.
    await page.getByTestId('chain-clear-seq').click();
    await page.getByTestId('dialog-cancel').click();
    // Wait for the dialog to fully detach (200ms fade) before re-opening, so the
    // next getByTestId('dialog-confirm') is unambiguous.
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    expect(await seqSteps()).toBe(4);

    // Confirming resets it to a single bank.
    await page.getByTestId('chain-clear-seq').click();
    await page.getByTestId('dialog-confirm').click();
    await expect.poll(seqSteps).toBe(1);
  });

  // song-mode.md REQ-13: Sync leads Audio (export is the tab's terminal action),
  // and above 1280px the two short rows share one line instead of spending two.
  test('Sync leads Audio, sharing one row only on a wide screen', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    // Anchor on a control inside each row rather than the row itself — the rows
    // carry only hashed CSS-Module classes.
    const syncBox = () => page.getByTestId('sync-mode-master').boundingBox();
    const audioBox = () => page.getByTestId('song-export-audio').boundingBox();
    const both = async () => {
      const [s, a] = await Promise.all([syncBox(), audioBox()]);
      if (!s || !a) throw new Error('Sync/Audio row controls have no box');
      return { s, a };
    };

    await page.setViewportSize({ width: 1440, height: 900 });
    let { s, a } = await both();
    // One line: vertically overlapping, and Audio starts to the right of Sync.
    expect(Math.abs(s.y - a.y)).toBeLessThan(s.height);
    expect(a.x).toBeGreaterThan(s.x + s.width);

    await page.setViewportSize({ width: 1024, height: 900 });
    ({ s, a } = await both());
    // Stacked, Sync first — Audio is a full row below it.
    expect(a.y).toBeGreaterThan(s.y + s.height);
  });

  test('loading a demo labels the preset selector with the song name', async ({ page }) => {
    await gotoAndStart(page);
    expect(await sessionDisplay(page)).toBe('basic');

    // Stopped transport: the Play LED runs the idle attract pulse
    // (play-button-blink.md REQ-2).
    await expect(page.getByTestId('transport-play')).toHaveClass(/\battract\b/);

    await page.getByTestId('tab-song').click();
    // Only the first DEMO_ROW_LIMIT (10) demos are inline; Zombie Nation (a
    // built-in, after all 13 drop-ins) hides behind the "All Demos" toggle
    // (song-mode.md REQ-10).
    await expect(page.getByTestId('song-demo-Zombie Nation')).toBeHidden();
    await page.getByTestId('song-demo-more').click();
    await page.getByTestId('song-demo-Zombie Nation').click();

    await expect.poll(() => sessionDisplay(page)).toBe('Zombie Nation');
    await expect(page.getByTestId('preset-select')).toContainText('Zombie Nation');

    // The demo load arms the fast green "press play" cue while stopped
    // (play-button-blink.md REQ-3); starting the transport consumes it (REQ-4).
    await expect(page.getByTestId('transport-play')).toHaveClass(/\bcue\b/);
    await page.getByTestId('transport-play').click();
    await expect(page.getByTestId('transport-play')).not.toHaveClass(/\bcue\b/);
    await expect(page.getByTestId('transport-play')).not.toHaveClass(/\battract\b/);
    await page.getByTestId('transport-play').click();
    await expect(page.getByTestId('transport-play')).toHaveClass(/\battract\b/);

    // Any silent-while-stopped action re-arms the cue — here, enabling a
    // machine via the bus (play-button-blink.md REQ-3). The sampler is the
    // one machine this demo leaves off, so the set is a real 0 → 1 edge.
    await page.evaluate(() => (window as any).__synth.bus.set('sampler.on', 1));
    await expect(page.getByTestId('transport-play')).toHaveClass(/\bcue\b/);
  });

  // song-mode.md REQ-12: drop-in demos are no longer bundled — clicking one
  // fetches its JSON, validates it and applies it. The built-in path above is
  // synchronous; this is the fetched one, and it is the only place the generated
  // name index is exercised end to end (the button label IS the index entry).
  test('a drop-in demo is fetched on click and applies', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    // Labelled with the song's own name, which only demos-index.json knows
    // (the file is apex-twin.json). Inline since DEMO_ROW_LIMIT rose to 10.
    const btn = page.getByTestId('song-demo-Apex Twin');
    await expect(btn).toBeVisible();
    await btn.click();

    await expect.poll(() => sessionDisplay(page)).toBe('Apex Twin');
    // Its actual content landed, not just the label: 128 BPM + the 8-step chains.
    await expect
      .poll(() => page.evaluate(() => (window as any).__synth.bus.get('transport.bpm')))
      .toBe(128);
    await expect
      .poll(() => page.evaluate(() => (window as any).__synth.engine.arrangement.seq.steps))
      .toEqual([0, 0, 1, 0, 0, 2, 0, 3]);
  });

  test('Export Song renders and downloads a WAV', async ({ page }) => {
    await gotoAndStart(page);
    // Shorten the render to a single bar (default fallback is 4) via the bridge.
    await page.evaluate(() => (window as any).__synth.engine.arrangement.setSeqChain([0], true));

    await page.getByTestId('tab-song').click();
    // v7: the button opens the options modal but keeps naming the format —
    // that is what tells it apart from the neighbouring Export (.json) button
    // (audio-export.md REQ-8) — and the confirm names the overridable one.
    await expect(page.getByTestId('song-export-audio')).toHaveText('Export Song as WAV…');
    await page.getByTestId('song-export-audio').click();
    await expect(page.getByTestId('export-audio-modal')).toBeVisible();
    await expect(page.getByTestId('export-audio-confirm')).toHaveText('Export as WAV');
    // 1 bar + the default tail bar ≈ 4 s at 120 BPM.
    await expect(page.getByTestId('export-audio-length')).toContainText('1 tail bar');

    const wavDownload = page.waitForEvent('download', { timeout: 20000 });
    await page.getByTestId('export-audio-confirm').click();

    // REQ-10: the modal STAYS and reports the render, rather than vanishing for
    // however long a real-time render takes.
    await expect(page.getByTestId('export-audio-progress')).toBeVisible();
    await expect(page.getByTestId('export-audio-status')).toContainText(/Rendering… bar \d+ of \d+/);

    const download = await wavDownload;
    expect(download.suggestedFilename()).toMatch(/\.wav$/);
    const path = await download.path();
    const head = readFileSync(path);
    expect(head.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(head.subarray(8, 12).toString('ascii')).toBe('WAVE');

    // …and it closes itself once the file is written.
    await expect(page.getByTestId('export-audio-modal')).toBeHidden();
  });

  /**
   * audio-export.md REQ-10: a ten-minute render needs a Cancel that genuinely
   * cancels, not a dead button beside a progress bar.
   */
  test('a render in flight can be cancelled, and writes nothing', async ({ page }) => {
    await gotoAndStart(page);
    // Long enough that the render is still going when we abort it.
    await page.evaluate(() => (window as any).__synth.engine.arrangement.setSeqChain([0, 1, 2, 3], true));
    await page.getByTestId('tab-song').click();

    let downloaded = false;
    page.on('download', () => { downloaded = true; });

    await page.getByTestId('song-export-audio').click();
    await page.getByTestId('export-audio-confirm').click();
    await expect(page.getByTestId('export-audio-progress')).toBeVisible();
    await page.getByTestId('export-audio-abort').click();

    await expect(page.getByTestId('export-audio-modal')).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => (window as any).__synth.engine.recorder.phase))
      .toBe('idle');
    expect(await page.evaluate(() => (window as any).__synth.engine.clock.playing)).toBe(false);
    await page.waitForTimeout(500);
    expect(downloaded).toBe(false);
  });

  /**
   * audio-export.md REQ-2/REQ-3 (v7): nothing pinned the rendered *length* in a
   * real browser before. The WAV header's data-chunk size gives it exactly, so
   * two runs of a one-bar song must be ~2× one run, and the tail bar must add
   * roughly a bar on top.
   */
  test('Runs and the tail bar change how much audio is rendered', async ({ page }) => {
    await gotoAndStart(page);
    await page.evaluate(() => (window as any).__synth.engine.arrangement.setSeqChain([0], true));
    await page.getByTestId('tab-song').click();

    /** Seconds of stereo 16-bit audio in a downloaded WAV, from its header. */
    const renderSeconds = async (runs: string, tail: boolean): Promise<number> => {
      // The modal now lingers on its "Done" state and then fades (REQ-10), so
      // wait for the previous one to fully detach before opening the next —
      // otherwise its testids are still in the DOM. Same idiom the Save/New
      // dialogs above use.
      await expect(page.getByTestId('export-audio-modal')).toHaveCount(0);
      await page.getByTestId('song-export-audio').click();
      // Dropdown options are plain buttons; scope to the dropdown so the row
      // "1" can't collide with anything else on the page.
      const dd = page.getByTestId('export-audio-runs');
      await dd.click();
      await dd.getByRole('button', { name: runs, exact: true }).click();
      if (!tail) await page.getByTestId('export-audio-tail').click();
      const dl = page.waitForEvent('download', { timeout: 30000 });
      await page.getByTestId('export-audio-confirm').click();
      const bytes = readFileSync(await (await dl).path());
      const rate = bytes.readUInt32LE(24);
      return bytes.readUInt32LE(40) / (rate * 4); // dataSize / (rate × 2ch × 2B)
    };

    // 120 BPM: one bar is 2 s. One run, no tail ≈ 2 s (plus the worklet's
    // look-ahead grace), so compare shapes rather than exact values.
    const oneBare = await renderSeconds('1', false);
    expect(oneBare).toBeGreaterThan(1.5);
    expect(oneBare).toBeLessThan(3);

    const oneTailed = await renderSeconds('1', true);
    expect(oneTailed).toBeGreaterThan(oneBare + 1.5); // a whole extra bar

    const twoBare = await renderSeconds('2', false);
    expect(twoBare).toBeGreaterThan(oneBare + 1.5);   // the second pass
  });

  // audio-export.md REQ-7: the MP3 encoder (lamejs) is a lazily-imported chunk,
  // so this is the only check that the dynamic import actually resolves in a
  // real browser. We inspect bytes rather than decode — CI Chromium has no MP3
  // decoder, but an MPEG frame sync is just a bit pattern.
  test('Export Song downloads an MP3 through the lazily-loaded encoder', async ({ page }) => {
    await gotoAndStart(page);
    await page.evaluate(() => (window as any).__synth.engine.arrangement.setSeqChain([0], true));

    await page.getByTestId('tab-song').click();
    // The Song tab's Format is the global DEFAULT (REQ-9): the modal opens
    // seeded from it rather than always on WAV.
    await page.getByTestId('song-export-fmt-mp3').click();
    await expect(page.getByTestId('song-export-audio')).toHaveText('Export Song as MP3…');
    await page.getByTestId('song-export-audio').click();
    await expect(page.getByTestId('export-audio-confirm')).toHaveText('Export as MP3');
    const mp3Download = page.waitForEvent('download', { timeout: 20000 });
    await page.getByTestId('export-audio-confirm').click();
    const download = await mp3Download;

    expect(download.suggestedFilename()).toMatch(/\.mp3$/);
    const bytes = readFileSync(await download.path());
    // First MPEG audio frame: 11 set sync bits, then the 192 kbps index (0xB).
    let i = 0;
    while (i < bytes.length - 4 && !(bytes[i] === 0xff && (bytes[i + 1]! & 0xe0) === 0xe0)) i++;
    expect(i).toBeLessThan(bytes.length - 4);
    expect(bytes[i + 2]! >> 4).toBe(0xb);
  });
});
