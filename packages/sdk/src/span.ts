import { randomUUID } from "node:crypto";
import type { Span, SpanType, SpanInput, SpanOutput } from "./types.js";
import { getPricing } from "./collectors/_utils.js";

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
    if (opts?.error !== undefined) this.span.error = opts.error;
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

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const prices = getPricing(model);
  return (
    (inputTokens / 1000) * prices.input +
    (outputTokens / 1000) * prices.output
  );
}
