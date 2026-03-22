import type { LanternTracer } from "@openlantern-ai/sdk";
import type { SpanOutput } from "@openlantern-ai/sdk";

interface BedrockClient {
  send(command: unknown): Promise<unknown>;
}

export function wrapBedrockClient<T extends BedrockClient>(
  client: T,
  tracer: LanternTracer,
  opts?: { traceId?: string; agentName?: string },
): T {
  const originalSend = client.send.bind(client);

  const wrappedSend = async (command: unknown): Promise<unknown> => {
    const cmd = command as Record<string, unknown>;
    const cmdName = (cmd.constructor as { name?: string })?.name ?? "";
    const input = cmd.input as Record<string, unknown> | undefined;

    // Only trace Converse* and InvokeModel* commands
    const isConverse = cmdName.startsWith("Converse");
    const isInvoke = cmdName.startsWith("InvokeModel");
    if (!isConverse && !isInvoke) return originalSend(command);

    let traceId = opts?.traceId;
    let ownTrace = false;
    if (!traceId) {
      const trace = tracer.startTrace({ agentName: opts?.agentName ?? "bedrock-agent", metadata: { provider: "bedrock" } });
      traceId = trace.id;
      ownTrace = true;
    }

    const modelId = String(input?.modelId ?? "unknown");
    const messages = (input?.messages as Array<{ role: string; content: Array<{ text?: string }> }>) ?? [];
    const normalizedMsgs = messages.map(m => ({
      role: m.role,
      content: (m.content ?? []).map(c => c.text ?? "").join(""),
    }));

    const span = tracer.startSpan(traceId, { type: "llm_call", input: { messages: normalizedMsgs }, model: modelId });

    try {
      const response = await originalSend(command);
      const res = response as Record<string, unknown>;

      // Extract tokens — Converse responses have usage at top level
      const usage = res.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      const outputMsg = res.output as { message?: { content?: Array<{ text?: string }> } } | undefined;
      const content = outputMsg?.message?.content?.map(c => c.text ?? "").join("") ?? "";

      const output: SpanOutput = { content, stopReason: String(res.stopReason ?? "") };
      tracer.endSpan(span.id, output, { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 });
      if (ownTrace) tracer.endTrace(traceId, "success");
      return response;
    } catch (error) {
      tracer.endSpan(span.id, {}, { error: error instanceof Error ? error.message : String(error) });
      if (ownTrace) tracer.endTrace(traceId, "error");
      throw error;
    }
  };
  Object.assign(client, { send: wrappedSend });

  return client;
}
