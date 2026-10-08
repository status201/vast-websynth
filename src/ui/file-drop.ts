// Drag a file onto the window to import it (paste-import.md REQ-a-dropped-file-takes-the-paste-routes).
//
// The drop is one more door onto the routes the Paste button and the file input
// already use — songs and project zips through `SongPanel.importBytes`, presets
// and banks through the preset manager's review step — so a dropped file can
// never be read differently from the same file chosen with Import.
import { classifyPayload } from '../state/paste-payload';
import { parsePresetPayload } from '../state/preset-file';
import type { PresetParse } from '../state/preset-validate';
import type { ParamBus } from '../state/params';
import { fileKindOf, oversizedFileMessage } from '../state/import-cap';
import { anyModalOpen } from './modal-stack';
import { showToast } from './components/toast';
import styles from './styles/file-drop.module.css';

export interface DropRoutes {
  onSong: (bytes: Uint8Array, name: string) => Promise<boolean>;
  onPresets: (parse: PresetParse) => void;
  bus?: ParamBus;
}

const toast = (message: string): void => { showToast({ message, testId: 'file-drop-toast' }); };

/**
 * Import one dropped file. Bounded before it is read (untrusted-input.md
 * REQ-a-file-is-sized-before-it-is-read): a JSON file over the song cap and a
 * zip over the archive cap are refused from their size alone, never buffered.
 */
export async function importDroppedFile(file: File, routes: DropRoutes): Promise<void> {
  const kind = fileKindOf(file);
  if (kind === 'audio') {
    toast('To use a sound, load it into a sampler slot from the Sampler tab.');
    return;
  }
  if (kind === 'other') {
    toast(`"${file.name}" is not a song, project or preset file.`);
    return;
  }
  const oversized = oversizedFileMessage(file);
  if (oversized) {
    toast(oversized);
    return;
  }
  if (kind === 'zip') {
    await routes.onSong(new Uint8Array(await file.arrayBuffer()), file.name);
    return;
  }
  const text = await file.text();
  const c = classifyPayload(text);
  if (c.kind === 'song' || c.kind === 'author') {
    await routes.onSong(new TextEncoder().encode(c.json!), file.name);
  } else if (c.kind === 'preset' || c.kind === 'bank') {
    routes.onPresets(parsePresetPayload(c.json!, routes.bus));
  } else {
    toast(c.reason ?? `"${file.name}" is not a song, project or preset file.`);
  }
}

const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files');

/**
 * Listen for files dragged over the window. Every file drop is claimed —
 * `preventDefault` — even one that is refused: left to the browser, a dropped
 * file *navigates the tab to it*, which throws away the session. While a dialog
 * is open the drop is claimed and ignored (the dialog owns the screen,
 * input-control.md REQ-shortcuts-yield-to-an-open-modal). Returns an uninstaller.
 */
export function installFileDrop(routes: DropRoutes, target: Window = window): () => void {
  const overlay = document.createElement('div');
  overlay.className = styles.overlay!;
  overlay.dataset.testid = 'file-drop-overlay';
  overlay.textContent = 'Drop a song, project or preset file to import it';
  overlay.hidden = true;
  document.body.appendChild(overlay);

  // dragenter/dragleave fire for every child crossed, so count depth rather
  // than trusting a single leave.
  let depth = 0;
  const show = (on: boolean): void => { overlay.hidden = !on; };

  const onEnter = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    if (!anyModalOpen()) show(true);
  };
  const onOver = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = anyModalOpen() ? 'none' : 'copy';
  };
  const onLeave = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  };
  const onDrop = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    show(false);
    if (anyModalOpen()) return;
    const file = e.dataTransfer?.files[0];
    if (file) void importDroppedFile(file, routes);
  };

  target.addEventListener('dragenter', onEnter);
  target.addEventListener('dragover', onOver);
  target.addEventListener('dragleave', onLeave);
  target.addEventListener('drop', onDrop);
  return () => {
    target.removeEventListener('dragenter', onEnter);
    target.removeEventListener('dragover', onOver);
    target.removeEventListener('dragleave', onLeave);
    target.removeEventListener('drop', onDrop);
    overlay.remove();
  };
}
