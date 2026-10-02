import { describe, it, expect } from 'vitest';
import { scheduleBend } from '../../src/audio/note-bend';

/**
 * The per-note bend's automation (step-settings.md REQ-bend-shapes-are-scoop-and-fall,
 * REQ-a-bend-zero-schedules-nothing). The shared mock `AudioParam` keeps no event
 * list, so this records the calls themselves — the order matters as much as the
 * values (a cancel must be followed by an anchoring setValueAtTime).
 */
type Call = [string, ...number[]];

function recordingParam(): { param: AudioParam; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (name: string) => (...args: number[]) => { calls.push([name, ...args]); return param; };
  const param = {
    value: 0,
    cancelScheduledValues: rec('cancel'),
    setValueAtTime: rec('set'),
    linearRampToValueAtTime: rec('ramp'),
  } as unknown as AudioParam;
  return { param, calls };
}

describe('scheduleBend', () => {
  it('bend 0 on a clean param writes nothing (REQ-a-bend-zero-schedules-nothing, regression)', () => {
    const { param, calls } = recordingParam();
    expect(scheduleBend(param, undefined, 1, false)).toBe(false);
    expect(scheduleBend(param, { semis: 0, shape: 'fall', dur: 0.1 }, 1, false)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a scoop is pinned away from the note and ramps onto it', () => {
    const { param, calls } = recordingParam();
    const dirty = scheduleBend(param, { semis: -2, shape: 'scoop', dur: 0.1 }, 1, false);
    expect(dirty).toBe(true);
    expect(calls).toEqual([['cancel', 1], ['set', -200, 1], ['ramp', 0, 1.1]]);
  });

  it('a fall leaves the note and holds (nothing returns it to 0)', () => {
    const { param, calls } = recordingParam();
    scheduleBend(param, { semis: 12, shape: 'fall', dur: 0.25 }, 2, false);
    expect(calls).toEqual([['cancel', 2], ['set', 0, 2], ['ramp', 1200, 2.25]]);
  });

  it('a reused voice does not inherit a fall, and resets only once (edge)', () => {
    const { param, calls } = recordingParam();
    let dirty = scheduleBend(param, { semis: 12, shape: 'fall', dur: 0.1 }, 0, false);
    calls.length = 0;
    dirty = scheduleBend(param, undefined, 0.5, dirty);
    expect(dirty).toBe(false);
    expect(calls).toEqual([['cancel', 0.5], ['set', 0, 0.5]]);
    calls.length = 0;
    scheduleBend(param, undefined, 1, dirty);
    expect(calls).toEqual([]);
  });

  it('a zero-length bend still ramps forward in time', () => {
    const { param, calls } = recordingParam();
    scheduleBend(param, { semis: 1, shape: 'scoop', dur: 0 }, 3, false);
    const ramp = calls.find((c) => c[0] === 'ramp')!;
    expect(ramp[2]).toBeGreaterThan(3);
  });
});
