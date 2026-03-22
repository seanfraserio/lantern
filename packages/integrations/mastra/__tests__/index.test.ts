import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "@lantern-ai/sdk";
import type { Trace } from "@lantern-ai/sdk";
import { createLanternMastraHook } from "../src/index.js";

function makeMockExporter() {
  const exported: Trace[][] = [];
  return {
    exporterType: "mock" as const, exported,
    export: vi.fn(async (traces: Trace[]) => { exported.push([...traces]); }),
    shutdown: vi.fn(async () => {}),
  };
}

describe("createLanternMastraHook", () => {
  let exporter: ReturnType<typeof makeMockExporter>;
  let tracer: LanternTracer;
  beforeEach(() => { exporter = makeMockExporter(); tracer = new LanternTracer({ exporter, serviceName: "test", flushIntervalMs: 100_000 }); });
  afterEach(async () => { await tracer.shutdown(); });

  it("creates a hook with onSpanStart and onSpanEnd", () => {
    const hook = createLanternMastraHook(tracer);
    expect(typeof hook.onSpanStart).toBe("function");
    expect(typeof hook.onSpanEnd).toBe("function");
  });

  it("records spans from Mastra telemetry events", async () => {
    const hook = createLanternMastraHook(tracer);
    hook.onSpanStart({ name: "llm.generate", spanId: "s1", attributes: { "gen_ai.system": "openai", "gen_ai.request.model": "gpt-4o" } });
    hook.onSpanEnd({ spanId: "s1", attributes: { "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 20, "gen_ai.completion": "Hello" } });
    hook.finish();

    await tracer.flush();
    expect(exporter.exported.length).toBeGreaterThan(0);
    const span = exporter.exported[0][0].spans[0];
    expect(span.type).toBe("llm_call");
  });
});
