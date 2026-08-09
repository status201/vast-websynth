import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  gotoAndStart, sessionDisplay, makeWavBuffer, busGet, busSet,
  pickDemo, clickDemo, dropInDeclaring, renderedDemoNames, visibleDemoNames,
  demoLibrary, dropInDemos, zipDemos, zipClipSlots, loadedSamplerSlots,
  otherBpm, armPlayCueViaMachine,
} from './helpers';

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
    await page.getByTestId('dialog-input').fill('test-e2e-song');
    await page.getByTestId('dialog-confirm').click();
    await jsonDownload; // consume the JSON download so it doesn't dangle
    const stored = await page.evaluate(() => localStorage.getItem('websynth.song.test-e2e-song'));
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
    await page.getByTestId('dialog-input').fill('test-no-samples');
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
    // A built-in: it applies synchronously, so the readout assertion below is
    // not racing a fetch. Which built-in is irrelevant — never name one.
    await clickDemo(page, (await pickDemo(page, 'built-in')).name);
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
    // A built-in — the synchronous source, so nothing here waits on a fetch.
    const demo = await pickDemo(page, 'built-in');
    await clickDemo(page, demo.name);

    await expect.poll(() => sessionDisplay(page)).toBe(demo.name);
    await expect(page.getByTestId('preset-select')).toContainText(demo.name);

    // The demo load arms the fast green "press play" cue while stopped
    // (play-button-blink.md REQ-3); starting the transport consumes it (REQ-4).
    await expect(page.getByTestId('transport-play')).toHaveClass(/\bcue\b/);
    await page.getByTestId('transport-play').click();
    await expect(page.getByTestId('transport-play')).not.toHaveClass(/\bcue\b/);
    await expect(page.getByTestId('transport-play')).not.toHaveClass(/\battract\b/);
    await page.getByTestId('transport-play').click();
    await expect(page.getByTestId('transport-play')).toHaveClass(/\battract\b/);

    // Any silent-while-stopped action re-arms the cue — here, enabling a
    // machine via the bus (play-button-blink.md REQ-3). The helper picks one the
    // demo left off, so the write is a real 0 → 1 edge whatever the song enables.
    await armPlayCueViaMachine(page);
    await expect(page.getByTestId('transport-play')).toHaveClass(/\bcue\b/);
  });

  // song-mode.md REQ-10, asserted structurally: how many demos exist is data, so
  // the spec is "at most DEMO_ROW_LIMIT inline, the rest behind the toggle" —
  // never "this named demo is hidden", which is only true at one library size.
  test('the demo row shows at most DEMO_ROW_LIMIT inline, rest behind All Demos', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    // Mirrors DEMO_ROW_LIMIT in src/ui/panels/song-panel.ts — a production
    // constant governed by REQ-10, so changing it is already a spec change.
    const LIMIT = 10;
    const all = await renderedDemoNames(page);
    const more = page.getByTestId('song-demo-more');

    if (all.length <= LIMIT) {
      // The boundary the REQ also states: no toggle, everything on show.
      await expect(more).toHaveCount(0);
      expect(await visibleDemoNames(page)).toEqual(all);
      return;
    }

    expect(await visibleDemoNames(page)).toEqual(all.slice(0, LIMIT));
    await expect(more).toHaveText('All Demos');

    await more.click();
    await expect(more).toHaveText('Less');
    expect(await visibleDemoNames(page)).toEqual(all);

    // …and it collapses again, which is what makes it a toggle.
    await more.click();
    await expect(more).toHaveText('All Demos');
    expect(await visibleDemoNames(page)).toEqual(all.slice(0, LIMIT));

    // A hidden demo, once revealed, loads like any other. Skip the zips here —
    // they fetch a whole bundle, and the bundle path has its own test below.
    const hidden = (await demoLibrary(page)).slice(LIMIT).find((d) => d.kind !== 'zip');
    if (!hidden) return; // every overflow demo is a zip — nothing to prove here
    await clickDemo(page, hidden.name);
    await expect.poll(() => sessionDisplay(page)).toBe(hidden.name);
  });

  // song-mode.md REQ-12: the row IS the shipped library, and each drop-in wears
  // the name from inside its own file (via the generated index), not its filename.
  test('the demo row is exactly the shipped library, in source order', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    const all = await renderedDemoNames(page);
    const dropIns = dropInDemos().map((d) => d.name);
    const zips = zipDemos().map((d) => d.name);

    expect(all.slice(0, dropIns.length)).toEqual(dropIns);
    expect(all.slice(all.length - zips.length)).toEqual(zips);
    // The built-ins are what is left in the middle, and there is at least one.
    expect(all.length).toBeGreaterThan(dropIns.length + zips.length);

    for (const name of dropIns) {
      await expect(page.getByTestId(`song-demo-${name}`)).toHaveText(name);
    }
  });

  // song-mode.md REQ-12: drop-in demos are no longer bundled — clicking one
  // fetches its JSON, validates it and applies it. The built-in path above is
  // synchronous; this is the fetched one, and it is the only place the generated
  // name index is exercised end to end (the button label IS the index entry).
  test('a drop-in demo is fetched on click and applies', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    // Any drop-in that states a tempo — the expectations below come out of the
    // shipped file, so editing that demo moves them with it.
    const { demo, song } = dropInDeclaring(['transport.bpm']);

    // The button wears the name from INSIDE the file, which only
    // demos-index.json knows at build time — filenames would not do, since
    // several drop-ins are named nothing like the song they hold.
    await expect(page.getByTestId(`song-demo-${demo.name}`)).toHaveText(demo.name);
    await clickDemo(page, demo.name);

    // `sessionDisplay` is set from the *fetched* file's own `name`, so matching
    // the button label proves the index end to end.
    await expect.poll(() => sessionDisplay(page)).toBe(demo.name);
    // Its actual content landed, not just the label.
    await expect.poll(() => busGet(page, 'transport.bpm')).toBe(song.params['transport.bpm']);
    await expect
      .poll(() => page.evaluate(() => (window as any).__synth.engine.arrangement.seq.steps))
      .toEqual(song.seqChain.steps);
  });

  /**
   * song-mode.md REQ-15 + session-autosave.md REQ-14d. Saving your own song
   * under a demo's name leaves two different songs behind one label, and each
   * door used to silently pick its own: the slot list gave you yours, the demo
   * button gave you the demo, and nothing said so. Now the demo doors ask.
   */
  test('a demo whose name you have saved asks which song you meant', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();

    // The tempo is the discriminator: `mine` is chosen to differ from whatever
    // the demo's own is, so the value the session lands on names the song that
    // actually loaded — whichever demo this turns out to be.
    const { demo, song } = dropInDeclaring(['transport.bpm']);
    const demoBpm = song.params['transport.bpm']!;
    const mine = otherBpm(demoBpm);

    await busSet(page, 'transport.bpm', mine);
    const jsonDownload = page.waitForEvent('download');
    await page.getByTestId('song-save').click();
    await page.getByTestId('dialog-input').fill(demo.name);
    // No slot holds that name yet, so the save itself is silent (REQ-14c) — the
    // guard fires on a real clash, not on borrowing a demo's name.
    await page.getByTestId('dialog-confirm').click();
    await jsonDownload;
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);

    // Reveal once if needed; the row does not re-render, so it stays reachable.
    await clickDemo(page, demo.name);
    const demoBtn = page.getByTestId(`song-demo-${demo.name}`);
    const savedBpm = (): Promise<number | null> => page.evaluate((name) => {
      const raw = localStorage.getItem(`websynth.song.${name}`);
      return raw ? (JSON.parse(raw).params['transport.bpm'] as number) : null;
    }, demo.name);

    // Dismissing loads NEITHER — the case a yes/no confirm could not express.
    await expect(page.getByTestId('dialog-choice-mine')).toBeVisible();
    await page.getByTestId('dialog-cancel').click();
    await expect(page.getByTestId('dialog-choice-mine')).toHaveCount(0);
    expect(await busGet(page, 'transport.bpm')).toBe(mine);

    // "Load the demo" applies the demo and leaves the saved slot untouched.
    await demoBtn.click();
    await page.getByTestId('dialog-choice-demo').click();
    await expect.poll(() => busGet(page, 'transport.bpm')).toBe(demoBpm);
    expect(await savedBpm()).toBe(mine);

    // "Load mine" applies the stored slot instead — the demo button can now
    // reach the song the slot list was hiding behind the same name.
    await demoBtn.click();
    await page.getByTestId('dialog-choice-mine').click();
    await expect.poll(() => busGet(page, 'transport.bpm')).toBe(mine);
  });

  /**
   * session-autosave.md REQ-14d (regression): the zip demos persisted themselves
   * because they rode the *import* path, so clicking 1973 offered to replace a
   * saved 1973 while clicking a JSON demo ignored yours entirely. Demos are
   * content, not the user's work — neither kind writes a slot now.
   */
  test('clicking a demo writes no song slot', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    const slotKeys = (): Promise<string[]> => page.evaluate(
      () => Object.keys(localStorage).filter((k) => k.startsWith('websynth.song.')),
    );

    const dropIn = await pickDemo(page, 'drop-in');
    await clickDemo(page, dropIn.name);
    await expect.poll(() => sessionDisplay(page)).toBe(dropIn.name);
    expect(await slotKeys()).toEqual([]);

    // The zip demo is the one that used to write one. It carries sampler clips,
    // so it also proves the bundle path still applies without persisting.
    const zip = await pickDemo(page, 'zip');
    await clickDemo(page, zip.name);
    // The bundle's *inner* song name is not readable from Node without
    // inflating, so wait on the clips it decodes instead — read from the zip's
    // own entry names, which are stored uncompressed.
    await expect
      .poll(() => loadedSamplerSlots(page), { timeout: 20000 })
      .toEqual(expect.arrayContaining(zipClipSlots(zip.path!)));
    expect(await slotKeys()).toEqual([]);
    // …and it selected the loaded song in the slot list, as every demo does.
    await expect(page.getByTestId('song-slot-select')).toContainText(await sessionDisplay(page));
  });

  /**
   * session-autosave.md REQ-14c: Save was the one write with no guard at all —
   * typing a name another song already held destroyed it, with no dialog and no
   * undo. It asks now, except when the name IS the slot this session came from.
   */
  test('Save asks before landing on a song it did not come from', async ({ page }) => {
    await gotoAndStart(page);
    await page.getByTestId('tab-song').click();
    const savedBpm = (): Promise<number | null> => page.evaluate(() => {
      const raw = localStorage.getItem('websynth.song.test-guarded');
      return raw ? (JSON.parse(raw).params['transport.bpm'] as number) : null;
    });
    const saveAs = async (name: string): Promise<void> => {
      await page.getByTestId('song-save').click();
      await page.getByTestId('dialog-input').fill(name);
      await page.getByTestId('dialog-confirm').click();
    };

    // Both tempos differ from the demo's, so "which song is loaded" stays
    // readable off the BPM whichever demo the row happens to offer first.
    const { demo, song } = dropInDeclaring(['transport.bpm']);
    const demoBpm = song.params['transport.bpm']!;
    const first = otherBpm(demoBpm);
    const edited = first + 4;

    await busSet(page, 'transport.bpm', first);
    let jsonDownload = page.waitForEvent('download');
    await saveAs('test-guarded');
    await jsonDownload;
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);

    // Re-saving the song you are working on stays one click, edits and all.
    await busSet(page, 'transport.bpm', edited);
    jsonDownload = page.waitForEvent('download');
    await saveAs('test-guarded');
    await jsonDownload;
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    expect(await savedBpm()).toBe(edited);

    // A demo click means the session no longer belongs to that slot…
    await clickDemo(page, demo.name);
    await expect.poll(() => busGet(page, 'transport.bpm')).toBe(demoBpm);

    // …so saving onto it now asks, and Back leaves the saved song alone.
    await saveAs('test-guarded');
    await expect(page.getByText('A different song is already saved under this name.')).toBeVisible();
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(1); // the prompt has faded out
    await page.getByTestId('dialog-cancel').click();
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    expect(await savedBpm()).toBe(edited);

    // Confirming replaces it — and no file is downloaded for a declined save.
    await saveAs('test-guarded');
    await expect(page.getByText('A different song is already saved under this name.')).toBeVisible();
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(1);
    jsonDownload = page.waitForEvent('download');
    await page.getByTestId('dialog-confirm').click();
    await jsonDownload;
    await expect.poll(savedBpm).toBe(demoBpm);
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
