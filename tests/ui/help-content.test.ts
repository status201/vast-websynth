// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { HELP_TOPICS, TOUR_STEPS } from '../../src/ui/onboarding/help-content';

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
