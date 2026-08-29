import { describe, it, expect, vi, afterEach } from 'vitest';
import { DrumMachine } from '../../../src/audio/transport/drum-machine';
import { PatternStore } from '../../../src/state/patterns';
import { makeMockAudioContext, type MockAudioContext } from '../mock-audio-context';
import type { Arrangement } from '../../../src/audio/transport/arrangement';
import type { Performance } from '../../../src/audio/transport/performance';
import type { TickSubscriber } from '../../../src/audio/transport/tick-source';

/**
 * Swapping a track's voice model (drum-machine.md REQ-11/REQ-19).
 *
 * The swap used to call `output.disconnect()` on the outgoing voice in the same
 * turn — a hard cut of whatever it was still sounding. That matters because
 * stopping the transport does **not** silence a drum hit (only the sampler is
 * stopped), so a cymbal rings for seconds after Stop, and a song load writes
 * `drum.t{i}.model` twice per track (song-mode.md REQ-17). It was heard as a
 * click on loading a demo with the transport stopped.
 */

const tickSource = (): TickSubscriber => ({
  onTick: () => () => {},
  onSeek: () => () => {},
});

const perf = (): Performance => ({ mapStep: (s: number) => s }) as unknown as Performance;

function build(): { dm: DrumMachine; ctx: MockAudioContext } {
  const ctx = makeMockAudioContext();
  const dm = new DrumMachine(
    ctx as unknown as AudioContext,
    tickSource(),
    new PatternStore(),
    { seq: { steps: [0] } } as unknown as Arrangement,
    perf(),
    ctx.createGain() as unknown as GainNode,
  );
  return { dm, ctx };
}

/** The model index a track is NOT already on, so the swap is a real change. */
const otherModel = (track: number): number => (track === 0 ? 1 : 0);

afterEach(() => { vi.useRealTimers(); });

describe('DrumMachine.setTrackModel (REQ-19)', () => {
  it('ramps the outgoing voice down and disconnects it later, never in the same turn', () => {
    vi.useFakeTimers();
    const { dm } = build();
    const old = dm.tracks[0]!;
    const disconnect = old.output.disconnect as unknown as ReturnType<typeof vi.fn>;
    const gain = old.output.gain as unknown as { setTargetAtTime: ReturnType<typeof vi.fn> };

    dm.setTrackModel(0, otherModel(0));

    // The replacement is live immediately (it is silent until triggered) …
    expect(dm.tracks[0]).not.toBe(old);
    // … while the outgoing voice is ramped, not severed.
    expect(gain.setTargetAtTime).toHaveBeenCalledWith(0, expect.any(Number), expect.any(Number));
    expect(disconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(disconnect).toHaveBeenCalled();
  });

  it('two swaps inside the window settle on the last, without a stray disconnect', () => {
    vi.useFakeTimers();
    const { dm } = build();
    const first = dm.tracks[0]!;

    dm.setTrackModel(0, 1);
    const second = dm.tracks[0]!;
    vi.advanceTimersByTime(10); // inside the fade window
    dm.setTrackModel(0, 2);
    const third = dm.tracks[0]!;

    vi.advanceTimersByTime(200);
    // Both superseded voices are gone, and the survivor is untouched.
    expect(first.output.disconnect).toHaveBeenCalled();
    expect(second.output.disconnect).toHaveBeenCalled();
    expect(third.output.disconnect).not.toHaveBeenCalled();
    expect(dm.tracks[0]).toBe(third);
  });

  it('a no-op model write touches nothing at all', () => {
    vi.useFakeTimers();
    const { dm } = build();
    const old = dm.tracks[0]!;
    const gain = old.output.gain as unknown as { setTargetAtTime: ReturnType<typeof vi.fn> };

    dm.setTrackModel(0, 0); // track 0 already boots on model 0

    expect(dm.tracks[0]).toBe(old);
    expect(gain.setTargetAtTime).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(old.output.disconnect).not.toHaveBeenCalled();
  });
});
