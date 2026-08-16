import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildKeyPanel } from '../../src/ui/panels/key-panel';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { SCALE_LABELS, CHORD_LABELS } from '../../src/utils/music';

/**
 * The KEY tab: the three controls and the one line of prose that says what they
 * currently do (scale-quantization.md, chord-tools.md REQ-8).
 *
 * The hint is the whole reason chord memory may sit disabled: a control that
 * quietly does nothing is exactly what ADR-014 exists to prevent, so what it *says*
 * is part of the contract, not decoration.
 */

const MINOR = SCALE_LABELS.indexOf('minor');
const TRIAD = CHORD_LABELS.indexOf('triad');

function build() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const el = buildKeyPanel(bus);
  return { bus, el };
}

const byId = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

/** The chord dropdown's option buttons, by label. */
function chordOption(el: HTMLElement, label: string): HTMLButtonElement {
  const dd = byId(el, 'key-chord');
  return [...dd.querySelectorAll<HTMLButtonElement>('button')]
    .find((o) => o.textContent === label)!;
}

describe('KEY panel', () => {
  it('reads keyboard, then the controls, then the hint — in the DOM (REQ-9)', () => {
    // The order lives in the DOM, not in CSS `order`, so wrapping to a narrow screen
    // preserves it and keyboard traversal matches what is on screen.
    const { el } = build();
    const wanted = ['key-map', 'key-root', 'key-scale', 'key-chord', 'key-hint'];
    const found = [...el.querySelectorAll<HTMLElement>('[data-testid]')]
      .map((n) => n.dataset.testid!)
      .filter((id) => wanted.includes(id));
    expect(found).toEqual(wanted);
  });

  it('keeps the three dropdowns in one wrapper, so they wrap as a unit (REQ-9)', () => {
    const { el } = build();
    // dropdown -> its labelled group -> the shared controls wrapper
    const parents = ['key-root', 'key-scale', 'key-chord']
      .map((id) => byId(el, id).parentElement!.parentElement);
    expect(new Set(parents).size).toBe(1);
    // …and that wrapper is not the one holding the keyboard.
    expect(parents[0]!.contains(byId(el, 'key-map'))).toBe(false);
  });

  it('mints a testid for each control and the hint', () => {
    const { el } = build();
    for (const id of ['key-root', 'key-scale', 'key-chord', 'key-hint']) {
      expect(byId(el, id), id).toBeTruthy();
    }
  });

  it('disables every chord voicing while chromatic (REQ-8)', () => {
    const { el } = build(); // boots chromatic
    for (const label of CHORD_LABELS.slice(1)) {
      expect(chordOption(el, label).disabled, label).toBe(true);
    }
  });

  it('enables them as soon as a scale is chosen (REQ-8)', () => {
    const { bus, el } = build();
    bus.set('scale.type', MINOR);
    for (const label of CHORD_LABELS.slice(1)) {
      expect(chordOption(el, label).disabled, label).toBe(false);
    }
  });

  it('says the notes are untouched while chromatic', () => {
    const { el } = build();
    expect(byId(el, 'key-hint').textContent).toContain('Chromatic');
  });

  it('names the key once a scale is chosen', () => {
    const { bus, el } = build();
    bus.set('scale.root', 9); // A
    bus.set('scale.type', MINOR);
    const text = byId(el, 'key-hint').textContent!;
    expect(text).toContain('A');
    expect(text).toContain('minor');
    // The non-destructive promise is the reason this filter is safe to leave on.
    expect(text).toContain('never rewritten');
  });

  it('explains that mono is why chord memory is silent (REQ-7)', () => {
    const { bus, el } = build();
    bus.set('scale.type', MINOR);
    bus.set('chord.voicing', TRIAD);
    bus.set('voicing.mode', 0); // mono
    expect(byId(el, 'key-hint').textContent).toContain('mono');
  });

  it('describes what chord memory will do once poly is back', () => {
    const { bus, el } = build();
    bus.set('scale.type', MINOR);
    bus.set('chord.voicing', TRIAD);
    bus.set('voicing.mode', 1); // poly
    const text = byId(el, 'key-hint').textContent!;
    expect(text).toContain('triad');
    expect(text).toContain('arpeggiator');
  });

  it('repaints from the bus, so a song load is reflected without a click', () => {
    const { bus, el } = build();
    bus.restore({ 'scale.type': MINOR, 'scale.root': 9 });
    expect(byId(el, 'key-hint').textContent).toContain('minor');
  });
});

/**
 * The two-octave keyboard map (scale-quantization.md REQ-9).
 *
 * State lives in `data-role`, not a class, so these assertions do not depend on how
 * CSS Modules resolve under Vitest.
 */
