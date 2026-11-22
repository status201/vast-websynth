// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { mountSongPanel } from './song-panel-harness';

/**
 * arrangement.md REQ-a-seq-slot-carries-a-transpose (v10, regression): New and a
 * lane's Clear are resets, so they reset the slot transpose too. Both passed only
 * `[0]` as the steps, and an omitted transpose keeps the lane's — so slot 1's +5
 * survived into the "blank" chain.
 */

const click = (testid: string): void =>
  document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!.click();

/** Confirm the danger dialog the click opened. */
async function confirm(): Promise<void> {
  let btn: HTMLElement | null = null;
  for (let i = 0; i < 50 && !btn; i++) {
    await new Promise((r) => setTimeout(r, 0));
    btn = document.querySelector<HTMLElement>('[data-testid="dialog-confirm"]');
  }
  btn!.click();
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => { document.body.innerHTML = ''; });

describe('a reset clears the slot transpose', () => {
  it('Clear chain', async () => {
    const { arrangement } = mountSongPanel();
    arrangement.setSeqChain([0, 1], true, [5, 7]);
    click('chain-clear-seq');
    await confirm();
    expect(arrangement.seq.steps).toEqual([0]);
    expect(arrangement.seq.transpose).toEqual([0]);
  });

  it('New', async () => {
    const { arrangement } = mountSongPanel();
    arrangement.setSeqChain([0, 1], true, [5, 7]);
    click('song-new');
    await confirm();
    expect(arrangement.seq.steps).toEqual([0]);
    expect(arrangement.seq.transpose).toEqual([0]);
  });
});
