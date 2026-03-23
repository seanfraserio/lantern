import { describe, it, expect } from "vitest";
import type {
  Trace,
  TraceStatus,
  Span,
  SpanType,
  SpanInput,
  SpanOutput,
  EvalScore,
  TracerConfig,
  ITraceExporter,
  StartTraceOpts,
  StartSpanOpts,
  TraceQueryFilter,
  TraceIngestRequest,
  TraceIngestResponse,
  SourceSummary,
} from "../types.js";

// Compile-time type checks — if these types don't exist or are wrong, tests won't compile.

describe("types", () => {
  it("Trace type has all required fields", () => {
    const trace: Trace = {
      id: "abc-123",
      sessionId: "def-456",
      agentName: "test-agent",
      environment: "dev",
      startTime: Date.now(),
      status: "running",
      spans: [],
      metadata: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
    };
    expect(trace.agentName).toBe("test-agent");
    expect(trace.status).toBe("running");
  });

  it("Trace accepts optional fields", () => {
    const trace: Trace = {
      id: "abc",
      sessionId: "def",
      agentName: "agent",
      environment: "prod",
      startTime: Date.now(),
      endTime: Date.now(),
      durationMs: 100,
      status: "success",
      spans: [],
      metadata: { key: "value" },
      totalInputTokens: 50,
      totalOutputTokens: 25,
      estimatedCostUsd: 0.001,
      agentVersion: "1.0.0",
      source: { serviceName: "svc", sdkVersion: "0.1.0", exporterType: "lantern" },
    };
    expect(trace.durationMs).toBe(100);
    expect(trace.source?.serviceName).toBe("svc");
  });

  it("Span type has all required fields", () => {
    const span: Span = {
      id: "span-id",
      traceId: "trace-id",
      type: "llm_call",
      startTime: Date.now(),
      input: {},
    };
    expect(span.type).toBe("llm_call");
  });

  it("TraceStatus values are exhaustive", () => {
    const statuses: TraceStatus[] = ["running", "success", "error"];
    expect(statuses).toHaveLength(3);
  });

  it("SpanType values are exhaustive", () => {
    const types: SpanType[] = ["llm_call", "tool_call", "reasoning_step", "retrieval", "custom"];
    expect(types).toHaveLength(5);
  });

  it("SpanInput accepts messages, prompt, and args", () => {
    const withMessages: SpanInput = {
      messages: [{ role: "user", content: "Hi" }],
    };
    const withPrompt: SpanInput = { prompt: "Hello" };
    const withArgs: SpanInput = { args: { key: "value" } };
    expect(withMessages.messages).toHaveLength(1);
    expect(withPrompt.prompt).toBe("Hello");
    expect(withArgs.args).toBeDefined();
  });

  it("SpanOutput accepts content, toolCalls, and stopReason", () => {
    const output: SpanOutput = {
      content: "response text",
      toolCalls: [{ name: "search", input: {} }],
      stopReason: "end_turn",
    };
    expect(output.content).toBe("response text");
    expect(output.stopReason).toBe("end_turn");
  });

  it("EvalScore has required scorer and score", () => {
    const score: EvalScore = {
      scorer: "toxicity",
      score: 0.95,
      label: "safe",
      detail: "No harmful content",
    };
    expect(score.scorer).toBe("toxicity");
  });

  it("TracerConfig requires exporter", () => {
    const mockExporter: ITraceExporter = {
      exporterType: "mock",
      export: async () => {},
      shutdown: async () => {},
    };
    const config: TracerConfig = { exporter: mockExporter };
    expect(config.exporter.exporterType).toBe("mock");
  });

  it("StartTraceOpts requires agentName", () => {
    const opts: StartTraceOpts = {
      agentName: "my-agent",
      agentVersion: "1.0",
      sessionId: "session-id",
      environment: "prod",
      metadata: { userId: "abc" },
    };
    expect(opts.agentName).toBe("my-agent");
  });

  it("StartSpanOpts requires type and input", () => {
    const opts: StartSpanOpts = {
      type: "llm_call",
      input: { prompt: "test" },
      model: "gpt-4o",
      parentSpanId: "parent",
      toolName: "calc",
    };
    expect(opts.type).toBe("llm_call");
  });

  it("TraceIngestRequest and Response types", () => {
    const req: TraceIngestRequest = { traces: [] };
    const res: TraceIngestResponse = { accepted: 0, errors: ["err"] };
    expect(req.traces).toEqual([]);
    expect(res.accepted).toBe(0);
  });

  it("SourceSummary type", () => {
    const summary: SourceSummary = {
      serviceName: "my-service",
      sdkVersion: "0.1.0",
      exporterType: "lantern",
      traceCount: 100,
      lastSeen: Date.now(),
      environments: ["prod", "dev"],
      agents: ["agent-a"],
    };
    expect(summary.serviceName).toBe("my-service");
  });

  it("TraceQueryFilter type", () => {
    const filter: TraceQueryFilter = {
      agentName: "agent-a",
      environment: "prod",
      status: "success",
      limit: 50,
      offset: 0,
    };
    expect(filter.limit).toBe(50);
  });
});
