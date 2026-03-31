import type { LanternTracer } from "../tracer.js";
import type { SpanOutput } from "../types.js";

/**
 * Shape of the Anthropic client we wrap.
 * We use a structural type so we don't need the actual Anthropic SDK as a dependency.
 */
interface AnthropicMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  model: string;
  stop_reason: string | null;
  usage: AnthropicUsage;
}

interface AnthropicCreateParams {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  temperature?: number;
  tools?: unknown[];
  [key: string]: unknown;
}

interface AnthropicMessages {
  create(params: AnthropicCreateParams): Promise<AnthropicResponse>;
}

interface AnthropicClient {
  messages: AnthropicMessages;
}

const WRAPPED = Symbol.for("lantern.wrapped");

/**
 * Wrap an Anthropic client to automatically trace all message.create() calls.
 * Creates llm_call spans with full input/output/token data.
 *
 * Usage:
 * ```typescript
 * import Anthropic from "@anthropic-ai/sdk";
 * import { LanternTracer, wrapAnthropicClient } from "@openlantern-ai/sdk";
 *
 * const client = wrapAnthropicClient(new Anthropic(), tracer);
 * // All client.messages.create() calls are now traced
 * ```
 */
export function wrapAnthropicClient<T extends AnthropicClient>(
  client: T,
  tracer: LanternTracer,
  opts?: { traceId?: string; agentName?: string }
): T {
  if ((client as any)[WRAPPED]) return client;

  const originalCreate = client.messages.create.bind(client.messages);

  const wrappedCreate = async (params: AnthropicCreateParams): Promise<AnthropicResponse> => {
    // Get or create a trace
    let traceId = opts?.traceId;
    let ownTrace = false;
    if (!traceId) {
      const trace = tracer.startTrace({
        agentName: opts?.agentName ?? "anthropic-agent",
      });
      traceId = trace.id;
      ownTrace = true;
    }

    // Create the LLM call span
    const messages = params.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string"
        ? m.content
        : m.content.map((c) => c.text ?? JSON.stringify(c)).join(""),
    }));

    const span = tracer.startSpan(traceId, {
      type: "llm_call",
      input: { messages },
      model: params.model,
    });

    try {
      const response = await originalCreate(params);

      // Extract text content from response
      const textContent = response.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");

      // Extract tool use blocks
      const toolCalls = response.content
        .filter((c) => c.type === "tool_use")
        .map((c) => ({ id: c.id, name: c.name, input: c.input }));

      const output: SpanOutput = {
        content: textContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        stopReason: response.stop_reason ?? undefined,
      };

      tracer.endSpan(span.id, output, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });

      // Create child spans for tool calls
      for (const tool of toolCalls) {
        const toolSpan = tracer.startSpan(traceId, {
          type: "tool_call",
          parentSpanId: span.id,
          input: { args: tool.input },
          toolName: tool.name as string,
        });

        // Tool call spans are started but not ended here —
        // the actual tool execution happens outside this wrapper.
        // The user can end them manually or they'll be captured
        // by MCP instrumentation.
        tracer.endSpan(toolSpan.id, { content: "Tool call initiated" });
      }

      if (ownTrace) {
        tracer.endTrace(traceId, "success");
      }

      return response;
    } catch (error) {
      tracer.endSpan(span.id, {}, {
        error: error instanceof Error ? error.message : String(error),
      });

      if (ownTrace) {
        tracer.endTrace(traceId, "error");
      }

      throw error;
    }
  };

  // Replace the create method with the wrapped version
  Object.assign(client.messages, { create: wrappedCreate });
  (client as any)[WRAPPED] = true;

  return client;
}
