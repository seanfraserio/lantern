/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConsoleExporter } from "../../exporters/console.js";
import type { Trace, Span } from "../../types.js";

function makeTrace(overrides?: Partial<Trace>): Trace {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    agentName: "test-agent",
    environment: "test",
    startTime: Date.now() - 500,
    endTime: Date.now(),
    durationMs: 500,
    status: "success",
    spans: [],
    metadata: {},
    totalInputTokens: 100,
    totalOutputTokens: 50,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

describe("ConsoleExporter", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleSpy: any;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("has exporterType of 'console'", () => {
    const exporter = new ConsoleExporter();
    expect(exporter.exporterType).toBe("console");
  });

  it("logs trace ID, agentName, and status", async () => {
    const exporter = new ConsoleExporter();
    const trace = makeTrace();
    await exporter.export([trace]);

    const logOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logOutput).toContain(trace.id);
    expect(logOutput).toContain("test-agent");
    expect(logOutput).toContain("success");
  });

  it("logs duration and token counts", async () => {
    const exporter = new ConsoleExporter();
    const trace = makeTrace({ durationMs: 1234, totalInputTokens: 200, totalOutputTokens: 100 });
    await exporter.export([trace]);

    const logOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logOutput).toContain("1234");
    expect(logOutput).toContain("200");
    expect(logOutput).toContain("100");
  });

  it("does not log span details in non-verbose mode", async () => {
    const exporter = new ConsoleExporter({ verbose: false });
    const span: Span = {
      id: crypto.randomUUID(),
      traceId: "trace-id",
      type: "llm_call",
      startTime: Date.now() - 100,
      endTime: Date.now(),
      durationMs: 100,
      input: {},
      model: "gpt-4o",
    };
    const trace = makeTrace({ spans: [span] });
    await exporter.export([trace]);

    const logOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logOutput).not.toContain("Model: gpt-4o");
  });

  it("logs span details in verbose mode", async () => {
    const exporter = new ConsoleExporter({ verbose: true });
    const span: Span = {
      id: crypto.randomUUID(),
      traceId: "trace-id",
      type: "llm_call",
      startTime: Date.now() - 100,
      endTime: Date.now(),
      durationMs: 100,
      input: {},
      model: "gpt-4o",
    };
    const trace = makeTrace({ spans: [span] });
    await exporter.export([trace]);

    const logOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logOutput).toContain("Model: gpt-4o");
    expect(logOutput).toContain("llm_call");
  });

  it("logs tool name in verbose mode", async () => {
    const exporter = new ConsoleExporter({ verbose: true });
    const span: Span = {
      id: crypto.randomUUID(),
      traceId: "trace-id",
      type: "tool_call",
      startTime: Date.now(),
      input: {},
      toolName: "web_search",
    };
    const trace = makeTrace({ spans: [span] });
    await exporter.export([trace]);

    const logOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logOutput).toContain("Tool: web_search");
  });

  it("logs error in verbose mode", async () => {
    const exporter = new ConsoleExporter({ verbose: true });
    const span: Span = {
      id: crypto.randomUUID(),
      traceId: "trace-id",
      type: "llm_call",
      startTime: Date.now(),
      input: {},
      error: "Rate limit exceeded",
    };
    const trace = makeTrace({ spans: [span] });
    await exporter.export([trace]);

    const logOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logOutput).toContain("Rate limit exceeded");
  });

  it("logs multiple traces", async () => {
    const exporter = new ConsoleExporter();
    const traces = [
      makeTrace({ agentName: "agent-a" }),
      makeTrace({ agentName: "agent-b" }),
    ];
    await exporter.export(traces);

    const logOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logOutput).toContain("agent-a");
    expect(logOutput).toContain("agent-b");
  });

  it("shutdown resolves without error", async () => {
    const exporter = new ConsoleExporter();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });
});
