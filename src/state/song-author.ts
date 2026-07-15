/**
 * The compact *authoring dialect* — an input-only song format
 * (`format: "websynth-song-author"`) that `Song.parse` expands into a
 * canonical `SongFile` (v3, or v4 when motion content is present) before
 * `validateSongFile` runs. It exists so AI
 * agents (and terse humans) can author a working song in ~40 lines instead
 * of the 576+ literal grid cells the canonical format requires. Nothing ever
 * serializes this dialect — see specs/features/song-authoring-dialect.md and
 * ADR-013 (input-only).
 *
 * Pure and dependency-free. Deliberately imports only `patterns.ts` +
 * `song-validate.ts` (and *type-only* `song.ts`), so the MCP server's Node
 * bundle can include it without dragging in `song.ts`'s import.meta.glob
 * demo registration.
 */
import type { SongFile, ChainData } from './song';
import type { SeqStep, TriggerCell, MotionStep, MotionAssign } from './patterns';
import {
  BANK_COUNT,
  SEQ_LENGTH,
  DRUM_TRACK_COUNT,
  SAMPLER_SLOT_COUNT,
  REST,
  TRIGGER_CELL_DEFAULTS,
  MOTION_STEP_DEFAULTS,
} from './patterns';
import { validateSongFile, type SongValidation } from './song-validate';

export const AUTHOR_FORMAT = 'websynth-song-author';

/** Cap reported errors so a wildly-malformed file can't produce thousands of lines. */
const MAX_ERRORS = 50;

/** Defaults for an authored seq step that is ON (off steps get the same + note 60). */
const SEQ_ON_DEFAULTS = { velocity: 0.85, gate: 0.5, prob: 1, ratchet: 1, tie: false };

const ALLOWED_KEYS = new Set([
  'format', 'version', 'name', 'params',
  'seq', 'drums', 'sampler', 'motion',
  'seqChain', 'drumChain', 'samplerChain', 'motionChain',
  'sampleNames', 'xy',
  '$schema', // tolerated so schema-aware editors/agents can self-reference
]);

/** Canonical grid keys — their presence means the agent mixed the two formats. */
const CANONICAL_KEYS = ['seqBanks', 'drumBanks', 'samplerBanks', 'motionBanks'] as const;

/** Normalized drum-track aliases → track index (kick/snare/hats/toms/clap). */
const DRUM_ALIASES: Record<string, number> = {
  kick: 0,
  snare: 1,
  chat: 2, hat: 2, hihat: 2, closedhat: 2,
  ohat: 3, openhat: 3,
  ltom: 4, lowtom: 4,
  mtom: 5, midtom: 5,
  htom: 6, hightom: 6,
  clap: 7,
};

const DRUM_KEY_HELP =
  'kick, snare, chat/hat/hihat/closedhat, ohat/openhat, ltom/lowtom, mtom/midtom, htom/hightom, clap, or "0".."7"';
const SAMPLER_KEY_HELP = 's1..s8 or "0".."7"';

type AddError = (msg: string) => void;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A short, human-readable description of an unexpected value for error messages. */
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  const t = typeof v;
  if (t === 'string') return `"${v as string}"`;
  if (t === 'number' || t === 'boolean') return String(v);
  return t;
}

/** `format === 'websynth-song-author'` on a JSON object — the routing test used by `Song.parse`. */
export function isAuthorSong(value: unknown): boolean {
  return isObject(value) && value.format === AUTHOR_FORMAT;
}

/* ---------------- note parsing ---------------- */

const NOTE_RE = /^([A-Ga-g])([#b]?)(-?\d+)$/;
const LETTER_SEMIS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/**
 * Note name → MIDI number with C4 = 60 (so C-1 = 0, G9 = 127).
 * Returns null when the string is not a note name at all.
 */
function noteNameToMidi(s: string): number | null {
  const m = NOTE_RE.exec(s);
  if (!m) return null;
  const semi = LETTER_SEMIS[m[1]!.toLowerCase()]!;
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = Number(m[3]);
  return (octave + 1) * 12 + semi + acc;
}

/** Parse a note value (number or name) into MIDI 0..127; adds an error and returns null when invalid. */
function parseNote(path: string, v: unknown, add: AddError): number | null {
  let midi: number | null = null;
  if (typeof v === 'number') {
    midi = v;
  } else if (typeof v === 'string') {
    midi = noteNameToMidi(v);
    if (midi === null) {
      add(`${path} must be a note name like "A2"/"C#4"/"Db3" or a MIDI number (got ${describe(v)})`);
      return null;
    }
  } else {
    add(`${path} must be a MIDI number 0..127 or a note name string (got ${describe(v)})`);
    return null;
  }
  if (!Number.isFinite(midi) || midi < 0 || midi > 127) {
    add(`${path} is out of MIDI range 0..127 (got ${describe(v)})`);
    return null;
  }
  return midi;
}

/* ---------------- per-step settings ---------------- */

function checkUnit(path: string, v: unknown, add: AddError): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    add(`${path} must be a number 0..1 (got ${describe(v)})`);
    return undefined;
  }
  return v;
}

