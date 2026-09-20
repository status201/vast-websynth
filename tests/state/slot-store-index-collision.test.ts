// untrusted-input.md REQ-a-slot-name-cannot-reach-the-index. The bug this pins:
// `SlotStore` keys a slot at `<prefix><name>` and its name index at
// `<prefix>index`, so the single name "index" addressed the index itself.
// Saving a song called "index" wrote the song JSON OVER the list of every saved
// name; `readIndex` then read a non-array as empty (correctly — it is validated,
// not cast) and the next `addToIndex` rewrote the list as `['index']`. Every
// other saved song vanished from `Song.list()`, its value orphaned in storage.
//
// The name is user-chosen on the Save dialog and payload-chosen on every import
// surface, so a share link could reach it.
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorageMock } from '../storage-mock';
import { Song } from '../../src/state/song';
import type { SongFile } from '../../src/state/song';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { fakeArr } from '../fixtures/fake-arrangement';

function songNamed(name: string): SongFile {
  const bus = new ParamBus();
  registerDefaults(bus);
  return Song.capture(bus, new PatternStore(), fakeArr(), name);
}

describe('a slot named "index" cannot reach the name index', () => {
  beforeEach(() => {
    installLocalStorageMock();
  });

  it('keeps the other saved songs listed', () => {
    Song.saveSlot('Alpha', songNamed('Alpha'));
    Song.saveSlot('Beta', songNamed('Beta'));

    Song.saveSlot('index', songNamed('index'));

    const list = Song.list();
    expect(list).toContain('Alpha');
    expect(list).toContain('Beta');
    expect(list).toContain('index');
  });

  it('round-trips the slot called "index" as its own song', () => {
    Song.saveSlot('Alpha', songNamed('Alpha'));
    Song.saveSlot('index', songNamed('index'));

    // Both are readable, and neither is the other.
    expect(Song.loadSlot('index')?.name).toBe('index');
    expect(Song.loadSlot('Alpha')?.name).toBe('Alpha');
  });

  it('deletes only the slot, leaving the index intact', () => {
    Song.saveSlot('Alpha', songNamed('Alpha'));
    Song.saveSlot('index', songNamed('index'));

    Song.deleteSlot('index');

    expect(Song.loadSlot('index')).toBeNull();
    expect(Song.list()).toContain('Alpha');
  });

  it('keeps the escape injective, so "index" and "_index" stay distinct', () => {
    Song.saveSlot('index', songNamed('index'));
    Song.saveSlot('_index', songNamed('_index'));

    expect(Song.loadSlot('index')?.name).toBe('index');
    expect(Song.loadSlot('_index')?.name).toBe('_index');
    const list = Song.list();
    expect(list).toContain('index');
    expect(list).toContain('_index');
  });
});
