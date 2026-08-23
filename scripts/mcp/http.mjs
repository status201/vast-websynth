/**
 * Streamable HTTP transport for the websynth MCP server
 * (mcp-server.md REQ-1b/REQ-9/REQ-11, untrusted-input.md REQ-14, ADR-020).
 *
 * This file is the whole trust boundary of the public endpoint. There is no
 * auth by design — every tool behind it is a pure function over a public
 * document format — so the bounds ARE the defence, and they are the only thing
 * here worth reviewing twice.
 *
 * Hand-rolled on node:http, like `rpc.mjs` is hand-rolled on the protocol
 * (ADR-003). `createDispatcher` was already transport-agnostic, so nothing
 * about JSON-RPC lives in here: this is framing, bounds and status codes.
 *
 * Stateless on purpose (REQ-9a/9b): no Mcp-Session-Id is issued and no SSE
 * stream is offered, so there is no session table to bound, no eviction policy
 * to get wrong, and no long-lived response for a reverse proxy to buffer. GET
 * answering 405 is the spec's way of saying "no server-initiated stream", and
 * it doubles as the reason the app's service worker can never cache this path
 * (pwa-install.md REQ-6 — a 405 is not a cacheable 200).
 */
import { createServer } from 'node:http';
import process from 'node:process';
import { loadCore, readVersion } from './core.mjs';

/** Origins a *browser* may call from. Claude sends none at all — see below. */
export const DEFAULT_ORIGINS = [
  'https://vast.status201.com',
  // The MCP Inspector, which runs in a tab.
  /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/,
];

const JSON_TYPE = 'application/json';

/**
 * How far past the body cap an over-cap upload is drained (and discarded) before
 * the connection is cut instead. Draining is what lets the client actually read
 * the 413; this is what stops the drain being its own denial of service.
 */
const DRAIN_GRACE = 8;

/**
 * Fixed-window per-IP counter, bounded (REQ-11).
 *
 * The cap is not paranoia about the happy path — it is that this map allocates
 * one entry per *caller-chosen* key on an endpoint anyone can reach. Unbounded,
 * the rate limiter would be a cheaper memory-exhaustion vector than anything it
 * protects against. When the ceiling is hit the whole window is dropped rather
 * than evicting one entry: a full sweep is O(1) amortised and cannot be gamed
 * into evicting a specific attacker's neighbour, which an LRU can.
 */
export function createRateLimiter({ perMinute, maxKeys, now = () => Date.now() }) {
  let windowStart = now();
  let counts = new Map();

  return {
    /** @returns {boolean} true when the request is allowed. */
    hit(key) {
      const t = now();
      if (t - windowStart >= 60_000) {
        windowStart = t;
        counts = new Map();
      }
      const n = counts.get(key) ?? 0;
      if (n >= perMinute) return false;
      if (n === 0 && counts.size >= maxKeys) {
        // At the ceiling: reset rather than grow. A flood of unique keys is
        // itself the attack, and the window is at most 60 s of amnesty.
        counts = new Map();
      }
      counts.set(key, n + 1);
      return true;
    },
    /** Tracked-key count — the ceiling this must never exceed is the point. */
    get size() {
      return counts.size;
    },
    /** Seconds until the current window rolls over, for Retry-After. */
    retryAfter() {
      return Math.max(1, Math.ceil((windowStart + 60_000 - now()) / 1000));
    },
  };
}

/**
 * The client address for rate-limiting: the FIRST `X-Forwarded-For` hop.
 *
 * Trustworthy only because the deployed nginx *overwrites* that header
 * (`proxy_set_header X-Forwarded-For $remote_addr`) rather than appending to
 * it. Appending would let an unauthenticated caller pick its own bucket by
 * sending the header itself. The code cannot verify the proxy is configured
 * that way, so it is written down beside the directive in DEPLOYMENT.md — and
 * it is the first thing to check if the limiter ever looks ineffective.
 */