function checkRatchet(path: string, v: unknown, add: AddError): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 4) {
    add(`${path} must be an integer 1..4 (got ${describe(v)})`);
    return undefined;
  }
  return v;
}

function checkTie(path: string, v: unknown, add: AddError): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') {
    add(`${path} must be a boolean (got ${describe(v)})`);
    return undefined;
  }
  return v;
}

interface StepOverrides {
  velocity?: number;
  gate?: number;
  prob?: number;
  ratchet?: number;
  tie?: boolean;
}

/** Pull the optional velocity/gate/prob/ratchet/tie overrides off an object. */
function readOverrides(path: string, o: Record<string, unknown>, add: AddError): StepOverrides {
  const out: StepOverrides = {};
  const velocity = checkUnit(`${path}.velocity`, o.velocity, add);
  if (velocity !== undefined) out.velocity = velocity;
  const gate = checkUnit(`${path}.gate`, o.gate, add);
  if (gate !== undefined) out.gate = gate;
  const prob = checkUnit(`${path}.prob`, o.prob, add);
  if (prob !== undefined) out.prob = prob;
  const ratchet = checkRatchet(`${path}.ratchet`, o.ratchet, add);
  if (ratchet !== undefined) out.ratchet = ratchet;
  const tie = checkTie(`${path}.tie`, o.tie, add);
  if (tie !== undefined) out.tie = tie;
  return out;
}

/* ---------------- seq banks ---------------- */

function emptySeqStep(): SeqStep {
  return { on: false, note: 60, ...SEQ_ON_DEFAULTS };
}

function makeEmptySeqBank(): SeqStep[] {
  return Array.from({ length: SEQ_LENGTH }, emptySeqStep);
}

/** Expand one positional seq entry (null | midi | "A2" | {note, ...}) into a cell. */
function expandSeqEntry(
  path: string,
  entry: unknown,
  bankDefaults: StepOverrides,
  add: AddError,
): SeqStep {
  const cell = { ...emptySeqStep(), ...bankDefaults };
  if (entry === null || entry === undefined) return cell;
  if (typeof entry === 'number' || typeof entry === 'string') {
    const midi = parseNote(path, entry, add);
    if (midi === null) return cell;
    cell.on = true;
    cell.note = midi;
    return cell;
  }
  if (isObject(entry)) {
    if (entry.note === undefined) {
      add(`${path}.note is required in a step object (got ${describe(entry.note)})`);
      return cell;
    }
    const midi = parseNote(`${path}.note`, entry.note, add);
    Object.assign(cell, readOverrides(path, entry, add));
    if (midi === null) return cell;
    cell.on = true;
    cell.note = midi;
    return cell;
  }
  add(`${path} must be null (rest), a MIDI number, a note name, or a step object (got ${describe(entry)})`);
  return cell;
}

