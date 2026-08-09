import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import index from '../../src/state/demos-index.json';
import { JSON_DEMOS, ZIP_DEMOS, DEMO_SONGS, demoMetaFor, demoNames } from '../../src/state/song';
import { demoSummary, type DemoMeta } from '../../src/state/demo-meta';

/**
 * specs/features/demo-library.md — the generated index is a build artifact, so
 * what is worth pinning is its SHAPE and its COVERAGE, not any demo's values.
 * The values themselves are gated byte-for-byte by `npm run check:demos`.
 *
 * Deliberately no demo is named here (`tests/no-shipped-demo-names.test.ts`).
 */
const DEMOS_DIR = path.join(process.cwd(), 'src', 'state', 'demos');
const entries = Object.entries(index as Record<string, DemoMeta>);

describe('demos-index.json', () => {
  it('covers every demo file on disk, JSON and zip alike (REQ-3)', () => {
    const onDisk = readdirSync(DEMOS_DIR)
      .filter((f) => f.endsWith('.json') || f.endsWith('.websynth.zip'))
      .sort();
    expect(Object.keys(index).sort()).toEqual(onDisk);
    // The zips are the only demos that can carry sampler audio, and they used
    // to be absent from the index entirely.
    expect(onDisk.some((f) => f.endsWith('.websynth.zip'))).toBe(true);
  });

  it('is keyed by sorted filenames, so the emitted JSON is byte-stable (REQ-7)', () => {
    const keys = Object.keys(index);
    expect(keys).toEqual([...keys].sort());
  });

  it.each(entries)('%s has a well-formed entry', (_file, meta) => {
    expect(typeof meta.name).toBe('string');
    expect(meta.name.length).toBeGreaterThan(0);
    expect(Number.isInteger(meta.bpm)).toBe(true);
    expect(meta.bpm).toBeGreaterThan(0);
    expect(Number.isInteger(meta.bars)).toBe(true);
    expect(meta.bars).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(meta.uses)).toBe(true);
    for (const m of meta.uses) expect(['seq', 'drums', 'sampler', 'motion']).toContain(m);
    for (const a of meta.armed ?? []) expect(['arp', 'motion']).toContain(a);
    // An empty `armed` must be omitted, not written as [] (REQ-7: stable shape).
    if (meta.armed) expect(meta.armed.length).toBeGreaterThan(0);
  });

  it('every shipped demo actually plays something', () => {
    // A demo whose machines are all silent is a broken drop-in, and the index
    // is now the cheapest place to notice.
    for (const [file, meta] of entries) {
      expect(meta.uses.length, `${file} sounds nothing`).toBeGreaterThan(0);
    }
  });

  it('gives every demo in the row a summary — including the built-ins (REQ-6)', () => {
    // The built-ins are TS literals with no index entry; `demoMetaFor` derives
    // their facts on the spot, so no button in the row can be left mute.
    for (const name of demoNames()) {
      const meta = demoMetaFor(name);
      expect(meta, `${name} has no metadata`).not.toBeNull();
      expect(demoSummary(meta!).length, `${name} has an empty summary`).toBeGreaterThan(0);
    }
    expect(Object.keys(DEMO_SONGS).length).toBeGreaterThan(0); // the built-ins exist
  });

  it('labels every drop-in and zip from the index, not from its filename', () => {
    for (const ref of [...JSON_DEMOS, ...ZIP_DEMOS]) {
      expect(ref.meta, `${ref.name} fell back to its filename`).toBeDefined();
      expect(ref.name).toBe(ref.meta!.name);
    }
  });
});
