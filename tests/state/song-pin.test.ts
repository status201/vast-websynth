// presets.md REQ-a-songs-sound-is-a-selectable-entry, end to end through the real
// Song.apply: the pinned sound is the EFFECTIVE patch, so an id a song omits is
// pinned at its default and re-selecting the song cannot leak another sound's
// value for it. Two synthetic songs — never shipped demos, whose params change.
import { describe, it, expect } from 'vitest';
import { Song, type SongFile } from '../../src/state/song';
import { ParamBus, registerDefaults } from '../../src/state/params';
import { PatternStore } from '../../src/state/patterns';
import { Arrangement } from '../../src/audio/transport/arrangement';
import { Presets } from '../../src/state/preset';
import { PresetSession, pinAppliedSong } from '../../src/state/preset-session';
import { fixtureSong } from '../fixtures/song-fixture';
import { TestClock } from '../audio/transport/test-clock';

const ID = 'filter.cutoff';

function rig() {
  const bus = new ParamBus();
  registerDefaults(bus);
  const patterns = new PatternStore();
  const arr = new Arrangement(patterns, new TestClock());
  const session = new PresetSession();
  /** What the Song panel's applySong does: apply, then pin through the helper. */
  const load = (file: SongFile): void => {
    Song.apply(file, bus, patterns, arr);
    pinAppliedSong(session, file.name, bus);
  };
  return { bus, session, load };
}

/** A song that sets `ID` to `value`, or omits it when `value` is undefined. */
function song(name: string, value?: number): SongFile {
  const f = fixtureSong();
  const params = { ...f.params };
  delete params[ID];
  if (value !== undefined) params[ID] = value;
  return { ...f, name, params };
}

describe('apply-then-pin (presets.md REQ-a-songs-sound-is-a-selectable-entry)', () => {
  it('pins an omitted id at its default, not the previous song’s value', () => {
    const { bus, session, load } = rig();
    const fallback = (() => { const b = new ParamBus(); registerDefaults(b); return b.get(ID); })();
    const setByA = fallback === 40 ? 50 : 40;

    load(song('Song A', setByA));
    expect(session.songSound?.patch[ID]).toBe(setByA);

    load(song('Song B'));   // B says nothing about the id
    expect(bus.get(ID)).toBe(fallback);
    expect(session.songSound?.name).toBe('Song B');
    expect(session.songSound?.patch[ID]).toBe(fallback);
  });

  it('re-selecting the pinned song after auditioning a preset restores its sound', () => {
    const { bus, session, load } = rig();
    load(song('Song A', 40));
    load(song('Song B'));
    const pinned = session.songSound!.patch[ID];

    bus.set(ID, 90);   // auditioning a preset moves the id
    // What the header selector does when the pinned entry is picked (app.ts).
    Presets.apply(bus, session.songSound!.patch);
    session.setActive('Song B');

    expect(bus.get(ID)).toBe(pinned);
    expect(bus.get(ID)).not.toBe(40);   // never Song A's value
  });
});
