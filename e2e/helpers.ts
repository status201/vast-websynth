import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Page, expect } from '@playwright/test';

/**
 * Navigate to the app and unlock audio via the trusted "Tap to start" click
 * (which resumes the AudioContext). Shared by specs that need a booted app.
 */
export async function gotoAndStart(page: Page): Promise<void> {
  // Suppress the first-visit onboarding tour so its overlay doesn't intercept
  // these specs (the dedicated onboarding spec clears this flag itself), pin
  // Performance mode off so every spec boots the standard 8-voice /
  // interactive-latency config regardless of the host's
  // navigator.hardwareConcurrency, and opt out of the empty-play hint so
  // specs can drive the bare transport (the dedicated empty-play spec
  // removes the flag itself).
  await page.addInitScript(() => {
    try {
      localStorage.setItem('websynth.onboarding.done', '1');
      localStorage.setItem('websynth.perf', 'off');
      localStorage.setItem('websynth.hint.emptyplay', '1');
    } catch {
      /* ignore */
    }
  });
  await page.goto('/');
  const startBtn = page.getByRole('button', { name: 'Tap to start' });
  await startBtn.click();
  await expect(startBtn).toBeHidden();
}

// State reads/writes go through the dev-only `window.__synth` bridge (main.ts).
// It's untyped in the page, so these test helpers cast — scoped to e2e only.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Read a ParamBus scalar from inside the page. */
export const busGet = (page: Page, id: string): Promise<number> =>
  page.evaluate((i) => (window as any).__synth.bus.get(i), id);

/** Set a ParamBus scalar from inside the page. */
export const busSet = (page: Page, id: string, value: number): Promise<void> =>
  page.evaluate((a) => (window as any).__synth.bus.set(a.id, a.value), { id, value });

/** Read the active preset/song label shown in the header selector. */
export const sessionDisplay = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).__synth.session.display as string);

/** Drag a knob upward (= increase) by its testid. */
export async function dragKnobUp(page: Page, testid: string): Promise<void> {
  const knob = page.getByTestId(testid);
  await expect(knob).toBeVisible();
  // `toBeVisible` is satisfied by an element that is merely BELOW the fold, and
  // page.mouse works in viewport coordinates — so without this a knob pushed off
  // screen by a layout change makes the drag land on nothing and silently do
  // nothing, failing the assertion far from the cause. Scroll first, then read
  // the box (scrolling moves it).
  await knob.scrollIntoViewIfNeeded();
  const box = await knob.boundingBox();
  if (!box) throw new Error(`${testid} has no bounding box`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 60, { steps: 6 }); // up = increase
  await page.mouse.up();
}

/* ------------------------------------------------------------------ *
 * The demo library (song-mode.md REQ-10/REQ-12)
 *
 * **Never name a demo in a spec.** `src/state/demos/` is a drop-in directory —
 * adding or editing a song there is a data change that must not touch a test
 * (specs/recipes/write-a-test.md; enforced by tests/no-shipped-demo-names.test.ts).
 * Specs that spelled one demo's name all broke the day a demo sorting before it
 * was added, because that pushed it past DEMO_ROW_LIMIT into the hidden overflow.
 *
 * So pick by **kind** — which is what a spec actually cares about: a drop-in
 * exercises the fetch path, a built-in is synchronous, a zip is the project
 * bundle. And read expected *values* from the shipped file, so editing a demo
 * moves the assertion with it.
 *
 * Playwright runs in plain Node — no Vite, so `src/state/song.ts` (which uses
 * `import.meta.glob`) is not importable here. The two file-backed halves of the
 * library are read off disk instead, mirroring that module's registration rules;
 * the built-ins are whatever the rendered row has that those two do not.
 * ------------------------------------------------------------------ */

export type DemoKind = 'drop-in' | 'built-in' | 'zip';

export interface DemoRef {
  /** The button label, and the `song-demo-<name>` testid suffix. */
  name: string;
  kind: DemoKind;
  /** Absolute path to the shipped file — drop-ins and zips only. */
  path?: string;
}

/** Repo path resolved from this file, so the runner's cwd never matters. */
const repoPath = (rel: string): string => fileURLToPath(new URL('../' + rel, import.meta.url));

const DEMO_DIR = 'src/state/demos';