/** Expand one seq bank — positional array or the {notes, ...defaults} form. */
function expandSeqBank(path: string, bank: unknown, add: AddError): SeqStep[] {
  let entries: unknown[];
  let bankDefaults: StepOverrides = {};
  if (Array.isArray(bank)) {
    entries = bank;
  } else if (isObject(bank)) {
    if (!Array.isArray(bank.notes)) {
      add(`${path}.notes must be an array of steps (got ${describe(bank.notes)})`);
      return makeEmptySeqBank();
    }
    for (const k of Object.keys(bank)) {
      if (!['notes', 'velocity', 'gate', 'prob', 'ratchet', 'tie'].includes(k)) {
        add(`${path}.${k} is not a bank field (allowed: notes, velocity, gate, prob, ratchet, tie)`);
      }
    }
    entries = bank.notes;
    bankDefaults = readOverrides(path, bank, add);
  } else {
    add(`${path} must be an array of steps or a {notes: [...]} object (got ${describe(bank)})`);
    return makeEmptySeqBank();
  }
  if (entries.length > SEQ_LENGTH) {
    add(`${path} has ${entries.length} steps — a bank holds at most ${SEQ_LENGTH} (short banks are rest-padded)`);
  }
  const out = makeEmptySeqBank();
  for (let i = 0; i < Math.min(entries.length, SEQ_LENGTH); i++) {
    out[i] = expandSeqEntry(`${path}[${i}]`, entries[i], bankDefaults, add);
  }
  // Rest-padding still carries the bank defaults so gate/velocity stay uniform
  // if the user later toggles a padded step on in the UI.
  for (let i = entries.length; i < SEQ_LENGTH; i++) {
    out[i] = { ...emptySeqStep(), ...bankDefaults };
  }
  return out;
}

function expandSeqBanks(v: unknown, add: AddError): SeqStep[][] {
  const banks: SeqStep[][] = Array.from({ length: BANK_COUNT }, makeEmptySeqBank);
  if (v === undefined) return banks;
  if (!Array.isArray(v)) {
    add(`seq must be an array of up to ${BANK_COUNT} banks (got ${describe(v)})`);
    return banks;
  }
  if (v.length > BANK_COUNT) add(`seq has ${v.length} banks — the synth has ${BANK_COUNT} (A..D)`);
  for (let b = 0; b < Math.min(v.length, BANK_COUNT); b++) {
    banks[b] = expandSeqBank(`seq[${b}]`, v[b], add);
  }
  return banks;
}

/* ---------------- drum / sampler hit banks ---------------- */

function makeTriggerGrid(rows: number): TriggerCell[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: SEQ_LENGTH }, () => ({ ...TRIGGER_CELL_DEFAULTS })),
  );
}

/** Resolve a drum track key (aliases) or sampler slot key (s1..s8) to a row index. */
function resolveRowKey(kind: 'drums' | 'sampler', key: string, rows: number): number | null {
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^\d+$/.test(norm)) {
    const i = Number(norm);
    return i < rows ? i : null;
  }
  if (kind === 'drums') return DRUM_ALIASES[norm] ?? null;
  const m = /^s([1-8])$/.exec(norm);
  return m ? Number(m[1]) - 1 : null;
}

/** Expand one hit-list bank ({kick:[0,4,8,12], ...}) onto a default trigger grid. */
function expandHitBank(
  kind: 'drums' | 'sampler',
  path: string,
  bank: unknown,
  rows: number,
  add: AddError,
): TriggerCell[][] {
  const grid = makeTriggerGrid(rows);
  if (!isObject(bank)) {
    add(`${path} must be an object mapping ${kind === 'drums' ? 'track names' : 'slots'} to hit lists (got ${describe(bank)})`);
    return grid;
  }
  const keyHelp = kind === 'drums' ? DRUM_KEY_HELP : SAMPLER_KEY_HELP;
  for (const [key, hits] of Object.entries(bank)) {
    const row = resolveRowKey(kind, key, rows);
    if (row === null) {
      add(`${path}.${key} is not a valid ${kind === 'drums' ? 'drum track' : 'sampler slot'} — use ${keyHelp}`);
      continue;
    }
    if (!Array.isArray(hits)) {
      add(`${path}.${key} must be an array of hits (got ${describe(hits)})`);
      continue;
    }
    hits.forEach((hit: unknown, h) => {
      const hitPath = `${path}.${key}[${h}]`;
      let step: unknown = hit;
      let overrides: StepOverrides = {};
      if (isObject(hit)) {
        step = hit.step;
        overrides = readOverrides(hitPath, hit, add);
      }
      if (typeof step !== 'number' || !Number.isInteger(step) || step < 0 || step >= SEQ_LENGTH) {
        add(`${hitPath}${isObject(hit) ? '.step' : ''} must be an integer step 0..${SEQ_LENGTH - 1} (got ${describe(step)})`);
        return;
      }
      const cell = grid[row]?.[step];
      if (cell) Object.assign(cell, { on: true }, overrides);
    });
  }
  return grid;
}

