// @vitest-environment node
//
// The tools take the song core INJECTED (mcp-server.md REQ-5), so this suite
// runs them against the real src modules directly under Vitest — no lib
// bundle needed.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
// eslint-disable-next-line
import { makeTools } from '../../scripts/mcp/tools.mjs';
import { validateSongFile } from '../../src/state/song-validate';
import { isAuthorSong, expandAuthorSong } from '../../src/state/song-author';
import { compactSongForExport } from '../../src/state/serialize';
import { buildAuthoringGuide, buildSongPrompt, buildPresetGuide } from '../../src/state/authoring-guide';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { validatePresetPayload, expandPresetParams } from '../../src/state/preset-validate';
import { buildPresetFile, buildBankFile, presetFilename, bankFilename } from '../../src/state/preset-file';
import { buildParamCatalog } from '../../src/state/param-catalog';

const core = {
  validateSongFile, isAuthorSong, expandAuthorSong,
  compactSongForExport, buildAuthoringGuide, buildSongPrompt,
  ParamBus, registerDefaults, buildParamCatalog,
  // presets (preset-authoring.md)
  buildPresetGuide, validatePresetPayload, expandPresetParams,
  buildPresetFile, buildBankFile, presetFilename, bankFilename,
};

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

function tool(name: string, opts?: Parameters<typeof makeTools>[1]): Tool {
  const tools = makeTools(core, opts) as Tool[];
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const AUTHOR = {
  format: 'websynth-song-author',
  version: 1,
  name: 'Tool Song',
  params: { 'transport.bpm': 124 },
  seq: [['A2', null, 'C3']],
  drums: [{ kick: [0, 4, 8, 12] }],
  seqChain: 'AABA',
};

const textOf = (r: ToolResult) => r.content[0]!.text;
const jsonOf = (r: ToolResult) => JSON.parse(textOf(r)) as Record<string, any>;

describe('makeTools', () => {
  it('exposes the song and preset tools with object schemas', () => {
    const tools = makeTools(core) as Tool[];
    expect(tools.map((t) => t.name)).toEqual([
      'get_params',
      'get_song_format', 'validate_song', 'expand_song', 'save_song', 'make_share_link',
      'get_preset_format', 'validate_preset', 'expand_preset', 'save_preset',
    ]);
    for (const t of tools) expect(t.inputSchema).toMatchObject({ type: 'object' });
  });
});

describe('get_song_format', () => {
  it('returns the live guide with the configured base URL', async () => {
    const res = await tool('get_song_format', { baseUrl: 'https://synth.example' }).handler({});
    const guide = textOf(res);
    expect(guide).toContain('COMPACT AUTHOR FORMAT');
    expect(guide).toContain('https://synth.example/schema/websynth-song-author.schema.json');
    expect(guide).toContain('"transport.bpm"'); // the live PARAMS table
    expect(res.isError).toBeUndefined();
  });
});

describe('validate_song', () => {
  it('ok:true for a valid author song (object or JSON string)', async () => {
    const t = tool('validate_song');
    expect(jsonOf(await t.handler({ song: AUTHOR }))).toEqual({ ok: true, errors: [] });
    expect(jsonOf(await t.handler({ song: JSON.stringify(AUTHOR) }))).toEqual({ ok: true, errors: [] });
  });

  it('validation failure is a SUCCESSFUL call carrying the errors', async () => {
    const res = await tool('validate_song').handler({ song: { ...AUTHOR, seq: [['H4']] } });
    expect(res.isError).toBeFalsy();
    const out = jsonOf(res);
    expect(out.ok).toBe(false);
    expect(out.errors[0]).toMatch(/seq\[0\]\[0\]/);
  });

  it('unparseable JSON strings and missing songs are validation results too', async () => {
    const t = tool('validate_song');
    expect(jsonOf(await t.handler({ song: '{ not json' })).ok).toBe(false);
    expect(jsonOf(await t.handler({})).ok).toBe(false);
  });

  it('canonical files route through validateSongFile', async () => {
    const canonical = expandAuthorSong(AUTHOR);
    if (!canonical.ok) throw new Error('fixture invalid');
    expect(jsonOf(await tool('validate_song').handler({ song: canonical.file as never }))).toEqual({ ok: true, errors: [] });
  });
});

describe('expand_song', () => {
  it('author → canonical compact v3 that passes the validator', async () => {
    const res = await tool('expand_song').handler({ song: AUTHOR });
    const file = jsonOf(res);
    expect(file.format).toBe('websynth-song');
    expect(file.version).toBe(3);
    expect(file.seqBanks).toHaveLength(4);
    expect(file.seqChain).toEqual({ enabled: true, steps: [0, 0, 1, 0] });
    expect(validateSongFile(file).ok).toBe(true);
  });

  it('invalid input returns {ok:false, errors} without isError', async () => {
    const res = await tool('expand_song').handler({ song: { ...AUTHOR, drums: [{ cowbell: [0] }] } });
    expect(res.isError).toBeFalsy();
    expect(jsonOf(res).ok).toBe(false);
  });
});

describe('save_song', () => {
  it('writes <safe-name>.websynth.json and returns the absolute path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'websynth-mcp-'));
    try {
      const res = await tool('save_song', { cwd: dir }).handler({ song: { ...AUTHOR, name: 'My Song!' } });
      const out = jsonOf(res);
      expect(out.ok).toBe(true);
      expect(out.path.endsWith('My_Song_.websynth.json')).toBe(true);
      const written = JSON.parse(readFileSync(out.path, 'utf8'));
      expect(validateSongFile(written).ok).toBe(true);
      expect(written.name).toBe('My Song!');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an invalid song writes nothing and reports the errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'websynth-mcp-'));
    try {
      const res = await tool('save_song', { cwd: dir }).handler({ song: { format: 'nope' } });
      expect(jsonOf(res).ok).toBe(false);
      expect(existsSync(join(dir, 'song.websynth.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('make_share_link', () => {
  it('builds a #song= URL whose payload inflates to the canonical compact JSON', async () => {
    const res = await tool('make_share_link', { baseUrl: 'https://synth.example/' }).handler({ song: AUTHOR });
    const { ok, url } = jsonOf(res);
    expect(ok).toBe(true);
    expect(url.startsWith('https://synth.example/#song=')).toBe(true);
    const payload = (url as string).split('#song=')[1]!;
    const json = inflateRawSync(Buffer.from(payload, 'base64url')).toString('utf8');
    const song = JSON.parse(json);
    expect(song.format).toBe('websynth-song');
    expect(song.params['transport.bpm']).toBe(124);
    expect(validateSongFile(song).ok).toBe(true);
  });

  it('defaults the base URL to the published site (WEBSYNTH_BASE_URL absent)', async () => {
    // Was localhost:5173 — a share link the recipient could not open, from a
    // server that usually runs nowhere near a dev server (mcp-server.md REQ-5e).
    const prev = process.env.WEBSYNTH_BASE_URL;
    delete process.env.WEBSYNTH_BASE_URL;
    try {
      const res = await tool('make_share_link').handler({ song: AUTHOR });
      expect(jsonOf(res).url).toMatch(/^https:\/\/vast\.status201\.com\/#song=/);
    } finally {
      if (prev !== undefined) process.env.WEBSYNTH_BASE_URL = prev;
    }
  });
});

/* ---------------- presets (preset-authoring.md) ---------------- */

const PRESET = {
  format: 'websynth-preset',
  version: 1,
  name: 'Tool Bass',
  params: { 'filter.cutoff': 62, 'filter.resonance': 2.4, 'voicing.mode': 0 },
};

const BANK = {
  format: 'websynth-preset-bank',
  version: 1,
  name: 'Tool Set',
  presets: { one: { 'filter.cutoff': 60 }, two: { 'filter.cutoff': 90 } },
};

describe('get_params', () => {
  it('returns the structured catalogue, not prose (param-catalogue.md REQ-8)', async () => {
    const cat = jsonOf(await tool('get_params').handler({}));
    const bus = new ParamBus();
    registerDefaults(bus);
    expect(cat.format).toBe('websynth-params');
    expect(cat.count).toBe(bus.ids().length);
    const cutoff = cat.params.find((p: { id: string }) => p.id === 'filter.cutoff');
    // A range an agent can compute against — the whole point over the prose table.
    expect(cutoff).toMatchObject({ min: 30, max: 130, patch: true });
    // The fields paramTable() drops reach the agent here.
    const wave = cat.params.find((p: { id: string }) => p.id === 'osc1.wave');
    expect(wave.labels).toEqual(['sine', 'triangle', 'saw', 'square']);
    // Song-level params ARE present (unlike the preset guide's narrowed table).
    expect(cat.params.some((p: { id: string }) => p.id === 'transport.bpm')).toBe(true);
  });
});

describe('the default base URL', () => {
  it('is the published site, so cited schema URLs resolve (REQ-5e)', async () => {
    // No baseUrl and no $WEBSYNTH_BASE_URL: the guides used to hand the model
    // http://localhost:5173 links, dead unless a dev server happened to run.
    const prev = process.env['WEBSYNTH_BASE_URL'];
    delete process.env['WEBSYNTH_BASE_URL'];
    try {
      const guide = textOf(await tool('get_preset_format').handler({}));
      expect(guide).toContain('https://vast.status201.com/schema/websynth-preset.schema.json');
      expect(guide).not.toContain('localhost');
    } finally {
      if (prev !== undefined) process.env['WEBSYNTH_BASE_URL'] = prev;
    }
  });
});

describe('get_preset_format', () => {
  it('returns the preset guide with the configured base URL', async () => {
    const guide = textOf(await tool('get_preset_format', { baseUrl: 'https://synth.example' }).handler({}));
    expect(guide).toContain('"format": "websynth-preset"');
    expect(guide).toContain('https://synth.example/schema/websynth-preset.schema.json');
    expect(guide).toContain('"filter.cutoff"'); // the live PARAMS table
    // A preset is a sound: song-level params are deliberately absent from its table.
    expect(guide).not.toContain('"transport.bpm"');
  });
});

describe('validate_preset', () => {
  it('ok for a valid preset and bank (object or JSON string)', async () => {
    const t = tool('validate_preset');
    expect(jsonOf(await t.handler({ preset: PRESET })).ok).toBe(true);
    expect(jsonOf(await t.handler({ preset: JSON.stringify(PRESET) })).ok).toBe(true);
    const bank = jsonOf(await t.handler({ preset: BANK }));
    expect(bank).toMatchObject({ ok: true, kind: 'bank', presets: ['one', 'two'] });
  });

  it('catches invented ids and out-of-range values (the authoring contract)', async () => {
    const res = await tool('validate_preset').handler({
      preset: { ...PRESET, params: { 'osc1.shape': 1, 'filter.cutoff': 999 } },
    });
    expect(res.isError).toBeFalsy(); // a failed validation is a successful call
    const out = jsonOf(res);
    expect(out.ok).toBe(false);
    expect(out.errors.join('\n')).toContain('osc1.shape');
    expect(out.errors.join('\n')).toMatch(/filter\.cutoff.*must be/);
  });

  it('warns about song-level ids in a sound without failing', async () => {
    const out = jsonOf(await tool('validate_preset').handler({
      preset: { ...PRESET, params: { ...PRESET.params, 'transport.bpm': 140 } },
    }));
    expect(out.ok).toBe(true);
    expect(out.warnings.join('\n')).toContain('transport.bpm');
  });

  it('points a song file at the right tool', async () => {
    const out = jsonOf(await tool('validate_preset').handler({ preset: { format: 'websynth-song' } }));
    expect(out.ok).toBe(false);
    expect(out.errors[0]).toContain('song file');
  });
});

describe('expand_preset', () => {
  it('fills every patch param from the defaults, keeping the authored values', async () => {
    const file = jsonOf(await tool('expand_preset').handler({ preset: PRESET }));
    expect(file.format).toBe('websynth-preset');
    expect(file.name).toBe('Tool Bass');
    expect(file.params['filter.cutoff']).toBe(62);
    // Unmentioned patch params arrive at their registered defaults…
    const bus = new ParamBus();
    registerDefaults(bus);
    expect(file.params['osc1.wave']).toBe(bus.def('osc1.wave')!.default);
    // …and song-level params stay out of a sound entirely.
    expect(file.params['transport.bpm']).toBeUndefined();
  });

  it('expands every entry of a bank', async () => {
    const file = jsonOf(await tool('expand_preset').handler({ preset: BANK }));
    expect(file.format).toBe('websynth-preset-bank');
    expect(Object.keys(file.presets)).toEqual(['one', 'two']);
    expect(file.presets.one['filter.cutoff']).toBe(60);
    expect(file.presets.two['env.amp.attack']).toBeTypeOf('number');
  });
});

describe('save_preset', () => {
  it('writes <name>.preset.websynth.json, importable by the app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'websynth-mcp-'));
    try {
      const out = jsonOf(await tool('save_preset', { cwd: dir }).handler({ preset: PRESET }));
      expect(out.ok).toBe(true);
      expect(out.path.endsWith('Tool_Bass.preset.websynth.json')).toBe(true);
      // Round-trips through the app's own file parser.
      const parsed = validatePresetPayload(JSON.parse(readFileSync(out.path, 'utf8')));
      expect(parsed.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a bank under the bank extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'websynth-mcp-'));
    try {
      const out = jsonOf(await tool('save_preset', { cwd: dir }).handler({ preset: BANK }));
      expect(out).toMatchObject({ ok: true, kind: 'bank' });
      expect(out.path.endsWith('Tool_Set.bank.websynth.json')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an invalid preset writes nothing and reports the errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'websynth-mcp-'));
    try {
      const out = jsonOf(await tool('save_preset', { cwd: dir }).handler({ preset: { format: 'nope' } }));
      expect(out.ok).toBe(false);
      expect(existsSync(join(dir, 'preset.preset.websynth.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// mcp-server.md REQ-5c / untrusted-input.md REQ-11. safeName only sanitizes the
// FILENAME; `dir` was unconstrained and mkdirSync(…, {recursive:true}) would
// build the path on the way out. The caller is a model, and a model summarising
// a hostile song file is a prompt-injection route to an arbitrary file write.
describe('save_song / save_preset directory containment', () => {
  const escapes = ['..', '../..', '../../../evil', 'a/../../../evil'];

  it('refuses a dir that resolves outside the working directory', async () => {
    for (const dir of escapes) {
      const cwd = mkdtempSync(join(tmpdir(), 'websynth-mcp-'));
      try {
        await expect(
          tool('save_song', { cwd }).handler({ song: AUTHOR, dir }),
          dir,
        ).rejects.toThrow(/must stay inside/);
        await expect(
          tool('save_preset', { cwd }).handler({ preset: PRESET, dir }),
          dir,
        ).rejects.toThrow(/must stay inside/);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  it('refuses an absolute dir', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'websynth-mcp-'));
    const outside = mkdtempSync(join(tmpdir(), 'websynth-outside-'));
    try {
      await expect(tool('save_song', { cwd }).handler({ song: AUTHOR, dir: outside }))
        .rejects.toThrow(/must stay inside/);
      // Nothing was created on the way out, either.
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('still writes into a nested dir inside cwd (regression)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'websynth-mcp-'));
    try {
      const out = jsonOf(await tool('save_song', { cwd }).handler({ song: AUTHOR, dir: 'sub/dir' }));
      expect(out.ok).toBe(true);
      expect(existsSync(out.path)).toBe(true);
      expect(out.path.startsWith(cwd)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
