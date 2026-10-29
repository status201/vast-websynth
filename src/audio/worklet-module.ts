/**
 * Load an AudioWorklet module once per context and URL, for the worklets that
 * load on first use — the flanger (flanger.md REQ-the-flanger-loads-on-first-use)
 * and the reverse delay (delay-types.md REQ-the-other-types-load-on-first-use).
 * A failure is forgotten, so the next use tries again rather than staying dead
 * for the session. The sync pair loads its own module and does stay inert after
 * a failure (oscillator-sync.md REQ-the-pair-is-built-on-first-use).
 */
const modules = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();

export function loadWorkletModule(ctx: BaseAudioContext, url: string): Promise<void> {
  let byUrl = modules.get(ctx);
  if (!byUrl) modules.set(ctx, (byUrl = new Map()));
  let p = byUrl.get(url);
  if (!p) {
    // Through a `then`, so a context without `audioWorklet` rejects instead of throwing.
    p = Promise.resolve().then(() => ctx.audioWorklet.addModule(url));
    p.catch(() => byUrl.delete(url));
    byUrl.set(url, p);
  }
  return p;
}
