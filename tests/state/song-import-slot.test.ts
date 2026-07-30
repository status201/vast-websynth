// The import-overwrite gate (session-autosave.md REQ-11, untrusted-input.md
// REQ-9). A song's NAME comes from the file, so with a share link it is
// attacker-chosen — and `Song.saveSlot` used to run unconditionally on every
// import. A link whose song is called "My Song" destroyed the user's slot of
// that name at boot, and the load-undo toast could not undo it: it restores the
// in-memory session, not localStorage.
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import { Song } from '../../src/state/song';
import type { SongFile } from '../../src/state/song';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';

function fakeArr() {
  const lane = { enabled: false, steps: [0] as number[] };
  return { seq: { ...lane }, drum: { ...lane }, sampler: { ...lane }, motion: { ...lane } };
}

function songNamed(name: string): SongFile {
  const bus = new ParamBus();
  registerDefaults(bus);
  return Song.capture(bus, new PatternStore(), fakeArr() as never, name);
}

describe('Song.planImportSave', () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  it('reports no conflict when the name is unused', () => {
    expect(Song.planImportSave(songNamed('Brand New'))).toEqual({
      name: 'Brand New', conflict: false,
    });
  });

  it('reports a conflict when a stored slot already has that name', () => {
    Song.saveSlot('My Song', songNamed('My Song'));
    expect(Song.planImportSave(songNamed('My Song'))).toEqual({
      name: 'My Song', conflict: true,
    });
  });

  it('does not treat a built-in demo name as the user\'s work', () => {
    // list() includes demos, hasSlot() deliberately does not: overwriting a demo
    // name costs the user nothing, and prompting there would be noise.
    const demoName = Song.list()[0]!;
    expect(Song.hasSlot(demoName)).toBe(false);
    expect(Song.planImportSave(songNamed(demoName)).conflict).toBe(false);
  });

  it('is a plan only — it writes nothing', () => {
    const file = songNamed('Untouched');
    Song.planImportSave(file);
    expect(Song.hasSlot('Untouched')).toBe(false);
  });

  it('stops seeing a conflict once the slot is deleted', () => {
    Song.saveSlot('Temp', songNamed('Temp'));
    expect(Song.planImportSave(songNamed('Temp')).conflict).toBe(true);
    Song.deleteSlot('Temp');
    expect(Song.planImportSave(songNamed('Temp')).conflict).toBe(false);
  });
});
