import { describe, it, expect } from "vitest";
import { buildTrace } from "../trace-builder.js";

const baseCapture = {
  provider: "anthropic" as const,
  model: "claude-sonnet-4-5-20251001",
  inputMessages: [{ role: "user", content: "Hello" }],
  outputContent: "Hello back!",
  inputTokens: 10,
  outputTokens: 5,
  durationMs: 250,
};

describe("buildTrace", () => {
  it("creates a trace with a valid UUID id", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("creates a trace with a valid UUID sessionId", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("generates unique trace IDs on each call", () => {
    const t1 = buildTrace(baseCapture);
    const t2 = buildTrace(baseCapture);
    expect(t1.id).not.toBe(t2.id);
  });

  it("creates exactly one llm_call span", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0].type).toBe("llm_call");
  });

  it("span has matching traceId", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.spans[0].traceId).toBe(trace.id);
  });

  it("sets correct token counts on trace and span", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.totalInputTokens).toBe(10);
    expect(trace.totalOutputTokens).toBe(5);
    expect(trace.spans[0].inputTokens).toBe(10);
    expect(trace.spans[0].outputTokens).toBe(5);
  });

  it("sets durationMs on trace and span", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.durationMs).toBe(250);
    expect(trace.spans[0].durationMs).toBe(250);
  });

  it("sets status 'success' when no error", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.status).toBe("success");
  });

  it("sets status 'error' and error field when error is provided", () => {
    const trace = buildTrace({ ...baseCapture, error: "HTTP 500: Internal Server Error" });
    expect(trace.status).toBe("error");
    expect(trace.spans[0].error).toBe("HTTP 500: Internal Server Error");
  });

  it("uses serviceName as agentName when provided", () => {
    const trace = buildTrace({ ...baseCapture, serviceName: "my-service" });
    expect(trace.agentName).toBe("my-service");
  });

  it("uses provider-proxy as agentName when no serviceName", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.agentName).toBe("anthropic-proxy");
  });

  it("uses openai-proxy agentName for openai provider", () => {
    const trace = buildTrace({ ...baseCapture, provider: "openai" });
    expect(trace.agentName).toBe("openai-proxy");
  });

  it("sets metadata with provider and proxied flag", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.metadata.provider).toBe("anthropic");
    expect(trace.metadata.proxied).toBe(true);
  });

  it("sets source exporterType to 'proxy'", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.source?.exporterType).toBe("proxy");
  });

  it("sets source serviceName from serviceName parameter", () => {
    const trace = buildTrace({ ...baseCapture, serviceName: "my-svc" });
    expect(trace.source?.serviceName).toBe("my-svc");
  });

  it("defaults source serviceName to 'lantern-proxy' when not provided", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.source?.serviceName).toBe("lantern-proxy");
  });

  it("sets output content and stopReason on span", () => {
    const trace = buildTrace({ ...baseCapture, outputContent: "42", stopReason: "end_turn" });
    expect(trace.spans[0].output?.content).toBe("42");
    expect(trace.spans[0].output?.stopReason).toBe("end_turn");
  });

  it("sets span model from capture", () => {
    const trace = buildTrace(baseCapture);
    expect(trace.spans[0].model).toBe("claude-sonnet-4-5-20251001");
  });

  it("computes startTime from now - durationMs", () => {
    const before = Date.now();
    const trace = buildTrace({ ...baseCapture, durationMs: 500 });
    const after = Date.now();
    const expectedStart = trace.endTime! - 500;
    expect(trace.startTime).toBeGreaterThanOrEqual(before - 500);
    expect(trace.startTime).toBeLessThanOrEqual(after);
    expect(trace.startTime).toBe(expectedStart);
  });

  it("sets span input messages from inputMessages", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Tell me a joke." },
    ];
    const trace = buildTrace({ ...baseCapture, inputMessages: messages });
    expect(trace.spans[0].input.messages).toEqual(messages);
  });
});
