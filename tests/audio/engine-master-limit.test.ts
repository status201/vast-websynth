import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const engine = readFileSync(fileURLToPath(new URL('../../src/audio/engine.ts', import.meta.url)), 'utf8');

/**
 * **The limiter is the last stage** (master-limiter.md
 * REQ-the-limiter-is-the-last-stage, ADR-029).
 *
 * No unit test builds a whole `Engine` (the mock context has no analysers), so
 * the wiring is pinned as a source rule, the way `engine-stereo.test.ts` pins
 * `forceStereo(this.synthPan)`. What is at stake is the default's meaning: a
 * 0 dBFS ceiling is only a no-op for in-range audio if it sits after the
 * master volume and before everything that hears the output. The real graph is
 * checked by rendering through it (`npm run bench:audio`).
 */
describe('the master limiter sits after the volume, before every listener', () => {
  it('master feeds the limiter, and the limiter feeds the destination', () => {
    expect(engine).toContain('this.master.connect(this.masterLimit.input)');
    expect(engine).toContain('this.masterLimit.output.connect(this.ctx.destination)');
  });

  it('the recorder taps the limiter, so an export is what was heard', () => {
    expect(engine).toContain('this.masterLimit.output.connect(this.recorderNode.input)');
  });

  it('nothing bypasses it: master reaches neither the destination nor the recorder directly', () => {
    expect(engine).not.toMatch(/this\.master\.connect\(this\.ctx\.destination\)/);
    expect(engine).not.toMatch(/this\.master\.connect\(this\.recorderNode/);
  });

  it('a failed limiter load is caught, so the boot goes on (REQ-a-failed-load-never-mutes-the-master)', () => {
    const at = engine.indexOf('await LimiterNode.loadModule(this.ctx)');
    expect(at).toBeGreaterThan(-1);
    const before = engine.slice(Math.max(0, at - 400), at);
    expect(before).toContain('try {');
  });
});
