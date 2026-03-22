import type { Trace, Span } from "@lantern-ai/sdk";

/**
 * Build a minimal valid Trace, with sensible defaults that can be overridden.
 */
export function makeTrace(overrides?: Partial<Trace>): Trace {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    agentName: "test-agent",
    environment: "test",
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    durationMs: 1000,
    status: "success",
    spans: [],
    metadata: {},
    totalInputTokens: 100,
    totalOutputTokens: 50,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

/**
 * Build a minimal valid Span with type defaults.
 */
export function makeSpan(overrides?: Partial<Span>): Span {
  return {
    id: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    type: "llm_call",
    startTime: Date.now() - 500,
    endTime: Date.now(),
    durationMs: 500,
    input: {},
    ...overrides,
  };
}

/**
 * Build a trace with a single LLM call span that has user input and assistant output.
 */
export function makeLlmTrace(
  userMessage: string,
  assistantOutput: string,
  traceOverrides?: Partial<Trace>,
  spanOverrides?: Partial<Span>,
): Trace {
  const span = makeSpan({
    type: "llm_call",
    input: {
      messages: [{ role: "user", content: userMessage }],
    },
    output: {
      content: assistantOutput,
    },
    ...spanOverrides,
  });
  return makeTrace({
    spans: [span],
    ...traceOverrides,
  });
}
