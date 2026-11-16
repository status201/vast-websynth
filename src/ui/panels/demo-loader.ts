/**
 * The one door every demo comes through (song-mode.md
 * REQ-drop-in-demos-are-fetched-on-click, REQ-one-name-two-songs-ask): the demo
 * buttons, the Load button, the guided tour and the empty-play hint all call
 * `loadDemo`, so none of them can reintroduce a silent guess between a demo and
 * a saved song of the same name.
 *
 * Three sources, one name space: built-in songs (bundled), drop-in JSON and
 * project zips (both fetched on click). A demo is content, never the user's
 * work, so no path here writes a slot (session-autosave.md
 * REQ-a-demo-click-never-writes-a-slot).
 */
import type { UiBridge } from '../ui-bridge';
import { chooseDialog } from '../components/dialog';
import { reportIfNewerVersion } from '../components/version-skew-toast';
import { Song, DEMO_SONGS, JSON_DEMOS, ZIP_DEMOS, resolveDemoName, type SongFile } from '../../state/song';
import { parseProjectZip } from '../../state/project';
import { failureAlert, thrownAlert, type SongIo } from './song-io';
import type { SlotPicker, SongSession } from './song-session';

export interface DemoLoaderDeps {
  bridge: UiBridge;
  song: SongSession;
  picker: SlotPicker;
  io: Pick<SongIo, 'applyProjectBundle'>;
}

export interface DemoLoader {
  /**
   * Load a demo by name and sync the slot picker. **Resolves when the song has
   * actually been applied** — the drop-ins and zips are fetched, so a caller
   * that acts on the loaded song (the tour starting the transport, the
   * empty-play modal pressing Play) must await it.
   */
  loadDemo(name: string): Promise<void>;
  /** Apply a parsed demo and sync the picker — the tail every branch ends on. */
  applyDemo(name: string, file: SongFile): void;
  /** Load a STORED slot: the Load button's main branch, and "Load mine". */
  loadStoredSlot(name: string, file: SongFile): void;
}

