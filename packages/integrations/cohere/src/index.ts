import type { LanternTracer } from "@lantern-ai/sdk";
import type { SpanOutput } from "@lantern-ai/sdk";

interface CohereChatResponse { text: string; meta?: { billedUnits?: { inputTokens?: number; outputTokens?: number } }; finish_reason?: string }
interface CohereGenerateResponse { generations: Array<{ text: string }>; meta?: { billedUnits?: { inputTokens?: number; outputTokens?: number } } }

interface CohereClient {
  chat(params: Record<string, unknown>): Promise<CohereChatResponse>;
  generate(params: Record<string, unknown>): Promise<CohereGenerateResponse>;
}

export function wrapCohereClient<T extends CohereClient>(
  client: T,
  tracer: LanternTracer,
  opts?: { traceId?: string; agentName?: string },
): T {
  // Wrap chat()
  const originalChat = client.chat.bind(client);
  const wrappedChat = async (params: Record<string, unknown>): Promise<CohereChatResponse> => {
    let traceId = opts?.traceId;
    let ownTrace = false;
    if (!traceId) {
      const trace = tracer.startTrace({ agentName: opts?.agentName ?? "cohere-agent", metadata: { provider: "cohere" } });
      traceId = trace.id;
      ownTrace = true;
    }
    const span = tracer.startSpan(traceId, { type: "llm_call", input: { messages: [{ role: "user", content: String(params.message ?? "") }] }, model: String(params.model ?? "command-r") });
    try {
      const response = await originalChat(params);
      const output: SpanOutput = { content: response.text, stopReason: response.finish_reason ?? undefined };
      tracer.endSpan(span.id, output, { inputTokens: response.meta?.billedUnits?.inputTokens ?? 0, outputTokens: response.meta?.billedUnits?.outputTokens ?? 0 });
      if (ownTrace) tracer.endTrace(traceId, "success");
      return response;
    } catch (error) {
      tracer.endSpan(span.id, {}, { error: error instanceof Error ? error.message : String(error) });
      if (ownTrace) tracer.endTrace(traceId, "error");
      throw error;
    }
  };
  Object.assign(client, { chat: wrappedChat });

  // Wrap generate()
  const originalGenerate = client.generate.bind(client);
  const wrappedGenerate = async (params: Record<string, unknown>): Promise<CohereGenerateResponse> => {
    let traceId = opts?.traceId;
    let ownTrace = false;
    if (!traceId) {
      const trace = tracer.startTrace({ agentName: opts?.agentName ?? "cohere-agent", metadata: { provider: "cohere" } });
      traceId = trace.id;
      ownTrace = true;
    }
    const span = tracer.startSpan(traceId, { type: "llm_call", input: { prompt: String(params.prompt ?? "") }, model: String(params.model ?? "command-r") });
    try {
      const response = await originalGenerate(params);
      const output: SpanOutput = { content: response.generations?.[0]?.text ?? "" };
      tracer.endSpan(span.id, output, { inputTokens: response.meta?.billedUnits?.inputTokens ?? 0, outputTokens: response.meta?.billedUnits?.outputTokens ?? 0 });
      if (ownTrace) tracer.endTrace(traceId, "success");
      return response;
    } catch (error) {
      tracer.endSpan(span.id, {}, { error: error instanceof Error ? error.message : String(error) });
      if (ownTrace) tracer.endTrace(traceId, "error");
      throw error;
    }
  };
  Object.assign(client, { generate: wrappedGenerate });

  return client;
}
