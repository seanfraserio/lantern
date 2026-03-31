import type { LanternTracer } from "../tracer.js";

/**
 * Shape of the MCP tool call result.
 */
interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Shape of the MCP client we wrap.
 * We use a structural type so we don't need the actual MCP SDK as a dependency.
 */
interface McpClient {
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpToolResult>;
}

const WRAPPED = Symbol.for("lantern.wrapped");

/**
 * Wrap an MCP client to automatically trace all callTool() invocations.
 * Creates tool_call spans with the tool name, input arguments, and result content.
 *
 * Usage:
 * ```typescript
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { LanternTracer, wrapMcpClient } from "@openlantern-ai/sdk";
 *
 * const mcpClient = wrapMcpClient(new Client(...), tracer);
 * // All mcpClient.callTool() calls are now traced
 * ```
 */
export function wrapMcpClient<T extends McpClient>(
  client: T,
  tracer: LanternTracer,
  opts?: { traceId?: string; agentName?: string }
): T {
  if ((client as any)[WRAPPED]) return client;

  const originalCallTool = client.callTool.bind(client);

  const wrappedCallTool = async (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpToolResult> => {
    // Get or create a trace
    let traceId = opts?.traceId;
    let ownTrace = false;
    if (!traceId) {
      const trace = tracer.startTrace({
        agentName: opts?.agentName ?? "mcp-agent",
      });
      traceId = trace.id;
      ownTrace = true;
    }

    // Create a tool_call span
    const span = tracer.startSpan(traceId, {
      type: "tool_call",
      input: { args: params.arguments },
      toolName: params.name,
    });

    try {
      const result = await originalCallTool(params);

      // Extract text content from the result
      const textContent = result.content
        .filter((c) => c.type === "text" && c.text !== undefined)
        .map((c) => c.text)
        .join("\n");

      tracer.endSpan(
        span.id,
        { content: textContent || undefined },
        result.isError ? { error: textContent || "MCP tool returned an error" } : undefined
      );

      if (ownTrace) {
        tracer.endTrace(traceId, result.isError ? "error" : "success");
      }

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      tracer.endSpan(span.id, {}, { error: errorMessage });

      if (ownTrace) {
        tracer.endTrace(traceId, "error");
      }

      throw error;
    }
  };

  // Replace callTool with the wrapped version
  Object.assign(client, { callTool: wrappedCallTool });
  (client as any)[WRAPPED] = true;

  return client;
}
