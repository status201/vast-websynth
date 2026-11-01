/**
 * The leanness rules for `scripts/spec-lint.mjs` — what keeps `specs/` "a lean
 * compiled instruction set, not a dumping ground" (specs/README.md → "Not in a
 * spec").
 *
 * The rule failed for years as prose alone: version history accreted in the
 * metadata block, in `## v3 fix` sections and in `(v7)` clauses inside REQs,
 * until a reader had to replay a spec's history to learn its current rule. These
 * checks refuse the three unambiguous shapes of that, and flag (without blocking)
 * the sizes that usually mean a spec is accreting again.
 *
 * Pure functions over strings, like `spec-reqs.mjs`, so
 * `tests/scripts/spec-lean.test.ts` can show each rule failing on the text it
 * exists to refuse. Zero-dep, because CI runs the lint without `npm install`.
 */

/** A spec past this many bytes is flagged (warning): it is probably accreting. */
export const SPEC_BYTES_WARN = 40_000;
/** A single REQ body past this many bytes is flagged (warning). */
export const REQ_BYTES_WARN = 2_500;

/** A REQ bullet's own landing marker: the `(v5)` / `— (v5, …)` right after its bold id. */
const LANDING = /^\s*- \*\*REQ-[a-z0-9-]+\*\*(?:\s*·\s*\*\*REQ-[a-z0-9-]+\*\*)*\s*(?:—\s*)?\(v\d+[^)]*\)/;
/** A version tag anywhere else in a REQ body: `(v7)`, `(v7, …)`, `(v7; …)`, `*(v7)*`. */
const INLINE_TAG = /\(v\d+(?:[),;]|\s)/;
/** A section named after a version: `## v3 fix — …`, `### v7 — …`. */
const VERSION_HEADING = /^#{2,4} v\d+\b/;

/**
 * Check one spec's text. `kind` is `'feature' | 'recipe' | 'architecture'`; ADRs
 * and templates are not passed in (an ADR *is* a dated record).
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkSpecLean(text) {
  const errors = [];
  const warnings = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  // 1. The metadata block's `version:` is an integer. A changelog under it — a
  //    `# v12: …` comment run, or a `vN:` note on the value — duplicates
  //    CHANGELOG.md and git, and is where the accretion started.
  if (lines[0]?.startsWith('```yaml')) {
    for (let i = 1; i < lines.length && !lines[i].startsWith('```'); i++) {
      const l = lines[i];
      if (/^version:.*#.*\bv\d+:/.test(l) || /^\s*#\s*v\d+\b/.test(l)) {
        errors.push(`line ${i + 1}: version history in the metadata block (history goes in CHANGELOG.md; \`version:\` is an integer)`);
      }
    }
  }

  // 2 + 3. Outside code fences: no version-named section anywhere, and no version
  //    tag inside a REQ body beyond the REQ's own landing marker.
  let inFence = false;
  let inReqs = false;
  let reqStart = -1;
  let reqBytes = 0;
  let reqName = '';
  const flushReq = () => {
    if (reqStart >= 0 && reqBytes > REQ_BYTES_WARN) {
      warnings.push(`line ${reqStart}: ${reqName} is ${reqBytes} bytes (over ${REQ_BYTES_WARN}) — split it, or move its history out`);
    }
    reqStart = -1;
    reqBytes = 0;
  };
  lines.forEach((line, i) => {
    if (i === 0 && line.startsWith('```yaml')) { inFence = true; return; }
    if (line.startsWith('```')) { inFence = !inFence; if (inReqs && reqStart >= 0) reqBytes += line.length + 1; return; }
    if (inFence) { if (inReqs && reqStart >= 0) reqBytes += line.length + 1; return; }
    if (VERSION_HEADING.test(line)) {
      errors.push(`line ${i + 1}: section named after a version (\`${line.slice(0, 40)}\`) — name it by the concern it covers`);
    }
    if (/^## /.test(line)) { flushReq(); inReqs = /^## Requirements/.test(line); return; }
    if (!inReqs) return;
    const head = /^- \*\*(REQ-[a-z0-9-]+)\*\*/.exec(line);
    if (head) { flushReq(); reqStart = i + 1; reqName = head[1]; }
    if (reqStart >= 0) reqBytes += Buffer.byteLength(line) + 1;
    const body = line.replace(LANDING, '');
    if (INLINE_TAG.test(body)) {
      errors.push(`line ${i + 1}: version tag inside a REQ body (a REQ states the current rule; only its own landing \`(vN)\` stays)`);
    }
  });
  flushReq();

  const bytes = Buffer.byteLength(text);
  if (bytes > SPEC_BYTES_WARN) {
    warnings.push(`${bytes} bytes (over ${SPEC_BYTES_WARN}) — see specs/README.md "Not in a spec"`);
  }
  return { errors, warnings };
}

/**
 * The `related:` ids in a metadata block that name no spec. An entry is a spec id
 * (`transport`), a relative path (`../decisions/adr-015-…`), optionally `.md`.
 * @param {string} block the metadata block's text
 * @param {Set<string>} ids every spec / ADR id in the repo
 */
export function danglingRelated(block, ids) {
  const out = [];
  // Every \r goes, not just \r\n pairs: a CRLF block's LAST line keeps a lone \r,
  // and `.` does not match \r, so its `# comment` would survive the strip below.
  const m = /^related:\n((?:[ \t]+-[^\n]*\n?)*)/m.exec(block.replace(/\r/g, ''));
  if (!m) return out;
  for (const raw of m[1].split('\n')) {
    const v = raw.replace(/^\s*-\s*/, '').replace(/\s*#.*$/, '').trim();
    if (!v) continue;
    const id = v.split('/').pop().replace(/\.md$/, '');
    if (!ids.has(id)) out.push(v);
  }
  return out;
}