function expandHitBanks(
  kind: 'drums' | 'sampler',
  v: unknown,
  rows: number,
  add: AddError,
): TriggerCell[][][] {
  const banks: TriggerCell[][][] = Array.from({ length: BANK_COUNT }, () => makeTriggerGrid(rows));
  if (v === undefined) return banks;
  if (!Array.isArray(v)) {
    add(`${kind} must be an array of up to ${BANK_COUNT} banks (got ${describe(v)})`);
    return banks;
  }
  if (v.length > BANK_COUNT) add(`${kind} has ${v.length} banks — the synth has ${BANK_COUNT} (A..D)`);
  for (let b = 0; b < Math.min(v.length, BANK_COUNT); b++) {
    banks[b] = expandHitBank(kind, `${kind}[${b}]`, v[b], rows, add);
  }
  return banks;
}

/* ---------------- motion banks ---------------- */

function makeEmptyMotionBank(): MotionStep[] {
  return Array.from({ length: SEQ_LENGTH }, () => ({ ...MOTION_STEP_DEFAULTS }));
}

/** Read an optional per-bank axis override ({x?, y?} of param-id strings). */
function readMotionAssign(path: string, v: unknown, add: AddError): MotionAssign | null {
  if (v === undefined) return null;
  if (!isObject(v)) {
    add(`${path} must be an object like {"x": "<param id>", "y": "<param id>"} (got ${describe(v)})`);
    return null;
  }
  const out: MotionAssign = {};
  for (const axis of ['x', 'y'] as const) {
    const id = v[axis];
    if (id === undefined) continue;
    if (typeof id !== 'string' || id.length === 0) {
      add(`${path}.${axis} must be a non-empty param id string (got ${describe(id)})`);
      continue;
    }
    out[axis] = id;
  }
  return out.x || out.y ? out : null;
}

/** Expand one motion anchor {step, x, y} onto the bank grid. */
function expandMotionAnchor(path: string, v: unknown, bank: MotionStep[], add: AddError): void {
  if (!isObject(v)) {
    add(`${path} must be an anchor object {"step": 0..${SEQ_LENGTH - 1}, "x": 0..1, "y": 0..1} (got ${describe(v)})`);
    return;
  }
  const step = v.step;
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 0 || step >= SEQ_LENGTH) {
    add(`${path}.step must be an integer 0..${SEQ_LENGTH - 1} (got ${describe(step)})`);
    return;
  }
  const x = checkUnit(`${path}.x`, v.x, add);
  const y = checkUnit(`${path}.y`, v.y, add);
  if (v.x === undefined) add(`${path}.x is required (0..1)`);
  if (v.y === undefined) add(`${path}.y is required (0..1)`);
  if (x === undefined || y === undefined) return;
  const cell = bank[step];
  if (cell) Object.assign(cell, { on: true, x, y });
}

/** Expand one motion bank — an anchor list, or {assign?, steps: [anchors]}. */
function expandMotionBank(
  path: string,
  v: unknown,
  add: AddError,
): { steps: MotionStep[]; assign: MotionAssign | null } {
  const bank = makeEmptyMotionBank();
  let anchors: unknown = v;
  let assign: MotionAssign | null = null;
  if (isObject(v)) {
    for (const k of Object.keys(v)) {
      if (!['assign', 'steps'].includes(k)) {
        add(`${path}.${k} is not a motion bank field (allowed: assign, steps)`);
      }
    }
    assign = readMotionAssign(`${path}.assign`, v.assign, add);
    anchors = v.steps;
  }
  if (anchors === undefined) return { steps: bank, assign };
  if (!Array.isArray(anchors)) {
    add(`${path} must be an array of anchors or {assign, steps: [...]} (got ${describe(anchors)})`);
    return { steps: bank, assign };
  }
  anchors.forEach((a: unknown, i) => expandMotionAnchor(`${path}[${i}]`, a, bank, add));
  return { steps: bank, assign };
}

function expandMotionBanks(
  v: unknown,
  add: AddError,
): { banks: MotionStep[][]; assigns: (MotionAssign | null)[] } {
  const banks: MotionStep[][] = Array.from({ length: BANK_COUNT }, makeEmptyMotionBank);
  const assigns: (MotionAssign | null)[] = Array(BANK_COUNT).fill(null);
  if (v === undefined) return { banks, assigns };
  if (!Array.isArray(v)) {
    add(`motion must be an array of up to ${BANK_COUNT} banks (got ${describe(v)})`);
    return { banks, assigns };
  }
  if (v.length > BANK_COUNT) add(`motion has ${v.length} banks — the synth has ${BANK_COUNT} (A..D)`);
  for (let b = 0; b < Math.min(v.length, BANK_COUNT); b++) {
    const r = expandMotionBank(`motion[${b}]`, v[b], add);
    banks[b] = r.steps;
    assigns[b] = r.assign;
  }
  return { banks, assigns };
}

