import type { LanternTracer } from "@lantern-ai/sdk";
import type { SpanOutput, SpanType } from "@lantern-ai/sdk";

interface AgentTraceData { traceId: string; name?: string; [key: string]: unknown }
interface AgentSpanData { spanId: string; traceId: string; type?: string; model?: string; input?: unknown; output?: unknown; usage?: { inputTokens?: number; outputTokens?: number }; toolName?: string; [key: string]: unknown }

function mapSpanType(agentType?: string): SpanType {
  switch (agentType) {
    case "generation": return "llm_call";
    case "tool": return "tool_call";
    case "handoff": return "reasoning_step";
    default: return "custom";
  }
}

export function createLanternTraceProcessor(
  tracer: LanternTracer,
  opts?: { agentName?: string },
) {
  const traceMap = new Map<string, string>(); // agents traceId -> lantern traceId
  const spanMap = new Map<string, string>();   // agents spanId -> lantern spanId

  return {
    onTraceStart(data: AgentTraceData) {
      const trace = tracer.startTrace({ agentName: opts?.agentName ?? data.name ?? "openai-agent", metadata: { provider: "openai-agents" } });
      traceMap.set(data.traceId, trace.id);
    },

    onSpanStart(data: AgentSpanData) {
      const lanternTraceId = traceMap.get(data.traceId);
      if (!lanternTraceId) return;
      const span = tracer.startSpan(lanternTraceId, {
        type: mapSpanType(data.type),
        input: { prompt: typeof data.input === "string" ? data.input : JSON.stringify(data.input ?? {}) },
        model: data.model,
        toolName: data.toolName,
      });
      spanMap.set(data.spanId, span.id);
    },

    onSpanEnd(data: AgentSpanData) {
      const lanternSpanId = spanMap.get(data.spanId);
      if (!lanternSpanId) return;
      const output: SpanOutput = { content: typeof data.output === "string" ? data.output : JSON.stringify(data.output ?? {}) };
      tracer.endSpan(lanternSpanId, output, { inputTokens: data.usage?.inputTokens ?? 0, outputTokens: data.usage?.outputTokens ?? 0 });
      spanMap.delete(data.spanId);
    },

    onTraceEnd(data: AgentTraceData) {
      const lanternTraceId = traceMap.get(data.traceId);
      if (lanternTraceId) {
        tracer.endTrace(lanternTraceId, "success");
        traceMap.delete(data.traceId);
      }
    },
  };
}