/** Every demo button, excluding the "All Demos" overflow toggle beside them. */
const demoButtons = (page: Page) =>
  page.locator('[data-testid^="song-demo-"]:not([data-testid="song-demo-more"])');

/**
 * Shipped drop-ins in registration order — `src/state/song.ts` globs
 * `./demos/*.json` and sorts by path, labelling each from `demos-index.json`
 * with a filename fallback.
 */
export function dropInDemos(): DemoRef[] {
  const index = JSON.parse(
    readFileSync(repoPath('src/state/demos-index.json'), 'utf8'),
  ) as Record<string, string>;
  return readdirSync(repoPath(DEMO_DIR))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      name: index[file] ?? file.replace(/\.(websynth\.)?json$/i, ''),
      kind: 'drop-in' as const,
      path: repoPath(`${DEMO_DIR}/${file}`),
    }));
}

/**
 * Shipped project-zip demos in registration order. The zip cannot be opened at
 * build time, so the name is the filename minus the extension with underscores
 * turned back into spaces (project-export.md REQ-7).
 */
export function zipDemos(): DemoRef[] {
  return readdirSync(repoPath(DEMO_DIR))
    .filter((f) => /\.websynth\.zip$/i.test(f))
    .sort()
    .map((file) => ({
      name: file.replace(/\.websynth\.zip$/i, '').replace(/_+/g, ' '),
      kind: 'zip' as const,
      path: repoPath(`${DEMO_DIR}/${file}`),
    }));
}

/** Every demo button's name, in render order — hidden ones included. */
export async function renderedDemoNames(page: Page): Promise<string[]> {
  return demoButtons(page).evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.testid!.slice('song-demo-'.length)));
}

/**
 * Every rendered demo button, in order, classified by source. The built-ins are
 * derived (rendered − drop-ins − zips) rather than read from `song.ts`, whose
 * Vite-only globs Playwright cannot evaluate.
 */
export async function demoLibrary(page: Page): Promise<DemoRef[]> {
  const rendered = await renderedDemoNames(page);
  const byName = new Map<string, DemoRef>();
  for (const d of [...dropInDemos(), ...zipDemos()]) {
    if (byName.has(d.name)) {
      throw new Error(`two shipped demos are both called "${d.name}" — names are the only demo id`);
    }
    byName.set(d.name, d);
  }
  const missing = [...byName.keys()].filter((n) => !rendered.includes(n));
  if (missing.length > 0) {
    throw new Error(
      `these shipped demos are not in the demo row: ${missing.join(', ')}\n`
      + 'demos-index.json is probably stale — run `npm run clean:demos`.',
    );
  }
  return rendered.map((name) => byName.get(name) ?? { name, kind: 'built-in' as const });
}

/** The first rendered demo of `kind`, for a spec that needs that code path. */
export async function pickDemo(page: Page, kind: DemoKind): Promise<DemoRef> {
  const library = await demoLibrary(page);
  const hit = library.find((d) => d.kind === kind);
  if (!hit) {
    const seen = library.map((d) => `${d.name} (${d.kind})`).join(', ') || 'none';
    throw new Error(`no ${kind} demo is registered — the row holds: ${seen}`);
  }
  return hit;
}

/** Demo buttons currently laid out — i.e. not inside the collapsed overflow. */
export const visibleDemoNames = (page: Page): Promise<string[]> =>
  demoButtons(page).filter({ visible: true }).evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.testid!.slice('song-demo-'.length)));

/** Expand the overflow row if there is one and it is collapsed. Idempotent. */
export async function revealAllDemos(page: Page): Promise<void> {
  const more = page.getByTestId('song-demo-more');
  if (await more.count() === 0) return;              // ≤ DEMO_ROW_LIMIT demos
  if ((await more.textContent())?.trim() === 'Less') return; // already open
  await more.click();
}

/**
 * Click a demo button by name, revealing the overflow first if it is hidden.
 * Mirrors `scripts/audio-bench.mjs`, which has always done this properly.
 */
export async function clickDemo(page: Page, name: string): Promise<void> {
  const btn = page.getByTestId(`song-demo-${name}`);
  if (await btn.count() === 0) {
    throw new Error(`no demo button named "${name}" (check the Song panel's Demos row)`);
  }
  if (!await btn.isVisible()) await revealAllDemos(page);
  await btn.click();
}

/* ---- Reading a drop-in's shipped contents ---- */

