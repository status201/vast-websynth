/**
 * Compact step cell used by the sequencer and drum machine.
 * Click toggles on/off. Render as a small lit/unlit square; the parent
 * gives it semantic meaning (note, drum hit, etc.).
 */
export class StepButton {
  readonly el: HTMLButtonElement;
  private _on = false;
  private _playing = false;

  constructor(label: string, accent: 'orange' | 'red' | 'yellow' = 'orange') {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = `step step-${accent}`;
    this.el.textContent = label;
  }

  setOn(on: boolean): void {
    this._on = on;
    this.el.classList.toggle('on', on);
  }

  /** Highlight the currently-playing step. */
  setPlaying(p: boolean): void {
    this._playing = p;
    this.el.classList.toggle('playing', p);
  }

  setLabel(s: string): void { this.el.textContent = s; }

  get on(): boolean { return this._on; }
  get playing(): boolean { return this._playing; }
}
