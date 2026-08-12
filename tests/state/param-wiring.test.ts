import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ParamBus, registerDefaults } from '../../src/state/params';

/**
 * Every registered parameter is reachable from code that does something with it.
 *
 * ADR-001 records the cost of the `ParamBus` design: a new param is registered in
 * `registerDefaults()` **and** wired somewhere else by hand — "the three-edit
 * dance". The failure mode that dance produces is a param that registers cleanly,
 * shows up in `public/params.json`, gets snapshotted into every preset and song
 * from then on (ADR-006/ADR-011), and drives nothing at all. Nothing else catches
 * it: it typechecks, and a dead param has no behaviour to write a test against.
 *
 * So this scans `src/` for each registered id and fails on any that no code
 * mentions. It is a reachability check, not a correctness one — it proves an id
 * is referenced, not that it is referenced *correctly*, and a param wired only to
 * a UI control it can never reach would still pass. It is the cheap half of the
 * guard; hearing the parameter do something is the other half (ADR-010).
 *
 * Ids with an index segment (`drum.3.vol`, `mod.5.src`) are almost never written
 * out — the code builds them from a template — so those are matched against the
 * shape the template would produce.
 */

/** Vitest runs from the repo root, so `src/` resolves off the cwd. */
const SRC = resolve(process.cwd(), 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'vendor' || e.name === 'demos') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Everything under `src/` except the registry itself — that is the thing we suspect. */
const HAYSTACK = sourceFiles(SRC)
  .filter((p) => !p.endsWith(join('state', 'params.ts')))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

/**
 * Does any code mention this id? Either literally, or — for an id carrying an
 * index — as the template that would build it (`drum.3.vol` ← `drum.${t}.vol`).
 */
function isMentioned(id: string): boolean {
  if (HAYSTACK.includes(id)) return true;
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = id.split('.');
  return parts.some((seg, i) => {
    // An index segment is a digit run, optionally behind a fixed letter prefix
    // the template keeps outside the interpolation (`drum.t${i}.vol`).
    const m = /^([A-Za-z]*)(\d+)$/.exec(seg);
    if (!m) return false;
    const pattern = parts
      .map((s, j) => (j === i ? `${esc(m[1]!)}\\$\\{[^}]+\\}` : esc(s)))
      .join('\\.');
    return new RegExp(pattern).test(HAYSTACK);
  }) || boundByPrefix(id, esc);
}

/**
 * ADR-008's self-wiring: a component is handed a prefix and subscribes its own
 * suffixes off it, so `fx.drum.delay.on` exists in the source only as the prefix
 * `'fx.drum.delay'` (passed to `FxChain.bind`) meeting `` `${prefix}.on` ``
 * (inside `bindBypassMix`). Matching those two halves is what tells this scan the
 * param is genuinely wired rather than merely spelled somewhere.
 */
function boundByPrefix(id: string, esc: (s: string) => string): boolean {
  const parts = id.split('.');
  for (let k = 1; k < parts.length; k++) {
    const prefix = parts.slice(0, k).join('.');
    const suffix = parts.slice(k).join('.');
    if (!HAYSTACK.includes(`'${prefix}'`) && !HAYSTACK.includes(`\`${prefix}\``)) continue;
    if (new RegExp(`\\$\\{[^}]+\\}\\.${esc(suffix)}`).test(HAYSTACK)) return true;
  }
  return false;
}

describe('every registered param is reachable from code (ADR-001)', () => {
  const bus = new ParamBus();
  registerDefaults(bus);
  const ids = [...bus.ids()];

  it('registers a non-trivial catalogue (guards the scan itself)', () => {
    // If registration or the file scan silently produced nothing, the assertion
    // below would pass vacuously — this is what stops that.
    expect(ids.length).toBeGreaterThan(100);
    expect(HAYSTACK.length).toBeGreaterThan(100_000);
  });

  it('leaves no parameter registered but unreferenced', () => {
    const orphans = ids.filter((id) => !isMentioned(id));
    expect(orphans).toEqual([]);
  });
});
