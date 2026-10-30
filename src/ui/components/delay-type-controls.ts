import type { ParamBus } from '../../state/params';
import { DELAY_TYPE_LABELS } from '../../state/delay';
import { typeDropdown } from './param-dropdown';
import { dimWhileParamIs, type Knob } from './knob';

/**
 * The delay's face, shared by the synth rack's Delay panel and the drum and
 * sampler DELAY header groups, so the three cannot drift apart
 * (delay-types.md REQ-type-is-a-header-dropdown-and-char-a-knob).
 */

/** The delay's knobs, left to right: param suffix and label. */
export const DELAY_KNOBS = [['time', 'TIME'], ['feedback', 'FB'], ['char', 'CHAR'], ['mix', 'MIX']] as const;

/**
 * The TYPE dropdown (REQ-delay-type-testids): after the title in a header group,
 * or, given a `legend`, the synth panel's title itself (REQ-type-is-a-header-dropdown-and-char-a-knob).
 */
export function delayTypeDropdown(bus: ParamBus, prefix: string, legend?: string): HTMLElement {
  return typeDropdown(bus, prefix, DELAY_TYPE_LABELS, legend);
}

/** Dim CHAR while TYPE is DIGITAL, which ignores it. */
export function dimCharAtDigital(bus: ParamBus, prefix: string, knobs: readonly Knob[]): void {
  dimWhileParamIs(bus, `${prefix}.type`, (v) => Math.round(v) === 0, [`${prefix}.char`], knobs);
}
