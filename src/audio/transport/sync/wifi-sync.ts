import type { SyncMessage, SyncTransport } from './sync-types';
import { type WebRtcDiagnostics, emptyDiagnostics } from './webrtc-diagnostics';
import type { WebRtcSyncTransport, WebRtcSyncTransportOptions } from './webrtc-sync-transport';

/**
 * What the Engine and the UI hold of WiFi sync: a sync transport plus pairing.
 * `WebRtcSyncTransport` implements it, and so does the boot-time facade below.
 */
export interface WifiLink extends SyncTransport {
  readonly diagnostics: WebRtcDiagnostics;
  onDiagnostics(cb: () => void): () => void;
  readonly linked: boolean;
  createLink(): Promise<string>;
  acceptOffer(blob: string): Promise<string>;
  acceptAnswer(blob: string): Promise<void>;
  closeLink(): void;
}

type MessageListener = (msg: SyncMessage, receivedAtMs: number) => void;

/**
 * WiFi sync before anyone pairs (webrtc-sync.md REQ-the-wifi-transport-loads-at-pairing):
 * a synchronous facade over a lazy `WebRtcSyncTransport`. Until a pairing step
 * builds the body it is an unlinked transport — nothing sent, nothing received,
 * no ports — which is all the Engine's `'wifi'` registration needs at boot.
 * Listeners are held here and relayed once the body exists, so no subscriber
 * re-subscribes.
 */
export class WifiSyncTransport implements WifiLink {
  private body: WebRtcSyncTransport | null = null;
  private loading: Promise<WebRtcSyncTransport> | null = null;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly portListeners = new Set<() => void>();
  private readonly diagListeners = new Set<() => void>();
  private readonly idle = emptyDiagnostics();

  constructor(private readonly opts?: WebRtcSyncTransportOptions) {}

  send(msg: SyncMessage, atMs?: number): void { this.body?.send(msg, atMs); }

  onMessage(cb: MessageListener): () => void { return listen(this.messageListeners, cb); }

  ports(): { ins: number; outs: number } { return this.body?.ports() ?? { ins: 0, outs: 0 }; }

  onPortsChange(cb: () => void): () => void { return listen(this.portListeners, cb); }

  get diagnostics(): WebRtcDiagnostics { return this.body?.diagnostics ?? this.idle; }

  onDiagnostics(cb: () => void): () => void { return listen(this.diagListeners, cb); }

  get linked(): boolean { return this.body?.linked ?? false; }

  async createLink(): Promise<string> { return (await this.load()).createLink(); }

  async acceptOffer(blob: string): Promise<string> { return (await this.load()).acceptOffer(blob); }

  async acceptAnswer(blob: string): Promise<void> { return (await this.load()).acceptAnswer(blob); }

  closeLink(): void { this.body?.closeLink(); }

  /**
   * Build the body on the first pairing step. A failed import rejects that step,
   * which the pair modal reports, and is forgotten so the next step retries.
   */
  private load(): Promise<WebRtcSyncTransport> {
    this.loading ??= import('./webrtc-sync-transport')
      .then((m) => {
        const body = new m.WebRtcSyncTransport(this.opts);
        body.onMessage((msg, at) => { for (const l of this.messageListeners) l(msg, at); });
        body.onPortsChange(() => { for (const l of this.portListeners) l(); });
        body.onDiagnostics(() => { for (const l of this.diagListeners) l(); });
        this.body = body;
        return body;
      })
      .catch((err: unknown) => {
        this.loading = null;
        throw err;
      });
    return this.loading;
  }
}

function listen<T>(set: Set<T>, cb: T): () => void {
  set.add(cb);
  return () => { set.delete(cb); };
}
