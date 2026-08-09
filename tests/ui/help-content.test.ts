// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { HELP_TOPICS, TOUR_STEPS, DEMO_FOR_TOUR } from '../../src/ui/onboarding/help-content';
import { demoNames } from '../../src/state/song';

/** A topic's authored copy — asserts it exists and is static (not a widget). */
function bodyOf(id: keyof typeof HELP_TOPICS): string {
  const t = HELP_TOPICS[id];
  expect(t, id).toBeTruthy();
  expect(typeof t.body, id).toBe('string');
  return t.body as string;
}

/** The two transport-sync help topics (onboarding.md REQ-6 / midi-clock-sync v2). */
describe('help-content sync topics', () => {
  it('has a `sync` topic explaining Master/Slave + USB-MIDI', () => {
    const t = HELP_TOPICS['sync'];
    expect(t).toBeTruthy();
    expect(t.title).toContain('Sync');
    expect(typeof t.body).toBe('string');
    const body = t.body as string;
    expect(body).toContain('Master');
    expect(body).toContain('Slave');
    expect(body).toMatch(/USB|loopMIDI/);
  });

  it('has a `sync.wifi` topic explaining the pairing steps', () => {
    const t = HELP_TOPICS['sync.wifi'];
    expect(t).toBeTruthy();
    expect(t.title.toLowerCase()).toContain('wifi');
    expect(typeof t.body).toBe('string');
    const body = t.body as string;
    expect(body).toContain('Create link');
    expect(body).toContain('Join');
  });
});

/** The Motion machine topic (onboarding.md REQ-7 / motion-sequencer.md REQ-8). */
describe('help-content motion topic', () => {
  it('has a `motion` topic explaining the Y/X graph view', () => {
    const t = HELP_TOPICS['motion'];
    expect(t).toBeTruthy();
    expect(t.title).toContain('Motion');
    expect(typeof t.body).toBe('string');
    const body = t.body as string;
    // The confusing bit the badge exists for: the one-axis-at-a-time graph.
    expect(body).toMatch(/Y \/ X/);
    expect(body).toContain('one at a time');
    expect(body).toContain('never move');
  });

  it('explains the two extra single-param tracks (v7)', () => {
    const body = bodyOf('motion');
    expect(body).toContain('two more tracks');
    expect(body).toContain('per bank');
    // Motion's Clear lists lanes, not a selected row (step-grid-editing REQ-6).
    expect(body).toContain('Clear ▾');
  });

  // The two short per-lane badges (onboarding.md REQ-14 / motion-sequencer.md v6).
  it('has a short `motion.xy` topic for the XY lane', () => {
    const t = HELP_TOPICS['motion.xy'];
    expect(t).toBeTruthy();
    expect(t.title).toContain('XY');
    const body = bodyOf('motion.xy');
    expect(body).toMatch(/anchor/i);
    expect(body).toContain('SLIDE');
    expect(body).toContain('Y / X');
  });

  it('has a short `motion.tracks` topic for the A/B tracks', () => {
    const t = HELP_TOPICS['motion.tracks'];
    expect(t).toBeTruthy();
    expect(t.title).toMatch(/A & B/);
    const body = bodyOf('motion.tracks');
    expect(body).toContain('per bank');
    expect(body).toContain('SLIDE');
  });
});

/** The grid gesture vocabulary reaches every step grid (onboarding.md REQ-11). */
describe('help-content grid gestures', () => {
  it.each(['seq', 'drums', 'sampler'] as const)('%s names every gesture', (id) => {
    const body = bodyOf(id);
    expect(body).toContain('drag');
    expect(body).toContain('Press and hold');
    expect(body).toContain('right-click');
    expect(body).toContain('Delete');
    expect(body).toContain('Clear ▾');
    expect(body).toContain('Ctrl+Z');
  });

  it('uses identical words on all three, so the vocabulary cannot drift', () => {
    const shared = bodyOf('seq').match(/<p><strong>Editing faster:.*?<\/p>/s)?.[0];
    expect(shared).toBeTruthy();
    expect(bodyOf('drums')).toContain(shared);
    expect(bodyOf('sampler')).toContain(shared);
  });
});

/** The sequencer's four tracks (sequencer.md REQ-8/9/10, onboarding.md REQ-11). */
describe('help-content seq topic', () => {
  it('explains the four tracks and the poly gate', () => {
    const body = bodyOf('seq');
    expect(body).toContain('Four tracks');
    expect(body).toContain('Poly');
    expect(body).toContain('mute');
  });
});

