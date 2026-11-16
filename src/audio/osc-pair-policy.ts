import { SyncOscNode } from './sync-osc/node';
import type { Voice } from './voice';
import { PWM_MIN_WIDTH } from './oscillator';
import { SQUARE_WAVE, waveIndex } from './waves';
import { PAIR_RELEASE_HOLD_MS } from './cross-mod';

/** What the policy asks of each voice. */
export type PairVoice = Pick<Voice, 'attachSync' | 'setFm' | 'setFmInUse' | 'setPairFree'>;

export interface OscPairPolicyDeps {
  ctx: AudioContext;
  voices: readonly PairVoice[];
  /** Whether a live mod-matrix row targets `fm` — FM's other way to be heard. */
  fmRouted(): boolean;
  /** Whether an LFO currently holds the `pulse` destination (PwmDriver). */
  pwmOwned(): boolean;
}

/**
 * The oscillator-sync pairs and the two rules that decide how the voices use
 * them — one owner for what used to be six fields and four methods on the Engine:
 *
 * - **The pairs are built on first use** (oscillator-sync.md
 *   REQ-the-pair-is-built-on-first-use): `ensureSync()` loads the worklet and
 *   attaches one pair per voice, once.
 * - **FM is in use** while the OSC 1 FM knob is up or a matrix row targets `fm`
 *   (cross-modulation.md REQ-cross-mod-disconnects-when-unused).
 * - **An FM'd pulse runs in the pair** (cross-modulation.md
 *   REQ-an-fm-carrier-with-a-pulse-width-runs-in-the-pair): FM onto a square whose
 *   width can move frees the pair, because on Gecko each width swap on an FM'd
 *   native oscillator costs render quanta.
 *
 * Every input arrives through a setter, which re-asks the predicate BEFORE the
 * caller writes the value on to the voices — so a width or wave that frees the
 * pair never reaches the native nodes on its way there.
 */
export class OscPairPolicy {
  /** Memoized, so a mode flicked back and forth loads the module once; `null` until asked. */
  private syncReady: Promise<void> | null = null;
  private fmIndex = 0;
  private fmInUse = false;
  private osc2Wave = 2;
  private osc2Width = PWM_MIN_WIDTH;
  private pairFree = false;
  /** The pending release of a freed pair; a predicate back to true cancels it. */
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: OscPairPolicyDeps) {}

  /**
   * Build one sync pair per voice, once. A failed load is logged and forgotten,
   * so the next switch-on tries again; the synth plays on native meanwhile, and
   * nothing throws into the subscriber that asked (ADR-015). Building the pairs
   * is not retried: attaching a voice twice would double its modulation.
   */
  ensureSync(): Promise<void> {
    const { ctx, voices } = this.deps;
    this.syncReady ??= SyncOscNode.loadModule(ctx)
      .then(
        () => { for (const v of voices) v.attachSync(SyncOscNode.create(ctx)); },
        (err: unknown) => {
          this.syncReady = null;
          console.warn('[sync] the sync worklet failed to load; sync stays off until it is switched on again', err);
        },
      )
      .catch((err: unknown) => {
        console.warn('[sync] building the sync pairs failed; sync stays off', err);
      });
    return this.syncReady;
  }

  /** `osc1.fm`: every voice gets the index, then FM's in-use answer is re-asked. */
  setFmIndex(x: number): void {
    this.fmIndex = x;
    for (const v of this.deps.voices) v.setFm(x);
    this.refreshFm();
  }

  /** `osc2.wave`, as the waves.ts index. */
  setOsc2Wave(x: number): void {
    this.osc2Wave = waveIndex(x);
    this.refreshPairFree();
  }

  /** `osc2.pulseWidth`; a non-finite write keeps the last width. */
  setOsc2Width(x: number): void {
    if (Number.isFinite(x)) this.osc2Width = x;
    this.refreshPairFree();
  }

  /** FM is engaged while anything can make it heard — the knob, or a live route on `fm`. */
  refreshFm(): void {
    const on = this.fmIndex > 0 || this.deps.fmRouted();
    for (const v of this.deps.voices) v.setFmInUse(on);
    this.fmInUse = on;
    this.refreshPairFree();
  }

  /**
   * Only a change of answer reaches the voices, so a WIDTH drag costs a compare.
   * Freeing is immediate; releasing waits `PAIR_RELEASE_HOLD_MS`, so a drag
   * through 0.5 does not toggle the pair (and pay the natives' catch-up each time).
   */
  refreshPairFree(): void {
    const want = this.fmInUse && this.osc2Wave === SQUARE_WAVE
      && (this.osc2Width > PWM_MIN_WIDTH || this.deps.pwmOwned());
    if (want) {
      if (this.releaseTimer !== null) {
        clearTimeout(this.releaseTimer);
        this.releaseTimer = null;
      }
      if (!this.pairFree) this.setPairFree(true);
      // Re-asked while freed, so a failed module load is retried (it is memoized).
      else void this.ensureSync();
    } else if (this.pairFree && this.releaseTimer === null) {
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null;
        this.setPairFree(false);
      }, PAIR_RELEASE_HOLD_MS);
    }
  }

  private setPairFree(on: boolean): void {
    this.pairFree = on;
    if (on) void this.ensureSync();
    for (const v of this.deps.voices) v.setPairFree(on);
  }
}