/**
 * The slice of a song file these specs assert against. Declared locally rather
 * than imported from `src/state/song.ts` — see the note at the top of this
 * section.
 */
export interface DemoSong {
  name: string;
  params: Record<string, number>;
  seqChain: { enabled: boolean; steps: number[] };
  drumChain: { enabled: boolean; steps: number[] };
}

export const readDropIn = (demo: DemoRef): DemoSong =>
  JSON.parse(readFileSync(demo.path!, 'utf8')) as DemoSong;

/**
 * The first drop-in whose `params` declares every listed key (and passes
 * `where`, if given) — for a spec that must pin a param value without naming a
 * demo. A canonically-exported demo carries its whole params map, but a
 * hand-authored partial file is legal (add-a-demo-song.md), so this checks
 * rather than assumes, and throws naming the key instead of skipping.
 */
export function dropInDeclaring(
  keys: string[],
  where?: (params: Record<string, number>) => boolean,
): { demo: DemoRef; song: DemoSong } {
  for (const demo of dropInDemos()) {
    const song = readDropIn(demo);
    if (keys.every((k) => typeof song.params?.[k] === 'number') && (where?.(song.params) ?? true)) {
      return { demo, song };
    }
  }
  throw new Error(
    `no drop-in demo declares ${keys.join(' + ')}${where ? ' matching the given predicate' : ''} `
    + '— either a demo lost the key, or this assertion needs a different one (e2e/helpers.ts)',
  );
}

/* ---- Zip demos: what a bundle carries, without inflating it ---- */

/** Entry names from a zip's local file headers (names are never compressed). */
export function zipEntryNames(path: string): string[] {
  const buf = readFileSync(path);
  const names: string[] = [];
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    names.push(buf.toString('utf8', i + 30, i + 30 + nameLen));
    i += 30 + nameLen + extraLen + compSize;
  }
  return names;
}

/**
 * The sampler slots a zip demo populates — clips are keyed by slot in the entry
 * name (`samples/<slot>-…`, `project.ts` CLIP_RE). Empty for a bundle with no
 * audio, which makes the assertion vacuous rather than false.
 */
export const zipClipSlots = (path: string): number[] =>
  zipEntryNames(path)
    .map((n) => /(?:^|\/)samples\/(\d+)-[^/]*\.(?:wav|mp3)$/i.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);

/* ---- Derived discriminators ---- */

/**
 * A valid tempo that differs from `other`, so "which song won" stays a real
 * question whatever the demo's own BPM turns out to be. Both values are inside
 * transport.bpm's 40..240 range.
 */
export const otherBpm = (other: number): number => (Math.round(other) === 96 ? 84 : 96);

/** Sampler slots currently holding decoded audio. */
export const loadedSamplerSlots = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as any).__synth.engine.sampler.buffers
    .map((b: unknown, i: number) => (b == null ? -1 : i))
    .filter((i: number) => i >= 0));

/**
 * Re-arm the Play cue with a silent-while-stopped action: switch a step machine
 * on (play-button-blink.md REQ-3). `ParamBus.set` no-ops on an unchanged value,
 * so this must be a real 0 → 1 edge — which machine a demo happens to leave off
 * is not something a spec may assume. Returns the param it drove.
 */
export async function armPlayCueViaMachine(page: Page): Promise<string> {
  const ids = ['sampler.on', 'drum.on', 'seq.on', 'motion.on'];
  for (const id of ids) {
    if (await busGet(page, id) < 0.5) {
      await busSet(page, id, 1);
      return id;
    }
  }
  // Everything is already on: turn one off (silent — the cue arms on v ≥ 0.5
  // only) and back on, so the rising edge is real either way.
  const id = ids[0]!;
  await busSet(page, id, 0);
  await busSet(page, id, 1);
  return id;
}

/**
 * Build a valid 16-bit PCM mono WAV as a Node Buffer — a fixture for
 * `setInputFiles` that the browser's `decodeAudioData` accepts. Default is a
 * short 440 Hz sine so there is real signal to decode.
 */
export function makeWavBuffer(durationSec = 0.1, sampleRate = 44100, freq = 440): Buffer {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataSize = numSamples * 2; // mono, 2 bytes/sample
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // channels
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    buf.writeInt16LE(Math.round(s * 0x3fff), 44 + i * 2); // ~half amplitude
  }
  return buf;
}
