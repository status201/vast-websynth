import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  layersNamedIn, namesLayersInOrder, readLayerOrder, cssLayerOrderPlugin,
} from '../../scripts/lib/css-layer-order.mjs';

// The one parser of the cascade layer order (specs/features/css-cascade-layers.md):
// the build plugin, check-bundle and the layers drift pin all read it here.

const ORDER = ['reset', 'theme', 'app-layout', 'controls', 'components', 'chrome', 'panels', 'shell'];

function layersFile(css: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'layers-')), 'layers.css');
  writeFileSync(file, css);
  return file;
}

describe('readLayerOrder', () => {
  it('reads the shipped order', () => {
    expect(readLayerOrder().names).toEqual(ORDER);
  });

  it('refuses a second statement or a stray rule — "the order" must be unambiguous', () => {
    expect(() => readLayerOrder(layersFile('@layer a, b;\n@layer c;'))).toThrow(/found 2/);
    expect(() => readLayerOrder(layersFile('@layer a, b;\n.x { color: red }'))).toThrow(/more than/);
    expect(() => readLayerOrder(layersFile('/* nothing */'))).toThrow(/found 0/);
  });
});

describe('namesLayersInOrder (the check-bundle property, REQ-the-layer-order-is-declared-once-and-first)', () => {
  it('accepts a chunk that names a prefix of the order, as the minifier leaves it', () => {
    const chunk = '@layer reset,theme,app-layout;@layer controls{.a{color:red}}';
    expect(layersNamedIn(chunk)).toEqual(['reset', 'theme', 'app-layout', 'controls']);
    expect(namesLayersInOrder(chunk, ORDER)).toBe(true);
  });

  it('rejects the shared chunk that opened with `controls` — the bug that made it the lowest layer', () => {
    expect(namesLayersInOrder('@layer controls{.a{color:red}}@layer components{}', ORDER)).toBe(false);
  });

  it('counts a statement and a block alike, each layer once', () => {
    expect(layersNamedIn('@layer reset, theme;@layer reset{}@layer theme { }')).toEqual(['reset', 'theme']);
  });
});

describe('cssLayerOrderPlugin', () => {
  it('prefixes every stylesheet with the statement, and leaves everything else alone', () => {
    const plugin = cssLayerOrderPlugin() as { transform: (code: string, id: string) => { code: string } | null };
    const out = plugin.transform('@layer controls { .a {} }', '/src/ui/styles/switch.module.css');
    expect(out?.code.startsWith(`@layer ${ORDER.join(', ')};\n`)).toBe(true);
    expect(plugin.transform('export {}', '/src/ui/app.ts')).toBeNull();
    expect(plugin.transform('x', '/src/a.css?raw')).toBeNull();
  });
});
