import type { LanternTracer } from "../tracer.js";
import type { SpanOutput } from "../types.js";

/**
 * Structural types matching the OpenAI SDK response format.
 * Used by all OpenAI-compatible providers (Groq, Together, DeepSeek, etc.)
 */
interface OpenAICompatResponse {
  id: string;
  choices: Array<{
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
  }>;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OpenAICompatParams {
  model: string;
  messages: Array<{ role: string; content: string | null }>;
  [key: string]: unknown;
}

interface OpenAICompatClient {
  chat: {
    completions: {
      create(params: OpenAICompatParams): Promise<OpenAICompatResponse>;
    };
  };
}

/**
 * Wrap any OpenAI-compatible client to trace chat.completions.create() calls.
 * Works with Groq, Together AI, Fireworks, DeepSeek, Perplexity, Ollama,
 * OpenRouter, xAI, Cerebras, Novita, and any other provider using the
 * OpenAI API format.
 *
 * @param client - OpenAI SDK instance (any baseURL)
 * @param tracer - LanternTracer instance
 * @param opts.provider - Provider label (e.g., "groq") — stored in trace metadata
 */
export function wrapOpenAICompatClient<T extends OpenAICompatClient>(
  client: T,
  tracer: LanternTracer,
  opts: { provider: string; traceId?: string; agentName?: string },
): T {
  const originalCreate = client.chat.completions.create.bind(client.chat.completions);

  const wrappedCreate = async (params: OpenAICompatParams): Promise<OpenAICompatResponse> => {
    let traceId = opts.traceId;
    let ownTrace = false;
    if (!traceId) {
      const trace = tracer.startTrace({
        agentName: opts.agentName ?? `${opts.provider}-agent`,
        metadata: { provider: opts.provider },
      });
      traceId = trace.id;
      ownTrace = true;
    }

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

      const firstChoice = response.choices[0];
      const textContent = firstChoice?.message?.content ?? "";
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

      for (const tool of toolCalls) {
        const toolSpan = tracer.startSpan(traceId, {
          type: "tool_call",
          parentSpanId: span.id,
          input: { args: tool.input },
          toolName: tool.name,
        });
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

  Object.assign(client.chat.completions, { create: wrappedCreate });
  return client;
}
