/**
 * The websynth MCP tools (mcp-server.md
 * REQ-five-song-tools/REQ-tool-input-errors-are-json-rpc-errors). The song
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
import { writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

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
 * Parse + validate either song format. Returns `{ok:true, file}` — a canonical
 * `websynth-song`, at whatever version the expander picked (the lowest that
 * holds the content; song-authoring-dialect.md REQ-the-emitted-version-is-the-lowest-that-fits) — or `{ok:false, errors}`.
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

/** The `preset` argument: one sound or a whole bank, object or JSON string. */
const PRESET_ARG = {
  description:
    'The preset: a JSON object in the "websynth-preset" (one sound) or ' +
    '"websynth-preset-bank" (many) format, or the same as a JSON string.',
  type: ['object', 'string'],
};

/**
 * Parse + validate a preset/bank payload against the live parameter registry
 * (preset-authoring.md): unknown ids and out-of-range values are errors here,
 * unlike the app's file import, which must stay forward-compatible.
 */
function resolvePreset(core, preset, bus) {
  let value = preset;
  if (typeof preset === 'string') {
    try {
      value = JSON.parse(preset);
    } catch (e) {
      return { ok: false, errors: ['preset is not valid JSON: ' + e.message] };
    }
  }
  if (value === undefined || value === null) {
    return { ok: false, errors: ['preset is required (an object or a JSON string).'] };
  }
  return core.validatePresetPayload(value, bus);
}

/** Song.download's filename sanitize idiom (song.ts) — kept in sync by test. */
const safeName = (name) => `${String(name).replace(/[^a-z0-9_-]+/gi, '_') || 'song'}.websynth.json`;

/**
 * Resolve a caller-supplied `dir` **inside** the working directory
 * (mcp-server.md REQ-an-mcp-write-stays-in-the-working-directory). `safeName` only sanitizes the filename; `dir` was
 * unconstrained, and `mkdirSync(…, {recursive:true})` would happily build the
 * path on the way out — an absolute path or `../../..` wrote anywhere the
 * process could. The caller here is a model, and a model summarising a hostile
 * song file is a prompt-injection route to an arbitrary file write.
 *
 * `isAbsolute(rel)` is the Windows case: for a different drive letter
 * `relative()` returns an absolute path rather than something starting `..`.
 */
function containedDir(cwd, dir) {
  const target = resolve(cwd, dir ?? '.');
  const rel = relative(cwd, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`dir must stay inside the server working directory (${cwd}).`);
  }
  return target;
}

const toBase64Url = (buf) => buf.toString('base64url');

const isBar = (v) => v === undefined || (Number.isInteger(v) && v >= 1);
const isChannels = (v) => v === undefined || (Array.isArray(v) && v.every((c) => Number.isInteger(c) && c >= 1 && c <= 16));

/**
 * read_midi's bytes, from `path` (local profile only) or `base64`
 * (mcp-server.md REQ-read-midi-reads-a-file-for-an-arranger). Returns
 * `{bytes}` or `{errors}`; an unreadable path throws, which the dispatcher
 * reports as a runtime failure.
 */
function midiBytes(core, { path, base64 }, local, cwd) {
  const max = core.MAX_MIDI_FILE_BYTES;
  if (path !== undefined && !local) {
    return { errors: ['path is not available on this server: send the file as base64.'] };
  }
  if ((path === undefined) === (base64 === undefined)) {
    return { errors: [local ? 'give exactly one of path or base64.' : 'base64 is required: the .mid file, base64-encoded.'] };
  }
  if (path !== undefined) {
    if (typeof path !== 'string') return { errors: ['path must be a string.'] };
    const file = resolve(cwd, path);
    // Size before a byte is read; nothing of a non-MIDI file reaches the reply
    // (the parser's error names the expected "MThd", never what it found).
    const st = statSync(file);
    if (!st.isFile()) return { errors: ['path is not a file.'] };
    if (st.size > max) return { errors: [`the file is ${st.size} bytes; the limit is ${max}`] };
    return { bytes: new Uint8Array(readFileSync(file)) };
  }
  if (typeof base64 !== 'string') return { errors: ['base64 must be a string.'] };
  // Refuse an over-size payload before decoding it, not after.
  if (base64.length > Math.ceil(max / 3) * 4 + 4) return { errors: [`the file is over the ${max}-byte limit`] };
  return { bytes: new Uint8Array(Buffer.from(base64, 'base64')) };
}

