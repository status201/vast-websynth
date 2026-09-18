/**
 * The REQ-id rules for `scripts/spec-lint.mjs` — what a requirement id may look
 * like, and which ids a spec is still allowed to mint (specs/README.md →
 * "Enforcement & exemptions", ADR-021).
 *
 * Pure functions over strings, for the same reason `spec-xref.mjs` is: the lint
 * finds the files and hands the text in, so `tests/scripts/spec-reqs.test.ts` can
 * show each rule actually *fails* on the id it exists to refuse. A gate whose only
 * evidence is "the tree passes" proves nothing. Zero-dep, because CI runs the lint
 * without `npm install`.
 *
 * Two id grammars coexist while the migration runs:
 *   • legacy numeric — `4`, `23a`. Frozen per spec by `req-legacy.mjs`.
 *   • slug — `reset-auto-start`. The only kind anything new may use.
 * They start with different character classes, so classifying one is never a
 * judgement call.
 */

/** Headings that end the requirements region — everything after is not a REQ list. */
export const AFTER_REQS = /^## (Technical design|Visual aids|Scenarios|Tests & verification|Open questions)/;

/**
 * A legacy number, optionally with the ONE letter a sub-id adds (`5a`, `13b`).
 * Exactly one, deliberately: `\d+[a-z]*` would read `2fast` as a sub-id of REQ-2
 * and wave a typo'd slug through under the number's ceiling. Every lettered id in
 * the repo is single-letter, so nothing legitimate needs the looser form.
 */
const NUMERIC = /^\d+[a-z]?$/;
/** Kebab-case, starting with a letter — so a slug and a number never look alike. */
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Long enough to name a rule, short enough to read inside a citation. */
const SLUG_MAX = 60;
const SLUG_MIN = 2;

/** `'numeric'`, `'slug'`, or null for an id that is neither and must be reported. */
export function reqKind(tag) {
  if (NUMERIC.test(tag)) return 'numeric';
  if (SLUG.test(tag) && tag.length >= SLUG_MIN && tag.length <= SLUG_MAX) return 'slug';
  return null;
}

/** Sort key for a legacy numeric tag: `5` < `5a` < `5b` < `6`. Null for a slug. */
export function reqKey(tag) {
  const m = tag.match(/^(\d+)([a-z]?)$/);
  return m ? [Number(m[1]), m[2]] : null;
}

/**
 * Ids declared between `## Requirements` and the first design/scenario/test
 * heading, in document order. The window deliberately spans intermediate `##`
 * sections: a spec that grew in versioned rounds (`midi-clock-sync.md`'s
 * "## v2 additions", "## v3 fix — …") keeps declaring REQs under them, and those
 * are declarations like any other.
 *
 * Only a top-level `- **REQ-x**` bullet declares one — a prose bullet that merely
 * *starts* with a REQ reference does not, which is why the bold must close right
 * after the id.
 *
 * The id itself is matched loosely (anything word-shaped) so that a malformed one
 * is *seen* and reported by `reqKind`. Matching only well-formed ids would make a
 * typo invisible here and then surface it as "declares no REQ-…" at every site
 * that cites it — the wrong end of the problem.
 */
export function declaredReqs(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0) { if (/^## Requirements/.test(lines[i])) start = i; }
    else if (AFTER_REQS.test(lines[i])) { end = i; break; }
  }
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^- \*\*REQ-([A-Za-z0-9][\w-]*)\*\*/);
    if (m) out.push({ tag: m[1], line: i + 1 });
  }
  return out;
}

/**
 * Every rule that can be decided from one spec: the id grammar, uniqueness within
 * the spec, the legacy numbers' order and density, and the freeze that makes a new
 * number an error.
 *
 * `ceiling` is the spec's entry in `req-legacy.mjs` (0 when it has none, which is
 * every spec written from now on). Slugs are exempt from order and density by
 * design: they are appended, and there is no sequence for them to be dense in.
 */
