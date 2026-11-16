/**
 * What the Song panel knows about the song that is loaded — the one owner of
 * the state its doors share (song-mode.md, session-autosave.md):
 *
 * - **apply** — every apply site routes through here, so the header reflects
 *   the loaded song and the playhead lands on bar one (REQ-a-load-lands-on-bar-one);
 * - **the apply token** — bumped by every apply, so async work from a superseded
 *   apply can tell it lost the session (REQ-superseded-async-work-must-not-leak);
 * - **the session's slot** — the stored slot it was last read from or written to
 *   (REQ-every-slot-write-is-guarded);
 * - **the loaded demo** — the one whose button wears the ⓘ
 *   (demo-library.md REQ-the-loaded-demo-carries-an-info-button);
 * - **the load-undo safety net** — every destructive apply stashes the session
 *   it overwrites and offers Undo (REQ-every-destructive-apply-stashes-first,
 *   REQ-undo-restores-the-stashed-file).
 *
 * The import/export paths (song-io.ts) and the demo door (demo-loader.ts) work
 * through it; none of them holds a copy of this state.
 */
import type { ParamBus } from '../../state/params';
import type { PresetSession } from '../../state/preset-session';
import { pinAppliedSong } from '../../state/preset-session';
import type { XyPadStore } from '../../state/xy-pad';
import type { StudioApi } from '../studio-api';
import { showToast } from '../components/toast';
import { unresolvedTargets } from '../../state/song-validate';
import { SAMPLER_SLOT_COUNT, emptyPatternSnapshot } from '../../state/patterns';
import { Song, type SongFile } from '../../state/song';
import { plural } from '../../utils/format';

/** The Song panel's slot picker, as the session sees it. */
export interface SlotPicker {
  readonly value: string;
  /** Re-read the stored slots (and the demos) into the picker. */
  refresh(): void;
  /** Show `name` — the one write path, so Delete keeps up. */
  select(name: string): void;
}

/**
 * The session an apply overwrote: the captured SongFile PLUS the live sampler
 * AudioBuffer refs (a SongFile only carries names). It lives solely in the undo
 * toast's closure, so dismissal or replacement releases the buffers.
 */
export interface SessionStash {
  file: SongFile;
  buffers: (AudioBuffer | null)[];
  slot: string;
  /** `slot` at stash time — Undo must not leave the Save guard describing a
   *  session that no longer exists (REQ-every-slot-write-is-guarded). */
  sourceSlot: string | null;
  /** The loaded demo at stash time — Undo brings back the ⓘ the session showed. */
  loadedDemo: string | null;
}

export interface SongSessionDeps {
  bus: ParamBus;
  engine: StudioApi;
  session: PresetSession;
  xy: XyPadStore;
  picker: SlotPicker;
}

export interface SongSession {
  /** Bumped by every apply (and by New): compare it across an await. */
  readonly applyToken: number;
  /**
   * The stored slot this session was last read from or written to — `null`
   * after a demo, a New, or an import that did not persist. It is what tells
   * Save "this name is *your* song, save it" apart from "this name is someone
   * else's song, ask first". Deliberately NOT the picker's value: a demo click
   * sets that to the demo's name, and saving over a slot that merely shares a
   * demo's name is exactly the silent loss the guard exists to stop.
   */
  slot: string | null;
  readonly loadedDemo: string | null;
  setLoadedDemo(name: string | null): void;
  /** Told whenever the loaded demo changes — the panel moves the ⓘ. */
  onLoadedDemoChange(fn: (name: string | null) => void): void;
  /** Apply a song and land on bar one. No stash, no toast. */
  apply(file: SongFile): void;
  /** Apply a song, stashing what it overwrites behind an Undo toast. */
  applyWithUndo(file: SongFile, verb?: string): void;
  /** Clear everything to a blank song, behind an Undo toast. */
  startBlank(): void;
  /** Capture the current session, for an Undo. */
  stash(): SessionStash;
  showUndo(message: string, stash: SessionStash): void;
  /** The current session as a SongFile under `name`. */
  capture(name: string): SongFile;
}

