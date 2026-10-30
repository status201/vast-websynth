import type { ParamBus } from '../../state/params';
import { DIRT_TYPE_LABELS } from '../../state/dirt';
import { typeDropdown } from './param-dropdown';

/**
 * Dirt's face, shared by the synth rack's Dirt panel and the sampler's DIRT
 * header group, so the two cannot drift apart (dirt-types.md
 * REQ-dirt-type-is-the-panel-title).
 */

/** Dirt's knobs, left to right: param suffix and label. */
export const DIRT_KNOBS = [['drive', 'DRIVE'], ['tone', 'TONE'], ['mix', 'MIX']] as const;

/**
 * The TYPE dropdown (REQ-dirt-type-testids): after the title in a header group,
 * or, given a `legend`, the synth panel's title itself.
 */
export function dirtTypeDropdown(bus: ParamBus, prefix: string, legend?: string): HTMLElement {
  return typeDropdown(bus, prefix, DIRT_TYPE_LABELS, legend);
}
