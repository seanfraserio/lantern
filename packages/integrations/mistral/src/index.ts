import type { LanternTracer } from "@openlantern-ai/sdk";
import type { SpanOutput } from "@openlantern-ai/sdk";

interface MistralMessage { role: string; content: string }
interface MistralChoice {
  message: { role: string; content: string | null; toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> };
  finishReason: string;
}
interface MistralUsage { promptTokens: number; completionTokens: number; totalTokens: number }
interface MistralResponse { id: string; choices: MistralChoice[]; model: string; usage: MistralUsage }
interface MistralParams { model: string; messages: MistralMessage[]; [key: string]: unknown }
interface MistralClient { chat: { complete(params: MistralParams): Promise<MistralResponse> } }

export function wrapMistralClient<T extends MistralClient>(
  client: T,
  tracer: LanternTracer,
  opts?: { traceId?: string; agentName?: string },
): T {
  const originalComplete = client.chat.complete.bind(client.chat);

  const wrappedComplete = async (params: MistralParams): Promise<MistralResponse> => {
    let traceId = opts?.traceId;
    let ownTrace = false;
    if (!traceId) {
      const trace = tracer.startTrace({ agentName: opts?.agentName ?? "mistral-agent", metadata: { provider: "mistral" } });
      traceId = trace.id;
      ownTrace = true;
    }

    const messages = params.messages.map((m) => ({ role: m.role, content: m.content ?? "" }));
    const span = tracer.startSpan(traceId, { type: "llm_call", input: { messages }, model: params.model });

    try {
      const response = await originalComplete(params);
      const firstChoice = response.choices[0];
      const textContent = firstChoice?.message?.content ?? "";
      const toolCalls = firstChoice?.message?.toolCalls?.map((tc) => ({ id: tc.id, name: tc.function.name, input: tc.function.arguments })) ?? [];

      const output: SpanOutput = { content: textContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, stopReason: firstChoice?.finishReason ?? undefined };
      tracer.endSpan(span.id, output, { inputTokens: response.usage.promptTokens, outputTokens: response.usage.completionTokens });

      for (const tool of toolCalls) {
        const toolSpan = tracer.startSpan(traceId, { type: "tool_call", parentSpanId: span.id, input: { args: tool.input }, toolName: tool.name });
        tracer.endSpan(toolSpan.id, { content: "Tool call initiated" });
      }

      if (ownTrace) tracer.endTrace(traceId, "success");
      return response;
    } catch (error) {
      tracer.endSpan(span.id, {}, { error: error instanceof Error ? error.message : String(error) });
      if (ownTrace) tracer.endTrace(traceId, "error");
      throw error;
    }
  };

  Object.assign(client.chat, { complete: wrappedComplete });
  return client;
}
