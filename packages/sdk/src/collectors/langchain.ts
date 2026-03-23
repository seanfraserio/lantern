import type { LanternTracer } from "../tracer.js";
import type { SpanType, SpanOutput } from "../types.js";

/**
 * Structural interface for LangChain callback handlers.
 * We don't import LangChain — this lets any compatible object work.
 */
export interface LangChainCallbackHandler {
  handleLLMStart?(serialized: any, prompts: string[], ...args: any[]): Promise<void>;
  handleLLMEnd?(output: any, ...args: any[]): Promise<void>;
  handleLLMError?(error: Error, ...args: any[]): Promise<void>;
  handleToolStart?(tool: any, input: string, ...args: any[]): Promise<void>;
  handleToolEnd?(output: string, ...args: any[]): Promise<void>;
  handleToolError?(error: Error, ...args: any[]): Promise<void>;
  handleChainStart?(serialized: any, inputs: any, ...args: any[]): Promise<void>;
  handleChainEnd?(outputs: any, ...args: any[]): Promise<void>;
  handleChainError?(error: Error, ...args: any[]): Promise<void>;
  handleRetrieverStart?(retriever: any, query: string, ...args: any[]): Promise<void>;
  handleRetrieverEnd?(documents: any[], ...args: any[]): Promise<void>;
}

/**
 * Create a LangChain callback handler that automatically traces LLM calls,
 * tool invocations, chain executions, and retriever queries as Lantern spans.
 *
 * Usage:
 * ```typescript
 * import { ChatOpenAI } from "@langchain/openai";
 * import { LanternTracer, createLanternCallbackHandler } from "@openlantern-ai/sdk";
 *
 * const handler = createLanternCallbackHandler(tracer);
 * const model = new ChatOpenAI({ callbacks: [handler] });
 * ```
 */
export function createLanternCallbackHandler(
  tracer: LanternTracer,
  opts?: { traceId?: string; agentName?: string }
): LangChainCallbackHandler {
  // Map runId → spanId for tracking active spans
  const activeSpans = new Map<string, string>();

  // Map runId → spanId history (persists after span ends, for parent lookups)
  const spanHistory = new Map<string, string>();

  // Map runId → parentRunId for building span hierarchy
  const parentRuns = new Map<string, string>();

  let traceId = opts?.traceId;
  let ownTrace = false;

  function ensureTrace(): string {
    if (!traceId) {
      const trace = tracer.startTrace({
        agentName: opts?.agentName ?? "langchain-agent",
      });
      traceId = trace.id;
      ownTrace = true;
    }
    return traceId;
  }

  function startSpan(
    runId: string,
    type: SpanType,
    input: Record<string, unknown>,
    extra?: { parentRunId?: string; model?: string; toolName?: string }
  ): void {
    const tid = ensureTrace();

    // Resolve parent span from parentRunId (check history too, span may have ended)
    let parentSpanId: string | undefined;
    if (extra?.parentRunId) {
      parentSpanId = activeSpans.get(extra.parentRunId) ?? spanHistory.get(extra.parentRunId);
      parentRuns.set(runId, extra.parentRunId);
    }

    const span = tracer.startSpan(tid, {
      type,
      input,
      parentSpanId,
      model: extra?.model,
      toolName: extra?.toolName,
    });

    activeSpans.set(runId, span.id);
    spanHistory.set(runId, span.id);
  }

  function endSpan(
    runId: string,
    output: SpanOutput,
    tokenOpts?: { inputTokens?: number; outputTokens?: number; error?: string }
  ): void {
    const spanId = activeSpans.get(runId);
    if (!spanId) return;

    tracer.endSpan(spanId, output, tokenOpts);
    activeSpans.delete(runId);
    parentRuns.delete(runId);

    // End the trace if we own it and no more active spans
    if (ownTrace && activeSpans.size === 0 && traceId) {
      const hasError = tokenOpts?.error !== undefined;
      tracer.endTrace(traceId, hasError ? "error" : "success");
      traceId = undefined;
      ownTrace = false;
    }
  }

  return {
    async handleLLMStart(serialized, prompts, runId, parentRunId) {
      const model = serialized?.kwargs?.model_name ?? serialized?.id?.at(-1);
      startSpan(
        runId,
        "llm_call",
        { prompt: prompts.join("\n") },
        { parentRunId, model }
      );
    },

    async handleLLMEnd(output, runId) {
      const text = output?.generations
        ?.flat()
        ?.map((g: any) => g.text)
        ?.join("") ?? "";

      const tokenUsage = output?.llmOutput?.tokenUsage;

      endSpan(
        runId,
        { content: text },
        {
          inputTokens: tokenUsage?.promptTokens,
          outputTokens: tokenUsage?.completionTokens,
        }
      );
    },

    async handleLLMError(error, runId) {
      endSpan(
        runId,
        {},
        { error: error.message }
      );
    },

    async handleToolStart(tool, input, runId, parentRunId) {
      const toolName = tool?.name ?? tool?.id?.at(-1) ?? "unknown_tool";
      startSpan(
        runId,
        "tool_call",
        { args: input },
        { parentRunId, toolName }
      );
    },

    async handleToolEnd(output, runId) {
      endSpan(runId, { content: output });
    },

    async handleToolError(error, runId) {
      endSpan(
        runId,
        {},
        { error: error.message }
      );
    },

    async handleChainStart(serialized, inputs, runId, parentRunId) {
      startSpan(
        runId,
        "custom",
        { args: inputs },
        { parentRunId }
      );
    },

    async handleChainEnd(outputs, runId) {
      const content = typeof outputs === "string"
        ? outputs
        : JSON.stringify(outputs);
      endSpan(runId, { content });
    },

    async handleChainError(error, runId) {
      endSpan(
        runId,
        {},
        { error: error.message }
      );
    },

    async handleRetrieverStart(retriever, query, runId, parentRunId) {
      startSpan(
        runId,
        "retrieval",
        { prompt: query },
        { parentRunId }
      );
    },

    async handleRetrieverEnd(documents, runId) {
      endSpan(runId, {
        content: `Retrieved ${documents.length} document(s)`,
      });
    },
  };
}
