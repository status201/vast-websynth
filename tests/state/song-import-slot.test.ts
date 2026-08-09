// The import-overwrite gate (session-autosave.md REQ-14/14b, untrusted-input.md
// REQ-9). A song's NAME comes from the file, so with a share link it is
// attacker-chosen — and `Song.saveSlot` used to run unconditionally on every
// import. A link whose song is called "My Song" destroyed the user's slot of
// that name at boot, and the load-undo toast could not undo it: it restores the
// in-memory session, not localStorage.
//
// But the gate asks "may I destroy this?", so it may only ask when the bytes
// actually differ (REQ-14b): a name match against an IDENTICAL slot used to
// re-prompt on every re-import, so "Replace it" never stuck.
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

/** The same song after an edit — a different cutoff is enough to change the bytes. */
function editedSong(name: string): SongFile {
  const file = songNamed(name);
  return { ...file, params: { ...file.params, 'filter.cutoff': 61 } };
}

describe('Song.planImportSave', () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  it('reports no conflict when the name is unused', () => {
    expect(Song.planImportSave(songNamed('test-brand-new'))).toEqual({
      name: 'test-brand-new', conflict: false,
    });
  });

  it('reports a conflict when a stored slot of that name holds different music', () => {
    Song.saveSlot('test-my-song', editedSong('test-my-song'));
    expect(Song.planImportSave(songNamed('test-my-song'))).toEqual({
      name: 'test-my-song', conflict: true,
    });
  });

  it('reports no conflict when the slot already holds this exact song (REQ-14b)', () => {
    // The bug: name-only matching re-asked "Replace your saved song?" every time
    // the same share link was re-opened, so answering "Replace it" never stuck.
    Song.saveSlot('test-bootleg', songNamed('test-bootleg'));
    expect(Song.planImportSave(songNamed('test-bootleg'))).toEqual({
      name: 'test-bootleg', conflict: false,
    });
  });

  it('asks again once the song under that name has changed (REQ-14b, boundary)', () => {
    Song.saveSlot('test-bootleg', songNamed('test-bootleg'));
    expect(Song.planImportSave(editedSong('test-bootleg')).conflict).toBe(true);
  });

  it('a replaced slot stays replaced — the same import is silent afterwards', () => {
    // The reported round trip: import v2 over a saved v1 (asks), replace, load
    // something else, import v2 again (must not ask).
    Song.saveSlot('test-bootleg', songNamed('test-bootleg'));
    const v2 = editedSong('test-bootleg');
    expect(Song.planImportSave(v2).conflict).toBe(true);
    Song.saveSlot('test-bootleg', v2);                 // the user chose "Replace it"
    expect(Song.planImportSave(v2).conflict).toBe(false);
  });

  it('does not treat a built-in demo name as the user\'s work', () => {
    // list() includes demos, hasSlot() deliberately does not: overwriting a demo
    // name costs the user nothing, and prompting there would be noise.
    // With no slots stored, every list() entry is a demo — which one is
    // irrelevant, so take the first rather than naming one.
    const demoName = Song.list()[0]!;
    expect(Song.hasSlot(demoName)).toBe(false);
    expect(Song.planImportSave(songNamed(demoName)).conflict).toBe(false);
  });

  it('is a plan only — it writes nothing', () => {
    const file = songNamed('test-untouched');
    Song.planImportSave(file);
    expect(Song.hasSlot('test-untouched')).toBe(false);
  });

  it('stops seeing a conflict once the slot is deleted', () => {
    Song.saveSlot('test-temp', editedSong('test-temp'));
    expect(Song.planImportSave(songNamed('test-temp')).conflict).toBe(true);
    Song.deleteSlot('test-temp');
    expect(Song.planImportSave(songNamed('test-temp')).conflict).toBe(false);
  });

  it('is the no-provenance case of planSlotSave', () => {
    Song.saveSlot('test-shared', editedSong('test-shared'));
    const file = songNamed('test-shared');
    expect(Song.planImportSave(file)).toEqual(Song.planSlotSave(file, null));
  });

  it('round-trips through storage: a re-parsed slot still compares equal', () => {
    // The real path never compares two in-memory objects — the slot is a STRING
    // written by a previous import, and the incoming file has been through
    // Song.parse. Both sides must still land on the same canonical bytes.
    const file = songNamed('test-shared');
    Song.saveSlot('test-shared', file);
    const reimported = Song.fromJSON(Song.toJSON(file))!;
    expect(Song.planImportSave(reimported).conflict).toBe(false);
  });
});

// The Save button's half of the same gate (session-autosave.md REQ-14c). Save
// used to call saveSlot unconditionally — typing a name another song already
// held destroyed it with no dialog and no undo. `from` is the slot the session
// came from, which is what separates "save my own song again" (silent) from
// "save on top of a song I have not been working on" (ask).
describe('Song.planSlotSave', () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  it('does not ask when saving back to the slot the session came from', () => {
    Song.saveSlot('test-my-song', songNamed('test-my-song'));
    // Edited since it was loaded — the normal save loop, and it must stay silent.
    expect(Song.planSlotSave(editedSong('test-my-song'), 'test-my-song').conflict).toBe(false);
  });

  it('asks when the name belongs to a song the session did not come from', () => {
    Song.saveSlot('test-night-watch', songNamed('test-night-watch'));
    expect(Song.planSlotSave(editedSong('test-night-watch'), 'test-my-song')).toEqual({
      name: 'test-night-watch', conflict: true,
    });
  });

  it('asks after a demo click, which leaves the session belonging to no slot', () => {
    // The loss this guard closes: click a demo button whose name a slot of yours
    // also carries (sessionSlot -> null), edit, Save under that same name — and
    // your own song is gone with no prompt.
    Song.saveSlot('test-reissue', songNamed('test-reissue'));
    expect(Song.planSlotSave(editedSong('test-reissue'), null).conflict).toBe(true);
  });

  it('never asks for an unused name, whatever the provenance', () => {
    expect(Song.planSlotSave(songNamed('test-brand-new'), null).conflict).toBe(false);
    expect(Song.planSlotSave(songNamed('test-brand-new'), 'test-other').conflict).toBe(false);
  });

  it('never asks when the slot already holds this exact song', () => {
    // Nothing to destroy (REQ-14b) — provenance does not even come into it.
    Song.saveSlot('test-twin', songNamed('test-twin'));
    expect(Song.planSlotSave(songNamed('test-twin'), null).conflict).toBe(false);
  });
});
