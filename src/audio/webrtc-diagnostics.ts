/**
 * Pure WebRTC pairing diagnostics (webrtc-sync.md REQ-11) — no DOM, no RTC, so
 * it is unit-testable directly. `WebRtcSyncTransport` accumulates a
 * `WebRtcDiagnostics` snapshot from the peer's ICE/candidate events + `getStats`
 * and the pair modal renders it in the debug panel; `summarizeDiagnostics` turns
 * a snapshot into plain-language hints ("a VPN/virtual adapter may be…", "a
 * firewall or different subnets…") so a user can self-diagnose a failed pair.
 */

export interface CandInfo {
  /** host | srflx | prflx | relay */
  type: string;
  /** udp | tcp */
  protocol: string;
  address: string;
}

export interface WebRtcDiagnostics {
  /** iceConnectionState transitions, in order (e.g. ['checking','disconnected']). */
  iceHistory: string[];
  /** connectionState transitions, in order. */
  connHistory: string[];
  /** latest iceGatheringState. */
  gathering: string;
  /** local ICE candidates gathered (exposes virtual-adapter subnets). */
  localCandidates: CandInfo[];
  /** how many candidates the other device sent (0 ⇒ code exchange didn't land). */
  remoteCandidateCount: number;
  /** the nominated/succeeded pair, or null if none ever connected. */
  selectedPair: { local: CandInfo; remote: CandInfo } | null;
  /** `icecandidateerror` descriptions. */
  candidateErrors: string[];
}

export function emptyDiagnostics(): WebRtcDiagnostics {
  return {
    iceHistory: [],
    connHistory: [],
    gathering: 'new',
    localCandidates: [],
    remoteCandidateCount: 0,
    selectedPair: null,
    candidateErrors: [],
  };
}

/**
 * Parse an SDP `a=candidate:` line (or an `RTCIceCandidate.candidate` string)
 * into `{ type, protocol, address }`. Returns null for non-candidate input.
 * Shape: `candidate:<foundation> <component> <proto> <priority> <addr> <port> typ <type> …`
 */
export function parseCandidate(line: string): CandInfo | null {
  const s = line.trim().replace(/^a=/, '');
  const m = /^candidate:\S+ \d+ (\S+) \d+ (\S+) \d+ typ (\S+)/i.exec(s);
  if (!m) return null;
  return { protocol: (m[1] ?? '').toLowerCase(), address: m[2] ?? '', type: (m[3] ?? '').toLowerCase() };
}

/** The `a.b.c` /24 label of an IPv4 address, or null (IPv6 / mDNS). */
function ipv4Subnet(address: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(address);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Plain-language hints for the debug panel — most-actionable first. */
export function summarizeDiagnostics(d: WebRtcDiagnostics): string[] {
  const hints: string[] = [];
  const connected =
    d.connHistory.includes('connected') ||
    d.iceHistory.includes('connected') ||
    d.iceHistory.includes('completed');

  if (connected) {
    hints.push(d.selectedPair
      ? `Connected via ${d.selectedPair.local.address} ↔ ${d.selectedPair.remote.address}.`
      : 'Connected.');
    return hints;
  }

  // Multiple local IPv4 subnets ⇒ virtual adapters / VPN advertising dead ends.
  const subnets = [...new Set(d.localCandidates.map((c) => ipv4Subnet(c.address)).filter((x): x is string => x !== null))];
  if (subnets.length > 1) {
    hints.push(
      `This device has several network adapters (${subnets.map((s) => `${s}.x`).join(', ')}). ` +
      'A VPN or a virtual adapter (WSL, Docker, Hyper-V, VirtualBox) may be advertising addresses ' +
      'the other device can’t reach — disable the extra adapters and retry.',
    );
  }

  const reachedChecking = d.iceHistory.includes('checking');

  if (d.remoteCandidateCount === 0 && reachedChecking) {
    hints.push(
      'No candidates were received from the other device — the code exchange didn’t complete. ' +
      'Re-scan or re-paste the link on both devices.',
    );
  } else if (reachedChecking) {
    hints.push(
      'The connection was attempted but no working path was found — usually a firewall blocking the ' +
      'browser (allow it, or set the Wi-Fi network to Private) or the two devices on different ' +
      'networks/subnets.',
    );
  }

  if (d.candidateErrors.length) {
    hints.push(`ICE errors: ${d.candidateErrors.slice(0, 3).join('; ')}.`);
  }

  if (!hints.length) hints.push(reachedChecking ? 'Connecting…' : 'Gathering network candidates…');
  return hints;
}
