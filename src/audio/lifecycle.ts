/**
 * The AudioContext's lifecycle (audio-lifecycle.md): the verified, retried resume;
 * the click-free master fade it schedules; the one-shot gesture re-arm when the
 * platform refuses; the foreground / bfcache / statechange re-arms; the Debug
 * panel's deliberate suspend; and the background watchdog's fade-then-suspend.
 * Extracted from Engine verbatim — Engine builds one and delegates its public
 * verbs here. It owns no node: it is handed the context, the master gain and the two platform shims.
 */
import type { ParamBus } from '../state/params';
import { masterLevel } from '../state/master-level';
import { delay, withTimeout } from '../utils/async';
import { type IosAudioSession, shouldResumeContext } from './ios-audio-session';
import type { MediaSessionKeepAlive } from './media-session';

/**
 * Master fade-in applied whenever the context is actually resumed
 * (audio-lifecycle.md REQ-a-start-is-click-free). Long enough to swallow the output stream's own
 * start transient and the worklets' first block, short enough to be inaudible
 * as a fade after a deliberate tap.
 */
const RESUME_FADE_S = 0.15;

/**
 * Fade before the watchdog suspends a backgrounded context that is breaking up
 * (audio-lifecycle.md REQ-breaking-up-background-audio-is-suspended). Short — the audio is already glitching, so the
 * point is only that the exit isn't itself a click.
 */
const GLITCH_FADE_S = 0.06;

/**
 * How long `ctx.resume()` gets to actually take before we stop believing it
 * (audio-lifecycle.md REQ-a-resume-that-does-not-take-is-retried). Android does not always reject a resume it will
 * not honour — it can hand back a promise that never settles at all — so the
 * await is raced rather than trusted, and the verdict comes from `ctx.state`.
 */
const RESUME_VERIFY_MS = 400;
/** Gap between resume attempts. Long enough for the OS to hand back audio focus. */
const RESUME_RETRY_MS = 150;
/** Retries after the first attempt, so three tries in total. */
const RESUME_RETRIES = 2;

/** What the UI needs to know about a resume that did not take (REQ-a-resume-that-does-not-take-is-retried/REQ-a-stuck-context-is-visible). */
export interface AudioRecoveryState {
  /** Every attempt failed: the app is silent and waiting for a gesture. */
  blocked: boolean;
  /** Consecutive failed recovery runs (one run = its whole retry sequence). */
  attempts: number;
  /** A one-shot window listener is waiting for a real user gesture. */
  gestureArmed: boolean;
}

/** The gestures that count as "the user touched the app" for a forced resume. */
const RESUME_GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

