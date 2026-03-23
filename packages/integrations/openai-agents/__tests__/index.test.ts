import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "@openlantern-ai/sdk";
import type { Trace } from "@openlantern-ai/sdk";
import { createLanternTraceProcessor } from "../src/index.js";

function makeMockExporter() {
  const exported: Trace[][] = [];
  return {
    exporterType: "mock" as const, exported,
    export: vi.fn(async (traces: Trace[]) => { exported.push([...traces]); }),
    shutdown: vi.fn(async () => {}),
  };
}

describe("createLanternTraceProcessor", () => {
  let exporter: ReturnType<typeof makeMockExporter>;
  let tracer: LanternTracer;
  beforeEach(() => { exporter = makeMockExporter(); tracer = new LanternTracer({ exporter, serviceName: "test", flushIntervalMs: 100_000 }); });
  afterEach(async () => { await tracer.shutdown(); });

  it("creates a trace processor with required methods", () => {
    const processor = createLanternTraceProcessor(tracer);
    expect(processor).toBeDefined();
    expect(typeof processor.onTraceStart).toBe("function");
    expect(typeof processor.onSpanStart).toBe("function");
    expect(typeof processor.onSpanEnd).toBe("function");
    expect(typeof processor.onTraceEnd).toBe("function");
  });

  it("records an LLM span on onSpanEnd", async () => {
    const processor = createLanternTraceProcessor(tracer);
    const traceData = { traceId: "t1", name: "agent-run" };
    processor.onTraceStart(traceData);
    const spanData = { spanId: "s1", traceId: "t1", type: "generation", model: "gpt-4o", input: "Hello", output: "Hi!", usage: { inputTokens: 10, outputTokens: 5 } };
    processor.onSpanStart(spanData);
    processor.onSpanEnd(spanData);
    processor.onTraceEnd(traceData);

    await tracer.flush();
    expect(exporter.exported.length).toBeGreaterThan(0);
    const span = exporter.exported[0][0].spans[0];
    expect(span.type).toBe("llm_call");
    expect(span.inputTokens).toBe(10);
  });
});