export function createDemoLoader(deps: DemoLoaderDeps): DemoLoader {
  const { bridge, song, picker, io } = deps;

  /**
   * A demo that failed between its fetch and its parse first asks whether a
   * deploy outran this tab: then the file is gone for good and the answer is
   * Reload, not a dialog (version-skew.md REQ-a-stale-failure-offers-reload). A
   * failure *applying* a song that did arrive is never that, and keeps its dialog.
   */
  const reportDemoFailure = async (name: string, report: () => Promise<void>): Promise<void> => {
    if (await reportIfNewerVersion(`Couldn't load "${name}"`)) return;
    await report();
  };

  /** A demo whose file would not parse — every error copyable (REQ-a-rejected-import-is-copyable-in-full). */
  const showDemoFailure = (name: string, errors: string[]): Promise<void> =>
    reportDemoFailure(name, () => failureAlert('Demo failed to load', `Could not load "${name}"`, errors, name));

  const applyDemo = (name: string, file: SongFile): void => {
    song.applyWithUndo(file);
    song.setLoadedDemo(name);
    picker.refresh();
    picker.select(name);
    // A demo is content, not a slot of the user's — so Save must still guard
    // this name (session-autosave.md
    // REQ-every-slot-write-is-guarded/REQ-a-demo-click-never-writes-a-slot).
    song.slot = null;
    bridge.cuePlay(); // nudge Play (play-button-blink.md REQ-silent-actions-arm-a-green-cue)
  };

  const loadStoredSlot = (name: string, file: SongFile): void => {
    song.applyWithUndo(file);
    song.slot = name; // the session now IS this slot — Save it back freely
    bridge.cuePlay();   // a loaded song is silent until Play (play-button-blink.md REQ-silent-actions-arm-a-green-cue)
  };

  const loadZipDemo = async (name: string, url: string): Promise<void> => {
    let res: Awaited<ReturnType<typeof parseProjectZip>>;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
      res = await parseProjectZip(new Uint8Array(await resp.arrayBuffer()));
    } catch (e) {
      await reportDemoFailure(name, () => thrownAlert('Demo failed to load', `Could not load "${name}": `, e, name));
      return;
    }
    if (!res.ok) {
      await showDemoFailure(name, res.errors.length > 0 ? res.errors : ['invalid project zip']);
      return;
    }
    try {
      // A demo, not the user's work: no slot is written, and the picker follows
      // the DEMO's name — the button's label is the promise.
      await io.applyProjectBundle(res, { persist: false, name });
    } catch (e) {
      await thrownAlert('Demo failed to load', `Could not load "${name}": `, e, name);
    }
  };

  const loadJsonDemo = async (name: string, url: string): Promise<void> => {
    let res: Awaited<ReturnType<typeof Song.parse>>;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
      // Same validator the Import button uses, so a corrupt drop-in reports
      // what is actually wrong with it rather than "not a song".
      res = await Song.parse(await resp.text());
    } catch (e) {
      await reportDemoFailure(name, () => thrownAlert('Demo failed to load', `Could not load "${name}": `, e, name));
      return;
    }
    if (!res.ok) {
      await showDemoFailure(name, res.errors.length > 0 ? res.errors : ['not a valid song file']);
      return;
    }
    try {
      applyDemo(name, res.file);
    } catch (e) {
      await thrownAlert('Demo failed to load', `Could not load "${name}": `, e, name);
    }
  };

  /**
   * One name, two songs (song-mode.md REQ-one-name-two-songs-ask). A demo's name
   * is not reserved, so saving your own "1979" leaves the demo button and the
   * slot list offering different music under one label. Ask, but only when a
   * **stored** slot shadows the name: `hasSlot`, not `list()`, which reports
   * demos too. Returns whether the caller should go on to load the demo; a
   * dismissal loads neither (dialog.md REQ-choose-dialog-offers-several-options).
   */
  const demoWinsOverSavedSong = async (name: string): Promise<boolean> => {
    if (!Song.hasSlot(name)) return true;
    const choice = await chooseDialog({
      title: `You have your own "${name}"`,
      message: `The demo button and your saved song share this name. Which one do you want?`,
      detail: 'Your saved copy is untouched either way.',
      choices: [{ id: 'demo', label: 'Load the demo' }, { id: 'mine', label: 'Load mine' }],
      cancelLabel: 'Cancel',
    });
    if (choice === 'mine') {
      const file = Song.loadSlot(name);
      // Vanished between the check and the answer (another tab, a delete) —
      // fall through to the demo rather than loading nothing.
      if (file) {
        loadStoredSlot(name, file);
        picker.select(name);
        return false;
      }
    }
    return choice === 'demo';
  };

  return {
    applyDemo,
    loadStoredSlot,
    // The shadow question is asked HERE, on the one door all three sources and
    // all four callers share, and before any fetch: a declined demo costs no
    // network. A name no source owns resolves to the first demo rather than to
    // silence — demo files are data, so the tour's `DEMO_FOR_TOUR` constant can
    // be orphaned by a rename that touches no code. Resolving BEFORE the shadow
    // question keeps the dialog naming the song that is actually loading.
    async loadDemo(name) {
      const resolved = resolveDemoName(name);
      if (!resolved) return; // no demos at all
      if (!await demoWinsOverSavedSong(resolved)) return;
      const file = DEMO_SONGS[resolved];
      if (file) {
        applyDemo(resolved, file);
        return;
      }
      const jsonDemo = JSON_DEMOS.find((d) => d.name === resolved);
      if (jsonDemo) return loadJsonDemo(jsonDemo.name, jsonDemo.url);
      const zipDemo = ZIP_DEMOS.find((d) => d.name === resolved);
      if (zipDemo) return loadZipDemo(zipDemo.name, zipDemo.url);
    },
  };
}
