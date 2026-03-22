import type { LanternTracer } from "@openlantern-ai/sdk";
import type { SpanOutput, SpanType } from "@openlantern-ai/sdk";

interface MastraSpanEvent {
  name?: string;
  spanId: string;
  parentSpanId?: string;
  attributes?: Record<string, unknown>;
}

function inferSpanType(name?: string): SpanType {
  if (name?.includes("llm") || name?.includes("generate")) return "llm_call";
  if (name?.includes("tool")) return "tool_call";
  return "custom";
}

export function createLanternMastraHook(
  tracer: LanternTracer,
  opts?: { agentName?: string },
) {
  const spanMap = new Map<string, { lanternSpanId: string; traceId: string }>();
  let activeTraceId: string | null = null;

  function ensureTrace(): string {
    if (!activeTraceId) {
      const trace = tracer.startTrace({ agentName: opts?.agentName ?? "mastra-agent", metadata: { provider: "mastra" } });
      activeTraceId = trace.id;
    }
    return activeTraceId;
  }

  return {
    onSpanStart(event: MastraSpanEvent) {
      const traceId = ensureTrace();
      const attrs = event.attributes ?? {};
      const model = String(attrs["gen_ai.request.model"] ?? attrs["model"] ?? "");
      const toolName = String(attrs["tool.name"] ?? "");
      const spanType = inferSpanType(event.name);

      const span = tracer.startSpan(traceId, {
        type: spanType,
        input: { prompt: String(attrs["gen_ai.prompt"] ?? event.name ?? "") },
        model: model || undefined,
        toolName: toolName || undefined,
      });
      spanMap.set(event.spanId, { lanternSpanId: span.id, traceId });
    },

    onSpanEnd(event: MastraSpanEvent) {
      const mapping = spanMap.get(event.spanId);
      if (!mapping) return;
      const attrs = event.attributes ?? {};
      const output: SpanOutput = { content: String(attrs["gen_ai.completion"] ?? "") };
      tracer.endSpan(mapping.lanternSpanId, output, {
        inputTokens: Number(attrs["gen_ai.usage.input_tokens"] ?? 0),
        outputTokens: Number(attrs["gen_ai.usage.output_tokens"] ?? 0),
      });
      spanMap.delete(event.spanId);
    },

    finish() {
      if (activeTraceId) {
        tracer.endTrace(activeTraceId, "success");
        activeTraceId = null;
      }
    },
  };
}
