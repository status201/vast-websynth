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
import { SONG_VERSION } from '../../src/state/song';
import { KNOWN_SONG_VERSIONS } from '../../src/state/song-version';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { buildAuthoringGuide, paramTable } from '../../src/state/authoring-guide';
import { PRESET_FORMAT, BANK_FORMAT } from '../../src/state/preset-validate';
import { isPatchParam } from '../../src/state/preset-session';
import { buildParamCatalog, PARAMS_FORMAT, PARAMS_VERSION } from '../../src/state/param-catalog';

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

/**
 * The canonical format version reaches the outside world through three surfaces:
 * the two published files, and the authoring guide the ✨ AI Prompt modal and the
 * MCP `get_song_format` tool serve. The published pair fell behind `capture()`
 * twice (v5 and v6 shipped without them) and the guide's canonical EXAMPLE SHAPE
 * sat at 4 while its own TOP-LEVEL SHAPE said 6 — so all three are pinned to
 * `SONG_VERSION` rather than trusted (song-mode.md REQ-2).
 */
describe('the published canonical version', () => {
  it('is the top of the schema version enum', () => {
    const schema = JSON.parse(read('schema/websynth-song.schema.json')) as Record<string, any>;
    const versions = schema.properties.version.enum as number[];
    expect(Math.max(...versions)).toBe(SONG_VERSION);
    expect(versions).toEqual([...Array(SONG_VERSION).keys()].map((i) => i + 1));
    // The runtime validator accepts exactly the set the schema advertises.
    expect(versions).toEqual(KNOWN_SONG_VERSIONS);
    // The prose beside the enum names the written version too.
    expect(schema.properties.version.description).toContain(`writes ${SONG_VERSION}`);
  });

  it('is what llms.txt advertises, with the versioned fields named', () => {
    const txt = read('llms.txt');
    expect(txt).toContain(`\`websynth-song\` (v${SONG_VERSION})`);
    expect(txt).toContain('seqTracks');
    expect(txt).toContain('motionTracks');
  });

  it('is what EVERY canonical example in the authoring guide names', () => {
    const bus = new ParamBus();
    registerDefaults(bus);
    const guide = buildAuthoringGuide(bus);
    // Each `"format": "websynth-song"` block is followed by its own "version".
    // The author dialect's own `version: 1` blocks are excluded by the format tag.
    const versions = [...guide.matchAll(/"format":\s*"websynth-song"[^]*?"version":\s*(\d+)/g)]
      .map((m) => Number(m[1]));
    expect(versions.length).toBeGreaterThanOrEqual(2);   // TOP-LEVEL SHAPE + EXAMPLE SHAPE
    for (const v of versions) expect(v).toBe(SONG_VERSION);
    // The author dialect stays at its own version 1, untouched by song bumps.
    expect(guide).toContain('"format": "websynth-song-author", "version": 1');
  });
});

/**
 * The preset schemas are the machine-readable mirror of `preset-validate.ts`
 * (preset-authoring.md REQ-6) — the same drift risk as the song pair.
 */
describe('the published preset schemas', () => {
  const preset = JSON.parse(read('schema/websynth-preset.schema.json')) as Record<string, any>;
  const bank = JSON.parse(read('schema/websynth-preset-bank.schema.json')) as Record<string, any>;

  it('tag the formats the validator accepts', () => {
    expect(preset.properties.format.const).toBe(PRESET_FORMAT);
    expect(bank.properties.format.const).toBe(BANK_FORMAT);
    for (const s of [preset, bank]) {
      expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(s.properties.version.const).toBe(1);
    }
  });

  it('describe params as an open map of numbers, like the validator', () => {
    expect(preset.$defs.params.additionalProperties).toEqual({ type: 'number' });
    expect(bank.properties.presets.additionalProperties.additionalProperties).toEqual({ type: 'number' });
    // A bank with no sounds is refused by validatePresetPayload.
    expect(bank.properties.presets.minProperties).toBe(1);
  });

  it('do not duplicate the live param table (it grows with the synth)', () => {
    for (const raw of [read('schema/websynth-preset.schema.json'), read('schema/websynth-preset-bank.schema.json')]) {
      expect(raw).not.toMatch(/env\.amp\.attack|fx\.delay\.mix/);
    }
  });
});

/**
 * The published parameter reference (param-catalogue.md). Unlike the schemas and
 * llms.txt these files ARE generated — `npm run gen:params` — so the pin here is
 * not "did someone forget to hand-edit it" but "was the generator run at all".
 * `npm run check:params` is the byte-exact gate in CI; these assertions cover the
 * contract a fetching agent depends on, which a byte comparison alone doesn't
 * describe.
 */
