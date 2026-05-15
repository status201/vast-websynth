export type ScopeMode = 'wave' | 'spectrum';

export class Scope {
  readonly el: HTMLCanvasElement;
  private mode: ScopeMode = 'wave';
  private rafId = 0;
  private readonly waveData: Uint8Array<ArrayBuffer>;
  private readonly freqData: Uint8Array<ArrayBuffer>;
  private bitmapW = 0;
  private bitmapH = 0;

  constructor(private readonly analyser: AnalyserNode) {
    this.el = document.createElement('canvas');
    this.el.className = 'scope';
    this.waveData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    this.freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.start();
  }

  setMode(m: ScopeMode): void { this.mode = m; }

  /** Sync the canvas bitmap size with its layout box. No-op if already in sync. */
  private syncSize(): boolean {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (w === 0 || h === 0) return false;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (bw !== this.bitmapW || bh !== this.bitmapH) {
      this.el.width = bw;
      this.el.height = bh;
      this.bitmapW = bw;
      this.bitmapH = bh;
    }
    return true;
  }

  private start(): void {
    const loop = () => {
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private draw(): void {
    if (!this.syncSize()) return;
    const ctx = this.el.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    // Set transform fresh each frame — no compounding.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Faint horizontal mid-line and grid (vintage CRT look)
    ctx.strokeStyle = 'rgba(244, 205, 94, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (this.mode === 'wave') {
      this.analyser.getByteTimeDomainData(this.waveData);
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = '#e8742e';
      ctx.shadowBlur = 6;
      ctx.shadowColor = 'rgba(232, 116, 46, 0.7)';
      ctx.beginPath();
      const len = this.waveData.length;
      for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * w;
        const v = ((this.waveData[i] ?? 128) - 128) / 128;
        const y = h / 2 + v * (h / 2 - 4);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else {
      this.analyser.getByteFrequencyData(this.freqData);
      const bins = this.freqData.length;
      const used = Math.floor(bins * 0.6);
      const barW = w / used;
      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, '#e8742e');
      grad.addColorStop(0.6, '#f4cd5e');
      grad.addColorStop(1, '#ff3a20');
      ctx.fillStyle = grad;
      ctx.shadowBlur = 4;
      ctx.shadowColor = 'rgba(232, 116, 46, 0.5)';
      for (let i = 0; i < used; i++) {
        const v = (this.freqData[i] ?? 0) / 255;
        const bh = v * (h - 2);
        if (bh < 0.5) continue;
        ctx.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
      }
      ctx.shadowBlur = 0;
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
  }
}
