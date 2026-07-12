// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
// Plain .mjs module — resolved relative to the repo root by Vitest.
import {
  createDispatcher,
  LATEST_PROTOCOL_VERSION,
  KNOWN_PROTOCOL_VERSIONS,
  // eslint-disable-next-line
} from '../../scripts/mcp/rpc.mjs';

type Dispatch = (msg: unknown) => Promise<Record<string, any> | null>;

const echoTool = {
  name: 'echo',
  description: 'echo back',
  inputSchema: { type: 'object', properties: { s: { type: 'string' } } },
  handler: vi.fn(async (args: { s?: string }) => ({
    content: [{ type: 'text', text: `echo:${args.s ?? ''}` }],
  })),
};
const crashTool = {
  name: 'crash',
  description: 'always throws',
  inputSchema: { type: 'object' },
  handler: async () => { throw new Error('boom'); },
};

function dispatcher(): Dispatch {
  return createDispatcher({ name: 'websynth', version: '9.9.9', tools: [echoTool, crashTool] }) as Dispatch;
}

const req = (id: number, method: string, params?: unknown) =>
  ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

describe('createDispatcher', () => {
  it('initialize echoes a known protocolVersion', async () => {
    for (const v of KNOWN_PROTOCOL_VERSIONS as string[]) {
      const res = await dispatcher()(req(1, 'initialize', { protocolVersion: v }));
      expect(res!.result.protocolVersion).toBe(v);
    }
  });

  it('initialize answers the latest version for unknown/missing requests', async () => {
    const d = dispatcher();
    const res = await d(req(1, 'initialize', { protocolVersion: '1999-01-01' }));
    expect(res!.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(res!.result.capabilities).toEqual({ tools: {} });
    expect(res!.result.serverInfo).toEqual({ name: 'websynth', version: '9.9.9' });
    const bare = await d(req(2, 'initialize'));
    expect(bare!.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('notifications get no response', async () => {
    const d = dispatcher();
    expect(await d({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await d({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} })).toBeNull();
    // A request-shaped message without an id is a notification per JSON-RPC.
    expect(await d({ jsonrpc: '2.0', method: 'tools/list' })).toBeNull();
  });

  it('ping returns an empty result', async () => {
    const res = await dispatcher()(req(3, 'ping'));
    expect(res).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });

  it('tools/list returns name/description/inputSchema only', async () => {
    const res = await dispatcher()(req(4, 'tools/list'));
    expect(res!.result.tools).toHaveLength(2);
    expect(res!.result.tools[0]).toEqual({
      name: 'echo',
      description: 'echo back',
      inputSchema: echoTool.inputSchema,
    });
    expect(res!.result.tools[0].handler).toBeUndefined();
  });

  it('tools/call routes arguments to the handler', async () => {
    const res = await dispatcher()(req(5, 'tools/call', { name: 'echo', arguments: { s: 'hi' } }));
    expect(res!.result.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    expect(res!.result.isError).toBeUndefined();
  });

  it('tools/call with a missing arguments object passes {}', async () => {
    const res = await dispatcher()(req(6, 'tools/call', { name: 'echo' }));
    expect(res!.result.content).toEqual([{ type: 'text', text: 'echo:' }]);
  });

  it('a crashing tool yields an isError result, not a JSON-RPC error', async () => {
    const res = await dispatcher()(req(7, 'tools/call', { name: 'crash', arguments: {} }));
    expect(res!.error).toBeUndefined();
    expect(res!.result.isError).toBe(true);
    expect(res!.result.content[0].text).toContain('boom');
  });

  it('unknown tool → -32602; unknown method → -32601', async () => {
    const d = dispatcher();
    const badTool = await d(req(8, 'tools/call', { name: 'nope', arguments: {} }));
    expect(badTool!.error.code).toBe(-32602);
    const badMethod = await d(req(9, 'resources/list'));
    expect(badMethod!.error.code).toBe(-32601);
  });

  it('rejects non-2.0 / non-object messages as Invalid Request', async () => {
    const d = dispatcher();
    expect((await d({ id: 1, method: 'ping' }))!.error.code).toBe(-32600);
    expect((await d('ping'))!.error.code).toBe(-32600);
    expect((await d(null))!.error.code).toBe(-32600);
  });
});
