// @vitest-environment node
//
// The Streamable HTTP transport (mcp-server.md REQ-1b/REQ-9/REQ-11,
// untrusted-input.md REQ-14, ADR-020).
//
// These run against a REAL ephemeral node:http server rather than a faked
// req/res pair. The things this file is actually pinning — a body refused
// mid-stream, a socket that must still deliver its 413, `Connection` handling —
// are properties of sockets, and a fake would pin the mock's behaviour instead.
// The dispatcher is stubbed, though: what is under test is framing and bounds,
// and tests/mcp/rpc.test.ts already owns the protocol half.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
// eslint-disable-next-line
import { createRequestListener, createRateLimiter, clientKey, originAllowed } from '../../scripts/mcp/http.mjs';

const LIMITS = { requestBytes: 1024, perMinute: 3, rateKeys: 4, requestMs: 5000 };

/** Tools the read-only profile exposes, in REQ-10's order. */
const READ_ONLY_TOOLS = [
  'get_params', 'get_song_format', 'validate_song', 'expand_song',
  'make_share_link', 'get_preset_format', 'validate_preset', 'expand_preset',
];

const stubTools = READ_ONLY_TOOLS.map((name) => ({
  name, description: name, inputSchema: { type: 'object' },
  handler: async () => ({ content: [{ type: 'text', text: name }] }),
}));

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function serve(overrides: Record<string, unknown> = {}) {
  // eslint-disable-next-line
  const { createDispatcher } = await import('../../scripts/mcp/rpc.mjs');
  const listener = createRequestListener({
    dispatch: createDispatcher({ name: 'websynth', version: '9.9.9', tools: stubTools }),
    version: '9.9.9',
    limits: LIMITS,
    log: () => {},
    ...overrides,
  });
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const rpc = (id: number, method: string, params?: unknown) =>
  ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

describe('MCP over HTTP — the handshake (REQ-1b/REQ-9)', () => {
  it('answers initialize with the same payload stdio gives, and no session id', async () => {
    const { base } = await serve();
    const res = await post(base, rpc(1, 'initialize', { protocolVersion: '2025-06-18' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    // REQ-9a: stateless. A session id would imply state there is none of.
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'websynth', version: '9.9.9' },
      },
    });
  });

  it('lists exactly the eight read-only tools, in order (REQ-10)', async () => {
    const { base } = await serve();
    const body = await (await post(base, rpc(2, 'tools/list'))).json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(READ_ONLY_TOOLS);
  });

  it('calls a tool and returns its result', async () => {
    const { base } = await serve();
    const body = await (await post(base, rpc(3, 'tools/call', { name: 'validate_song', arguments: {} }))).json();
    expect(body.result.content[0].text).toBe('validate_song');
  });

  it('answers 202 with no body for a notification', async () => {
    const { base } = await serve();
    const res = await post(base, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('never routes a write tool, because the profile does not carry one (REQ-10)', async () => {
    const { base } = await serve();
    const body = await (await post(base, rpc(4, 'tools/call', { name: 'save_song', arguments: { song: {} } }))).json();
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/save_song/);
  });

  it('ignores MCP-Protocol-Version, including one from the future (REQ-9d)', async () => {
    const { base } = await serve();
    const versions = ['2025-03-26', '2025-06-18', '2099-01-01', 'nonsense'];
    for (const [i, v] of versions.entries()) {
      // A distinct caller each time: more values here than one address is
      // allowed per window (LIMITS.perMinute), and this test is not about that.
      const res = await post(base, rpc(5, 'tools/list'),
        { 'mcp-protocol-version': v, 'x-forwarded-for': `198.18.0.${i}` });
      expect(res.status, v).toBe(200);
    }
  });

  it('accepts the POST on any path, so the proxy mount point is not a constant (REQ-9e)', async () => {
    const { base } = await serve();
    const paths = ['/', '/mcp', '/mcp/', '/some/other/mount'];
    for (const [i, path] of paths.entries()) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        // A distinct caller per path: this test is about routing, and there are
        // more paths here than LIMITS.perMinute allows one address.
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${i}` },
        body: JSON.stringify(rpc(6, 'tools/list')),
      });
      expect(res.status, path).toBe(200);
    }
  });
});

describe('MCP over HTTP — malformed requests (REQ-9)', () => {
  it('answers 400 with a JSON-RPC parse error for an unparseable body', async () => {
    const { base } = await serve();
    const res = await post(base, '{not json');
    expect(res.status).toBe(400);
    // The one rejection that is a JSON-RPC error rather than a bare status:
    // the protocol specifies this shape.
    expect(await res.json()).toEqual({
      jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' },
    });
  });

  it('answers 415 for a non-JSON content type', async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    });
    expect(res.status).toBe(415);
  });

  it('answers 405 + Allow on GET and DELETE — there is no stream (REQ-9b)', async () => {
    const { base } = await serve();
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow'), method).toMatch(/POST/);
    }
  });

  it('answers by method, never by path — there is no 404 (REQ-9e)', async () => {
    const { base } = await serve();
    // The server does not route on path, so it has no notion of a path being
    // "wrong". A GET to an unrouted path is the same 405 as a GET to /mcp, and
    // an exotic method is 405 too — never 404.
    for (const [path, method] of [['/nope', 'GET'], ['/nope', 'PUT'], ['/', 'PATCH']] as const) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.get('allow'), `${method} ${path}`).toMatch(/POST/);
    }
  });

  it('serves /healthz for an uptime check', async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '9.9.9' });
  });

  it('marks every response no-store, so nothing caches the API (REQ-9b)', async () => {
    const { base } = await serve();
    const res = await post(base, rpc(7, 'tools/list'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('MCP over HTTP — Origin (REQ-9c)', () => {
  it('allows a request with no Origin at all — that is what Claude sends', async () => {
    const { base } = await serve();
    const res = await post(base, rpc(8, 'tools/list'));
    expect(res.status).toBe(200);
  });

  it('rejects a foreign Origin with 403', async () => {
    const { base } = await serve();
    const res = await post(base, rpc(9, 'tools/list'), { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('allows the published site and loopback, and echoes CORS back', async () => {
    const { base } = await serve();
    for (const origin of ['https://vast.status201.com', 'http://localhost:6274', 'http://127.0.0.1:3000']) {
      const res = await post(base, rpc(10, 'tools/list'), { origin });
      expect(res.status, origin).toBe(200);
      expect(res.headers.get('access-control-allow-origin'), origin).toBe(origin);
    }
  });

  it('answers a preflight with 204 and the CORS headers', async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: { origin: 'https://vast.status201.com', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
  });

  it('originAllowed treats absent as allowed and unknown as denied', () => {
    const allowed = ['https://a.example', /^http:\/\/localhost(?::\d+)?$/];
    expect(originAllowed('', allowed)).toBe(true);
    expect(originAllowed(undefined, allowed)).toBe(true);
    expect(originAllowed('https://a.example', allowed)).toBe(true);
    expect(originAllowed('http://localhost:9999', allowed)).toBe(true);
    expect(originAllowed('https://b.example', allowed)).toBe(false);
  });
});

describe('MCP over HTTP — bounds (REQ-11, untrusted-input REQ-14)', () => {
  it('answers 413 for a body over the cap, without buffering it', async () => {
    const { base } = await serve();
    const res = await post(base, 'x'.repeat(LIMITS.requestBytes * 4));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/exceeds/);
  });

  it('delivers that 413 to a client that is still streaming', async () => {
    // The regression this guards: destroying the socket the moment the cap is
    // hit — or sending `Connection: close` — makes Node reset the connection,
    // and a streaming client then sees ECONNRESET instead of the reason. fetch()
    // buffers the whole body before sending, so it cannot tell the two apart;
    // only a chunked writer can.
    const { server } = await serve();
    const { port } = server.address() as AddressInfo;

    const status = await new Promise<number | string>((resolve) => {
      const req = httpRequest(
        { port, host: '127.0.0.1', method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json' } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); },
      );
      req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
      const chunk = Buffer.alloc(4096, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < LIMITS.requestBytes * 4) {
          sent += chunk.length;
          if (!req.write(chunk)) { req.once('drain', pump); return; }
        }
        req.end();
      };
      pump();
    });

    expect(status).toBe(413);
  });

  it('accepts a body exactly at the cap', async () => {
    const { base } = await serve();
    // A valid message padded with whitespace to precisely requestBytes.
    const msg = JSON.stringify(rpc(11, 'tools/list'));
    const body = msg + ' '.repeat(LIMITS.requestBytes - Buffer.byteLength(msg));
    expect(Buffer.byteLength(body)).toBe(LIMITS.requestBytes);
    const res = await post(base, body);
    expect(res.status).toBe(200);
  });

  it('rate-limits per IP and answers 429 with Retry-After', async () => {
    const { base } = await serve();
    const hit = (ip: string) => post(base, rpc(12, 'tools/list'), { 'x-forwarded-for': ip });

    for (let i = 0; i < LIMITS.perMinute; i++) {
      expect((await hit('203.0.113.5')).status).toBe(200);
    }
    const blocked = await hit('203.0.113.5');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);

    // A different caller is unaffected — the bucket is per address, not global.
    expect((await hit('203.0.113.99')).status).toBe(200);
  });

  it('keys the limiter on the FIRST X-Forwarded-For hop', async () => {
    const { base } = await serve();
    // The deployed proxy overwrites XFF, but if it ever appended, the client's
    // own value would be first — which is exactly the entry we must key on for
    // the limit to mean anything.
    const hit = (xff: string) => post(base, rpc(13, 'tools/list'), { 'x-forwarded-for': xff });
    for (let i = 0; i < LIMITS.perMinute; i++) {
      expect((await hit('198.51.100.7, 10.0.0.1')).status).toBe(200);
    }
    expect((await hit('198.51.100.7, 10.0.0.2')).status).toBe(429);
  });

  it('clientKey falls back to the socket when there is no forwarded header', () => {
    expect(clientKey({ headers: {}, socket: { remoteAddress: '1.2.3.4' } })).toBe('1.2.3.4');
    expect(clientKey({ headers: { 'x-forwarded-for': ' 9.9.9.9 , 10.0.0.1' }, socket: {} })).toBe('9.9.9.9');
    expect(clientKey({ headers: {}, socket: {} })).toBe('unknown');
  });
});

describe('the rate limiter is itself bounded (REQ-11)', () => {
  it('never tracks more than maxKeys addresses', () => {
    const limiter = createRateLimiter({ perMinute: 10, maxKeys: 8, now: () => 0 });
    for (let i = 0; i < 500; i++) limiter.hit(`10.0.0.${i}`);
    // The point is not the exact number — it is that a flood of unique keys
    // cannot make this grow without bound. An IP-keyed map that does is a
    // cheaper memory-exhaustion vector than anything it protects (ADR-015).
    expect(limiter.size).toBeLessThanOrEqual(8);
  });

  it('still limits a repeat caller while under the ceiling', () => {
    const limiter = createRateLimiter({ perMinute: 2, maxKeys: 100, now: () => 0 });
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
    expect(limiter.hit('b')).toBe(true);
  });

  it('forgives once the window rolls over', () => {
    let t = 0;
    const limiter = createRateLimiter({ perMinute: 1, maxKeys: 100, now: () => t });
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
    t += 60_001;
    expect(limiter.hit('a')).toBe(true);
  });
});

describe('the endpoint adds no parser of its own (untrusted-input REQ-14)', () => {
  it('a hostile song meets the same validators it would in the app', async () => {
    // Not a stub dispatcher here: the point is that the HTTP layer hands the
    // arguments straight to the real tool, so a payload gets the identical
    // answer whether it arrived over a socket or a pasted file.
    const [{ makeTools }, { createDispatcher }, core] = await Promise.all([
      // eslint-disable-next-line
      import('../../scripts/mcp/tools.mjs'),
      // eslint-disable-next-line
      import('../../scripts/mcp/rpc.mjs'),
      import('./core-fixture'),
    ]);
    const { base } = await serve({
      dispatch: createDispatcher({
        name: 'websynth', version: '9.9.9',
        tools: makeTools(core.core, { allowWrites: false }),
      }),
    });

    const hostile = {
      format: 'websynth-song-author', version: 1, name: 'bad',
      params: { 'transport.bpm': 124 },
      // The exact payload ADR-015 was written for: a note that reaches
      // midiToHz as Infinity and throws out of an AudioParam write.
      seq: [[1_000_000]],
    };
    const res = await post(base, rpc(14, 'tools/call', { name: 'validate_song', arguments: { song: hostile } }));
    expect(res.status).toBe(200);

    const payload = JSON.parse((await res.json()).result.content[0].text);
    expect(payload.ok).toBe(false);
    // The field-level message the in-app import shows, verbatim — the endpoint
    // is a transport, so the answer must be identical, not merely also a failure.
    expect(payload.errors).toEqual(['seq[0][0] is out of MIDI range 0..127 (got 1000000)']);
  });
});
