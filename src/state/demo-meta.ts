/**
 * What a demo song *is*, derived from the song itself — see
 * `specs/features/demo-library.md`.
 *
 * Pure and I/O-free on purpose: the generator (`scripts/clean-demos.ts`) runs it
 * over files, the tests run it over hand-built fixtures, and the UI reads the
 * result out of the generated index. Nothing here touches the filesystem, the
 * DOM or an AudioContext.
 */
import type { SongFile, ChainData } from './song';

/** A machine that will actually sound when the demo plays. */
export type DemoMachine = 'seq' | 'drums' | 'sampler' | 'motion';
/**
 * Something set up and waiting for a hand — see {@link demoMetaOf}.
 *
 * Deliberately only these two. A **staged effect** (dialled in, then bypassed or
 * closed to `mix: 0`) was specced as a third, and measured out: "any bypassed
 * effect with a non-default parameter" fires on **13 of the 15** shipped demos,
 * and the stricter "on but `mix` pinned to 0" fires on **none**. A hint that
 * appears on almost every button is not a hint, and one that never appears is
 * dead code. See demo-library.md REQ-4 before re-adding it.
 */
export type DemoArmed = 'arp' | 'motion';

export interface DemoMeta {
  /** The song's own `name` — what the demo button says. */
  name: string;
  /** `transport.bpm`, rounded. 0 when the song does not set one. */
  bpm: number;
  /** Longest enabled chain lane, matching `Arrangement.songBars`. 0 = no arrangement. */
  bars: number;
  uses: DemoMachine[];
  /** Omitted when empty, so a plain demo's entry stays small. */
  armed?: DemoArmed[];
  /** Hand-written, merged from `demo-notes.json`. Never generated. */
  blurb?: string;
}

const MACHINE_ORDER: readonly DemoMachine[] = ['seq', 'drums', 'sampler', 'motion'];

const on = (v: number | undefined): boolean => (v ?? 0) >= 0.5;

/** Longest **enabled** chain lane — the same rule `Arrangement.songBars` uses. */
function songBars(file: SongFile): number {
  const lanes: (ChainData | undefined)[] = [
    file.seqChain, file.drumChain, file.samplerChain, file.motionChain,
  ];
  let bars = 0;
  for (const lane of lanes) {
    if (lane?.enabled && lane.steps.length > bars) bars = lane.steps.length;
  }
  return bars;
}

/** Any step on, across every bank/track of a grid of `{on}` cells. */
const anyOn = (banks: readonly (readonly { on?: boolean }[])[] | undefined): boolean =>
  !!banks?.some((rows) => rows.some((c) => c.on === true));

const anyOn3 = (banks: readonly (readonly (readonly { on?: boolean }[])[])[] | undefined): boolean =>
  !!banks?.some((bank) => bank.some((row) => row.some((c) => c.on === true)));

/** Does the song carry motion data at all — anchors or an assigned track? */
function hasMotionData(file: SongFile): boolean {
  if (anyOn(file.motionBanks)) return true;
  return !!file.motionTracks?.some((bank) =>
    bank?.some((t) => t && t.param && t.steps.some((s) => s.on === true)));
}

/**
 * Everything about a demo that can be *derived* from it (demo-library.md REQ-1).
 * The blurb is the one thing that cannot, and is merged in by the generator.
 */
export function demoMetaOf(file: SongFile): Omit<DemoMeta, 'blurb'> {
  const params = file.params ?? {};
  const uses: DemoMachine[] = [];
  const armed: DemoArmed[] = [];

  // Track 1 lives in seqBanks, tracks 2-4 in the additive seqTracks (v6).
  const seqSounds = anyOn(file.seqBanks)
    || !!file.seqTracks?.some((bank) => bank?.some((t) => t?.some((s) => s.on === true)));
  if (seqSounds) uses.push('seq');
  if (anyOn3(file.drumBanks)) uses.push('drums');
  if (anyOn3(file.samplerBanks)) uses.push('sampler');

  // Motion is the one machine that can be present but switched off, and that is
  // a legitimate way to stage it for the player rather than a mistake.
  const motion = hasMotionData(file);
  if (motion && on(params['motion.on'])) uses.push('motion');
  else if (motion) armed.push('motion');

  // The arpeggiator follows the keyboard/MIDI and never the sequencer
  // (arpeggiator.md REQ-7), so an armed arp is ALWAYS armed and never "used".
  if (on(params['arp.on'])) armed.push('arp');

  const meta: Omit<DemoMeta, 'blurb'> = {
    name: file.name,
    bpm: Math.round(params['transport.bpm'] ?? 0),
    bars: songBars(file),
    uses: MACHINE_ORDER.filter((m) => uses.includes(m)),
  };
  if (armed.length > 0) meta.armed = armed;
  return meta;
}

const MACHINE_LABEL: Record<DemoMachine, string> = {
  seq: 'seq', drums: 'drums', sampler: 'sampler', motion: 'motion',
};
const ARMED_LABEL: Record<DemoArmed, string> = {
  arp: 'hold a key: arp armed',
  motion: 'motion ready — switch it on',
};

/**
 * The one-line summary a demo button's `title` shows (demo-library.md REQ-6):
 * `124 BPM · 16 bars · seq + drums · arp armed — <blurb>`.
 *
 * Each fact is dropped when it is unknown rather than shown as a zero: "0 bars"
 * is worse than saying nothing.
 */
export function demoSummary(meta: DemoMeta): string {
  const facts: string[] = [];
  if (meta.bpm > 0) facts.push(`${meta.bpm} BPM`);
  if (meta.bars > 0) facts.push(`${meta.bars} bar${meta.bars === 1 ? '' : 's'}`);
  if (meta.uses.length > 0) facts.push(meta.uses.map((m) => MACHINE_LABEL[m]).join(' + '));
  for (const a of meta.armed ?? []) facts.push(ARMED_LABEL[a]);
  const head = facts.join(' · ');
  if (!meta.blurb) return head;
  return head ? `${head} — ${meta.blurb}` : meta.blurb;
}
