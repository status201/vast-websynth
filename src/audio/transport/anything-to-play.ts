import { REST, type PatternStore } from '../../state/patterns';
import type { ChainLane } from './arrangement';

/**
 * Would starting the transport make ANY sound right now? The pure rule behind
 * the header's "nothing to play yet" hint (empty-play-hint.md REQ-2).
 *
 * A machine counts when it is switched on AND a bank it would actually play —
 * the distinct banks in its chain (RESTs skipped) when the lane is enabled,
 * its edit bank otherwise — has an active step. The sampler additionally
 * needs a loaded buffer on a triggered slot. An enabled arp counts
 * unconditionally: it sounds as soon as a key is held, so nagging it would
 * be wrong.
 *
 * Everything is injected (a `get` fn, the store, the lanes, the buffer array)
 * so the rule is unit-testable without an engine.
 */
export function anythingToPlay(
  get: (id: string) => number,
  patterns: PatternStore,
  lanes: { seq: ChainLane; drum: ChainLane; sampler: ChainLane },
  samplerBuffers: ReadonlyArray<AudioBuffer | null>,
): boolean {
  const on = (id: string): boolean => get(id) >= 0.5;
  const banks = (lane: ChainLane, edit: number): number[] =>
    lane.enabled ? [...new Set(lane.steps.filter((s) => s !== REST))] : [edit];

  if (on('arp.on')) return true;
  if (on('seq.on') && banks(lanes.seq, patterns.seqEditBank)
    .some((b) => patterns.seqBank(b).some((track) => track.some((s) => s.on)))) return true;
  if (on('drum.on') && banks(lanes.drum, patterns.drumEditBank)
    .some((b) => patterns.drumBank(b).some((track) => track.some((c) => c.on)))) return true;
  if (on('sampler.on') && banks(lanes.sampler, patterns.samplerEditBank)
    .some((b) => patterns.samplerBank(b).some((cells, slot) =>
      samplerBuffers[slot] != null && cells.some((c) => c.on)))) return true;
  return false;
}
