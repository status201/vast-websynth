import { ListenerSet } from '../../utils/listeners';

/**
 * Whether a machine panel's content is actually on screen.
 *
 * `TabContainer` hides an inactive panel with a class, so all four panels stay
 * live and subscribed: without this gate every one of them repaints its playhead
 * on every 16th — ~50 class writes a tick against DOM nobody can see — and the
 * Motion panel re-projects its SVG graph every bar (runtime-performance.md
 * REQ-no-work-for-offscreen-dom).
 *
 * Panels are built **before** the `TabContainer` exists, so a gate starts
 * `shown` and is corrected by the first `onViewChange`; a panel can never be
 * stuck dark. `whenShown` is how deferred work catches up on reveal — the point
 * of the gate is to skip work, not to show stale state.
 */
export class VisibilityGate {
  private visible = true;
  private readonly showListeners = new ListenerSet();

  get shown(): boolean { return this.visible; }

  set(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) this.showListeners.emit();
  }

  /** Run `fn` whenever the panel becomes visible again. Returns a disposer. */
  whenShown(fn: () => void): () => void {
    return this.showListeners.add(fn);
  }
}
