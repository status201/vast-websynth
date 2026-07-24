// @vitest-environment node
//
// End-to-end over real stdio: build the core bundle, spawn the server, and
// drive initialize → tools/list → tools/call. Pins REQ-1 (stdout stays
// protocol-pure) because every reply must parse as a JSON-RPC frame.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const serverPath = path.join(repoRoot, 'scripts', 'mcp', 'websynth-mcp.mjs');

let child: ChildProcessWithoutNullStreams;
let lines: Interface;
const pending = new Map<number, (msg: Record<string, any>) => void>();
let nextId = 1;

function request(method: string, params?: unknown): Promise<Record<string, any>> {
  const id = nextId++;
  const p = new Promise<Record<string, any>>((resolve) => pending.set(id, resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
  return p;
}

beforeAll(() => {
  // Build the bundle up front (vite's bin invoked directly — cross-platform,
  // no npm/shell indirection) so the server start below is fast; the server's
  // own self-build path stays covered by its staleness logic.
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    'build', '--config', path.join('scripts', 'mcp', 'vite.lib.config.ts'),
  ], { cwd: repoRoot, stdio: 'ignore' });

  child = spawn(process.execPath, [serverPath], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  lines = createInterface({ input: child.stdout, terminal: false });
  lines.on('line', (line) => {
    // REQ-1: EVERY stdout line must be a JSON-RPC frame.
    const msg = JSON.parse(line) as Record<string, any>;
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  });
}, 120_000);

afterAll(() => {
  child?.kill();
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
      'get_song_format', 'validate_song', 'expand_song', 'save_song', 'make_share_link',
      'get_preset_format', 'validate_preset', 'expand_preset', 'save_preset',
    ]);
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
    expect(JSON.parse(res.result.content[0].text)).toEqual({ ok: true, errors: [] });
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
