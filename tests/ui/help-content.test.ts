// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { HELP_TOPICS } from '../../src/ui/onboarding/help-content';

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
});
