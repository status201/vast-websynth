// @vitest-environment node
//
// The tools take the song core INJECTED (mcp-server.md REQ-5), so this suite
// runs them against the real src modules directly under Vitest — no lib
// bundle needed.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
// eslint-disable-next-line
import { makeTools } from '../../scripts/mcp/tools.mjs';
import { validateSongFile } from '../../src/state/song-validate';
import { isAuthorSong, expandAuthorSong } from '../../src/state/song-author';
import { compactSongForExport } from '../../src/state/serialize';
import { buildAuthoringGuide, buildSongPrompt } from '../../src/state/authoring-guide';
import { ParamBus, registerDefaults } from '../../src/state/params';

const core = {
  validateSongFile, isAuthorSong, expandAuthorSong,
  compactSongForExport, buildAuthoringGuide, buildSongPrompt,
  ParamBus, registerDefaults,
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
  it('exposes the five tools with object schemas', () => {
    const tools = makeTools(core) as Tool[];
    expect(tools.map((t) => t.name)).toEqual([
      'get_song_format', 'validate_song', 'expand_song', 'save_song', 'make_share_link',
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

  it('defaults the base URL to localhost:5173 (WEBSYNTH_BASE_URL absent)', async () => {
    const prev = process.env.WEBSYNTH_BASE_URL;
    delete process.env.WEBSYNTH_BASE_URL;
    try {
      const res = await tool('make_share_link').handler({ song: AUTHOR });
      expect(jsonOf(res).url).toMatch(/^http:\/\/localhost:5173\/#song=/);
    } finally {
      if (prev !== undefined) process.env.WEBSYNTH_BASE_URL = prev;
    }
  });
});
