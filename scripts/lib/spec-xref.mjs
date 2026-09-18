/**
 * Cross-reference checks for `scripts/spec-lint.mjs` — the prose that points INTO
 * specs and code (specs/README.md → "Enforcement & exemptions").
 *
 * Pure functions over strings: the lint discovers the files and the code's
 * identifiers, and hands the text in. That split is what lets
 * tests/scripts/spec-xref.test.ts show each check actually *fails* on drift — a
 * lint whose only evidence is "the tree passes" proves nothing. Zero-dep, like the
 * lint, because CI runs it without `npm install`.
 */

/**
 * Names a spec may use in backticks that the code deliberately does NOT contain —
 * a platform API the design chose not to call, which is exactly why the spec
 * names it. Keep this short, and give every entry its reason.
 */
export const EXTERNAL_NAMES = new Set([
  'shadowBlur', 'shadowColor',   // performance-mode.md REQ-the-canvas-drop-shadow-is-gone: the canvas draws with neither
  'setPositionState',            // media-session.md: deliberately unset — a synth has no duration
]);

/**
 * The id is declared in the spec — or it is a lettered part (`23a`) of a declared
 * legacy numeric id. That leniency is numeric-only: a slug ends in a letter too, so
 * applying it there would answer `REQ-reset-auto-start` by looking for a
 * `REQ-reset-auto-` nobody wrote.
 */
export function hasReq(reqs, tag) {
  return reqs.has(tag) || (/^\d+[a-z]+$/.test(tag) && reqs.has(tag.replace(/[a-z]+$/, '')));
}

/**
 * A REQ id as a citation writes it: a legacy number (`4`, `23a`) or a slug
 * (`reset-auto-start`). One class matches both — which kind it is only matters
 * where an id is *declared*, and `spec-reqs.mjs` owns that. A segment can never be
 * empty, so a trailing hyphen or an em-dash after the id stays out of the match.
 */
const REQ_TAG = String.raw`[a-z0-9]+(?:-[a-z0-9]+)*`;
const REQ_RUN = String.raw`REQ-(${REQ_TAG})((?:\s*[/,]\s*REQ-${REQ_TAG})*)`;
/**
 * `x.md REQ-<id>`, `x.md) REQ-<id>`, `x.md's REQ-<id>`, `x.md → v3, REQ-<id>`, runs
 * `REQ-<id>/REQ-<id>` — and the backticked form, `` `specs/x.md` REQ-<id> ``, which the
 * root docs and several ADRs use. That last closer was missing for a long time, so
 * 45 citations across CLAUDE.md, DEPLOYMENT.md and the ADRs were never checked at
 * all; one of them had already gone stale.
 */
const MD_CITATION = new RegExp(String.raw`(${REQ_TAG})\.md[)\`]*(?:'s)?[\s,:→]*(?:v\d+,?\s*)?${REQ_RUN}`, 'g');
/** A bare spec id: `arrangement REQ-start-seeks-every-lane`. Only ids that ARE specs are checked, so prose is safe. */
const BARE_CITATION = new RegExp(String.raw`(?<![\w./-])(${REQ_TAG}) ${REQ_RUN}`, 'g');

/**
 * The leading ids on a line, for a citation whose spec name ended the line above.
 * Only the head of the line counts — once ordinary prose resumes, an id is no
 * longer part of the carried citation.
 */
const LEADING_RUN = new RegExp(String.raw`^[\s*/#>|()[\]'"\`,-]*${REQ_RUN}`);

/**
 * The spec named at the end of `prevLine`, when that line carries no id of its own.
 *
 * A citation wraps like any other prose:
 *
 *     …buffers to match ([scope](scope.md)
 *     REQ-all-analysers-share-fft-settings). Because it applies live, …
 *
 * Read line by line — which is how this file and the lint both work — the second
 * line looks like a bare id belonging to whatever spec the file is about. 130
 * citations in the tree are split this way, and every one of them went unchecked
 * until this existed; a rename pass reading them the same way silently repointed
 * 17 of them at the wrong spec before an audit caught it.
 */
function carriedAnchor(prevLine, reqsById) {
  if (!prevLine) return null;
  // The signal is the spec name ENDING the line, not the absence of ids on it: a
  // requirement bullet always carries its own id, and one of them ends with a link
  // to another spec whose id opens the next line.
  const m = prevLine.match(new RegExp(String.raw`(${REQ_TAG})\.md[)\`'\s]*$`));
  return m && reqsById.has(m[1]) ? m[1] : null;
}

/**
 * Every slug any spec declares. A slug names one requirement repo-wide
 * (`spec-reqs.mjs` → `duplicateSlugs`), which is what makes a BARE `REQ-<slug>` —
 * one that names no spec, the shape most comments use — resolvable at all. Under
 * numbers it never was: a bare number meant nothing without knowing which spec was
 * meant, so ~3,900 references in the tree were unlintable by construction.
 */
function allSlugs(reqsById) {
  const out = new Set();
  for (const reqs of reqsById.values()) for (const tag of reqs) if (/^[a-z]/.test(tag)) out.add(tag);
  return out;
}

/** A bare `REQ-<slug>` — no spec id in front of it, and not part of a run. */
const BARE_SLUG = new RegExp(String.raw`(?<![\w./-])REQ-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`, 'g');

/**
 * Citations in `text` whose REQ does not exist. `knownMd` is every markdown
 * basename in the repo, so a `.md` name that is not a spec but is a real file is
 * not reported as an unknown spec. `inSpec` skips the `[x](x.md) REQ-<id>` link
 * form, which the per-spec pass already checks with its own, looser window — that
 * skip is line-scoped, so a citation split across the break is still checked here.
 */
