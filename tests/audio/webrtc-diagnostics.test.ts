import { describe, it, expect } from 'vitest';
import { parseCandidate, summarizeDiagnostics, emptyDiagnostics } from '../../src/audio/webrtc-diagnostics';

describe('webrtc-diagnostics', () => {
  it('parseCandidate extracts type/protocol/address (IPv4, IPv6, tcp, a=)', () => {
    expect(parseCandidate('candidate:842163049 1 udp 1677729535 192.168.68.112 65490 typ host generation 0'))
      .toEqual({ type: 'host', protocol: 'udp', address: '192.168.68.112' });
    expect(parseCandidate('a=candidate:1 1 tcp 100 fdd3:9d8b::1 9 typ host tcptype active'))
      .toEqual({ type: 'host', protocol: 'tcp', address: 'fdd3:9d8b::1' });
    expect(parseCandidate('not a candidate')).toBeNull();
  });

  it('flags multiple adapter subnets as a likely VPN/virtual adapter', () => {
    const d = emptyDiagnostics();
    d.iceHistory = ['checking', 'disconnected'];
    d.remoteCandidateCount = 2;
    d.localCandidates = [
      { type: 'host', protocol: 'udp', address: '192.168.68.112' },
      { type: 'host', protocol: 'udp', address: '192.168.56.1' },
    ];
    expect(summarizeDiagnostics(d).join(' ')).toMatch(/virtual adapter|VPN/i);
  });

  it('flags a firewall / different subnet when checking never connects', () => {
    const d = emptyDiagnostics();
    d.iceHistory = ['checking', 'disconnected'];
    d.remoteCandidateCount = 3;
    d.localCandidates = [{ type: 'host', protocol: 'udp', address: '192.168.68.112' }];
    expect(summarizeDiagnostics(d).join(' ')).toMatch(/firewall/i);
  });

  it('flags a missing code exchange when no remote candidates arrived', () => {
    const d = emptyDiagnostics();
    d.iceHistory = ['checking'];
    d.remoteCandidateCount = 0;
    expect(summarizeDiagnostics(d).join(' ')).toMatch(/code exchange/i);
  });

  it('reports success with the selected pair', () => {
    const d = emptyDiagnostics();
    d.connHistory = ['connecting', 'connected'];
    d.selectedPair = {
      local: { type: 'host', protocol: 'udp', address: '192.168.68.112' },
      remote: { type: 'host', protocol: 'udp', address: '192.168.68.50' },
    };
    expect(summarizeDiagnostics(d).join(' ')).toContain('Connected via 192.168.68.112');
  });
});
