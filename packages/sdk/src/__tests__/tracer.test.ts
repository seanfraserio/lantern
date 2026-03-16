import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "../tracer.js";
import type { ITraceExporter, Trace } from "../types.js";

function makeMockExporter(): ITraceExporter & { exported: Trace[][] } {
  const exported: Trace[][] = [];
  return {
    exporterType: "mock",
    exported,
    export: vi.fn(async (traces: Trace[]) => {
      exported.push([...traces]);
    }),
    shutdown: vi.fn(async () => {}),
  };
}

describe("LanternTracer", () => {
  let exporter: ReturnType<typeof makeMockExporter>;
  let tracer: LanternTracer;

  beforeEach(() => {
    exporter = makeMockExporter();
    tracer = new LanternTracer({
      exporter,
      serviceName: "test-service",
      environment: "test",
      flushIntervalMs: 100_000,
      batchSize: 50,
    });
  });

  afterEach(async () => {
    await tracer.shutdown();
  });

  describe("startTrace", () => {
    it("creates a trace with required fields", () => {
      const trace = tracer.startTrace({ agentName: "test-agent" });
      expect(trace.agentName).toBe("test-agent");
      expect(trace.status).toBe("running");
      expect(trace.spans).toEqual([]);
      expect(trace.totalInputTokens).toBe(0);
      expect(trace.totalOutputTokens).toBe(0);
      expect(trace.estimatedCostUsd).toBe(0);
      expect(trace.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("uses provided sessionId", () => {
      const sessionId = "11111111-1111-1111-1111-111111111111";
      const trace = tracer.startTrace({ agentName: "agent", sessionId });
      expect(trace.sessionId).toBe(sessionId);
    });

    it("generates sessionId if not provided", () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      expect(trace.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("uses tracer environment by default", () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      expect(trace.environment).toBe("test");
    });

    it("uses override environment when provided", () => {
      const trace = tracer.startTrace({ agentName: "agent", environment: "prod" });
      expect(trace.environment).toBe("prod");
    });

    it("includes source with serviceName and sdkVersion", () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      expect(trace.source?.serviceName).toBe("test-service");
      expect(trace.source?.sdkVersion).toBe("0.1.0");
      expect(trace.source?.exporterType).toBe("mock");
    });
  });

  describe("startSpan", () => {
    it("creates a span within a trace", () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      const span = tracer.startSpan(trace.id, {
        type: "llm_call",
        input: { prompt: "Hello" },
        model: "gpt-4o",
      });
      expect(span.traceId).toBe(trace.id);
      expect(span.type).toBe("llm_call");
      expect(span.model).toBe("gpt-4o");
    });

    it("throws if trace not found", () => {
      expect(() =>
        tracer.startSpan("nonexistent-id", { type: "llm_call", input: {} })
      ).toThrow("not found");
    });

    it("creates a tool_call span with toolName", () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      const span = tracer.startSpan(trace.id, {
        type: "tool_call",
        input: { args: { query: "test" } },
        toolName: "web_search",
      });
      expect(span.type).toBe("tool_call");
      expect(span.toolName).toBe("web_search");
    });
  });

  describe("endSpan", () => {
    it("throws if span not found", () => {
      expect(() =>
        tracer.endSpan("nonexistent-span-id", { content: "output" })
      ).toThrow("not found");
    });

    it("moves completed span to trace and aggregates tokens", () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      const span = tracer.startSpan(trace.id, {
        type: "llm_call",
        input: { prompt: "Hello" },
        model: "gpt-4o",
      });
      tracer.endSpan(span.id, { content: "World" }, {
        inputTokens: 100,
        outputTokens: 50,
      });

      const updatedTrace = tracer.getTrace(trace.id);
      expect(updatedTrace?.spans).toHaveLength(1);
      expect(updatedTrace?.totalInputTokens).toBe(100);
      expect(updatedTrace?.totalOutputTokens).toBe(50);
    });

    it("removes span from activeSpans after ending", () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      const span = tracer.startSpan(trace.id, { type: "llm_call", input: {} });
      tracer.endSpan(span.id, {});
      // Attempting to end the same span again should throw
      expect(() => tracer.endSpan(span.id, {})).toThrow("not found");
    });
  });

  describe("endTrace", () => {
    it("removes trace from active traces", () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      tracer.endTrace(trace.id, "success");
      expect(tracer.getTrace(trace.id)).toBeUndefined();
    });

    it("throws if trace not found", () => {
      expect(() => tracer.endTrace("nonexistent-id")).toThrow("not found");
    });

    it("defaults to success status", async () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      tracer.endTrace(trace.id);
      await tracer.flush();
      expect(exporter.exported[0][0].status).toBe("success");
    });

    it("accepts error status", async () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      tracer.endTrace(trace.id, "error");
      await tracer.flush();
      expect(exporter.exported[0][0].status).toBe("error");
    });
  });

  describe("flush", () => {
    it("exports buffered traces and clears buffer", async () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      tracer.endTrace(trace.id, "success");
      await tracer.flush();

      expect(exporter.export).toHaveBeenCalledTimes(1);
      expect(exporter.exported[0]).toHaveLength(1);
      expect(exporter.exported[0][0].agentName).toBe("agent");
    });

    it("does nothing if buffer is empty", async () => {
      await tracer.flush();
      expect(exporter.export).not.toHaveBeenCalled();
    });

    it("restores buffer on export failure and re-throws", async () => {
      const failingExporter: ITraceExporter = {
        exporterType: "failing",
        export: vi.fn(async () => { throw new Error("Export failed"); }),
        shutdown: vi.fn(async () => {}),
      };
      const failTracer = new LanternTracer({
        exporter: failingExporter,
        flushIntervalMs: 100_000,
      });
      const trace = failTracer.startTrace({ agentName: "agent" });
      failTracer.endTrace(trace.id, "success");

      await expect(failTracer.flush()).rejects.toThrow("Export failed");
      // Buffer restored — can attempt again
      await expect(failTracer.flush()).rejects.toThrow("Export failed");
      await failTracer.shutdown().catch(() => {});
    });

    it("auto-flushes when batch size is reached", async () => {
      const smallBatchTracer = new LanternTracer({
        exporter,
        batchSize: 2,
        flushIntervalMs: 100_000,
      });

      const t1 = smallBatchTracer.startTrace({ agentName: "a1" });
      smallBatchTracer.endTrace(t1.id, "success");
      const t2 = smallBatchTracer.startTrace({ agentName: "a2" });
      smallBatchTracer.endTrace(t2.id, "success");

      // Give auto-flush microtask time to run
      await new Promise((r) => setTimeout(r, 20));
      expect(exporter.export).toHaveBeenCalled();
      await smallBatchTracer.shutdown();
    });
  });

  describe("token aggregation and cost estimation", () => {
    it("aggregates tokens and cost across multiple spans", async () => {
      const trace = tracer.startTrace({ agentName: "agent" });

      const span1 = tracer.startSpan(trace.id, { type: "llm_call", input: {}, model: "gpt-4o" });
      tracer.endSpan(span1.id, {}, { inputTokens: 200, outputTokens: 100 });

      const span2 = tracer.startSpan(trace.id, { type: "llm_call", input: {}, model: "gpt-4o" });
      tracer.endSpan(span2.id, {}, { inputTokens: 50, outputTokens: 25 });

      tracer.endTrace(trace.id, "success");
      await tracer.flush();

      const exported = exporter.exported[0][0];
      expect(exported.totalInputTokens).toBe(250);
      expect(exported.totalOutputTokens).toBe(125);
      expect(exported.estimatedCostUsd).toBeGreaterThan(0);
    });
  });

  describe("getTrace", () => {
    it("returns active trace by ID", () => {
      const trace = tracer.startTrace({ agentName: "agent" });
      expect(tracer.getTrace(trace.id)).toBeDefined();
    });

    it("returns undefined for unknown ID", () => {
      expect(tracer.getTrace("unknown-id")).toBeUndefined();
    });
  });
});
