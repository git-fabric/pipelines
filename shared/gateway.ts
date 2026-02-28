/**
 * Thin HTTP client for the fabric gateway MCP endpoint.
 * Sends JSON-RPC tool calls and parses SSE responses.
 */

const GW_URL =
  process.env.FABRIC_GATEWAY_URL ??
  'http://fabric-gateway.cortex-system.svc.cluster.local:3000';

/**
 * Call a tool on the fabric gateway and return the parsed result.
 * Gateway responds with SSE format: `data: {...}\n\n`
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: args },
  });

  const res = await fetch(`${GW_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Gateway HTTP ${res.status}: ${await res.text()}`);
  }

  const text = await res.text();

  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      const payload = JSON.parse(line.slice(6)) as {
        result?: { content?: Array<{ text?: string }> };
        error?: { message: string };
      };
      if (payload.error) throw new Error(payload.error.message);
      const text = payload.result?.content?.[0]?.text;
      if (text !== undefined) {
        // Tool results are JSON strings; parse if possible
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
    }
  }

  throw new Error(`No data in gateway response. Body: ${text.slice(0, 200)}`);
}

/**
 * Run multiple tool calls in parallel and return all results.
 */
export async function callTools(
  calls: Array<{ name: string; args?: Record<string, unknown> }>,
): Promise<unknown[]> {
  return Promise.all(calls.map((c) => callTool(c.name, c.args ?? {})));
}

export { GW_URL };