describe('the published parameter reference', () => {
  const bus = new ParamBus();
  registerDefaults(bus);
  const catalog = JSON.parse(read('params.json')) as ReturnType<typeof buildParamCatalog>;

  it('is stamped with its own format, not the app version', () => {
    expect(catalog.format).toBe(PARAMS_FORMAT);
    expect(catalog.version).toBe(PARAMS_VERSION);
    expect(catalog.songVersion).toBe(SONG_VERSION);
    // A release bump must not be able to redden `check:params`.
    expect(read('params.json')).not.toContain('appVersion');
  });

  it('names every registered param, in bus order, with its range', () => {
    const ids = bus.ids();
    expect(catalog.count).toBe(ids.length);
    expect(catalog.params.map((p) => p.id)).toEqual(ids);
    for (const entry of catalog.params) {
      const def = bus.def(entry.id)!;
      expect([entry.min, entry.max, entry.default], entry.id)
        .toEqual([def.min, def.max, def.default]);
    }
  });

  it('carries the fields the prose table drops', () => {
    const wave = catalog.params.find((p) => p.id === 'osc1.wave');
    expect(wave?.taper).toBe('discrete');
    expect(wave?.labels).toEqual(['sine', 'triangle', 'saw', 'square']);
    // At least one param exercises each of the fields paramTable() omits.
    expect(catalog.params.some((p) => p.taper === 'exp' || p.taper === 'power')).toBe(true);
    expect(catalog.params.some((p) => p.curve !== undefined)).toBe(true);
    expect(catalog.params.some((p) => p.unit !== undefined)).toBe(true);
  });

  it('omits unset optional fields rather than emitting null', () => {
    expect(read('params.json')).not.toContain('null');
    for (const entry of catalog.params) {
      const def = bus.def(entry.id)!;
      expect(Object.hasOwn(entry, 'unit'), entry.id).toBe(def.unit !== undefined);
      expect(Object.hasOwn(entry, 'step'), entry.id).toBe(def.step !== undefined);
    }
  });

  it('splits sound from song exactly as the preset validator does', () => {
    for (const entry of catalog.params) {
      expect(entry.patch, entry.id).toBe(isPatchParam(entry.id));
    }
    // Both halves are non-empty, or one of the two markdown sections is a lie.
    expect(catalog.params.some((p) => p.patch)).toBe(true);
    expect(catalog.params.some((p) => !p.patch)).toBe(true);
  });

  it('renders params.md through the one shared paramTable()', () => {
    const md = read('params.md');
    expect(md).toContain(paramTable(bus, isPatchParam));
    expect(md).toContain(paramTable(bus, (id) => !isPatchParam(id)));
    expect(md).toContain('GENERATED');
    // ADR-005 — the trap an agent falls into first.
    expect(md).toContain('MIDI note number');
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

  it('names the preset formats and their schema URLs', () => {
    expect(txt).toContain(`\`${PRESET_FORMAT}\``);
    expect(txt).toContain(`\`${BANK_FORMAT}\``);
    expect(txt).toContain('/schema/websynth-preset.schema.json');
    expect(txt).toContain('/schema/websynth-preset-bank.schema.json');
  });

  it('pins the grid dimensions and drum track names', () => {
    expect(txt).toContain(`seqBanks[${BANK_COUNT}][${SEQ_LENGTH}]`);
    expect(txt).toContain(`drumBanks[${BANK_COUNT}][${DRUM_TRACKS.length}][${SEQ_LENGTH}]`);
    for (const t of DRUM_TRACKS) expect(txt).toContain(t);
  });

  it('links the generated params reference instead of duplicating the table', () => {
    expect(txt).toContain('/params.json');
    expect(txt).toContain('/params.md');
    // The other two doors to the same table stay named.
    expect(txt).toContain('AI Prompt');
    expect(txt).toContain('get_params');
    // The live table is bus-generated; llms.txt must not carry param ids that drift.
    expect(txt).not.toMatch(/env\.amp\.attack|fx\.delay\.mix/);
  });

  it('publishes every format version it advertises a schema for', () => {
    for (const fmt of ['websynth-song', 'websynth-song-author', PRESET_FORMAT, BANK_FORMAT]) {
      expect(txt).toContain(`/schema/${fmt}.schema.json`);
    }
    // The version matrix must reach the version the app actually writes.
    expect(txt).toContain(`- v${SONG_VERSION} —`);
  });
});
