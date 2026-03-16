import { describe, it, expect } from "vitest";
import { AgentSpan } from "../span.js";

describe("AgentSpan", () => {
  describe("construction", () => {
    it("creates a span with required fields", () => {
      const span = new AgentSpan("trace-id", "llm_call", { prompt: "Hello" });
      const s = span.toSpan();
      expect(s.traceId).toBe("trace-id");
      expect(s.type).toBe("llm_call");
      expect(s.input).toEqual({ prompt: "Hello" });
      expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(s.startTime).toBeGreaterThan(0);
    });

    it("sets optional parentSpanId, model, and toolName", () => {
      const span = new AgentSpan("trace-id", "tool_call", {}, {
        parentSpanId: "parent-id",
        model: "gpt-4o",
        toolName: "web_search",
      });
      const s = span.toSpan();
      expect(s.parentSpanId).toBe("parent-id");
      expect(s.model).toBe("gpt-4o");
      expect(s.toolName).toBe("web_search");
    });

    it("does not set optional fields when not provided", () => {
      const span = new AgentSpan("trace-id", "llm_call", {});
      const s = span.toSpan();
      expect(s.parentSpanId).toBeUndefined();
      expect(s.model).toBeUndefined();
      expect(s.toolName).toBeUndefined();
    });
  });

  describe("id and traceId getters", () => {
    it("exposes id as a UUID", () => {
      const span = new AgentSpan("my-trace-id", "reasoning_step", {});
      expect(span.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("exposes traceId correctly", () => {
      const span = new AgentSpan("my-trace-id", "reasoning_step", {});
      expect(span.traceId).toBe("my-trace-id");
    });
  });

  describe("end()", () => {
    it("sets output, endTime, and durationMs", () => {
      const span = new AgentSpan("trace-id", "llm_call", {});
      const completed = span.end({ content: "Hello world" });
      expect(completed.output).toEqual({ content: "Hello world" });
      expect(completed.endTime).toBeGreaterThan(0);
      expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("sets input and output token counts", () => {
      const span = new AgentSpan("trace-id", "llm_call", {});
      const completed = span.end({}, { inputTokens: 100, outputTokens: 50 });
      expect(completed.inputTokens).toBe(100);
      expect(completed.outputTokens).toBe(50);
    });

    it("sets error message", () => {
      const span = new AgentSpan("trace-id", "llm_call", {});
      const completed = span.end({}, { error: "API timeout" });
      expect(completed.error).toBe("API timeout");
    });

    it("estimates cost for gpt-4o", () => {
      const span = new AgentSpan("trace-id", "llm_call", {}, { model: "gpt-4o" });
      // gpt-4o: 0.005/1K in + 0.015/1K out
      // 1000 in + 500 out = 0.005 + 0.0075 = 0.0125
      const completed = span.end({}, { inputTokens: 1000, outputTokens: 500 });
      expect(completed.estimatedCostUsd).toBeCloseTo(0.0125, 5);
    });

    it("estimates cost for claude-sonnet", () => {
      const span = new AgentSpan("trace-id", "llm_call", {}, { model: "claude-sonnet-4-5-20251001" });
      // 0.003/1K in + 0.015/1K out
      // 1000 in + 1000 out = 0.003 + 0.015 = 0.018
      const completed = span.end({}, { inputTokens: 1000, outputTokens: 1000 });
      expect(completed.estimatedCostUsd).toBeCloseTo(0.018, 5);
    });

    it("estimates cost using fallback pricing for unknown model", () => {
      const span = new AgentSpan("trace-id", "llm_call", {}, { model: "unknown-model-xyz" });
      // Fallback: 0.001/1K in + 0.002/1K out
      // 1000 in + 1000 out = 0.001 + 0.002 = 0.003
      const completed = span.end({}, { inputTokens: 1000, outputTokens: 1000 });
      expect(completed.estimatedCostUsd).toBeCloseTo(0.003, 5);
    });

    it("does not estimate cost when model is not set", () => {
      const span = new AgentSpan("trace-id", "llm_call", {});
      const completed = span.end({}, { inputTokens: 100, outputTokens: 50 });
      expect(completed.estimatedCostUsd).toBeUndefined();
    });

    it("does not estimate cost when tokens are missing", () => {
      const span = new AgentSpan("trace-id", "llm_call", {}, { model: "gpt-4o" });
      const completed = span.end({});
      expect(completed.estimatedCostUsd).toBeUndefined();
    });

    it("returns the completed span", () => {
      const span = new AgentSpan("trace-id", "llm_call", {});
      const completed = span.end({ content: "done" });
      expect(completed.traceId).toBe("trace-id");
      expect(completed.id).toBe(span.id);
    });
  });

  describe("toSpan()", () => {
    it("returns a copy of the span", () => {
      const span = new AgentSpan("trace-id", "custom", { prompt: "test" });
      const copy1 = span.toSpan();
      const copy2 = span.toSpan();
      expect(copy1).not.toBe(copy2); // different references
      expect(copy1).toEqual(copy2);
    });
  });
});
