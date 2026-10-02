// Browser downloads — the one place a Blob becomes a saved file, and the one
// filename sanitiser every exported file family (songs, projects, presets,
// banks) shares, so they all name alike (audio-export.md, project-export.md).

/** Save `blob` as `filename` through a throwaway object URL. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `name` with every run of characters outside `[a-z0-9_-]` collapsed to `_`;
 *  `fallback` when nothing is left. */
export function safeFilename(name: string, fallback: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, '_') || fallback;
}
