/**
 * The websynth MCP tools (specs/features/mcp-server.md REQ-5/6). The song
 * core is *injected* so this module unit-tests against the real src modules
 * under Vitest without the Node bundle. Zero deps beyond node builtins.
 *
 * Design note: a song that fails validation is a SUCCESSFUL tool call
 * (isError stays false) whose payload says {ok:false, errors:[…]} — the model
 * is expected to read the errors and fix the song, not to treat the call as
 * crashed. isError is reserved for genuine tool failures (e.g. unwritable
 * save path).
 */
import { deflateRawSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** MCP text content payload. */
const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (value) => text(JSON.stringify(value, null, 2));

/** The `song` argument: an object, or a JSON string an agent pasted through. */
const SONG_ARG = {
  description:
    'The song: a JSON object (either the compact "websynth-song-author" dialect ' +
    'or the full canonical "websynth-song" format), or the same as a JSON string.',
  type: ['object', 'string'],
};

/**
 * Parse + validate either song format. Returns
 * `{ok:true, file}` (file = canonical v3) or `{ok:false, errors}`.
 */
function resolveSong(core, song) {
  let value = song;
  if (typeof song === 'string') {
    try {
      value = JSON.parse(song);
    } catch (e) {
      return { ok: false, errors: ['song is not valid JSON: ' + e.message] };
    }
  }
  if (value === undefined || value === null) {
    return { ok: false, errors: ['song is required (an object or a JSON string).'] };
  }
  return core.isAuthorSong(value) ? core.expandAuthorSong(value) : core.validateSongFile(value);
}

/** Song.download's filename sanitize idiom (song.ts) — kept in sync by test. */
const safeName = (name) => `${String(name).replace(/[^a-z0-9_-]+/gi, '_') || 'song'}.websynth.json`;

const toBase64Url = (buf) => buf.toString('base64url');

/**
 * Build the five tools.
 * @param {object} core - the song core (bundle or src imports): validateSongFile,
 *   isAuthorSong, expandAuthorSong, compactSongForExport, buildAuthoringGuide,
 *   ParamBus, registerDefaults.
 * @param {{baseUrl?: string, cwd?: string}} [opts]
 */
export function makeTools(core, opts = {}) {
  const baseUrl = (opts.baseUrl ?? process.env.WEBSYNTH_BASE_URL ?? 'http://localhost:5173')
    .replace(/\/+$/, '');
  const cwd = opts.cwd ?? process.cwd();

  /** Canonical compact JSON text of a validated file (what the app exports). */
  const compactJson = (file) => JSON.stringify(core.compactSongForExport(file), null, 2);

  return [
    {
      name: 'get_song_format',
      description:
        'Get the complete, current websynth/VAST G1-J5 song authoring guide: the compact ' +
        '"websynth-song-author" dialect (recommended), the live synth parameter table with ' +
        'ranges/defaults, musical tips, and the canonical format appendix. Call this before ' +
        'writing a song.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const bus = new core.ParamBus();
        core.registerDefaults(bus);
        return text(core.buildAuthoringGuide(bus, baseUrl));
      },
    },
    {
      name: 'validate_song',
      description:
        'Validate a song (author dialect or canonical format). Returns {ok, errors[]}. ' +
        'A failed validation is a normal result: read the errors, fix the song, validate again.',
      inputSchema: {
        type: 'object',
        properties: { song: SONG_ARG },
        required: ['song'],
        additionalProperties: false,
      },
      handler: async ({ song }) => {
        const res = resolveSong(core, song);
        return json(res.ok ? { ok: true, errors: [] } : { ok: false, errors: res.errors });
      },
    },
    {
      name: 'expand_song',
      description:
        'Expand a compact "websynth-song-author" song into the canonical "websynth-song" v3 ' +
        'JSON the app exports (also accepts an already-canonical song and returns its compact ' +
        'form). Returns the JSON, or {ok:false, errors[]} to fix.',
      inputSchema: {
        type: 'object',
        properties: { song: SONG_ARG },
        required: ['song'],
        additionalProperties: false,
      },
      handler: async ({ song }) => {
        const res = resolveSong(core, song);
        if (!res.ok) return json({ ok: false, errors: res.errors });
        return text(compactJson(res.file));
      },
    },
    {
      name: 'save_song',
      description:
        'Validate a song (either format) and write it as <name>.websynth.json (canonical ' +
        'compact form) ready to import into the synth. Returns the absolute path, or ' +
        '{ok:false, errors[]} to fix.',
      inputSchema: {
        type: 'object',
        properties: {
          song: SONG_ARG,
          dir: {
            type: 'string',
            description: 'Directory to write into (default: the server working directory).',
          },
        },
        required: ['song'],
        additionalProperties: false,
      },
      handler: async ({ song, dir }) => {
        const res = resolveSong(core, song);
        if (!res.ok) return json({ ok: false, errors: res.errors });
        const target = resolve(cwd, dir ?? '.');
        mkdirSync(target, { recursive: true });
        const path = resolve(target, safeName(res.file.name));
        writeFileSync(path, compactJson(res.file));
        return json({ ok: true, path, name: res.file.name });
      },
    },
    {
      name: 'make_share_link',
      description:
        'Validate a song (either format) and return a shareable URL that loads it in the ' +
        'synth (deflate + base64url in the #song= hash — the payload never reaches a server). ' +
        `Base URL from $WEBSYNTH_BASE_URL (currently ${baseUrl}).`,
      inputSchema: {
        type: 'object',
        properties: { song: SONG_ARG },
        required: ['song'],
        additionalProperties: false,
      },
      handler: async ({ song }) => {
        const res = resolveSong(core, song);
        if (!res.ok) return json({ ok: false, errors: res.errors });
        // Compact + minified (no pretty-print) so the URL stays short; the
        // payload matches src/state/song-link.ts's wire format exactly.
        const payload = toBase64Url(
          deflateRawSync(Buffer.from(JSON.stringify(core.compactSongForExport(res.file)), 'utf8')),
        );
        return json({ ok: true, url: `${baseUrl}/#song=${payload}` });
      },
    },
  ];
}