export function citationsIn(text, reqsById, knownMd, inSpec = false, bareSlugs = true) {
  const out = [];
  if (!text.includes('REQ-')) return out; // most code files cite nothing
  const lines = text.split(/\r?\n/);
  const slugs = bareSlugs ? allSlugs(reqsById) : null;
  lines.forEach((line, i) => {
    // Both patterns end in `REQ-`, so a line without it cannot match — and
    // skipping it keeps a whole-repo pass cheap enough for the Stop hook.
    if (!line.includes('REQ-')) return;
    const seen = new Set();
    const report = (msg) => { if (!seen.has(msg)) { seen.add(msg); out.push(`line ${i + 1}: ${msg}`); } };
    const check = (id, first, rest, md) => {
      if (id.startsWith('adr-')) return; // ADRs declare no REQs
      const reqs = reqsById.get(id);
      if (!reqs) {
        if (md && !knownMd.has(`${id}.md`)) report(`cites \`${id}.md\`, which is no spec`);
        return;
      }
      const more = [...rest.matchAll(new RegExp(String.raw`REQ-(${REQ_TAG})`, 'g'))].map((m) => m[1]);
      for (const tag of [first, ...more]) {
        if (!hasReq(reqs, tag)) report(`\`${id}${md ? '.md' : ''} REQ-${tag}\` — ${id}.md declares no REQ-${tag}`);
      }
    };
    // Spans already claimed by an anchored citation. A bare-slug pass must not
    // re-report an id that one of these already resolved against its own spec.
    const claimed = [];
    for (const m of line.matchAll(MD_CITATION)) {
      claimed.push([m.index, m.index + m[0].length]);
      if (inSpec && /\]\([^)\s]*$/.test(line.slice(0, m.index))) continue; // a link target
      check(m[1], m[2], m[3] ?? '', true);
    }
    for (const m of line.matchAll(BARE_CITATION)) {
      claimed.push([m.index, m.index + m[0].length]);
      check(m[1], m[2], m[3] ?? '', false);
    }

    // The tail of a citation whose spec name is on the line above.
    const carry = carriedAnchor(lines[i - 1], reqsById);
    if (carry) {
      const lead = line.match(LEADING_RUN);
      if (lead) { claimed.push([0, lead[0].length]); check(carry, lead[1], lead[2] ?? '', true); }
    }

    // What no anchored citation claimed is a bare slug: it names no spec, so it is
    // checked against every slug in the tree. Only a slug can be resolved this way
    // — a number never could, which is the whole argument of ADR-021.
    if (slugs) {
      for (const m of line.matchAll(BARE_SLUG)) {
        if (claimed.some(([s, e]) => m.index >= s && m.index < e)) continue;
        if (!slugs.has(m[1])) report(`\`REQ-${m[1]}\` is declared by no spec`);
      }
    }
  });
  return out;
}

/** A line that talks about the past ("was", "renamed", "v6's") may name what is gone. */
export const HISTORY = /\b(?:was|were|used to|removed|deleted|renamed|replaced|replaces|superseded|gone|no longer|formerly|previously|dropped|retired|until v\d+|v\d+'s)\b/i;

/**
 * Backticked code names in a spec or doc that no code identifier matches.
 *
 * Only shapes that are unambiguously code are checked — `Class.member` (a
 * PascalCase receiver), `camelCase(...)` and bare `camelCase` with an inner
 * capital — so prose words, CSS classes, file names and platform types in
 * backticks (`AudioParam`, `MediaSession`) are never read as claims. Exempt:
 *   • a line that talks about the past (`HISTORY`) — "was `attachTransport`";
 *   • `## Open questions` — a proposal names what does not exist yet;
 *   • a name the same document defines as a YAML key in one of its own fenced
 *     blocks (midi-clock-sync.md's `linkIdleMs: 3000` data shapes);
 *   • `EXTERNAL_NAMES`.
 */
export function staleNamesIn(text, ids) {
  const lines = text.split(/\r?\n/);
  const local = new Set();
  let fenced = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) { fenced = !fenced; continue; }
    const k = fenced && l.match(/^\s*([A-Za-z_$][\w$]*):/);
    if (k) local.add(k[1]);
  }
  const known = (w) => ids.has(w) || local.has(w) || EXTERNAL_NAMES.has(w);
  const out = [];
  let future = false;
  lines.forEach((line, i) => {
    if (/^## /.test(line)) future = /^## Open questions/.test(line);
    if (future || HISTORY.test(line)) return;
    for (const m of line.matchAll(/`([^`\n]{2,80})`/g)) {
      const tok = m[1];
      let missing = [];
      const dotted = tok.match(/^([A-Z][A-Za-z0-9]*)\.([a-z_$][\w$]*)(?:\(.*\))?$/);
      const call = tok.match(/^([a-z_$][\w$]*[A-Z][\w$]*)\(.*\)$/);
      const camel = tok.match(/^([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)$/);
      if (dotted) missing = [dotted[1], dotted[2]].filter((w) => !known(w));
      else if (call) missing = known(call[1]) ? [] : [call[1]];
      else if (camel) missing = known(camel[1]) ? [] : [camel[1]];
      if (missing.length) {
        out.push(`line ${i + 1}: \`${tok}\` names ${missing.map((w) => `\`${w}\``).join(' and ')}, which the code does not have`);
      }
    }
  });
  return out;
}