/* ---------------- chains ---------------- */

const CHAIN_HELP =
  'a string of bank letters A..D ("." or "-" = rest), an array of bank indices (-1 = rest), or {enabled, steps}';

function expandChain(path: string, v: unknown, add: AddError): ChainData {
  if (v === undefined) return { enabled: false, steps: [0] };
  if (typeof v === 'string') {
    const chars = v.replace(/\s+/g, '').split('');
    if (chars.length === 0) {
      add(`${path} must not be an empty string — ${CHAIN_HELP}`);
      return { enabled: false, steps: [0] };
    }
    const steps: number[] = [];
    for (const ch of chars) {
      if (ch === '.' || ch === '-') { steps.push(REST); continue; }
      const i = ch.toUpperCase().charCodeAt(0) - 65; // 'A' → 0
      if (i < 0 || i >= BANK_COUNT) {
        add(`${path} has an invalid bank letter "${ch}" — use A..${String.fromCharCode(64 + BANK_COUNT)}, "." or "-" for a rest`);
        continue;
      }
      steps.push(i);
    }
    return { enabled: true, steps: steps.length > 0 ? steps : [0] };
  }
  if (Array.isArray(v)) {
    if (v.length === 0) {
      add(`${path} must have at least 1 entry`);
      return { enabled: false, steps: [0] };
    }
    const steps: number[] = [];
    v.forEach((s: unknown, i) => {
      const ok = typeof s === 'number' && Number.isInteger(s) && (s === REST || (s >= 0 && s <= BANK_COUNT - 1));
      if (!ok) {
        add(`${path}[${i}] must be an integer 0..${BANK_COUNT - 1} or ${REST} (rest) (got ${describe(s)})`);
        return;
      }
      steps.push(s);
    });
    return { enabled: true, steps: steps.length > 0 ? steps : [0] };
  }
  if (isObject(v)) {
    if (typeof v.enabled !== 'boolean') add(`${path}.enabled must be a boolean (got ${describe(v.enabled)})`);
    const inner = expandChain(path + '.steps', v.steps === undefined ? [0] : v.steps, add);
    return { enabled: v.enabled === true, steps: inner.steps };
  }
  add(`${path} must be ${CHAIN_HELP} (got ${describe(v)})`);
  return { enabled: false, steps: [0] };
}

/* ---------------- top level ---------------- */

function expandParams(v: unknown, add: AddError): Record<string, number> {
  if (v === undefined) return {};
  if (!isObject(v)) {
    add(`params must be an object of param id -> number (got ${describe(v)})`);
    return {};
  }
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      add(`params.${k} must be a finite number (got ${describe(val)})`);
      continue;
    }
    out[k] = val;
  }
  return out;
}

function expandSampleNames(v: unknown, add: AddError): (string | null)[] {
  const out: (string | null)[] = Array(SAMPLER_SLOT_COUNT).fill(null);
  if (v === undefined) return out;
  if (!Array.isArray(v)) {
    add(`sampleNames must be an array of up to ${SAMPLER_SLOT_COUNT} entries (got ${describe(v)})`);
    return out;
  }
  if (v.length > SAMPLER_SLOT_COUNT) {
    add(`sampleNames has ${v.length} entries — the sampler has ${SAMPLER_SLOT_COUNT} slots`);
  }
  for (let i = 0; i < Math.min(v.length, SAMPLER_SLOT_COUNT); i++) {
    const n: unknown = v[i];
    if (n !== null && typeof n !== 'string') {
      add(`sampleNames[${i}] must be a string or null (got ${describe(n)})`);
      continue;
    }
    out[i] = n as string | null;
  }
  return out;
}

/**
 * Expand an authoring-dialect value into a canonical `SongFile` (v3; v4 when
 * motion content is present).
 * Validates in authoring terms first (path-prefixed, capped errors), expands,
 * then runs `validateSongFile` as the final gate. Input-only: nothing ever
 * serializes the dialect back out (ADR-013).
 */
