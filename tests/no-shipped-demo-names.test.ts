import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { demoNames } from '../src/state/song';

/**
 * **A test may not name a shipped demo song.**
 *
 * `src/state/demos/` is a drop-in directory: adding, editing, renaming or
 * removing a song there is a data change that `specs/recipes/add-a-demo-song.md`
 * promises needs no code change. A test that spells a demo's name silently
 * revokes that promise, and it broke for real — adding one demo pushed another
 * past `DEMO_ROW_LIMIT` into the collapsed overflow, and five e2e call sites
 * that clicked it by name started timing out.
 *
 * The rule is `specs/recipes/write-a-test.md`; this file is what enforces it.
 * The demo list comes from `demoNames()` — the runtime source of truth (the
 * glob, `demos-index.json`, the built-ins and the zips) — rather than a
 * re-implementation that could drift the way a stale index would.
 */

const repo = (rel: string): string => fileURLToPath(new URL('../' + rel, import.meta.url));

/** Directories whose `.ts` files are subject to the rule. */
const SCANNED = ['tests', 'e2e'];

/**
 * Files permitted to contain a shipped demo name. Every entry needs a reason —
 * an empty allowlist is the goal, and adding to it is a design decision, not a
 * fix for a red test.
 */
const ALLOWLIST = new Map<string, string>([
  ['tests/no-shipped-demo-names.test.ts', 'derives the list from demoNames(); never spells one'],
]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(repo(dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(repo(rel)).isDirectory()) out.push(...tsFiles(rel));
    else if (entry.endsWith('.ts')) out.push(rel);
  }
  return out;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Two ways a demo name can be baked into a test, and only two:
 *
 * - **the testid** — `song-demo-<name>`, which nothing else can contain;
 * - **an exact quoted token** — `'Fat'`, `"1973"`, `` `Right` ``.
 *
 * The quote boundaries are what keep short names safe: `'Right'` matches while
 * `'ArrowRight'` does not, `'1973'` matches while `'websynth.song.1973'` does
 * not. Comments are deliberately in scope — a comment quoting a demo name is a
 * claim that goes stale the moment the library changes.
 */
const matchers = (name: string): { label: string; re: RegExp }[] => [
  { label: 'song-demo-<name> testid', re: new RegExp(escape(`song-demo-${name}`)) },
  { label: 'quoted string literal', re: new RegExp(`(['"\`])${escape(name)}\\1`) },
];

describe('no test names a shipped demo song', () => {
  it('the demo library is non-empty', () => {
    // Otherwise the scan below passes vacuously and this file is decoration.
    expect(demoNames().length).toBeGreaterThan(0);
  });

  it('no shipped demo claims the reserved `test-` prefix', () => {
    // Test-owned song and slot names all start with `test-`. Reserving the
    // prefix on the demo side makes a collision impossible — otherwise *adding*
    // a demo could break a test, which is the exact failure this file prevents.
    expect(demoNames().filter((n) => n.toLowerCase().startsWith('test-'))).toEqual([]);
  });

  it('no file under tests/ or e2e/ spells a demo name', () => {
    // Compiled once per demo, not once per LINE per demo: the scan is
    // files x lines x demos, so building the regexes inside the loop meant
    // ~10^6 RegExp constructions and put the whole test on the edge of its
    // timeout under a loaded parallel run.
    const probes = demoNames().flatMap((name) =>
      matchers(name).map(({ label, re }) => ({ name, label, re })));
    const offences: string[] = [];

    // Cheap pre-filter, tested against the WHOLE file once. A clean file — which is
    // every file, almost always — then costs one regex pass instead of lines x probes,
    // and only a file that actually mentions a demo pays for the per-line walk that
    // locates it. Without this the scan grew with the suite and tipped over its
    // timeout under load: it went red on a run whose only change was six new test
    // files, which is the worst kind of flake because it accuses innocent code.
    //
    // Deliberately the BARE names, not the probe sources joined together: every probe
    // contains its name literally, so a name-miss is a probe-miss and the filter
    // cannot hide an offence. Joining the sources would be wrong — the quoted-literal
    // probe carries a `\1` backreference, and alternation renumbers the groups.
    const mentionsAny = new RegExp(demoNames().map(escape).join('|'));

    for (const dir of SCANNED) {
      for (const file of tsFiles(dir)) {
        if (ALLOWLIST.has(file)) continue;
        const text = readFileSync(repo(file), 'utf8');
        if (!mentionsAny.test(text)) continue;
        text.split(/\r?\n/).forEach((line, i) => {
          for (const { name, label, re } of probes) {
            if (re.test(line)) offences.push(`  ${file}:${i + 1}  "${name}"  [${label}]`);
          }
        });
      }
    }

    if (offences.length > 0) {
      throw new Error(
        `${offences.length} place(s) name a shipped demo song. A test must never fail\n`
        + 'because a demo was added or edited (specs/recipes/write-a-test.md).\n\n'
        + `${offences.join('\n')}\n\n`
        + 'Pick demos by KIND, not by name:\n'
        + "  e2e   pickDemo(page, 'drop-in' | 'built-in' | 'zip'), clickDemo,\n"
        + '        dropInDeclaring — e2e/helpers.ts\n'
        + '  unit  it.each over DROP_IN_DEMOS / DEMO_SONGS, or the test-owned\n'
        + '        fixtureSong() — tests/fixtures/song-fixture.ts\n',
      );
    }
    // Explicit, generous timeout on top of the pre-filter above. This test reads every
    // file in two directories, so its cost tracks the size of the suite while its
    // budget does not — and a repo-wide guard that goes red from *contention* teaches
    // people to re-run rather than to look, which is how a guard stops being believed.
  }, 30_000);

  it('every allowlist entry still exists and still needs its exemption', () => {
    // A stale allowlist is how a rule quietly stops applying.
    for (const [file, reason] of ALLOWLIST) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(0);
      expect(() => statSync(repo(file)), `${file} is allowlisted but missing`).not.toThrow();
    }
  });
});