export function clientKey(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/** True when `origin` is absent (a non-browser caller) or allowlisted. */
export function originAllowed(origin, allowed) {
  // Absent is ALLOWED, deliberately (REQ-9c). Claude reaches this server-side
  // and sends no Origin, so requiring the header would reject the only client
  // that matters. The check exists for DNS rebinding, which is a browser
  // attack, and a browser always sends one.
  if (!origin) return true;
  return allowed.some((a) => (a instanceof RegExp ? a.test(origin) : a === origin));
}

/**
 * Read the body with a running byte count, refusing over-cap input *in transit*
 * (REQ-11). Resolves `null` when the cap was hit — the caller has already been
 * answered 413, so there is nothing left to do.
 *
 * Over the cap the buffered chunks are dropped immediately and nothing further
 * is kept: a cap applied after the fact has already spent the memory it was
 * meant to save (untrusted-input.md REQ-2).
 *
 * The remaining bytes are then *discarded as they arrive* rather than the socket
 * being destroyed on the spot. Destroying leaves unread data on the connection,
 * which makes Node reset it — and a client mid-upload then sees `ECONNRESET`
 * instead of the 413 that would have told it what to fix. For the same reason
 * the 413 does **not** carry `Connection: close`: Node honours that by dropping
 * the socket as soon as the response is written, which reintroduces the reset it
 * was added to avoid. Both were measured against a streaming client, not
 * reasoned about — `fetch` buffers the whole body first and so cannot tell the
 * two cases apart.
 *
 * Discarding costs no memory, so REQ-2 still holds; it costs bandwidth, so the
 * drain is bounded in turn by {@link DRAIN_GRACE} and the connection is cut for
 * a sender that keeps going regardless. In production nginx's own
 * `client_max_body_size` refuses these at the edge anyway — this path is what
 * makes the bound true when the process is reached directly.
 */
function readBody(req, res, maxBytes) {
  return new Promise((resolve) => {
    let chunks = [];
    let total = 0;
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (done) {
        // Draining. Nothing is kept; give up on a sender that will not stop.
        if (total > maxBytes * DRAIN_GRACE) req.destroy();
        return;
      }
      if (total > maxBytes) {
        chunks = []; // drop what was read; keep nothing more
        finish(null);
        send(res, 413, { error: `Request body exceeds ${maxBytes} bytes` });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
}

/** JSON response helper. `body === null` sends no payload (202/204). */
function send(res, status, body, extraHeaders = {}) {
  if (res.writableEnded || res.headersSent) return;
  const headers = { ...extraHeaders };
  if (body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': `${JSON_TYPE}; charset=utf-8`,
    'content-length': Buffer.byteLength(text),
    // Belt and braces for REQ-9b: nothing on this path is ever cacheable, by
    // a browser, a service worker or an intermediary.
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

/** CORS headers for an allowed origin. Omitted entirely when there is none. */
function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, accept, mcp-protocol-version',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

/**
 * Build the request listener.
 *
 * @param {object} opts
 * @param {(msg: unknown) => Promise<object|null>} opts.dispatch  from createDispatcher
 * @param {string} opts.version    reported by /healthz
 * @param {Array<string|RegExp>} [opts.origins]
 * @param {{requestBytes: number, perMinute: number, rateKeys: number, requestMs: number}} opts.limits
 *        the MAX_MCP_* constants from src/state/limits.ts, via the core bundle
 * @param {(...a: unknown[]) => void} [opts.log]
 */
export function createRequestListener({
  dispatch,
  version,
  origins = DEFAULT_ORIGINS,
  limits,
  log = (...a) => process.stderr.write(`[websynth-mcp] ${a.join(' ')}\n`),
}) {
  const limiter = createRateLimiter({
    perMinute: limits.perMinute,
    maxKeys: limits.rateKeys,
  });

  return function listener(req, res) {
    // One clock for the whole request (REQ-11). A tool that somehow hangs must
    // not hold a socket open indefinitely on a public endpoint.
    res.setTimeout?.(limits.requestMs, () => {
      send(res, 504, { error: 'Request timed out' });
      res.destroy?.();
    });

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const cors = corsHeaders(origin);
    // Path is parsed but NOT matched for the MCP verb (REQ-9e): the same
    // process answers at /mcp behind the production proxy, at / on the origin
    // server, and at whatever a developer types locally. Hard-matching /mcp
    // would make the deployment topology a code constant.
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (!originAllowed(origin, origins)) {
      send(res, 403, { error: 'Origin not allowed' });
      return;
    }

    if (req.method === 'OPTIONS') {
      send(res, 204, null, cors);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      send(res, 200, { ok: true, version }, cors);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      // No server-initiated stream, and no session to terminate (REQ-9a/9b).
      send(res, 405, { error: 'This MCP server offers no SSE stream; use POST.' }, {
        ...cors,
        allow: 'POST, OPTIONS',
      });
      return;
    }

    if (req.method !== 'POST') {
      send(res, 405, { error: 'Method not allowed' }, { ...cors, allow: 'POST, OPTIONS' });
      return;
    }

    if (!limiter.hit(clientKey(req))) {
      send(res, 429, { error: 'Rate limit exceeded' }, {
        ...cors,
        'retry-after': String(limiter.retryAfter()),
      });
      return;
    }

    const ctype = String(req.headers['content-type'] ?? '');
    if (!ctype.toLowerCase().includes(JSON_TYPE)) {
      send(res, 415, { error: `Content-Type must be ${JSON_TYPE}` }, cors);
      return;
    }

    void readBody(req, res, limits.requestBytes).then(async (body) => {
      if (body === null) return; // already answered (413) or the socket died

      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        // The one place a rejection is a JSON-RPC error rather than a bare
        // status: the protocol specifies this shape for a parse failure.
        send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, cors);
        return;
      }

      // MCP-Protocol-Version is deliberately IGNORED (REQ-9d) — not read and
      // discarded, simply never consulted. `rpc.mjs` behaves identically at
      // every revision it knows and `initialize` already negotiates, so there
      // is nothing this header could change. Validating it would only give a
      // client newer than this file a way to be refused for no reason.

      try {
        const result = await dispatch(msg);
        // A notification has no response. 202 is the spec's answer.
        if (result === null) send(res, 202, null, cors);
        else send(res, 200, result, cors);
      } catch (e) {
        log('dispatch failed:', e?.stack ?? String(e));
        send(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }, cors);
      }
    });
  };
}

/**
 * Stand the whole thing up: core bundle → read-only tools → dispatcher →
 * listener → socket. Both HTTP entries are a one-line call to this; the only
 * thing they disagree about is `selfBuild` (REQ-3).
 *
 * `allowWrites: false` is not a parameter (REQ-10). Whether the write tools are
 * exposed is a property of the *transport*, not of the deployment: there is no
 * configuration in which a remotely-reachable server should write files into
 * its own working directory, so it is not made configurable.
 *
 * @param {{selfBuild?: boolean, port?: number, host?: string}} [opts]
 */
export async function startServer({ selfBuild = false, port, host } = {}) {
  const core = await loadCore({ selfBuild });
  const { makeTools } = await import('./tools.mjs');
  const { createDispatcher } = await import('./rpc.mjs');

  const version = readVersion();
  const dispatch = createDispatcher({
    name: 'websynth',
    version,
    tools: makeTools(core, { allowWrites: false }),
  });

  const listener = createRequestListener({
    dispatch,
    version,
    limits: {
      requestBytes: core.MAX_MCP_REQUEST_BYTES,
      perMinute: core.MAX_MCP_REQUESTS_PER_MINUTE,
      rateKeys: core.MAX_MCP_RATE_KEYS,
      requestMs: core.MAX_MCP_REQUEST_MS,
    },
  });

  const server = createServer(listener);
  const listenPort = port ?? Number(process.env.PORT ?? 8787);
  // Under Passenger, listen() is intercepted and the host/port are ignored — a
  // stock node:http server needs no Passenger-specific code. Standalone, bind
  // loopback only: the reverse proxy is the only thing that should reach this.
  const listenHost = host ?? process.env.HOST ?? '127.0.0.1';

  await new Promise((resolve) => server.listen(listenPort, listenHost, resolve));
  const addr = server.address();
  process.stderr.write(
    `[websynth-mcp] ready (http, v${version}) on ` +
      `${typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : String(addr)}\n`,
  );
  return server;
}
