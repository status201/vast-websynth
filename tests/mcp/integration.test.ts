// @vitest-environment node
//
// End-to-end over real stdio: spawn the server on a checkout with NO bundle, so
// it self-builds, then drive initialize → tools/list → tools/call.
//
// The bundle is deliberately NOT pre-built here. It used to be — one `vite
// build` up front so the server start was fast — but that skipped `ensureCore`'s
// spawn path entirely, leaving "self-build keeps stdout protocol-pure" (REQ-1)
// unpinned: the interesting case is precisely a server that runs a Vite build
// while a client is talking to it. It costs nothing, because the pre-build was
// running that same single build unconditionally anyway; it has only moved
// inside the server, where the child process's output can actually reach — and
// must not corrupt — the protocol stream.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const serverPath = path.join(repoRoot, 'scripts', 'mcp', 'websynth-mcp.mjs');
const distDir = path.join(repoRoot, 'scripts', 'mcp', 'dist');
const distFile = path.join(distDir, 'song-core.mjs');

let child: ChildProcessWithoutNullStreams;
let lines: Interface;
const pending = new Map<number, (msg: Record<string, any>) => void>();
let nextId = 1;

/** Every line the server wrote to stdout, and any that was not a JSON-RPC
 *  frame. Parsing defensively (rather than letting JSON.parse throw inside the
 *  'line' handler) turns an impure stream into a readable assertion instead of
 *  an unhandled error. */
const stdoutLines: string[] = [];
const impure: string[] = [];
let stderrText = '';

function request(method: string, params?: unknown): Promise<Record<string, any>> {
  const id = nextId++;
  const p = new Promise<Record<string, any>>((resolve) => pending.set(id, resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
  return p;
}

beforeAll(async () => {
  // A checkout that has never run the server (or whose bundle is stale).
  rmSync(distDir, { recursive: true, force: true });

  child = spawn(process.execPath, [serverPath], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderrText += chunk; });

  lines = createInterface({ input: child.stdout, terminal: false });
  lines.on('line', (line) => {
    stdoutLines.push(line);
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line) as Record<string, any>;
    } catch {
      impure.push(line); // REQ-1 violation — asserted below
      return;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  // Absorb the self-build here rather than in the first test's budget: nothing
  // is answered until `ensureCore()` finishes, so this round-trip *is* the wait.
  await request('ping');
}, 180_000);

afterAll(() => {
  child?.kill();
});

// mcp-server.md REQ-1 / REQ-3. The build runs in a child process whose stdout is
// relayed to our stderr, so a chatty toolchain cannot reach the protocol stream.
describe('the self-build', () => {
  it('produces the bundle on a checkout that had none', () => {
    expect(existsSync(distFile)).toBe(true);
  });

  it('keeps stdout protocol-pure while it builds', () => {
    expect(impure).toEqual([]);
    expect(stdoutLines.length).toBeGreaterThan(0);
    for (const line of stdoutLines) {
      expect(JSON.parse(line), line).toMatchObject({ jsonrpc: '2.0' });
    }
  });

  // `ensureCore` logs nothing at all when the bundle is fresh, so these two
  // lines are the proof that the self-build path is what just ran — and that
  // its output went to stderr rather than into the frames above.
  it('reports the build on stderr, where a client ignores it', () => {
    expect(stderrText).toMatch(/building song-core bundle/);
    expect(stderrText).toMatch(/song-core bundle ready/);
  });
});

describe('websynth MCP server over stdio', () => {
  it('initialize → initialized handshake', async () => {
    const res = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0' },
    });
    expect(res.result.protocolVersion).toBe('2025-06-18');
    expect(res.result.capabilities).toEqual({ tools: {} });
    expect(res.result.serverInfo.name).toBe('websynth');
    // The initialized notification must produce no reply (nothing to await —
    // the next request's id-matched response proves the stream stayed clean).
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }, 30_000);

  it('tools/list names the song and preset tools', async () => {
    const res = await request('tools/list');
    expect(res.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'get_params',
      'get_song_format', 'validate_song', 'expand_song', 'save_song', 'make_share_link',
      'get_preset_format', 'validate_preset', 'expand_preset', 'save_preset',
    ]);
  }, 30_000);

  // Proves `buildParamCatalog` survived the Vite lib build of song-core-entry —
  // the catalogue is only useful to an agent if it comes back over real stdio.
  it('get_params returns the catalogue over real stdio', async () => {
    const res = await request('tools/call', { name: 'get_params', arguments: {} });
    const cat = JSON.parse(res.result.content[0].text);
    expect(cat.format).toBe('websynth-params');
    expect(cat.count).toBeGreaterThan(100);
    expect(cat.params.some((p: { id: string }) => p.id === 'filter.cutoff')).toBe(true);
  }, 30_000);

  // The preset half rides the same bundle (mcp-server.md REQ-4): proving one
  // preset tool answers over real stdio proves song-core-entry's new exports
  // survived the Vite lib build.
  it('validate_preset: an invented parameter id → ok:false, not isError', async () => {
    const res = await request('tools/call', {
      name: 'validate_preset',
      arguments: {
        preset: { format: 'websynth-preset', version: 1, name: 'Bad', params: { 'osc1.shape': 1 } },
      },
    });
    expect(res.result.isError).toBeFalsy();
    const out = JSON.parse(res.result.content[0].text);
    expect(out.ok).toBe(false);
    expect(out.errors.join('\n')).toContain('osc1.shape');
  }, 30_000);

  it('validate_song: good song → ok:true', async () => {
    const res = await request('tools/call', {
      name: 'validate_song',
      arguments: {
        song: {
          format: 'websynth-song-author', version: 1, name: 'Stdio Song',
          seq: [['A2', null, 'C3']], drums: [{ kick: [0, 4, 8, 12] }],
        },
      },
    });
    expect(res.result.isError).toBeFalsy();
    // `warnings` is always present on the success payload (mcp-server.md REQ-13)
    // — empty here because every automation target in this song resolves.
    expect(JSON.parse(res.result.content[0].text)).toEqual({ ok: true, errors: [], warnings: [] });
  }, 30_000);

  it('validate_song: broken song → ok:false with authoring-term errors (still not isError)', async () => {
    const res = await request('tools/call', {
      name: 'validate_song',
      arguments: {
        song: { format: 'websynth-song-author', version: 1, name: 'Bad', drums: [{ cowbell: [99] }] },
      },
    });
    expect(res.result.isError).toBeFalsy();
    const out = JSON.parse(res.result.content[0].text);
    expect(out.ok).toBe(false);
    expect(out.errors.join(' ')).toMatch(/cowbell/);
  }, 30_000);

  it('unknown method → -32601; parse error → -32700', async () => {
    const res = await request('resources/list');
    expect(res.error.code).toBe(-32601);

    const parseErr = new Promise<Record<string, any>>((resolve) => {
      const onLine = (line: string) => {
        const msg = JSON.parse(line) as Record<string, any>;
        if (msg.error?.code === -32700) {
          lines.off('line', onLine);
          resolve(msg);
        }
      };
      lines.on('line', onLine);
    });
    child.stdin.write('this is not json\n');
    expect((await parseErr).error.code).toBe(-32700);
  }, 30_000);
});
