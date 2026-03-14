import { randomUUID } from "node:crypto";
import type { Span, SpanType, SpanInput, SpanOutput } from "./types.js";

/**
 * Builder for creating and managing spans.
 */
export class AgentSpan {
  private span: Span;

  constructor(
    traceId: string,
    type: SpanType,
    input: SpanInput,
    opts?: { parentSpanId?: string; model?: string; toolName?: string }
  ) {
    this.span = {
      id: randomUUID(),
      traceId,
      parentSpanId: opts?.parentSpanId,
      type,
      startTime: Date.now(),
      input,
      model: opts?.model,
      toolName: opts?.toolName,
    };
  }

  get id(): string {
    return this.span.id;
  }

  get traceId(): string {
    return this.span.traceId;
  }

  end(output: SpanOutput, opts?: { inputTokens?: number; outputTokens?: number; error?: string }): Span {
    this.span.endTime = Date.now();
    this.span.durationMs = this.span.endTime - this.span.startTime;
    this.span.output = output;
    if (opts?.inputTokens !== undefined) this.span.inputTokens = opts.inputTokens;
    if (opts?.outputTokens !== undefined) this.span.outputTokens = opts.outputTokens;
    if (opts?.error) this.span.error = opts.error;
    if (this.span.inputTokens && this.span.outputTokens && this.span.model) {
      this.span.estimatedCostUsd = estimateCost(
        this.span.model,
        this.span.inputTokens,
        this.span.outputTokens
      );
    }
    return this.span;
  }

  toSpan(): Span {
    return { ...this.span };
  }
}

/**
 * Rough cost estimation based on model name.
 * Prices in USD per 1K tokens.
 */
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing: Record<string, { input: number; output: number }> = {
    "claude-sonnet-4-5-20251001": { input: 0.003, output: 0.015 },
    "claude-haiku-4-5-20251001": { input: 0.0008, output: 0.004 },
    "claude-opus-4-5-20251001": { input: 0.015, output: 0.075 },
    "gpt-4o": { input: 0.005, output: 0.015 },
    "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  };

  // Default pricing if model not found
  const prices = pricing[model] ?? { input: 0.001, output: 0.002 };

  return (
    (inputTokens / 1000) * prices.input +
    (outputTokens / 1000) * prices.output
  );
}