export function expandAuthorSong(value: unknown): SongValidation {
  if (!isObject(value)) return { ok: false, errors: ['Author song must be a JSON object.'] };

  const errors: string[] = [];
  const add: AddError = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); };
  const o = value;

  if (o.format !== AUTHOR_FORMAT) add(`format must be "${AUTHOR_FORMAT}" (got ${describe(o.format)})`);
  if (o.version !== 1) add(`version must be 1 (got ${describe(o.version)})`);
  if (typeof o.name !== 'string') add(`name must be a string (got ${describe(o.name)})`);

  // Form-mixing is the likeliest agent failure: canonical grids in an author
  // file get a pointed redirect, not a generic unknown-key error.
  for (const k of CANONICAL_KEYS) {
    if (k in o) {
      add(`"${k}" is a full-form websynth-song field. The author dialect uses "seq"/"drums"/"sampler" hit lists — or set format to "websynth-song" for a full-form file.`);
    }
  }
  for (const k of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(k) && !(CANONICAL_KEYS as readonly string[]).includes(k)) {
      add(`unknown field "${k}" (allowed: ${[...ALLOWED_KEYS].filter((a) => a !== '$schema').join(', ')})`);
    }
  }

  const params = expandParams(o.params, add);
  const seqBanks = expandSeqBanks(o.seq, add);
  const drumBanks = expandHitBanks('drums', o.drums, DRUM_TRACK_COUNT, add);
  const seqChain = expandChain('seqChain', o.seqChain, add);
  const drumChain = expandChain('drumChain', o.drumChain, add);

  // Sampler fields are emitted only when the author supplied sampler content,
  // mirroring how a v1/v2 canonical file simply lacks them.
  const hasSampler = o.sampler !== undefined || o.samplerChain !== undefined || o.sampleNames !== undefined;
  const samplerBanks = hasSampler ? expandHitBanks('sampler', o.sampler, SAMPLER_SLOT_COUNT, add) : undefined;
  const samplerChain = hasSampler ? expandChain('samplerChain', o.samplerChain, add) : undefined;
  const sampleNames = hasSampler ? expandSampleNames(o.sampleNames, add) : undefined;

  // Motion fields likewise appear only when the author supplied motion content.
  const hasMotion = o.motion !== undefined || o.motionChain !== undefined;
  const motion = hasMotion ? expandMotionBanks(o.motion, add) : undefined;
  const motionChain = hasMotion ? expandChain('motionChain', o.motionChain, add) : undefined;

  // xy passes through; validated lightly here so the error names the author file.
  if (o.xy !== undefined) {
    if (!isObject(o.xy)) {
      add(`xy must be an object like {"x": "<param id>", "y": "<param id>"} (got ${describe(o.xy)})`);
    } else {
      for (const axis of ['x', 'y'] as const) {
        const id = o.xy[axis];
        if (typeof id !== 'string' || id.length === 0) {
          add(`xy.${axis} must be a non-empty param id string (got ${describe(id)})`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // REQ-11: a machine whose banks carry hits auto-enables, unless the author
  // set its on/off param explicitly — seq.on/drum.on/sampler.on default to 0
  // and Song.apply resets params first, so the song would import silent.
  const hasHits = (banks: { on: boolean }[][]): boolean =>
    banks.some((row) => row.some((step) => step.on));
  const autoEnable = (id: string, on: boolean) => {
    if (params[id] === undefined && on) params[id] = 1;
  };
  autoEnable('seq.on', hasHits(seqBanks));
  autoEnable('drum.on', hasHits(drumBanks.flat()));
  if (samplerBanks) autoEnable('sampler.on', hasHits(samplerBanks.flat()));
  if (motion) autoEnable('motion.on', hasHits([motion.banks.flat()]));

  const file: SongFile = {
    format: 'websynth-song',
    version: motion ? 4 : 3,
    name: o.name as string,
    params,
    seqBanks,
    drumBanks,
    seqChain,
    drumChain,
  };
  if (samplerBanks && samplerChain && sampleNames) {
    file.samplerBanks = samplerBanks;
    file.samplerChain = samplerChain;
    file.sampleNames = sampleNames;
  }
  if (o.xy !== undefined) file.xy = o.xy as SongFile['xy'];
  if (motion && motionChain) {
    file.motionBanks = motion.banks;
    file.motionAssigns = motion.assigns;
    file.motionChain = motionChain;
  }

  // Final gate: the expansion must yield a file the canonical validator accepts.
  return validateSongFile(file);
}