export class AudioLifecycle {
  /**
   * True while the context is suspended *because we asked* — only ever set by
   * `suspendForDebug()`. The `statechange` re-arm (REQ-an-unasked-suspension-is-recovered) is gated on this
   * rather than on the platform, which is what lets the listener exist off iOS
   * without instantly undoing the Debug panel's Suspend (REQ-statechange-must-not-fight-a-deliberate-suspend).
   */
  private deliberateSuspend = false;
  /** True while the watchdog's fade-out is still holding the master at 0 (REQ-the-glitch-fade-out-is-always-undone). */
  private glitchMuted = false;
  /** Context time the last fade-in started — what `masterLevelAt` reads instead of `.value`. */
  private fadeInFrom = -Infinity;
  /** The watchdog's pending suspend, cancellable if we come back first (REQ-the-glitch-fade-out-is-always-undone). */
  private glitchTimer: number | null = null;
  /** Consecutive failed recovery runs (REQ-a-resume-that-does-not-take-is-retried). */
  private resumeAttempts = 0;
  /** True from the moment we give up until a resume actually takes (REQ-a-stuck-context-is-visible). */
  private blocked = false;
  /**
   * Whether the context has ever been running. Until it has, the automatic
   * re-arms stay out of the way: before the Tap-to-start gesture a refused
   * resume is the *expected* state, not a fault to report (REQ-a-resume-that-does-not-take-is-retried). Without
   * this the initial `pageshow` would raise the "tap to resume" toast over the
   * start modal on every load.
   */
  private everRan = false;
  /**
   * Whether the context reached `running` without a user gesture — i.e. the
   * browser's autoplay policy permits us (audio-lifecycle.md REQ-the-gesture-is-required-only-when-required). Read from
   * the state `new AudioContext()` returned, re-read at the end of `init()` and
   * OR'd in from `statechange`, because the spec allows a permitted context to
   * be created `suspended` and transition asynchronously.
   *
   * This is an observation, not a policy guess: a running context is an open
   * output stream. `main.ts` reads it to decide whether the "Tap to start" modal
   * is needed at all — and iOS excludes itself, since Safari never creates a
   * running context without a gesture, so no user-agent check is involved.
   */
  private autoplayAllowedFlag = false;
  /** Detach for the armed one-shot gesture listeners; null when nothing is armed. */
  private disarmGesture: (() => void) | null = null;
  /** Serialises `resume()` so a visibilitychange mid-retry cannot start a second run. */
  private resuming: Promise<void> | null = null;
  private readonly blockedListeners = new Set<(blocked: boolean) => void>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly master: GainNode,
    private readonly bus: ParamBus,
    private readonly iosSession: IosAudioSession,
    private readonly media: MediaSessionKeepAlive,
  ) {
    // The state we were handed IS the autoplay verdict (REQ-the-gesture-is-required-only-when-required). Captured here,
    // before anything can change it, and never by suspending the context —
    // that would destroy the only direct evidence we get.
    this.autoplayAllowedFlag = this.ctx.state === 'running';
  }

  /** Whether the context has ever been running — the master-volume gate reads it. */
  get hasRun(): boolean { return this.everRan; }

  /**
   * Last word on the autoplay verdict (REQ-the-gesture-is-required-only-when-required): Engine calls this at the
   * end of `init()`, after its worklet loads, so an asynchronous transition to
   * `running` that happened before the `statechange` listener existed is caught.
   */
  rereadAutoplay(): void {
    if (this.ctx.state === 'running') this.autoplayAllowedFlag = true;
  }

  /**
   * Resume the AudioContext. Browsers create it suspended until a user
   * gesture, so `init()` can run (and the UI can mount) before this is
   * called — this must be invoked from within the start-button gesture.
   *
   * `iosSession.unlock()` runs first (synchronously, inside the gesture) to
   * switch iOS off the silent-switch-respecting *ambient* category; it is a
   * no-op elsewhere. `shouldResumeContext` then covers `'suspended'` and the
   * iOS-only `'interrupted'` state alike — and gates the fade with it, so
   * resuming an already-running context can never dip live audio.
   *
   * The call is **verified, not trusted** (audio-lifecycle.md REQ-a-resume-that-does-not-take-is-retried). Android
   * can refuse a resume that lands outside a user gesture, and it does not
   * always refuse by rejecting — the promise can simply never settle. So each
   * attempt is raced against `RESUME_VERIFY_MS`, the verdict comes from
   * `ctx.state`, and three failures hand the job to the next real gesture.
   */
  async resume(): Promise<void> {
    // Serialise: a visibilitychange arriving mid-retry must join the run in
    // flight, not start a competing one that re-ramps the master under it.
    this.resuming ??= this.runResume().finally(() => { this.resuming = null; });
    return this.resuming;
  }

  private async runResume(): Promise<void> {
    // Any resume is intent to play, so it clears a Debug-panel suspend (REQ-an-unasked-suspension-is-recovered).
    this.deliberateSuspend = false;
    this.iosSession.unlock();
    // Android: become a media player the OS protects (media-session.md). Like
    // the iOS call above it must run inside the gesture, and it is a no-op off
    // its own platform — so both run before the state check.
    this.media.unlock();

    for (let attempt = 0; ; attempt++) {
      // A context that is already running still needs its gain back in two
      // cases, and neither is a dip — the gain is at 0 either way (REQ-the-fade-never-dips-live-audio):
      //  - the watchdog muted it and something else resumed us (REQ-the-glitch-fade-out-is-always-undone);
      //  - it was created running, so this is the FIRST start and the master is
      //    still on its seeded silence (REQ-nothing-is-audible-before-the-first-start). Without this the app would come
      //    up running and silent, which is worse than the click.
      if (!shouldResumeContext(this.ctx.state)) {
        // `state === 'running'` because the other branch here is `'closed'`,
        // where there is nothing left to fade into.
        if (this.glitchMuted || (!this.everRan && this.ctx.state === 'running')) this.fadeInMaster();
        this.onResumeSucceeded();
        return;
      }
      this.fadeInMaster();
      // Raced, not awaited: `currentTime` is frozen, so the ramp above is
      // already on the timeline whatever this promise decides to do (REQ-the-ramp-is-scheduled-before-the-await).
      // A rejected resume() and one that hangs forever are the same event here —
      // both mean "not running yet", and `ctx.state` is the only thing worth
      // asking afterwards.
      await withTimeout(this.ctx.resume(), RESUME_VERIFY_MS, undefined);
      if (!shouldResumeContext(this.ctx.state)) { this.onResumeSucceeded(); return; }
      if (attempt >= RESUME_RETRIES) break;
      await delay(RESUME_RETRY_MS);
    }

    // Out of attempts. The platform wants a gesture; take the next one.
    this.resumeAttempts++;
    this.armGestureResume();
  }

  /** Clear the recovery state after a resume that actually took (REQ-a-resume-that-does-not-take-is-retried). */
  private onResumeSucceeded(): void {
    this.everRan = true;
    this.glitchMuted = false;
    this.clearGlitchTimer();
    this.resumeAttempts = 0;
    this.disarmGesture?.();
    this.disarmGesture = null;
    if (!this.blocked) return;
    this.blocked = false;
    this.notifyBlocked(false);
  }

  /**
   * Arm a one-shot resume on the next real user gesture (REQ-a-resume-that-does-not-take-is-retried). Capture-phase
   * so a control that stops propagation cannot swallow it, and passive so it can
   * never delay a scroll or a key. Idempotent — re-arming while already armed
   * keeps the existing listeners rather than stacking a second set.
   */
  private armGestureResume(): void {
    if (this.disarmGesture) return;
    this.disarmGesture = this.onFirstGesture(() => {
      this.disarmGesture = null;
      void this.resume();
    });
    if (this.blocked) return;
    this.blocked = true;
    this.notifyBlocked(true);
  }

  /**
   * Run `fn` once, on the next real user gesture anywhere in the app; returns a
   * disarm. Capture-phase so a control that stops propagation cannot swallow it,
   * passive so it can never delay a scroll or a key, and `once` per type with the
   * siblings torn down alongside whichever fired.
   *
   * Extracted from `armGestureResume` because the auto-start path needs the same
   * arming for the work that genuinely wants a gesture but is not about the
   * AudioContext — Web MIDI's permission prompt and the Android keep-alive
   * (audio-lifecycle.md REQ-post-gesture-work-is-deferred). One implementation, not two.
   */
  onFirstGesture(fn: () => void): () => void {
    const opts: AddEventListenerOptions = { capture: true, passive: true, once: true };
    let disarmed = false;
    const onGesture = (): void => {
      disarm();
      fn();
    };
    const disarm = (): void => {
      if (disarmed) return;
      disarmed = true;
      for (const type of RESUME_GESTURES) window.removeEventListener(type, onGesture, opts);
    };
    for (const type of RESUME_GESTURES) window.addEventListener(type, onGesture, opts);
    return disarm;
  }

  private notifyBlocked(blocked: boolean): void {
    // A UI listener must never be able to break the audio layer (ADR-015).
    for (const fn of this.blockedListeners) {
      try { fn(blocked); } catch { /* a broken listener is not the Engine's problem */ }
    }
  }

  /**
   * Subscribe to "audio is stuck and needs a tap" (REQ-a-stuck-context-is-visible). The Engine owns the
   * state and touches no DOM; `main.ts` turns this into the toast (ADR-001).
   * Returns an unsubscribe.
   */
  onAudioBlocked(fn: (blocked: boolean) => void): () => void {
    this.blockedListeners.add(fn);
    return () => { this.blockedListeners.delete(fn); };
  }

  /**
   * Whether audio is unblocked without a user gesture (audio-lifecycle.md
   * REQ-the-gesture-is-required-only-when-required). `main.ts` reads this to decide whether the "Tap to start" modal is
   * needed; the Debug panel surfaces it on the context row.
   */
  get autoplayAllowed(): boolean { return this.autoplayAllowedFlag; }

  /** Recovery state for the Debug panel and the toast (REQ-a-resume-that-does-not-take-is-retried/REQ-a-stuck-context-is-visible). */
  get audioRecovery(): AudioRecoveryState {
    return {
      blocked: this.blocked,
      attempts: this.resumeAttempts,
      gestureArmed: this.disarmGesture !== null,
    };
  }

  /**
   * The Debug panel's Suspend — the *only* suspend that counts as deliberate, so
   * the `statechange` re-arm leaves it alone (audio-lifecycle.md REQ-statechange-must-not-fight-a-deliberate-suspend/REQ-an-unasked-suspension-is-recovered).
   */
  async suspendForDebug(): Promise<void> {
    this.deliberateSuspend = true;
    try { await this.ctx.suspend(); } catch { /* already gone — nothing to do */ }
  }

  /**
   * Ramp the master up from silence so a start doesn't click
   * (audio-lifecycle.md REQ-a-start-is-click-free). The graph is fine; what clicks is the step from
   * "not rendering" to "rendering at full gain" — the device's own stream-start
   * transient, the worklets' first block, or an underrun while the start
   * handler is still working all arrive at once otherwise.
   *
   * Scheduled *before* `ctx.resume()` is awaited: `currentTime` is frozen while
   * a context is suspended, so this ramp is guaranteed to cover the very first
   * rendered blocks rather than landing somewhere inside them (REQ-the-ramp-is-scheduled-before-the-await).
   */
  private fadeInMaster(): void {
    const t = this.ctx.currentTime;
    // Same law as the master.volume subscription, so the fade lands exactly
    // where the knob says — and its setTargetAtTime (scheduled while suspended
    // by the boot patch) is superseded by the events below.
    const level = masterLevel(this.bus.get('master.volume'), this.bus.get('master.expression'));
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(0, t);
    this.master.gain.linearRampToValueAtTime(level, t + RESUME_FADE_S);
    this.fadeInFrom = t;
  }

  /**
   * Where the master gain is at `t`, from the schedule this class wrote — never
   * from `.value`, which Gecko does not keep current under automation (ADR-027).
   * Silent before the first start and while the glitch fade holds it down; part
   * way up while a fade-in runs; else the knob's level (the master.volume
   * subscription retargets within a few `RAMP_MEDIUM` constants).
   */
  private masterLevelAt(t: number): number {
    if (!this.everRan || this.glitchMuted) return 0;
    const level = masterLevel(this.bus.get('master.volume'), this.bus.get('master.expression'));
    const since = t - this.fadeInFrom;
    return since >= 0 && since < RESUME_FADE_S ? level * (since / RESUME_FADE_S) : level;
  }

  /**
   * Recover the context after the OS takes it away. Android suspends a hidden
   * page's context (screen off, app switch) and leaves it suspended on return;
   * iOS drops it into `'suspended'`/`'interrupted'` on calls, Siri and
   * app-switching. Both are fixed by resuming when the page comes back.
   *
   * The `statechange` listener runs on **every** platform (v5) and is gated on
   * `deliberateSuspend`, not on the OS. Not installing it off iOS used to stand
   * in for "don't fight the Debug panel's Suspend" (audio-lifecycle.md REQ-statechange-must-not-fight-a-deliberate-suspend),
   * and the price was that every non-iOS device had no recovery at all from a
   * suspension arriving while the page is *visible* — an audio-focus loss, a
   * battery saver, an interruption. Gating on the intent keeps REQ-statechange-must-not-fight-a-deliberate-suspend and buys
   * back the recovery (REQ-an-unasked-suspension-is-recovered).
   *
   * `pageshow` joins `visibilitychange` because a bfcache restore can reach a
   * visible, interactive page without one (REQ-a-bfcache-restore-counts-as-returning).
   */
  installContextRearm(): void {
    const onForeground = (): void => {
      if (document.hidden || !this.everRan) return;
      // We are back before the watchdog's fade finished — call the suspend off
      // rather than letting it land on a foreground page (REQ-the-glitch-fade-out-is-always-undone).
      this.clearGlitchTimer();
      // The Android keep-alive first: if the OS paused our element while we were
      // away, the session it holds needs to come back too (media-session REQ-session-rearms-on-foreground).
      this.media.rearm();
      // iOS re-arms unconditionally: even a context that survived needs the
      // silent loop replayed to hold the media-backed session category. Off iOS
      // a muted-but-running context still needs `resume()` to undo the fade.
      if (this.iosSession.active || this.glitchMuted || shouldResumeContext(this.ctx.state)) {
        void this.resume();
      }
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('pageshow', onForeground);
    this.ctx.addEventListener('statechange', () => {
      // A context the browser was allowed to start may be created `suspended`
      // and transition asynchronously — that still counts as autoplay permitted
      // (REQ-the-gesture-is-required-only-when-required). Only before the first start: after it, `running` says nothing
      // about policy, it just says we resumed.
      if (!this.everRan && this.ctx.state === 'running') this.autoplayAllowedFlag = true;
      if (this.deliberateSuspend || !this.everRan) return;
      if (!document.hidden && shouldResumeContext(this.ctx.state)) void this.resume();
    });
  }

  /** Drop the watchdog's pending suspend, if one is still in flight (REQ-the-glitch-fade-out-is-always-undone). */
  private clearGlitchTimer(): void {
    if (this.glitchTimer === null) return;
    window.clearTimeout(this.glitchTimer);
    this.glitchTimer = null;
  }

  /**
   * The watchdog's verdict: this device cannot keep a backgrounded audio thread
   * fed, so go quiet rather than crackle (audio-lifecycle.md REQ-breaking-up-background-audio-is-suspended). Fade first
   * so the exit is clean, then suspend — `currentTime` freezes with it, so the
   * transport's grid is preserved and the foreground re-arm picks up where it
   * left off. The suspend is deferred past the fade; a throttled background timer
   * can only make it *later*, which is inaudible at zero gain.
   *
   * `glitchMuted` records that the master is being held at 0 by *us*, so that
   * whatever brings the context back restores it — including a browser that
   * resumes the context by itself, where the state-gated `fadeInMaster()` would
   * otherwise leave a running context silent (REQ-the-glitch-fade-out-is-always-undone).
   */
  suspendForGlitch(): void {
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.masterLevelAt(t), t);
    this.master.gain.linearRampToValueAtTime(0, t + GLITCH_FADE_S);
    this.glitchMuted = true;
    this.clearGlitchTimer();
    this.glitchTimer = window.setTimeout(() => {
      this.glitchTimer = null;
      // Coming back inside the fade window cancels this, so by here the page is
      // still hidden and the suspend is still the right answer.
      void this.ctx.suspend().catch(() => { /* already gone — nothing to do */ });
    }, GLITCH_FADE_S * 1000);
  }
}
