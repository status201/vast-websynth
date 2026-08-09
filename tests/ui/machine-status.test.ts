import { describe, it, expect } from 'vitest';
import {
  machineStatus,
  readArpStatus,
  subscribeArpStatus,
  type MachineFlags,
  type MachineId,
  type MachineState,
} from '../../src/ui/machine-status';
import { ParamBus, registerDefaults } from '../../src/state/params';
import type { LaneFlags } from '../../src/audio/transport/lane-mix';

const NONE: MachineFlags = { seq: false, drum: false, sampler: false, motion: false };
const ALL: MachineFlags = { seq: true, drum: true, sampler: true, motion: true };
const NO_SOLO: LaneFlags = { seq: false, drum: false, sampler: false };

const flags = (over: Partial<MachineFlags> = {}): MachineFlags => ({ ...NONE, ...over });
const solos = (over: Partial<LaneFlags> = {}): LaneFlags => ({ ...NO_SOLO, ...over });

/** All four machines enabled, nothing muted, nothing soloed. */
const status = (
  on: MachineFlags = ALL,
  mute: MachineFlags = NONE,
  solo: LaneFlags = NO_SOLO,
): Record<MachineId, MachineState> => machineStatus(on, mute, solo);

describe('machineStatus', () => {
  it('reports every enabled, unmuted machine as on', () => {
    expect(status()).toEqual({ seq: 'on', drum: 'on', sampler: 'on', motion: 'on' });
  });

  it('reports a disabled machine as off whatever its mixer state', () => {
    // drum is off but also muted AND soloed — `off` must win over both.
    const s = status(flags({ seq: true, sampler: true, motion: true }), flags({ drum: true }), solos({ drum: true }));
    expect(s.drum).toBe('off');
  });

  it('reports an enabled but self-muted machine as muted', () => {
    expect(status(ALL, flags({ sampler: true })).sampler).toBe('muted');
  });

  it("mutes an unmuted lane when another lane is soloed (solo wins)", () => {
    const s = status(ALL, NONE, solos({ seq: true }));
    expect(s.seq).toBe('on');
    expect(s.drum).toBe('muted');
    expect(s.sampler).toBe('muted');
  });

  it('keeps a soloed lane audible even when it is also muted', () => {
    // Standard DAW behaviour, inherited from audibleLanes.
    const s = status(ALL, flags({ drum: true }), solos({ drum: true }));
    expect(s.drum).toBe('on');
  });

  it('ignores solo for motion, which is not an audio lane', () => {
    // Another lane soloing must not silence the motion machine.
    expect(status(ALL, NONE, solos({ seq: true })).motion).toBe('on');
  });

  it('mutes motion from its own flag only', () => {
    expect(status(ALL, flags({ motion: true })).motion).toBe('muted');
    expect(status(flags({ seq: true, drum: true, sampler: true })).motion).toBe('off');
  });
});

// machine-status.md REQ-10 — the arp lamp. Two states, not three: the arp is not
// an audio lane, so it has no mute, solo or chain to dim it.
//
// The defs must be registered: `ParamBus.set` on an *unregistered* id writes once
// and notifies nobody, so a bare bus would silently pass every assertion below.
const newBus = (): ParamBus => {
  const bus = new ParamBus();
  registerDefaults(bus);
  return bus;
};

describe('readArpStatus', () => {
  it('reads off at the param default and on once armed', () => {
    const bus = newBus();
    expect(readArpStatus(bus)).toBe('off');
    bus.set('arp.on', 1);
    expect(readArpStatus(bus)).toBe('on');
    bus.set('arp.on', 0);
    expect(readArpStatus(bus)).toBe('off');
  });

  it('never reports muted, whatever the mixer is doing', () => {
    // Every lane muted and another soloed — none of it reaches the arp.
    const bus = newBus();
    bus.set('arp.on', 1);
    for (const m of ['seq', 'drum', 'sampler', 'motion']) bus.set(`${m}.mute`, 1);
    bus.set('seq.solo', 1);
    expect(readArpStatus(bus)).toBe('on');
  });

  it('subscribes to arp.on, paints immediately, and disposes', () => {
    const bus = newBus();
    const seen: MachineState[] = [];
    const off = subscribeArpStatus(bus, () => { seen.push(readArpStatus(bus)); });
    // `subscribe` fires with the current value, so this is the initial paint.
    expect(seen).toEqual(['off']);

    bus.set('arp.on', 1);
    expect(seen).toEqual(['off', 'on']);

    off();
    bus.set('arp.on', 0);
    expect(seen).toEqual(['off', 'on']);
  });
});