export function createSongSession(deps: SongSessionDeps): SongSession {
  const { bus, engine, session, xy, picker } = deps;
  let applyToken = 0;
  let slot: string | null = null;
  let loadedDemo: string | null = null;
  let onDemo: ((name: string | null) => void) | null = null;

  const setLoadedDemo = (name: string | null): void => {
    loadedDemo = name;
    onDemo?.(name);
  };

  /**
   * Return the playhead to bar 1 (song-mode.md REQ-a-load-lands-on-bar-one). A song carries no
   * position — the cue is transient (transport-position.md → Persistence) — so
   * without this the incoming song inherits the outgoing one's playhead and cue.
   *
   * Via `StudioApi.seekTo`, never `clock.seek`, so the three refusals (slaved /
   * exporting / rendering) hold — a refused seek is a silent no-op and the song
   * still loads. Called AFTER the apply: `set*Chain` zeroes each lane position
   * but leaves `expectFirstBar`, and only a following seek re-arms it, so the
   * incoming chain plays slot 0 for a full bar.
   */
  const toTop = (): void => {
    // Clear first: the loop driver cues a stopped transport into an engaged
    // range, which must not race this seek. A range names bars of the OUTGOING
    // song (transport-loop.md REQ-loading-a-song-clears-the-loop).
    engine.loop.clear();
    engine.seekTo(0);
  };

  const apply = (file: SongFile): void => {
    applyToken++;
    // `engine.sampler` lets apply evict audio the incoming song renames, so a
    // slot's label can never outlive the sound under it (song-mode.md REQ-stale-sampler-audio-is-evicted).
    Song.apply(file, bus, engine.patterns, engine.arrangement, xy, engine.sampler);
    // Pin the song's sound so the selector can offer it back (presets.md
    // REQ-a-songs-sound-is-a-selectable-entry) — from the bus after the apply; `pinAppliedSong` says why.
    pinAppliedSong(session, file.name, bus);
    toTop();
  };

  const capture = (name: string): SongFile =>
    Song.capture(bus, engine.patterns, engine.arrangement, name, xy);

  const stash = (): SessionStash => ({
    file: capture(session.label || 'My Song'),
    buffers: [...engine.sampler.buffers],
    slot: picker.value,
    sourceSlot: slot,
    loadedDemo,
  });

  const restore = (s: SessionStash): void => {
    apply(s.file);
    for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) {
      engine.sampler.setBuffer(i, s.buffers[i] ?? null);
      // Re-fire the meta event AFTER the buffer lands — that's what clears
      // .needs-reload in the sampler panel (same idiom as the zip import).
      engine.patterns.setSampleName(i, s.file.sampleNames?.[i] ?? null);
    }
    picker.refresh();
    picker.select(s.slot);
    slot = s.sourceSlot;
    setLoadedDemo(s.loadedDemo);
  };

  const showUndo = (message: string, s: SessionStash): void => {
    showToast({
      message,
      actionLabel: 'Undo',
      testId: 'song-undo-toast',
      onAction: () => restore(s),
    });
  };

  return {
    get applyToken() { return applyToken; },
    get slot() { return slot; },
    set slot(v: string | null) { slot = v; },
    get loadedDemo() { return loadedDemo; },
    setLoadedDemo,
    onLoadedDemoChange(fn) { onDemo = fn; },
    apply,
    capture,
    stash,
    showUndo,

    applyWithUndo(file: SongFile, verb = 'Loaded'): void {
      const s = stash();
      apply(file);
      // Whatever arrived, it is no longer the demo the ⓘ names; the two demo
      // paths set it again right after this returns.
      setLoadedDemo(null);
      // untrusted-input.md REQ-an-unresolvable-target-warns. Asked here rather than threaded from each
      // importer because every route in — file, paste, share link, zip, demo —
      // funnels through this one call, so one question covers all of them.
      //
      // Folded into the undo toast rather than raised as its own: the toast host
      // is single-slot, so a second toast would replace this one and take the Undo
      // affordance with it. And never a dialog — the song loaded fine.
      const dead = unresolvedTargets(file);
      const note = dead.length > 0
        ? ` — ${plural(dead.length, 'automation target')} not recognised`
        : '';
      showUndo(`${verb} "${file.name}"${note}`, s);
    },

    startBlank(): void {
      // Still stash + toast (session-autosave.md REQ-every-destructive-apply-stashes-first): New is
      // the one path that also nulls the sampler buffers, so Undo is the only
      // way back to a stash with its audio intact.
      const s = stash();
      applyToken++; // a New also supersedes any in-flight clip decodes
      setLoadedDemo(null);
      // Same authoritative blank the load path uses (song-mode.md REQ-apply-resets-to-defaults-first).
      engine.patterns.restore(emptyPatternSnapshot());
      for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) engine.sampler.setBuffer(i, null);
      // Explicit [0]: an omitted transpose keeps slot 1's, and a blank song is
      // not a fourth up (arrangement REQ-a-seq-slot-carries-a-transpose).
      engine.arrangement.setSeqChain([0], false, [0]);
      engine.arrangement.setDrumChain([0], false);
      engine.arrangement.setSamplerChain([0], false);
      engine.arrangement.setMotionChain([0], false);
      // New does not route through `apply`, so it resets the playhead itself
      // (song-mode.md REQ-a-load-lands-on-bar-one).
      toTop();
      slot = null; // a blank session belongs to no slot (REQ-every-slot-write-is-guarded)
      showUndo('Started a new song', s);
    },
  };
}