/** The tools omitted from the read-only profile (mcp-server.md REQ-the-remote-profile-is-read-only). */
const WRITE_TOOLS = new Set(['save_song', 'save_preset']);

/**
 * Build the tool list: one shared discovery tool, then the song half and the
 * preset half.
 * @param {object} core - the song core (bundle or src imports): validateSongFile,
 *   isAuthorSong, expandAuthorSong, compactSongForExport, buildAuthoringGuide,
 *   buildParamCatalog, ParamBus, registerDefaults, parseMidiFile, analyzeMidi,
 *   MAX_MIDI_FILE_BYTES.
 * @param {{baseUrl?: string, cwd?: string, allowWrites?: boolean}} [opts]
 */
export function makeTools(core, opts = {}) {
  // Whether the two write tools exist (mcp-server.md REQ-the-remote-profile-is-read-only). Defaults TRUE, so
  // the stdio profile is exactly what it always was; the HTTP transport passes
  // false. This is a property of the transport, not of a deployment: a write
  // here lands in the *server's* working directory, which for a local agent is
  // the user's own repo and for a public host is a directory no caller can
  // retrieve a file from. Remotely it would be a disk-filling vector in
  // exchange for an artifact nobody collects — `make_share_link` is the answer
  // to "give me the result" for a caller who is not on this machine.
  const allowWrites = opts.allowWrites ?? true;
  // The guides cite absolute schema URLs off this. It defaulted to the dev
  // server, so every schema link an agent was handed 404'd unless the operator
  // happened to have a `vite dev` running — the published site is the only base
  // that is true by default. Override with WEBSYNTH_BASE_URL to point at a local
  // dev server or a fork's host.
  const baseUrl = (opts.baseUrl ?? process.env.WEBSYNTH_BASE_URL ?? 'https://vast.status201.com')
    .replace(/\/+$/, '');
  const cwd = opts.cwd ?? process.cwd();

  /** Canonical compact JSON text of a validated file (what the app exports). */
  const compactJson = (file) => JSON.stringify(core.compactSongForExport(file), null, 2);

  /** The live parameter registry — stateless here, so one instance serves all. */
  let busInstance;
  const bus = () => {
    if (!busInstance) {
      busInstance = new core.ParamBus();
      core.registerDefaults(busInstance);
    }
    return busInstance;
  };

  /**
   * A validated payload → the file the app would export: params expanded from
   * the synth defaults, so the sound is complete and deterministic wherever it
   * is loaded (preset-authoring.md REQ-expansion-fills-every-patch-param).
   */
  const presetFileOf = (parse) => {
    if (parse.kind === 'preset') {
      const snap = parse.presets[parse.name] ?? Object.values(parse.presets)[0] ?? {};
      return {
        kind: 'preset',
        file: core.buildPresetFile(parse.name, core.expandPresetParams(bus(), snap)),
        filename: core.presetFilename(parse.name),
      };
    }
    const entries = {};
    for (const [n, snap] of Object.entries(parse.presets)) {
      entries[n] = core.expandPresetParams(bus(), snap);
    }
    return {
      kind: 'bank',
      file: core.buildBankFile(parse.name, entries),
      filename: core.bankFilename(parse.name),
    };
  };

  const tools = [
    /* ---------------- shared discovery (param-catalogue.md) ---------------- */

    {
      name: 'get_params',
      description:
        'Get the complete synth parameter catalogue as structured JSON: every parameter id with its ' +
        'min/max/default, its taper/curve/unit, and — for a choice parameter — the value map its ' +
        'stored index refers to. Each entry has patch:true if it belongs to a SOUND (a preset) or ' +
        'patch:false if it is song-level (transport, arp, sequencer, drums, sampler). Use this when ' +
        'you need ranges to compute against; use get_preset_format / get_song_format for the prose ' +
        'guides that teach how to write a file.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => json(core.buildParamCatalog(bus())),
    },

    /* ---------------- songs (song-authoring-dialect.md) ---------------- */

    {
      name: 'get_song_format',
      description:
        'Get the complete, current websynth/VAST G1-J8 song authoring guide: the compact ' +
        '"websynth-song-author" dialect (recommended), the live synth parameter table with ' +
        'ranges/defaults, musical tips, and the canonical format appendix. Call this before ' +
        'writing a song.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => text(core.buildAuthoringGuide(bus(), baseUrl)),
    },
    {
      name: 'validate_song',
      description:
        'Validate a song (author dialect or canonical format). Returns {ok, errors[], warnings[]}. ' +
        'A failed validation is a normal result: read the errors, fix the song, validate again. ' +
        'Warnings do not fail the song but say what will not work: an automation target ' +
        '(xy, motionAssigns, motionTracks) naming a parameter that does not exist is a lane ' +
        'that will never move. Fix those too unless you meant a parameter this build lacks.',
      inputSchema: {
        type: 'object',
        properties: { song: SONG_ARG },
        required: ['song'],
        additionalProperties: false,
      },
      handler: async ({ song }) => {
        const res = resolveSong(core, song);
        // untrusted-input.md REQ-an-unresolvable-target-warns: warnings ride the success branch. They are
        // the whole point of this tool for an agent — a misspelled motion target
        // is otherwise accepted here and then silently dropped at play time.
        return json(res.ok
          ? { ok: true, errors: [], warnings: res.warnings ?? [] }
          : { ok: false, errors: res.errors });
      },
    },
    {
      name: 'expand_song',
      // No version literal in this text: it is model-visible and drifted from v3
      // through three format bumps before anyone noticed (mcp-server.md REQ-five-song-tools).
      description:
        'Expand a compact "websynth-song-author" song into the canonical "websynth-song" ' +
        'JSON the app exports (also accepts an already-canonical song and returns its compact ' +
        'form). Returns the JSON, or {ok:false, errors[]} to fix. This returns the song text ' +
        'only — call validate_song for warnings about targets that will not resolve.',
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
        const target = containedDir(cwd, dir);
        mkdirSync(target, { recursive: true });
        const path = resolve(target, safeName(res.file.name));
        writeFileSync(path, compactJson(res.file));
        // A write is a commitment, so REQ-an-unresolvable-target-warns's warnings are worth repeating here
        // rather than making the agent call validate_song separately to learn
        // that the song it just saved has an automation lane that cannot move.
        return json({ ok: true, path, name: res.file.name, warnings: res.warnings ?? [] });
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

    {
      name: 'read_midi',
      description:
        'Read a Standard MIDI File (.mid) and return a summary of it for arranging: tempo and meter, the GM ' +
        'instrument, range and polyphony of each channel, the coarsest grid every onset fits (with the ' +
        'seq.rate/seq.len that fits it, e.g. eighths = two bars per bank), groups of identical bars (one bank ' +
        'each), and a bar-by-bar listing whose tokens are "pos:Note/len" in sixteenths from the bar start. ' +
        'Channel 10 is drums, mapped to the tracks of the drum machine. The listing is a window of bars per ' +
        'call: page on with fromBar. It reads; it writes no song — plan the banks and chains from it, then ' +
        'write the song with get_song_format.',
      inputSchema: {
        type: 'object',
        properties: {
          ...(allowWrites
            ? { path: { type: 'string', description: 'Path to a .mid file on this machine (read-only).' } }
            : {}),
          base64: {
            type: 'string',
            description: allowWrites
              ? 'The bytes of the .mid file, base64-encoded (instead of path).'
              : 'The bytes of the .mid file, base64-encoded.',
          },
          fromBar: { type: 'integer', minimum: 1, description: 'First bar to list (1-based). Default: the first bar with a note.' },
          toBar: { type: 'integer', minimum: 1, description: 'Last bar to list. Default: as far as one call allows.' },
          channels: {
            type: 'array',
            items: { type: 'integer', minimum: 1, maximum: 16 },
            description: 'MIDI channels (1-16) to list and compare. Default: all.',
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const { fromBar, toBar, channels } = args;
        if (!isBar(fromBar) || !isBar(toBar) || !isChannels(channels)) {
          return json({ ok: false, errors: ['fromBar/toBar must be integers >= 1 and channels integers 1-16.'] });
        }
        const src = midiBytes(core, args, allowWrites, cwd);
        if (src.errors) return json({ ok: false, errors: src.errors });
        const parse = core.parseMidiFile(src.bytes);
        if (!parse.ok) return json({ ok: false, errors: parse.errors });
        const analysis = core.analyzeMidi(parse.file, { fromBar, toBar, channels });
        if (!analysis.ok) return json(analysis);
        return json({ ...analysis, warnings: parse.warnings });
      },
    },

    /* ---------------- presets (preset-authoring.md) ---------------- */

    {
      name: 'get_preset_format',
      description:
        'Get the complete, current websynth/VAST G1-J8 PRESET authoring guide: the preset and bank ' +
        'file shapes, the live synth parameter table with ranges/defaults, and sound-design notes ' +
        '(what makes a bass/pad/pluck/acid patch). A preset is a SOUND only — no notes, patterns or ' +
        'tempo, which belong to a song (see get_song_format). Call this before writing a preset.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => text(core.buildPresetGuide(bus(), baseUrl)),
    },
    {
      name: 'validate_preset',
      description:
        'Validate a preset or bank against the live parameter registry. Returns {ok, errors[], ' +
        'warnings[]} — unknown parameter ids and out-of-range values are errors, song-level ids in a ' +
        'sound are warnings. A failed validation is a normal result: read the errors, fix, validate again.',
      inputSchema: {
        type: 'object',
        properties: { preset: PRESET_ARG },
        required: ['preset'],
        additionalProperties: false,
      },
      handler: async ({ preset }) => {
        const res = resolvePreset(core, preset, bus());
        return json(res.ok
          ? { ok: true, kind: res.kind, name: res.name, presets: Object.keys(res.presets), errors: [], warnings: res.warnings ?? [] }
          : { ok: false, errors: res.errors });
      },
    },
    {
      name: 'expand_preset',
      description:
        'Expand a sparse authored preset/bank into the COMPLETE file the app exports: every parameter ' +
        'you left out is filled from the synth defaults, so the patch sounds identical wherever it is ' +
        'loaded instead of inheriting leftovers from the previous sound. Returns the JSON, or ' +
        '{ok:false, errors[]} to fix.',
      inputSchema: {
        type: 'object',
        properties: { preset: PRESET_ARG },
        required: ['preset'],
        additionalProperties: false,
      },
      handler: async ({ preset }) => {
        const res = resolvePreset(core, preset, bus());
        if (!res.ok) return json({ ok: false, errors: res.errors });
        return text(JSON.stringify(presetFileOf(res).file, null, 2));
      },
    },
    {
      name: 'save_preset',
      description:
        'Validate a preset/bank, expand it to the complete form, and write it as ' +
        '<name>.preset.websynth.json (one sound) or <name>.bank.websynth.json (many) — ready to import ' +
        'from the synth\'s Preset button. Returns the absolute path, or {ok:false, errors[]} to fix.',
      inputSchema: {
        type: 'object',
        properties: {
          preset: PRESET_ARG,
          dir: {
            type: 'string',
            description: 'Directory to write into (default: the server working directory).',
          },
        },
        required: ['preset'],
        additionalProperties: false,
      },
      handler: async ({ preset, dir }) => {
        const res = resolvePreset(core, preset, bus());
        if (!res.ok) return json({ ok: false, errors: res.errors });
        const { kind, file, filename } = presetFileOf(res);
        const target = containedDir(cwd, dir);
        mkdirSync(target, { recursive: true });
        const path = resolve(target, filename);
        writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
        return json({
          ok: true, path, kind, name: res.name,
          presets: Object.keys(res.presets),
          warnings: res.warnings ?? [],
        });
      },
    },
  ];

  // Filtered, not conditionally assembled: the read-only profile keeps the
  // remaining nine in exactly the order above, which mcp-server.md REQ-the-remote-profile-is-read-only
  // pins by name. Building two lists would let them drift.
  return allowWrites ? tools : tools.filter((t) => !WRITE_TOOLS.has(t.name));
}
