import type { LanternTracer } from "../tracer.js";
import type { SpanOutput } from "../types.js";

/**
 * Shape of the OpenAI client we wrap.
 * We use structural types so we don't need the actual OpenAI SDK as a dependency.
 */
interface OpenAIMessage {
  role: string;
  content: string | null;
}

interface OpenAIChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: string;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIResponse {
  id: string;
  choices: OpenAIChoice[];
  model: string;
  usage: OpenAIUsage;
}

interface OpenAICreateParams {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  [key: string]: unknown;
}

interface OpenAICompletions {
  create(params: OpenAICreateParams): Promise<OpenAIResponse>;
}

interface OpenAIClient {
  chat: {
    completions: OpenAICompletions;
  };
}

/**
 * Wrap an OpenAI client to automatically trace all chat.completions.create() calls.
 * Creates llm_call spans with full input/output/token data.
 *
 * Usage:
 * ```typescript
 * import OpenAI from "openai";
 * import { LanternTracer, wrapOpenAIClient } from "@lantern-ai/sdk";
 *
 * const client = wrapOpenAIClient(new OpenAI(), tracer);
 * // All client.chat.completions.create() calls are now traced
 * ```
 */
export function wrapOpenAIClient<T extends OpenAIClient>(
  client: T,
  tracer: LanternTracer,
  opts?: { traceId?: string; agentName?: string }
): T {
  const originalCreate = client.chat.completions.create.bind(client.chat.completions);

  const wrappedCreate = async (params: OpenAICreateParams): Promise<OpenAIResponse> => {
    // Get or create a trace
    let traceId = opts?.traceId;
    let ownTrace = false;
    if (!traceId) {
      const trace = tracer.startTrace({
        agentName: opts?.agentName ?? "openai-agent",
      });
      traceId = trace.id;
      ownTrace = true;
    }

    // Create the LLM call span
    const messages = params.messages.map((m) => ({
      role: m.role,
      content: m.content ?? "",
    }));

    const span = tracer.startSpan(traceId, {
      type: "llm_call",
      input: { messages },
      model: params.model,
    });

    try {
      const response = await originalCreate(params);

      // Extract text content from the first choice (primary response)
      const firstChoice = response.choices[0];
      const textContent = firstChoice?.message?.content ?? "";

      // Extract tool calls if present
      const toolCalls = firstChoice?.message?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: tc.function.arguments,
      })) ?? [];

      const output: SpanOutput = {
        content: textContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        stopReason: firstChoice?.finish_reason ?? undefined,
      };

      tracer.endSpan(span.id, output, {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      });

      // Create child spans for tool calls
      for (const tool of toolCalls) {
        const toolSpan = tracer.startSpan(traceId, {
          type: "tool_call",
          parentSpanId: span.id,
          input: { args: tool.input },
          toolName: tool.name,
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
  Object.assign(client.chat.completions, { create: wrappedCreate });

  return client;
}
