import { describe, it, expect } from 'vitest';
import {
  buildPresetFile, buildBankFile, parsePresetPayload, describePresetPayload,
  planImport, presetFilename, bankFilename, sameSnapshot,
} from '../../src/state/preset-file';
import { ParamBus, registerDefaults } from '../../src/state/params';

/**
 * presets.md REQ-7..REQ-11. Everything here is pure — no Storage mock, no DOM:
 * the whole import decision is a function of incoming × existing × policy.
 */

const A = { 'filter.cutoff': 80, 'osc1.level': 0.5 };
const B = { 'filter.cutoff': 40, 'osc1.level': 0.5 };

describe('sameSnapshot (REQ-8)', () => {
  it('compares at the 4-sig-fig boundary save() writes at', () => {
    expect(sameSnapshot({ a: 0.123456789 }, { a: 0.1235 })).toBe(true);
    expect(sameSnapshot({ a: 0.1 }, { a: 0.2 })).toBe(false);
  });

  it('a differing key set is never equal', () => {
    expect(sameSnapshot({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe('file building (REQ-7)', () => {
  it('a preset file tags its format and rounds its params', () => {
    const f = buildPresetFile('MyLead', { 'filter.cutoff': 80.123456 });
    expect(f).toMatchObject({ format: 'websynth-preset', version: 1, name: 'MyLead' });
    expect(f.params['filter.cutoff']).toBe(80.12);
  });

  it('a bank file keys its presets by name', () => {
    const f = buildBankFile('mine', { one: A, two: B });
    expect(f.format).toBe('websynth-preset-bank');
    expect(Object.keys(f.presets)).toEqual(['one', 'two']);
  });

  it('filenames sanitize like Song.download and carry the family extension', () => {
    expect(presetFilename('My Lead!')).toBe('My_Lead_.preset.websynth.json');
    expect(bankFilename('set 1')).toBe('set_1.bank.websynth.json');
    // Exactly Song.download's behaviour: punctuation collapses to '_' (which is
    // a usable name), and only a fully empty result falls back.
    expect(presetFilename('///')).toBe('_.preset.websynth.json');
    expect(presetFilename('')).toBe('preset.preset.websynth.json');
    expect(bankFilename('')).toBe('bank.bank.websynth.json');
  });
});

describe('parsePresetPayload (REQ-11)', () => {
  it('round-trips a preset file, collapsing it to a one-entry map', () => {
    const res = parsePresetPayload(JSON.stringify(buildPresetFile('MyLead', A)));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe('preset');
    expect(res.presets).toEqual({ MyLead: A });
  });

  it('round-trips a bank file', () => {
    const res = parsePresetPayload(JSON.stringify(buildBankFile('mine', { one: A, two: B })));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe('bank');
    expect(Object.keys(res.presets)).toEqual(['one', 'two']);
  });

  it('names the expected format when the tag is wrong', () => {
    const res = parsePresetPayload('{"format":"nope"}');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toContain('websynth-preset');
  });

  it('points a song file at the Song tab rather than reporting a schema failure', () => {
    const res = parsePresetPayload('{"format":"websynth-song","version":4}');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toContain('song file');
  });

  it('rejects non-JSON, a non-numeric params map, and an empty bank', () => {
    expect(parsePresetPayload('not json').ok).toBe(false);
    expect(parsePresetPayload('{"format":"websynth-preset","params":{"a":"x"}}').ok).toBe(false);
    expect(parsePresetPayload('{"format":"websynth-preset-bank","presets":{}}').ok).toBe(false);
    expect(parsePresetPayload('{"format":"websynth-preset-bank"}').ok).toBe(false);
  });

  // preset-authoring.md REQ-8 — the app's door now runs the registry checks, but
  // only the structural layer decides `ok`. That is the whole safety argument:
  // nothing that imported before starts being refused.
  it('given the bus, warns where it used to say nothing', () => {
    const b = new ParamBus();
    registerDefaults(b);
    const text = JSON.stringify(buildPresetFile('hot', { 'filter.cutoff': 9000 }));

    const blind = parsePresetPayload(text);
    expect(blind.ok).toBe(true);
    if (blind.ok) expect(blind.warnings).toBeUndefined();

    const seeing = parsePresetPayload(text, b);
    expect(seeing.ok).toBe(true);
    if (seeing.ok) expect((seeing.warnings ?? []).join(' ')).toContain('filter.cutoff');
  });

  it('ok is identical with and without the bus, for every shape', () => {
    const b = new ParamBus();
    registerDefaults(b);
    for (const text of [
      'not json',
      '{"format":"nope"}',
      '{"format":"websynth-song","version":4}',
      '{"format":"websynth-preset","params":{"a":"x"}}',
      '{"format":"websynth-preset-bank","presets":{}}',
      JSON.stringify(buildPresetFile('invented', { 'osc1.shape': 1 })),
      JSON.stringify(buildPresetFile('hot', { 'filter.cutoff': 9000 })),
      JSON.stringify(buildBankFile('mine', { one: A, two: B })),
    ]) {
      expect(parsePresetPayload(text, b).ok, text).toBe(parsePresetPayload(text).ok);
    }
  });

  it('describePresetPayload sniffs the family for the song importer', () => {
    expect(describePresetPayload(JSON.stringify(buildPresetFile('x', A)))).toBe('preset');
    expect(describePresetPayload(JSON.stringify(buildBankFile('x', { a: A })))).toBe('bank');
    expect(describePresetPayload('{"format":"websynth-song"}')).toBeNull();
    expect(describePresetPayload('<html>')).toBeNull();
  });
});

describe('planImport (REQ-10)', () => {
  it('classifies new / identical / conflicting', () => {
    const plan = planImport({ fresh: A, same: A, clash: B }, { same: A, clash: A }, 'rename');
    expect(plan.counts).toMatchObject({ new: 1, identical: 1, conflict: 1 });
    expect(plan.rows.map((r) => r.status)).toEqual(['new', 'identical', 'conflict']);
  });

  it('renames a conflict to the first free suffix, leaving the stored one alone', () => {
    const plan = planImport({ lead: B }, { lead: A }, 'rename');
    expect(plan.writes).toEqual([{ source: 'lead', target: 'lead 2', status: 'conflict' }]);
  });

  it('skips suffixes already taken', () => {
    const plan = planImport({ lead: B }, { lead: A, 'lead 2': A, 'lead 3': A }, 'rename');
    expect(plan.writes[0]!.target).toBe('lead 4');
  });

  it('does not collide two renamed conflicts with each other (edge)', () => {
    const plan = planImport({ lead: B, pad: B }, { lead: A, pad: A }, 'rename');
    expect(plan.writes.map((w) => w.target)).toEqual(['lead 2', 'pad 2']);
  });

  it('overwrite writes in place; skip drops the conflict entirely', () => {
    const over = planImport({ fresh: A, lead: B }, { lead: A }, 'overwrite');
    expect(over.writes.map((w) => w.target)).toEqual(['fresh', 'lead']);

    const skip = planImport({ fresh: A, lead: B }, { lead: A }, 'skip');
    expect(skip.writes.map((w) => w.target)).toEqual(['fresh']);
  });

  it('an identical preset writes nothing under EVERY policy — re-importing your own export is a no-op', () => {
    for (const policy of ['rename', 'overwrite', 'skip'] as const) {
      const plan = planImport({ lead: A }, { lead: A }, policy);
      expect(plan.counts.writes).toBe(0);
      expect(plan.rows[0]!.status).toBe('identical');
    }
  });

  it('a preset stored at full precision matches its rounded export (regression)', () => {
    // save() rounds, capture() does not — an export of a live patch must still
    // compare identical to the stored slot it came from.
    const live = { 'filter.cutoff': 80.123456789 };
    const stored = { 'filter.cutoff': 80.12 };
    expect(planImport({ x: live }, { x: stored }, 'rename').rows[0]!.status).toBe('identical');
  });

  it('an empty file plans nothing and confirms nothing', () => {
    const plan = planImport({}, { lead: A }, 'rename');
    expect(plan.rows).toEqual([]);
    expect(plan.counts.writes).toBe(0);
  });
});
