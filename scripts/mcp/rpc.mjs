/**
 * Pure JSON-RPC 2.0 / MCP dispatch for the websynth MCP server
 * (specs/features/mcp-server.md REQ-2/6). No stdio in here — the entry
 * (websynth-mcp.mjs) owns framing, this module just maps a parsed request
 * to a response object (or null for notifications). Hand-rolled, zero deps
 * (ADR-003).
 */

/** Protocol revisions this server knows; initialize echoes a known one. */
export const KNOWN_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
export const LATEST_PROTOCOL_VERSION = '2025-06-18';

const JSONRPC = '2.0';

const err = (id, code, message, data) => ({
  jsonrpc: JSONRPC,
  id: id ?? null,
  error: data === undefined ? { code, message } : { code, message, data },
});

const ok = (id, result) => ({ jsonrpc: JSONRPC, id: id ?? null, result });

/**
 * Build the message dispatcher.
 * @param {{ name: string, version: string, tools: Array<{name: string, description: string,
 *   inputSchema: object, handler: (args: object) => Promise<{content: Array<object>, isError?: boolean}>}> }} opts
 * @returns {(msg: unknown) => Promise<object | null>} response, or null for notifications
 */
export function createDispatcher({ name, version, tools }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  return async function dispatch(msg) {
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || msg.jsonrpc !== JSONRPC) {
      return err(msg && typeof msg === 'object' ? msg.id : null, -32600, 'Invalid Request');
    }
    const { id, method, params } = msg;

    // Notifications (no id / notifications/*) never get a response.
    if (typeof method === 'string' && method.startsWith('notifications/')) return null;
    if (id === undefined) return null;

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = KNOWN_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        return ok(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name, version },
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, {
          tools: tools.map(({ name: n, description, inputSchema }) => ({
            name: n,
            description,
            inputSchema,
          })),
        });
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return err(id, -32602, `Unknown tool: ${params?.name}`);
        try {
          return ok(id, await tool.handler(params?.arguments ?? {}));
        } catch (e) {
          // A tool crash is a *result* with isError, per MCP — the model can
          // read it and retry — never a dead JSON-RPC error.
          return ok(id, {
            content: [{ type: 'text', text: `Tool failed: ${e?.message ?? String(e)}` }],
            isError: true,
          });
        }
      }
      default:
        return err(id, -32601, `Method not found: ${method}`);
    }
  };
}
