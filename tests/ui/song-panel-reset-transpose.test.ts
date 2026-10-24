// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { buildSongPanel } from '../../src/ui/panels/song-panel';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { Arrangement } from '../../src/audio/transport/arrangement';
import { UiBridge } from '../../src/ui/ui-bridge';
import { TestClock } from '../audio/transport/test-clock';
import { installLocalStorageMock } from '../storage-mock';

/**
 * arrangement.md REQ-a-seq-slot-carries-a-transpose (v10, regression): New and a
 * lane's Clear are resets, so they reset the slot transpose too. Both passed only
 * `[0]` as the steps, and an omitted transpose keeps the lane's — so slot 1's +5
 * survived into the "blank" chain.
 */

/** Every property another stub, every call one too — whatever the panel reaches for. */
function anything(): unknown {
  const fn = function () { /* stub */ };
  const proxy: unknown = new Proxy(fn, {
    get: (_t, key) => {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === Symbol.iterator) return function* () { /* empty */ };
      if (key === 'then') return undefined;
      return proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

function panel() {
  installLocalStorageMock();
  const bus = new ParamBus();
  registerDefaults(bus);
  const patterns = new PatternStore();
  const arrangement = new Arrangement(patterns, new TestClock());
  const stub = anything() as Record<PropertyKey, unknown>;
  // A real arrangement and pattern store; everything else the panel touches is a stub.
  const engine = new Proxy(stub, {
    get: (t, key) => key === 'arrangement' ? arrangement : key === 'patterns' ? patterns : t[key],
  }) as never;
  const a = anything() as never;
  const p = buildSongPanel(bus, engine, a, a, new UiBridge(), a, a);
  document.body.appendChild(p.el);
  return { arrangement };
}

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
    const { arrangement } = panel();
    arrangement.setSeqChain([0, 1], true, [5, 7]);
    click('chain-clear-seq');
    await confirm();
    expect(arrangement.seq.steps).toEqual([0]);
    expect(arrangement.seq.transpose).toEqual([0]);
  });

  it('New', async () => {
    const { arrangement } = panel();
    arrangement.setSeqChain([0, 1], true, [5, 7]);
    click('song-new');
    await confirm();
    expect(arrangement.seq.steps).toEqual([0]);
    expect(arrangement.seq.transpose).toEqual([0]);
  });
});
