import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "@lantern-ai/sdk";
import type { Trace } from "@lantern-ai/sdk";
import { wrapCohereClient } from "../src/index.js";

function makeMockExporter() {
  const exported: Trace[][] = [];
  return {
    exporterType: "mock" as const, exported,
    export: vi.fn(async (traces: Trace[]) => { exported.push([...traces]); }),
    shutdown: vi.fn(async () => {}),
  };
}

describe("wrapCohereClient", () => {
  let exporter: ReturnType<typeof makeMockExporter>;
  let tracer: LanternTracer;
  beforeEach(() => { exporter = makeMockExporter(); tracer = new LanternTracer({ exporter, serviceName: "test", flushIntervalMs: 100_000 }); });
  afterEach(async () => { await tracer.shutdown(); });

  it("patches chat() and captures billedUnits tokens", async () => {
    const response = {
      text: "Hello!",
      meta: { billedUnits: { inputTokens: 12, outputTokens: 8 } },
      finish_reason: "COMPLETE",
    };
    const mockChat = vi.fn().mockResolvedValue(response);
    const client = { chat: mockChat, generate: vi.fn() };

    const wrapped = wrapCohereClient(client, tracer);
    const result = await wrapped.chat({ message: "Hi", model: "command-r-plus" });

    expect(result.text).toBe("Hello!");
    await tracer.flush();
    const span = exporter.exported[0][0].spans[0];
    expect(span.inputTokens).toBe(12);
    expect(span.outputTokens).toBe(8);
  });

  it("patches generate() and captures tokens", async () => {
    const response = {
      generations: [{ text: "Generated text" }],
      meta: { billedUnits: { inputTokens: 5, outputTokens: 10 } },
    };
    const mockGenerate = vi.fn().mockResolvedValue(response);
    const client = { chat: vi.fn(), generate: mockGenerate };

    const wrapped = wrapCohereClient(client, tracer);
    const result = await wrapped.generate({ prompt: "Hello", model: "command-r" });

    expect(result.generations[0].text).toBe("Generated text");
    await tracer.flush();
    const span = exporter.exported[0][0].spans[0];
    expect(span.inputTokens).toBe(5);
  });
});
