import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * **`cancelScheduledValues` must pin the value it cancelled.**
 *
 * Cancelling removes the in-flight ramp *and* leaves no event at `t`, so the
 * next scheduled ramp starts from "the value of the AudioParam". Blink reads
 * that as the automation's computed value and the curve stays continuous;
 * Gecko does not write automation results back to the intrinsic value, so the
 * param snaps back to whatever was last assigned and the output steps.
 * `cancelAndHoldAtTime` would pin it natively — Firefox does not implement it
 * (`specs/features/sidechain-ducking.md`).
 *
 * That defect shipped once already. The DJ filter cancelled both of its params
 * on every write and re-issued a scheduled ramp; on Firefox every write
 * restarted from the constructed 20 kHz, so the cutoff sawtoothed open at the
 * write rate — 60 Hz from the motion loop — and crackled the master bus
 * (`specs/features/performance.md` REQ-10). It was invisible to the suite: the
 * mock `AudioParam` has a static `value` and no event list, so cancel-then-ramp
 * semantics cannot be observed by a behavioural test at all.
 *
 * Hence a source rule instead, of the same kind as
 * `tests/no-shipped-demo-names.test.ts` and `tests/ui/iconography.test.ts`: the
 * **first** thing scheduled on that same param after a cancel must be a
 * `setValueAtTime` (pin it) or a `setTargetAtTime` (retarget from it), never a
 * ramp. It has to be the *first* — `ducker.ts` cancels, pins, ramps, then
 * settles with a `setTargetAtTime` four lines later, so merely finding an anchor
 * somewhere nearby would accept the very defect this is here to catch.
 *
 * The rule and the way out of it are `specs/architecture.md` — a *continuous*
 * control should not be cancelling in the first place; `setTargetAtTime`
 * continues from wherever the curve has reached and may be re-issued at any
 * rate.
 */

const repo = (rel: string): string => fileURLToPath(new URL('../../' + rel, import.meta.url));

/** Every audio-layer source file is subject to the rule. */
const SCANNED = ['src/audio', 'public/worklets'];

/** How far after the cancel to look for the next write on the same param. */
const WINDOW = 8;

/** Anchors: these establish a value to continue from. */
const ANCHORS = ['setValueAtTime', 'setTargetAtTime'];
/** Ramps: these need a value to start from, and a bare cancel leaves none. */
const RAMPS = ['linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setValueCurveAtTime'];

/**
 * Cancel sites that legitimately pin nothing. Keyed `path:line`, and every entry
 * needs a reason — an empty allowlist is the goal, and adding to it is a design
 * decision, not a fix for a red test.
 */
const ALLOWED: Record<string, string> = {};

interface Hit { file: string; line: number; recv: string; }

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * The receiver of a `.cancelScheduledValues(` call — the expression to its left,
 * e.g. `node.frequency` in `node.frequency.cancelScheduledValues(now)`. Walks
 * backwards over identifier/`.`/`[]`/`()` characters, which is enough for the
 * shapes this codebase actually writes (`p`, `this.gain`, `node.detune`,
 * `this.slots[i]!.gain`).
 */
function receiverBefore(line: string, at: number): string {
  let i = at;
  let depth = 0;
  while (i > 0) {
    const c = line[i - 1]!;
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') { if (depth === 0) break; depth--; }
    else if (depth === 0 && !/[A-Za-z0-9_$.!?]/.test(c)) break;
    i--;
  }
  return line.slice(i, at).trim();
}

describe('AudioParam automation is never cancelled without being anchored', () => {
  const hits: Hit[] = [];
  const unanchored: string[] = [];

  for (const root of SCANNED) {
    for (const abs of walk(repo(root))) {
      const rel = abs.slice(abs.indexOf(root));
      const lines = readFileSync(abs, 'utf-8').replace(/\r\n/g, '\n').split('\n');
      lines.forEach((text, idx) => {
        const at = text.indexOf('.cancelScheduledValues(');
        if (at < 0) return;
        const recv = receiverBefore(text, at);
        hits.push({ file: rel, line: idx + 1, recv });
        // The FIRST subsequent write on this same param decides it.
        let verdict: 'anchored' | 'ramp' | 'none' = 'none';
        outer: for (const next of lines.slice(idx + 1, idx + 1 + WINDOW)) {
          for (const m of [...ANCHORS, ...RAMPS]) {
            if (next.includes(recv + '.' + m + '(')) {
              verdict = ANCHORS.includes(m) ? 'anchored' : 'ramp';
              break outer;
            }
          }
        }
        if (verdict !== 'anchored' && !(`${rel}:${idx + 1}` in ALLOWED)) {
          const why = verdict === 'ramp'
            ? 'the next write is a ramp, which has no value to start from'
            : 'nothing pins a value afterwards';
          unanchored.push(`${rel}:${idx + 1}  ${recv}.cancelScheduledValues(...) — ${why}`);
        }
      });
    }
  }

  it('finds the cancel sites it is meant to be policing', () => {
    // A silent zero would mean the walk or the matcher broke, and the guard
    // would pass forever without checking anything.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('pins a value after every cancel', () => {
    expect(unanchored, unanchored.join('\n')).toEqual([]);
  });

  it('leaves the DJ filter cancelling nothing at all (performance.md REQ-10)', () => {
    // Not merely anchored — the sweep is a continuous control, so it must use
    // `setTargetAtTime` and never reach for a cancel again.
    expect(hits.filter((h) => h.file.endsWith('transport/performance.ts'))).toEqual([]);
  });
});