describe('KEY panel — keyboard map', () => {
  const MAJOR = SCALE_LABELS.indexOf('major');
  const SEMITONES = 24;

  /** The role of every semitone of the map, 0..23. */
  function roles(el: HTMLElement): string[] {
    return Array.from({ length: SEMITONES }, (_, s) => byId(el, `key-map-${s}`).dataset.role!);
  }

  /** Distinct pitch classes carrying `role`. */
  function pcs(el: HTMLElement, role: string): number[] {
    const out = new Set<number>();
    roles(el).forEach((r, s) => { if (r === role) out.add(s % 12); });
    return [...out].sort((a, b) => a - b);
  }

  it('draws two full octaves as real piano topology', () => {
    const { el } = build();
    // 24 keys: 14 white + 10 black, each addressable by its semitone.
    for (let s = 0; s < SEMITONES; s++) expect(byId(el, `key-map-${s}`), `${s}`).toBeTruthy();
  });

  it('lights every key while chromatic, because every note is admitted', () => {
    const { el } = build(); // boots chromatic
    expect(roles(el).every((r) => r === 'root' || r === 'scale')).toBe(true);
  });

  it('choosing a scale visibly removes the notes outside it', () => {
    const { bus, el } = build();
    bus.set('scale.type', MAJOR);
    expect(pcs(el, 'scale')).toEqual([2, 4, 5, 7, 9, 11]);   // D E F G A B (C is the root)
    expect(pcs(el, 'out')).toEqual([1, 3, 6, 8, 10]);        // C# D# F# G# A#
  });

  it('marks the same pitch classes in both octaves', () => {
    const { bus, el } = build();
    bus.set('scale.type', MAJOR);
    const r = roles(el);
    for (let s = 0; s < 12; s++) expect(r[s + 12], `semitone ${s}`).toBe(r[s]);
  });

  it('follows the root to another key', () => {
    const { bus, el } = build();
    bus.set('scale.type', MAJOR);
    bus.set('scale.root', 7); // G major — one sharp, F#
    expect(pcs(el, 'root')).toEqual([7]);
    expect(pcs(el, 'out')).toEqual([1, 3, 5, 8, 10]); // F natural is out, F# is in
  });

  it('gives the root precedence over its other roles', () => {
    const { bus, el } = build();
    bus.set('scale.type', MAJOR);
    bus.set('chord.voicing', TRIAD);
    // C is the root, a chord tone AND a scale tone — it must read as the root.
    expect(byId(el, 'key-map-0').dataset.role).toBe('root');
    expect(pcs(el, 'root')).toEqual([0]);
  });

  it('shows the voicing before anything is played (tonic chord)', () => {
    const { bus, el } = build();
    bus.set('scale.type', MAJOR);
    expect(pcs(el, 'chord')).toEqual([]);
    bus.set('chord.voicing', TRIAD);
    expect(pcs(el, 'chord')).toEqual([4, 7]); // E and G; C is shown as the root
  });

  it('names each key and its role on hover', () => {
    const { bus, el } = build();
    bus.set('scale.type', MAJOR);
    bus.set('chord.voicing', TRIAD);
    expect(byId(el, 'key-map-0').title).toBe('C — root');
    expect(byId(el, 'key-map-4').title).toBe('E — chord tone');
    expect(byId(el, 'key-map-2').title).toBe('D — in scale');
    expect(byId(el, 'key-map-1').title).toBe('C# — not in scale');
  });

  it('labels the root keys and nothing else', () => {
    const { bus, el } = build();
    bus.set('scale.type', MAJOR);
    bus.set('scale.root', 9); // A minor-ish root on a white key
    const labelled = Array.from({ length: SEMITONES }, (_, s) => byId(el, `key-map-${s}`))
      .filter((k) => (k.textContent ?? '') !== '');
    expect(labelled).toHaveLength(2);                       // one per octave
    for (const k of labelled) expect(k.textContent).toBe('A');
  });

  it('lists the legend in the order of the dropdowns (REQ-9, regression)', () => {
    // The legend sits directly under Root / Scale / Chord memory and a reader pairs
    // them positionally, so it follows dropdown order — not the precedence order the
    // painter resolves in. It used to read root, chord, in scale.
    const { el } = build();
    const roles = [...byId(el, 'key-legend').querySelectorAll<HTMLElement>('[data-role]')]
      .map((sw) => sw.dataset.role!);
    expect(roles).toEqual(['root', 'scale', 'chord']);
    expect(byId(el, 'key-legend').textContent).toBe('rootin scalechord');
  });

  it('hides the chord legend entry while no key wears that colour', () => {
    const { bus, el } = build();
    const chordSwatch = byId(el, 'key-legend').querySelector('[data-role="chord"]')!;
    expect(chordSwatch.parentElement!.classList.contains('hidden')).toBe(true);
    bus.set('scale.type', MAJOR);
    bus.set('chord.voicing', TRIAD);
    expect(chordSwatch.parentElement!.classList.contains('hidden')).toBe(false);
  });

  it('backs that hide with a rule, so it leaves the layout (REQ-9, regression)', () => {
    // The painter toggles a `hidden` class, but this app has no global
    // `.hidden { display: none }` (see modal.module.css) — so without a rule in the
    // module the hide changed nothing on screen, and the test above passed anyway.
    // Only the stylesheet can catch that, the same shape as `overlay-cost.test.ts`.
    // Resolved from the vitest root, not `import.meta.url`: this file runs in jsdom,
    // where the module URL is an http: one and `fileURLToPath` throws.
    const css = readFileSync(
      resolve(process.cwd(), 'src/ui/styles/key.module.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .find(([, sel]) => /\.legendItem\b/.test(sel!) && /\bhidden\b/.test(sel!));
    expect(rule, 'key.module.css declares no rule for a hidden legend item').toBeTruthy();
    expect(rule![2]!.replace(/\s/g, '')).toContain('display:none');
  });

  it('cannot be played — the map carries no handlers and no tab stop', () => {
    // The app's real keyboard is always on screen; a second one that sounded notes
    // would make "which keyboard am I playing?" a question (spec gesture inventory).
    const { bus, el } = build();
    let sounded = 0;
    bus.onNote(() => { sounded++; });
    const key = byId(el, 'key-map-0');
    key.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    key.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sounded).toBe(0);
    expect(key.tabIndex).toBeLessThan(0);
    expect(key.closest('button')).toBeNull();
  });
});
