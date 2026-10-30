import { applyDrive, type DirtNodes, type Voicing } from './dirt';
import { VOICINGS, VoicingRouter } from './dirt-voicings';
import { dirtTypeOf, type DirtType } from '../../state/dirt';

/** The wet path's glide to silence before a type swap (dirt-types.md REQ-a-dirt-type-switch-is-click-free). */
export const TYPE_DIP_S = 0.005;
/** When the swap lands: eight `TYPE_DIP_S` constants, about −70 dB. */
export const TYPE_SWAP_MS = 40;

/**
 * Dirt's TYPE, once a type other than DISTORTION has been chosen
 * (dirt-types.md REQ-the-other-dirt-types-load-on-first-use). Imported with the
 * voicings, in one chunk; from then on `Dirt` forwards TYPE and DRIVE here.
 *
 * A switch dips the wet, swaps under the silence and glides back
 * (REQ-a-dirt-type-switch-is-click-free). A switch while one is pending only
 * retargets it, and a quiesced (bypassed) effect swaps at once.
 */
export class DirtSwitch {
  /** The voicing wired now, and the type a pending swap will wire. */
  private type: DirtType = 'distortion';
  private voicing: Voicing = VOICINGS.distortion;
  private target: DirtType = 'distortion';
  /** Built on the first swap away from DISTORTION, with its biquad pool. */
  private router: VoicingRouter | null = null;
  /** The wet is held down for a swap that has not landed yet. */
  private dipped = false;
  private swapTimer: number | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly nodes: DirtNodes,
    private drive: number,
    /** The wrapper has cut the input for a bypass: nothing is heard, so a swap needs no dip. */
    private quiesced: boolean,
  ) {}

  setDrive(amount: number): void {
    this.drive = amount;
    applyDrive(this.ctx, this.nodes, this.voicing, amount, !this.dipped);
  }

  setType(v: number): void {
    this.target = dirtTypeOf(v);
    if (this.quiesced) {
      if (this.swapTimer !== null) clearTimeout(this.swapTimer);
      this.swapTimer = null;
      this.swap();
      return;
    }
    if (this.dipped || this.target === this.type) return;
    this.dipped = true;
    this.nodes.postGain.gain.setTargetAtTime(0, this.ctx.currentTime, TYPE_DIP_S);
    this.swapTimer = window.setTimeout(() => {
      this.swapTimer = null;
      this.swap();
    }, TYPE_SWAP_MS);
  }

  quiesce(on: boolean): void { this.quiesced = on; }

  /** Wire the target voicing (if it changed) and re-apply DRIVE under it. */
  private swap(): void {
    if (this.target !== this.type) {
      this.router ??= new VoicingRouter(this.ctx, this.nodes.preGain, this.nodes.shaper, this.nodes.tone);
      this.type = this.target;
      this.voicing = this.router.route(this.type);
    }
    this.dipped = false;
    this.setDrive(this.drive);
  }
}
