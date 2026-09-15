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
  'shadowBlur', 'shadowColor',   // performance-mode.md REQ-7: the canvas draws with neither
  'setPositionState',            // media-session.md: deliberately unset — a synth has no duration
]);

/** REQ-n is declared in the spec — or n is a lettered part (`23a`) of a declared REQ-23. */
export function hasReq(reqs, tag) {
  return reqs.has(tag) || (/[a-z]$/.test(tag) && reqs.has(tag.replace(/[a-z]+$/, '')));
}

const REQ_RUN = String.raw`REQ-(\d+[a-z]*)((?:\s*[/,]\s*REQ-\d+[a-z]*)*)`;
/** `x.md REQ-n`, `x.md) REQ-n`, `x.md's REQ-n`, `x.md → v3, REQ-n`, and runs `REQ-6/REQ-8`. */
const MD_CITATION = new RegExp(String.raw`([a-z0-9]+(?:-[a-z0-9]+)*)\.md\)?(?:'s)?[\s,:→]*(?:v\d+,?\s*)?${REQ_RUN}`, 'g');
/** A bare spec id: `arrangement REQ-4`. Only ids that ARE specs are checked, so prose is safe. */
const BARE_CITATION = new RegExp(String.raw`(?<![\w./-])([a-z0-9]+(?:-[a-z0-9]+)*) ${REQ_RUN}`, 'g');

/**
 * Citations in `text` whose REQ does not exist. `knownMd` is every markdown
 * basename in the repo, so a `.md` name that is not a spec but is a real file is
 * not reported as an unknown spec. `inSpec` skips the `[x](x.md) REQ-n` link
 * form, which the per-spec pass already checks with its own, looser window.
 */
export function citationsIn(text, reqsById, knownMd, inSpec = false) {
  const out = [];
  if (!text.includes('REQ-')) return out; // most code files cite nothing
  text.split(/\r?\n/).forEach((line, i) => {
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
      for (const tag of [first, ...[...rest.matchAll(/REQ-(\d+[a-z]*)/g)].map((m) => m[1])]) {
        if (!hasReq(reqs, tag)) report(`\`${id}${md ? '.md' : ''} REQ-${tag}\` — ${id}.md declares no REQ-${tag}`);
      }
    };
    for (const m of line.matchAll(MD_CITATION)) {
      if (inSpec && /\]\([^)\s]*$/.test(line.slice(0, m.index))) continue; // a link target
      check(m[1], m[2], m[3] ?? '', true);
    }
    for (const m of line.matchAll(BARE_CITATION)) check(m[1], m[2], m[3] ?? '', false);
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
