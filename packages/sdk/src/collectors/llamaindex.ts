import type { LanternTracer } from "../tracer.js";
import type { SpanType } from "../types.js";

/**
 * Shape of a LlamaIndex callback handler.
 * We use a structural type so we don't need the actual LlamaIndex SDK as a dependency.
 */
interface LlamaIndexCallbackHandler {
  onEvent(eventType: string, payload: Record<string, unknown>): void;
}

/**
 * Mapping from LlamaIndex event types to Lantern span types.
 */
const EVENT_SPAN_TYPE: Record<string, SpanType> = {
  llm_start: "llm_call",
  retrieval_start: "retrieval",
  query_start: "custom",
  embedding_start: "custom",
};

/**
 * Create a LlamaIndex-compatible event handler that traces events as Lantern spans.
 *
 * Usage:
 * ```typescript
 * import { LanternTracer, createLanternEventHandler } from "@lantern-ai/sdk";
 *
 * const handler = createLanternEventHandler(tracer, { agentName: "rag-agent" });
 * // Pass handler to LlamaIndex Settings.callbackManager
 * ```
 */
export function createLanternEventHandler(
  tracer: LanternTracer,
  opts?: { traceId?: string; agentName?: string }
): LlamaIndexCallbackHandler {
  // Track active spans: eventId → spanId
  const activeSpans = new Map<string, string>();
  let counter = 0;

  function getEventId(payload: Record<string, unknown>): string {
    if (typeof payload.id === "string") return payload.id;
    if (typeof payload.eventId === "string") return payload.eventId;
    return String(++counter);
  }

  function getBaseEventType(eventType: string): string {
    return eventType.replace(/_start$|_end$/, "");
  }

  function extractModel(payload: Record<string, unknown>): string | undefined {
    if (typeof payload.model === "string") return payload.model;
    const serialized = payload.serialized as Record<string, unknown> | undefined;
    if (serialized && typeof serialized.model === "string") return serialized.model;
    return undefined;
  }

  function extractTokens(payload: Record<string, unknown>): {
    inputTokens?: number;
    outputTokens?: number;
  } {
    const response = payload.response as Record<string, unknown> | undefined;
    const raw = response?.raw as Record<string, unknown> | undefined;
    const usage = raw?.usage as Record<string, unknown> | undefined;
    if (!usage) return {};

    return {
      inputTokens: typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : typeof usage.input_tokens === "number"
          ? usage.input_tokens
          : undefined,
      outputTokens: typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : undefined,
    };
  }

  return {
    onEvent(eventType: string, payload: Record<string, unknown>): void {
      const isStart = eventType.endsWith("_start");
      const isEnd = eventType.endsWith("_end");
      if (!isStart && !isEnd) return;

      // Resolve or create a trace
      let traceId = opts?.traceId;
      if (!traceId) {
        // Look for an existing trace from a prior start event, or create one
        const existingTraceId = activeSpans.size > 0
          ? undefined // will create a new one below
          : undefined;
        void existingTraceId;

        const trace = tracer.startTrace({
          agentName: opts?.agentName ?? "llamaindex-agent",
        });
        traceId = trace.id;
        // Persist it so subsequent events reuse this trace
        (opts as { traceId?: string } | undefined) &&
          ((opts as { traceId?: string }).traceId = traceId);
      }

      const eventId = getEventId(payload);

      if (isStart) {
        const spanType = EVENT_SPAN_TYPE[eventType] ?? "custom";
        const model = extractModel(payload);

        const input = eventType === "llm_start"
          ? { messages: Array.isArray(payload.messages)
              ? (payload.messages as Array<{ role: string; content: string }>)
              : undefined }
          : eventType === "retrieval_start"
            ? { prompt: typeof payload.query === "string" ? payload.query : undefined }
            : { prompt: typeof payload.query === "string" ? payload.query : undefined };

        const span = tracer.startSpan(traceId, {
          type: spanType,
          input,
          model,
        });

        // Map the base event type + eventId so the matching _end can find it
        activeSpans.set(`${getBaseEventType(eventType)}:${eventId}`, span.id);
      } else {
        // _end event — find and close the matching span
        const key = `${getBaseEventType(eventType)}:${eventId}`;
        const spanId = activeSpans.get(key);
        if (!spanId) return; // no matching start — ignore gracefully

        activeSpans.delete(key);

        const tokens = extractTokens(payload);

        const responseContent = typeof payload.response === "string"
          ? payload.response
          : typeof (payload.response as Record<string, unknown> | undefined)?.text === "string"
            ? (payload.response as Record<string, unknown>).text as string
            : typeof payload.response === "object" && payload.response !== null
              ? JSON.stringify(payload.response)
              : undefined;

        // For retrieval_end, capture node count
        const nodes = payload.nodes as unknown[] | undefined;
        const retrievalInfo = Array.isArray(nodes)
          ? `Retrieved ${nodes.length} nodes`
          : undefined;

        tracer.endSpan(
          spanId,
          { content: responseContent ?? retrievalInfo },
          {
            ...tokens,
          }
        );
      }
    },
  };
}
