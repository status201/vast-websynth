import { BypassWrapper, type Effect } from './effect';
import { CompressorNode, type CompressorMode } from '../compressor/node';

/**
 * Hardware-modelled bus compressor ('fet' = 1176 style, 'vca' = SSL G bus
 * style — see public/worklets/compressor.js). The constructor builds only the
 * BypassWrapper plumbing so the effect can be wired into a chain synchronously
 * before the worklet module is loaded; call `attachWorklet()` from
 * Engine.init() after CompressorNode.loadModule(). Until then the (bypassed)
 * dry path carries the signal, which is the correct sound since the `.on`
 * param defaults to off. Setters cache their values and are replayed onto the
 * live AudioParams at attach time.
 */
export class Compressor implements Effect {
  readonly input: AudioNode;
  readonly output: AudioNode;
  private readonly wrap: BypassWrapper;
  private node: CompressorNode | null = null;
  private grCb: ((db: number) => void) | null = null;

  private threshold = -18;
  private ratio = 4;
  private attack = 0.003;
  private release = 0.3;
  private autoRelease = false;
  private makeup = 0;

  constructor(private readonly ctx: AudioContext, private readonly mode: CompressorMode) {
    this.wrap = new BypassWrapper(ctx, 1);
    this.input = this.wrap.input;
    this.output = this.wrap.output;
  }

  /** Create the worklet node and splice it into the wet path. */
  attachWorklet(): void {
    if (this.node) return;
    const node = CompressorNode.create(this.ctx, this.mode);
    this.wrap.processedIn.connect(node.input);
    node.output.connect(this.wrap.processedOut);
    node.onGr = (db) => this.grCb?.(db);
    this.node = node;
    const t = this.ctx.currentTime;
    node.threshold.setValueAtTime(this.threshold, t);
    node.ratio.setValueAtTime(this.ratio, t);
    node.attack.setValueAtTime(this.attack, t);
    node.release.setValueAtTime(this.release, t);
    node.autoRelease.setValueAtTime(this.autoRelease ? 1 : 0, t);
    node.makeup.setValueAtTime(this.makeup, t);
  }

  onGr(cb: (db: number) => void): void {
    this.grCb = cb;
  }

  setBypass(b: boolean): void {
    this.wrap.setBypass(b);
    if (b) this.grCb?.(0); // don't leave the meter frozen on a stale value
  }

  setThreshold(db: number): void {
    this.threshold = db;
    this.apply(this.node?.threshold, db);
  }

  /** Actual ratio (not a UI index); >= 100 = "all buttons in" (fet mode). */
  setRatio(r: number): void {
    this.ratio = r;
    this.apply(this.node?.ratio, r);
  }

  setAttack(seconds: number): void {
    this.attack = seconds;
    this.apply(this.node?.attack, seconds);
  }

  setRelease(seconds: number): void {
    this.release = seconds;
    this.apply(this.node?.release, seconds);
  }

  setAutoRelease(on: boolean): void {
    this.autoRelease = on;
    this.apply(this.node?.autoRelease, on ? 1 : 0);
  }

  setMakeup(db: number): void {
    this.makeup = db;
    this.apply(this.node?.makeup, db);
  }

  private apply(param: AudioParam | undefined, v: number): void {
    param?.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }
}
