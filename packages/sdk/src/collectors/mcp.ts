import type { LanternTracer } from "../tracer.js";

// TODO: Implement MCP tool call instrumentation

interface McpClient {
  callTool: (name: string, args: unknown) => Promise<unknown>;
}

/**
 * Wrap an MCP client to automatically trace tool calls.
 */
export function wrapMcpClient<T extends McpClient>(
  client: T,
  _tracer: LanternTracer
): T {
  // TODO: Implement MCP auto-instrumentation
  // Should intercept client.callTool() and create tool_call spans
  console.warn("[lantern] MCP auto-instrumentation not yet implemented");
  return client;
}
