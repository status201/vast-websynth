import { AUTHOR_FORMAT } from './song-author';
import { PRESET_FORMAT, BANK_FORMAT } from './preset-file';
import { isObject } from './validate-utils';

/**
 * Pasted-payload extraction + classification — `specs/features/paste-import.md`
 * REQ-1..REQ-4.
 *
 * Deliberately pure (no DOM, no `song.ts` — its `import.meta.glob` would poison
 * any Node bundle, same rule as `song-author.ts`): the whole "what did the user
 * just paste?" decision is a function of one string, so the modal is left with
 * nothing but rendering and every tolerance rule is unit-testable.
 *
 * Tolerance is the point. AI agents wrap their answer in ```json fences and
 * top-and-tail it with prose; refusing that input would make the paste door
 * useless in the one situation it exists for.
 */

/** The canonical song format tag (a literal here as in `song-validate.ts`). */
const SONG_FORMAT = 'websynth-song';

export type PasteKind = 'song' | 'author' | 'preset' | 'bank' | 'unknown';

export interface PasteClassification {
  kind: PasteKind;
  /** The extracted JSON body — present whenever `kind` is not `unknown`. */
  json?: string;
  /** The payload's own `name`, when it has one. */
  name?: string;
  /** Sounds in the payload (1 for a preset file). */
  count?: number;
  /** REQ-3 — the kind was inferred from keys because no `format` tag was present. */
  assumed?: true;
  /** REQ-4 — why it was refused. Only set when `kind` is `unknown`. */
  reason?: string;
}

const NO_JSON = 'No JSON found — paste the whole reply, or just the { … } object.';
const MALFORMED = 'That JSON is incomplete or malformed — the reply may have been cut off.';
const NO_FORMAT =
  'JSON without a "format" field — expected websynth-song, websynth-song-author, ' +
  'websynth-preset or websynth-preset-bank.';

/** Fenced block: ```json … ``` (language tag optional). Non-greedy, first match wins. */
const FENCE_RE = /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/;

/**
 * The JSON body of a pasted reply, or null (REQ-1). Prefers the first fenced
 * code block, then slices first `{` … last `}` so surrounding prose never
 * reaches `JSON.parse`.
 */
export function extractJson(text: string): string | null {
  if (!text) return null;
  const body = FENCE_RE.exec(text)?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return body.slice(start, end + 1).trim();
}

/** A payload's `name`, when it carries a usable one. */
function nameOf(o: Record<string, unknown>): string | undefined {
  return typeof o['name'] === 'string' && o['name'] ? o['name'] : undefined;
}

/**
 * What did the user paste? Total (never throws) and always explains a refusal
 * (REQ-2/REQ-4). Routing is by `format` tag, with a key-shape fallback for a
 * payload that dropped it (REQ-3).
 */
export function classifyPayload(text: string): PasteClassification {
  const json = extractJson(text);
  if (json === null) return { kind: 'unknown', reason: NO_JSON };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: 'unknown', reason: MALFORMED };
  }
  if (!isObject(parsed)) {
    return { kind: 'unknown', reason: 'That JSON is not an object.' };
  }

  const name = nameOf(parsed);
  switch (parsed['format']) {
    case SONG_FORMAT:
      return { kind: 'song', json, ...(name ? { name } : {}) };
    case AUTHOR_FORMAT:
      return { kind: 'author', json, ...(name ? { name } : {}) };
    case PRESET_FORMAT:
      return { kind: 'preset', json, count: 1, ...(name ? { name } : {}) };
    case BANK_FORMAT: {
      const presets = parsed['presets'];
      const count = isObject(presets) ? Object.keys(presets).length : 0;
      return { kind: 'bank', json, count, ...(name ? { name } : {}) };
    }
  }

  // REQ-3 — no (or an unrecognized) tag: infer from the keys that only one
  // format has, so an agent that dropped one field still reaches the validator
  // instead of a dead end.
  if (parsed['format'] === undefined) {
    if ('seqBanks' in parsed || 'drumBanks' in parsed) {
      return { kind: 'song', json, assumed: true, ...(name ? { name } : {}) };
    }
    if ('seq' in parsed || 'drums' in parsed) {
      return { kind: 'author', json, assumed: true, ...(name ? { name } : {}) };
    }
    return { kind: 'unknown', reason: NO_FORMAT };
  }

  return {
    kind: 'unknown',
    reason: `Unrecognized "format": ${JSON.stringify(parsed['format'])}.`,
  };
}