export function checkSpecReqs(text, ceiling = 0) {
  const errors = [];
  const warnings = [];
  const reqs = declaredReqs(text);

  const seen = new Map();
  const numeric = [];
  for (const { tag, line } of reqs) {
    const kind = reqKind(tag);
    if (!kind) {
      errors.push(`\`REQ-${tag}\` (line ${line}) is not a valid id — use a kebab-case slug, `
        + 'lower-case and starting with a letter (e.g. `REQ-reset-auto-start`)');
      continue;
    }
    if (seen.has(tag)) errors.push(`duplicate \`REQ-${tag}\` (line ${line}; first at line ${seen.get(tag)})`);
    else seen.set(tag, line);

    if (kind === 'numeric') {
      numeric.push({ tag, line });
      // The freeze. A number above the ceiling cannot be one of the ids this spec
      // already had, so it is being minted now — which is the thing slugs exist to
      // stop. Lettered parts ride on their parent's number, so `24a` under a
      // ceiling of 24 is still legacy.
      if (reqKey(tag)[0] > ceiling) {
        errors.push(`\`REQ-${tag}\` (line ${line}) is a NEW numeric id — `
          + (ceiling ? `numbers here are frozen at REQ-${ceiling}` : 'this spec has no legacy numbers')
          + '. A new requirement gets a slug: `- **REQ-<kebab-slug>** — …` '
          + '(specs/decisions/adr-021-req-ids-are-slugs.md). '
          + 'Renamed this spec? Move its scripts/lib/req-legacy.mjs entry.');
      }
    }
  }

  // Legacy numbers stay in ascending order so the list still reads 1,2,3 — a REQ
  // added back then was APPENDED and its bullet moved into place, never renumbered.
  // Unreachable while `req-legacy.mjs` is empty (a number cannot be declared at
  // all), and kept for the same reason that file is: it is the rule for the form,
  // not a statement that the form currently occurs.
  for (let i = 1; i < numeric.length; i++) {
    const [pn, ps] = reqKey(numeric[i - 1].tag);
    const [cn, cs] = reqKey(numeric[i].tag);
    if (cn < pn || (cn === pn && cs < ps)) {
      errors.push(`\`REQ-${numeric[i].tag}\` (line ${numeric[i].line}) is out of order — `
        + `it follows \`REQ-${numeric[i - 1].tag}\``);
      break; // one report per spec; the whole list needs re-sorting anyway
    }
  }

  // A gap is only a warning: a reserved range is plausible, a scrambled list is not.
  const nums = [...new Set(numeric.map((r) => reqKey(r.tag)[0]))];
  if (nums.length) {
    const missing = [];
    for (let n = 1; n <= Math.max(...nums); n++) if (!nums.includes(n)) missing.push(n);
    if (missing.length) warnings.push(`gap in the REQ sequence: no REQ-${missing.join(', REQ-')}`);
  }

  return { reqs, errors, warnings };
}

/**
 * Slugs that two specs both declare.
 *
 * A number only ever meant something next to the spec that owned it, which is why
 * a bare `REQ-7` in a code comment could never be checked. A slug is distinctive
 * enough to resolve on its own — but only while it names one requirement in the
 * whole repo, so that is a rule rather than a hope. Numbers are exempt: every spec
 * has a REQ-1.
 *
 * `declaredBySpec` maps spec id → the `declaredReqs` array for it. Reported
 * against the *later* spec in iteration order, so the first declarer keeps the slug.
 */
export function duplicateSlugs(declaredBySpec) {
  const owner = new Map();
  const out = [];
  for (const [specId, reqs] of declaredBySpec) {
    for (const { tag, line } of reqs) {
      if (reqKind(tag) !== 'slug') continue;
      const first = owner.get(tag);
      if (first) {
        out.push({ specId, message: `\`REQ-${tag}\` (line ${line}) is already declared by ${first}.md — `
          + 'a slug names one requirement repo-wide, so that a citation of it resolves on its own' });
      } else owner.set(tag, specId);
    }
  }
  return out;
}