/** The Render button's badge (onboarding.md REQ-15 / render-to-sampler.md REQ-10). */
describe('help-content seq.render topic', () => {
  it('explains the import and why the bar plays twice', () => {
    const t = HELP_TOPICS['seq.render'];
    expect(t).toBeTruthy();
    expect(t.title).toMatch(/sampler/i);
    const body = bodyOf('seq.render');
    expect(body).toMatch(/sampler slot/i);
    // The whole point of the badge: the two-pass tail bake reads as a hang.
    expect(body).toMatch(/twice/i);
    expect(body).toMatch(/reverb/i);
    // Both disabled reasons (render-to-sampler.md REQ-6).
    expect(body).toMatch(/no steps/i);
    expect(body).toMatch(/MIDI clock/i);
  });
});

/** The header Presets button (onboarding.md REQ-12). */
describe('help-content presets topic', () => {
  it('separates a preset from a song and covers export/import', () => {
    const t = HELP_TOPICS['presets'];
    expect(t.title).toContain('Preset');
    const body = bodyOf('presets');
    expect(body).toContain('one <em>sound</em>');
    expect(body).toContain('song');
    expect(body).toContain('Export preset');
    expect(body).toContain('Export bank');
    // The import wizard's whole point: nothing is written until you confirm.
    expect(body).toContain('review');
    expect(body).toContain('until you confirm');
  });
});

/** The gesture tour step (onboarding.md REQ-13). */
describe('the tour', () => {
  it('teaches the grid gestures on the drum grid, before the Song-tab steps', () => {
    const i = TOUR_STEPS.findIndex((s) => s.title === 'Paint a pattern');
    expect(i).toBeGreaterThan(-1);
    const step = TOUR_STEPS[i]!;
    // Not `panel-seq`: the previous step already spotlights it, and an unmoved
    // spotlight reads as "nothing happened".
    expect(step.target).toBe('panel-drums');
    expect(step.precondition).toBeTypeOf('function');
    expect(String(step.body)).toContain('Drag');
    expect(TOUR_STEPS.findIndex((s) => s.title === 'Arrange a full song')).toBeGreaterThan(i);
  });
});

/** Playhead-ruler + Song-transport badges (onboarding.md REQ-16). */
describe('help-content transport-position topics', () => {
  const LANES = ['seq', 'drum', 'sampler', 'motion'] as const;

  it('has one ruler topic per machine tab', () => {
    for (const lane of LANES) {
      const t = HELP_TOPICS[`transport.ruler.${lane}`];
      expect(t, lane).toBeTruthy();
    }
  });

  it('shares ONE topic object across the four ids (identical copy by construction)', () => {
    const first = HELP_TOPICS['transport.ruler.seq'];
    for (const lane of LANES) expect(HELP_TOPICS[`transport.ruler.${lane}`]).toBe(first);
  });

  it('the ruler copy covers what the grid playhead cannot say, plus the keys', () => {
    const body = bodyOf('transport.ruler.seq');
    expect(body).toContain('stopped');            // it shows position while stopped
    expect(body).toMatch(/switched off/);         // …and on a disabled machine
    expect(body).toMatch(/bank/);                 // …and across banks
    expect(body).toContain('Home');
    expect(body).toContain('Shift');
  });

  it('has a `transport.song` topic covering the scrubber and the window', () => {
    const t = HELP_TOPICS['transport.song'];
    expect(t).toBeTruthy();
    expect(t.title.toLowerCase()).toContain('transport');
    const body = bodyOf('transport.song');
    expect(body).toContain('bar.step');
    expect(body).toMatch(/chains? above|chain/);  // cells line up with chain slots
    expect(body).toMatch(/floating window|window/);
    expect(body).toMatch(/external clock|export|render/); // when seeking is refused
  });

  // live-fx-window.md REQ-7 — the sibling badge on the row below the transport.
  it('has a `song.fx` topic naming every control in the Live FX row', () => {
    const t = HELP_TOPICS['song.fx'];
    expect(t).toBeTruthy();
    const body = bodyOf('song.fx');
    for (const control of ['DJ', 'Fill', 'Stutter', 'Drop', 'Tape', 'XY']) {
      expect(body).toContain(control);
    }
    expect(body).toMatch(/momentary|hold/);        // the buttons are not latches
    expect(body).toMatch(/floating window|window/); // what LIVE FX adds
    expect(body).toContain('external clock');       // Tape Stop while slaved
    // The compressor sharing the row has its own badge; don't duplicate it.
    expect(body).not.toMatch(/compressor/i);
  });
});

/**
 * song-mode.md REQ-12 (v18). The tour names its demo by string constant, while
 * `src/state/demos/` is a drop-in directory anyone may rename in. `loadDemo`
 * now falls back to the first demo, so an orphaned constant no longer breaks the
 * tour — but it would quietly demonstrate a song the script was not written for,
 * which is worth a warning. Reads the constant rather than spelling a name, so
 * adding or editing a demo can never fail this.
 */
describe('the tour names a demo that exists', () => {
  it('DEMO_FOR_TOUR is a registered demo', () => {
    expect(demoNames()).toContain(DEMO_FOR_TOUR);
  });
});
