import type { SongFile } from '../../src/state/song';
import type { SeqStep, DrumCell } from '../../src/state/patterns';
import {
  SEQ_LENGTH, BANK_COUNT, DRUM_TRACK_COUNT, TRIGGER_CELL_DEFAULTS,
} from '../../src/state/patterns';

/**
 * The suite's own song file.
 *
 * **No shipped demo is a test fixture.** A demo is *content* —
 * `src/state/demos/**` is an SDD-exempt drop-in directory, and
 * `specs/recipes/add-a-demo-song.md` promises that adding or editing one needs no
 * code change. A test that pins a demo's BPM or step notes quietly revokes that
 * promise: the suite then fails for a data edit that broke nothing. This file is
 * what those tests assert against instead, and it is owned by the tests, so its
 * values only change when a test wants them to.
 * (The rule is `specs/recipes/write-a-test.md`; `tests/no-shipped-demo-names.test.ts`
 * enforces it.)
 *
 * Deliberately a **v1** file with no sampler and no motion sections — that is the
 * backward-compatibility shape the load path must keep accepting (ADR-007), and
 * it is what the retired built-in fixture happened to be, so the migration tests
 * that leaned on "the fixture is v1" keep meaning what they meant.
 *
 * Built as an explicit literal rather than via `Song.capture`, which would stamp
 * the current `SONG_VERSION` and grow every optional section.
 */
export const FIXTURE = {
  /** The reserved `test-` prefix: no shipped demo may claim it, so this name can
   *  never collide with a demo button or a slot the app offers. */
  name: 'test-fixture-song',
  bpm: 137,
  /** Deliberately long, so rounding and re-compaction idempotence have something
   *  to bite on (ADR-011). `compactSongForExport` emits `cutoffRounded`. */
  cutoff: 60.03635787963867,
  cutoffRounded: 60.04,

  /** An otherwise-default sounded step — the one that proves sparse cells
   *  re-expand to their defaults on `restore`. Step 0 stays a rest. */
  plainStep: 2,
  plainNote: 69,
  /** A step carrying every per-step setting at once (step-settings.md). */
  settingsStep: 5,
  settingsNote: 72,
  settingsProb: 0.35,
  settingsRatchet: 3,

  /** A drum cell with a choked gate, and one with a ghost probability. */
  chokedTrack: 3, chokedStep: 2, chokedGate: 0.45,
  ghostTrack: 2, ghostStep: 1, ghostProb: 0.35,

  seqChain: [0, 1, 2, 3],
  drumChain: [0, 0, 0, 1],
  xy: { x: 'osc1.octave', y: 'osc2.octave' },
} as const;

/**
 * Params are a **partial** map on purpose: `apply()` resets every registered
 * param the file omits back to its default, and `fx.drum.delay.on` is the key the
 * test for that behaviour flips beforehand — so this map must never grow it.
 */
function fixtureParams(): Record<string, number> {
  return {
    'transport.bpm': FIXTURE.bpm,
    'voicing.mode': 0, // mono
    'osc1.wave': 2, 'osc1.octave': 0, 'osc1.level': 0.85,
    'osc2.wave': 3, 'osc2.octave': -1, 'osc2.detune': 12, 'osc2.level': 0.4,
    'filter.cutoff': FIXTURE.cutoff, 'filter.resonance': 0.6, 'filter.drive': 2,
    'env.amp.attack': 0.004, 'env.amp.decay': 0.15,
    'fx.drum.comp.ratio': 4,
  };
}

const seqStep = (i: number, over: Partial<SeqStep> = {}): SeqStep => ({
  on: false, note: 60 + (i % 8), velocity: 0.8, gate: 0.5,
  prob: 1, ratchet: 1, tie: false, ...over,
});

function fixtureSeqBank(bank: number): SeqStep[] {
  const steps = Array.from({ length: SEQ_LENGTH }, (_, i) => seqStep(i));
  // Bank 0 carries the pinned cells; the other banks differ only enough to be
  // distinguishable, so a chain of [0,1,2,3] plays four unlike bars.
  steps[FIXTURE.plainStep] = seqStep(FIXTURE.plainStep, {
    on: true, note: FIXTURE.plainNote + bank,
  });
  steps[FIXTURE.settingsStep] = seqStep(FIXTURE.settingsStep, {
    on: true, note: FIXTURE.settingsNote + bank,
    prob: FIXTURE.settingsProb, ratchet: FIXTURE.settingsRatchet, tie: true,
  });
  return steps;
}

function fixtureDrumBank(bank: number): DrumCell[][] {
  const grid = Array.from({ length: DRUM_TRACK_COUNT }, () =>
    Array.from({ length: SEQ_LENGTH }, (): DrumCell => ({ ...TRIGGER_CELL_DEFAULTS })));
  // A four-on-the-floor kick, all-default apart from `on` — the cell that proves
  // a sparse `{ on: true }` re-expands to gate 1 / ratchet 1 / tie false.
  for (let s = 0; s < SEQ_LENGTH; s += 4) grid[0]![s] = { ...TRIGGER_CELL_DEFAULTS, on: true };
  if (bank === 0) {
    grid[FIXTURE.chokedTrack]![FIXTURE.chokedStep] = {
      ...TRIGGER_CELL_DEFAULTS, on: true, gate: FIXTURE.chokedGate,
    };
    grid[FIXTURE.ghostTrack]![FIXTURE.ghostStep] = {
      ...TRIGGER_CELL_DEFAULTS, on: true, prob: FIXTURE.ghostProb,
    };
  }
  return grid;
}

/** A fresh, deeply-mutable copy — tests edit it in place (strip cells to the
 *  legacy shape, delete `xy`, downgrade `version`), so it must never be shared. */
export function fixtureSong(): SongFile {
  return {
    format: 'websynth-song',
    version: 1,
    name: FIXTURE.name,
    params: fixtureParams(),
    seqBanks: Array.from({ length: BANK_COUNT }, (_, b) => fixtureSeqBank(b)),
    drumBanks: Array.from({ length: BANK_COUNT }, (_, b) => fixtureDrumBank(b)),
    seqChain: { enabled: true, steps: [...FIXTURE.seqChain] },
    drumChain: { enabled: true, steps: [...FIXTURE.drumChain] },
    xy: { ...FIXTURE.xy },
  };
}
