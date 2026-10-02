import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

/**
 * runtime-performance.md REQ-global-listeners-live-only-for-a-gesture, as a source rule.
 *
 * A `pointermove` on `window` or `document` fires for every mouse movement over
 * the whole page. Attached for the length of a drag it costs nothing; attached
 * for good it runs a handler on every frame the user is anywhere near the app.
 * The repo has no linter, so — like `tests/audio/no-unanchored-cancel.test.ts` —
 * the rule is a scan: every global move listener a file adds must be removed by
 * the same file with the same handler, which is the shape a gesture-scoped
 * listener has (added on pointerdown, removed on pointerup / cancel).
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const SRC = join(root, 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'vendor' ? [] : files(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

const ADD = /\b(window|document)\.addEventListener\(\s*'(pointermove|mousemove|touchmove)'\s*,\s*([\w.]+)/g;

describe('global move listeners live only for a gesture', () => {
  it('every window/document move listener is removed by the file that adds it', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(ADD)) {
        seen++;
        const [, target, type, handler] = m;
        const removal = new RegExp(
          `\\b${target}\\.removeEventListener\\(\\s*'${type}'\\s*,\\s*${handler!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        );
        if (!removal.test(text)) offenders.push(`${relative(root, f)}: ${target} ${type} ${handler}`);
      }
    }
    expect(seen, 'the scan found nothing — the pattern has drifted from the code').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
