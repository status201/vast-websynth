// The one source of truth for "is this machine on, muted, or off" — read by the
// tab bar's status LEDs and the Song panel (machine-status.md REQ-1). The rule
// layers on top of `audibleLanes` rather than re-deriving mute/solo, so the LED
// can never disagree with what you hear.
//
// Split into a pure core (`machineStatus`) plus thin ParamBus adapters, so the
// truth table is unit-testable without a bus.

import type { ParamBus } from '../state/params';
import { audibleLanes, type LaneFlags } from '../audio/transport/lane-mix';

/** The four step machines. Note these are the *param* prefixes (`drum`, not `drums`). */
export type MachineId = 'seq' | 'drum' | 'sampler' | 'motion';

/** `off` = disabled; `muted` = enabled but inaudible; `on` = enabled and audible. */
export type MachineState = 'off' | 'muted' | 'on';

export const MACHINE_IDS: readonly MachineId[] = ['seq', 'drum', 'sampler', 'motion'];

/** Param prefix -> `TabContainer` id. Only `drum` differs from its tab (`drums`). */
export const MACHINE_TAB: Record<MachineId, string> = {
  seq: 'seq',
  drum: 'drums',
  sampler: 'sampler',
  motion: 'motion',
};

export type MachineFlags = Record<MachineId, boolean>;

/**
 * Pure state rule (machine-status.md REQ-2). A machine that is off stays off
 * whatever its mixer state. Otherwise the three audio lanes defer to
 * `audibleLanes` (solo wins over mute); motion has no solo and makes no sound,
 * so it is muted purely by its own flag.
 */
export function machineStatus(
  on: MachineFlags,
  mute: MachineFlags,
  solo: LaneFlags,
): Record<MachineId, MachineState> {
  const audible = audibleLanes(
    { seq: mute.seq, drum: mute.drum, sampler: mute.sampler },
    solo,
  );
  const state = (m: MachineId): MachineState => {
    if (!on[m]) return 'off';
    const silent = m === 'motion' ? mute.motion : !audible[m];
    return silent ? 'muted' : 'on';
  };
  return { seq: state('seq'), drum: state('drum'), sampler: state('sampler'), motion: state('motion') };
}

/** Read one boolean suffix across the three audio lanes (`mute` / `solo`). */
export function laneFlags(bus: ParamBus, suffix: string): LaneFlags {
  return {
    seq: bus.get(`seq.${suffix}`) >= 0.5,
    drum: bus.get(`drum.${suffix}`) >= 0.5,
    sampler: bus.get(`sampler.${suffix}`) >= 0.5,
  };
}

function machineFlags(bus: ParamBus, suffix: string): MachineFlags {
  const lanes = laneFlags(bus, suffix);
  return { ...lanes, motion: bus.get(`motion.${suffix}`) >= 0.5 };
}

export function readMachineStatus(bus: ParamBus): Record<MachineId, MachineState> {
  return machineStatus(machineFlags(bus, 'on'), machineFlags(bus, 'mute'), laneFlags(bus, 'solo'));
}

/**
 * Subscribe to every param the status depends on (11 of them). Returns a
 * disposer that drops them all. `ParamBus.subscribe` fires immediately with the
 * current value, so this also drives the initial paint — no separate seed call.
 */
export function subscribeMachineStatus(bus: ParamBus, fn: () => void): () => void {
  const offs: Array<() => void> = [];
  for (const m of MACHINE_IDS) {
    offs.push(bus.subscribe(`${m}.on`, fn));
    offs.push(bus.subscribe(`${m}.mute`, fn));
    // Motion has no solo — it is not an audio lane.
    if (m !== 'motion') offs.push(bus.subscribe(`${m}.solo`, fn));
  }
  return () => { for (const off of offs) off(); };
}
