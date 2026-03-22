import { describe, it, expect } from "vitest";
import { normalizeTokens, getPricing, normalizeMessages, wrapWithTrace } from "../_utils.js";
import { LanternTracer } from "../../tracer.js";
import type { Trace } from "../../types.js";
import { vi } from "vitest";

function makeMockExporter() {
  const exported: Trace[][] = [];
  return {
    exporterType: "mock" as const,
    exported,
    export: vi.fn(async (traces: Trace[]) => { exported.push([...traces]); }),
    shutdown: vi.fn(async () => {}),
  };
}

describe("normalizeTokens", () => {
  it("normalizes OpenAI token fields", () => {
    const result = normalizeTokens({ prompt_tokens: 10, completion_tokens: 20 });
    expect(result).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("normalizes Anthropic token fields", () => {
    const result = normalizeTokens({ input_tokens: 5, output_tokens: 15 });
    expect(result).toEqual({ inputTokens: 5, outputTokens: 15 });
  });

  it("normalizes Google token fields", () => {
    const result = normalizeTokens({ promptTokenCount: 8, candidatesTokenCount: 12 });
    expect(result).toEqual({ inputTokens: 8, outputTokens: 12 });
  });

  it("normalizes camelCase token fields (Mistral)", () => {
    const result = normalizeTokens({ promptTokens: 7, completionTokens: 14 });
    expect(result).toEqual({ inputTokens: 7, outputTokens: 14 });
  });

  it("returns zeros for missing fields", () => {
    const result = normalizeTokens({});
    expect(result).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("getPricing", () => {
  it("returns known model pricing", () => {
    const p = getPricing("gpt-4o");
    expect(p.input).toBeGreaterThan(0);
    expect(p.output).toBeGreaterThan(0);
  });

  it("matches partial model names", () => {
    const p = getPricing("gpt-4o-2024-08-06");
    expect(p.input).toBe(getPricing("gpt-4o").input);
  });

  it("returns default pricing for unknown models", () => {
    const p = getPricing("some-unknown-model");
    expect(p).toEqual({ input: 0.001, output: 0.002 });
  });

  it("supports provider-scoped lookup", () => {
    const p = getPricing("llama-3.1-70b-versatile", "groq");
    expect(p.input).toBeGreaterThan(0);
  });
});

describe("normalizeMessages", () => {
  it("passes through simple messages", () => {
    const msgs = [{ role: "user", content: "Hi" }];
    expect(normalizeMessages(msgs)).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("handles Anthropic content arrays", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];
    expect(normalizeMessages(msgs)).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("stringifies non-text content blocks", () => {
    const msgs = [{ role: "user", content: [{ type: "image", data: "abc" }] }];
    const result = normalizeMessages(msgs);
    expect(result[0].content).toContain("image");
  });
});

describe("wrapWithTrace", () => {
  it("creates a trace and span, calls fn, ends span with tokens", async () => {
    const exporter = makeMockExporter();
    const tracer = new LanternTracer({ exporter, serviceName: "test", flushIntervalMs: 100_000 });

    const result = await wrapWithTrace(
      {
        tracer,
        spanType: "llm_call",
        model: "test-model",
        buildInput: () => JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
        extractTokens: () => ({ inputTokens: 10, outputTokens: 20 }),
        extractOutput: () => "Hello!",
      },
      async () => ({ answer: "Hello!" }),
    );

    expect(result).toEqual({ answer: "Hello!" });

    await tracer.flush();
    const traces = exporter.exported[0];
    expect(traces).toHaveLength(1);
    expect(traces[0].spans[0].type).toBe("llm_call");
    expect(traces[0].spans[0].inputTokens).toBe(10);
    expect(traces[0].spans[0].outputTokens).toBe(20);

    await tracer.shutdown();
  });

  it("records errors and re-throws", async () => {
    const exporter = makeMockExporter();
    const tracer = new LanternTracer({ exporter, serviceName: "test", flushIntervalMs: 100_000 });

    await expect(
      wrapWithTrace(
        {
          tracer,
          spanType: "llm_call",
          model: "test-model",
          buildInput: () => "{}",
          extractTokens: () => ({ inputTokens: 0, outputTokens: 0 }),
          extractOutput: () => "",
        },
        async () => { throw new Error("boom"); },
      ),
    ).rejects.toThrow("boom");

    await tracer.flush();
    const traces = exporter.exported[0];
    expect(traces[0].spans[0].error).toBe("boom");

    await tracer.shutdown();
  });
});
