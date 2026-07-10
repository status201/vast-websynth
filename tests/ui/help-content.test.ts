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
