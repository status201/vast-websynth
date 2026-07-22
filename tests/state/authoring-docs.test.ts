// @vitest-environment node
//
// Drift pins for the *published* authoring docs: the author-dialect JSON
// Schema and llms.txt are static files, so these tests fail loudly if the
// structural constants in patterns.ts ever change without them.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SEQ_LENGTH,
  SEQ_TRACK_COUNT,
  BANK_COUNT,
  DRUM_TRACKS,
  SAMPLER_SLOT_COUNT,
} from '../../src/state/patterns';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../public/${rel}`, import.meta.url)), 'utf8');

describe('websynth-song-author.schema.json', () => {
  const schema = JSON.parse(read('schema/websynth-song-author.schema.json')) as Record<string, any>;

  it('is a draft 2020-12 schema for the author format', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.properties.format.const).toBe('websynth-song-author');
    expect(schema.properties.version.const).toBe(1);
    expect(schema.required).toEqual(['format', 'version', 'name']);
  });

  it('bank/step/slot dimensions match patterns.ts', () => {
    for (const key of ['seq', 'drums', 'sampler', 'motion']) {
      expect(schema.properties[key].maxItems, key).toBe(BANK_COUNT);
    }
    const [positional, defaults, tracks] = schema.$defs.seqBank.oneOf;
    expect(positional.maxItems).toBe(SEQ_LENGTH);
    expect(defaults.properties.notes.maxItems).toBe(SEQ_LENGTH);
    // v6 multi-track form — capped at the real track count (sequencer.md REQ-8).
    expect(tracks.properties.tracks.maxItems).toBe(SEQ_TRACK_COUNT);
    expect(schema.properties.sampleNames.maxItems).toBe(SAMPLER_SLOT_COUNT);
    // Hits address steps 0..15; chains address banks -1..3.
    const [hitIdx, hitObj] = schema.$defs.hit.oneOf;
    expect(hitIdx.maximum).toBe(SEQ_LENGTH - 1);
    expect(hitObj.properties.step.maximum).toBe(SEQ_LENGTH - 1);
    const [, chainArr, chainObj] = schema.$defs.chain.oneOf;
    expect(chainArr.items.minimum).toBe(-1);
    expect(chainArr.items.maximum).toBe(BANK_COUNT - 1);
    expect(chainObj.properties.steps.items.maximum).toBe(BANK_COUNT - 1);
  });

  it('motion anchors mirror the expander (steps 0..15, coords 0..1)', () => {
    const anchor = schema.$defs.motionAnchor;
    expect(anchor.required).toEqual(['step', 'x', 'y']);
    expect(anchor.properties.step.maximum).toBe(SEQ_LENGTH - 1);
    expect(anchor.properties.x).toMatchObject({ minimum: 0, maximum: 1 });
    expect(anchor.properties.y).toMatchObject({ minimum: 0, maximum: 1 });
    expect(schema.properties.motionChain.$ref).toBe('#/$defs/chain');
  });

  it('note names and step settings mirror the expander', () => {
    const [midi, name] = schema.$defs.note.oneOf;
    expect(midi.minimum).toBe(0);
    expect(midi.maximum).toBe(127);
    expect(new RegExp(name.pattern).test('C#4')).toBe(true);
    expect(new RegExp(name.pattern).test('Db-1')).toBe(true);
    expect(new RegExp(name.pattern).test('H4')).toBe(false);
    expect(schema.$defs.stepSettings.ratchet).toMatchObject({ minimum: 1, maximum: 4 });
  });
});

describe('llms.txt', () => {
  const txt = read('llms.txt');

  it('names both formats and both schema URLs', () => {
    expect(txt).toContain('websynth-song-author');
    expect(txt).toContain('`websynth-song`');
    expect(txt).toContain('/schema/websynth-song-author.schema.json');
    expect(txt).toContain('/schema/websynth-song.schema.json');
  });

  it('pins the grid dimensions and drum track names', () => {
    expect(txt).toContain(`seqBanks[${BANK_COUNT}][${SEQ_LENGTH}]`);
    expect(txt).toContain(`drumBanks[${BANK_COUNT}][${DRUM_TRACKS.length}][${SEQ_LENGTH}]`);
    for (const t of DRUM_TRACKS) expect(txt).toContain(t);
  });

  it('points at the in-app AI Prompt instead of duplicating the params table', () => {
    expect(txt).toContain('AI Prompt');
    // The live table is bus-generated; llms.txt must not carry param ids that drift.
    expect(txt).not.toMatch(/env\.amp\.attack|fx\.delay\.mix/);
  });
});
