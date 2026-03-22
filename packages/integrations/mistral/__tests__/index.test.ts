import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "@lantern-ai/sdk";
import type { Trace } from "@lantern-ai/sdk";
import { wrapMistralClient } from "../src/index.js";

function makeMockExporter() {
  const exported: Trace[][] = [];
  return {
    exporterType: "mock" as const,
    exported,
    export: vi.fn(async (traces: Trace[]) => { exported.push([...traces]); }),
    shutdown: vi.fn(async () => {}),
  };
}

describe("wrapMistralClient", () => {
  let exporter: ReturnType<typeof makeMockExporter>;
  let tracer: LanternTracer;

  beforeEach(() => {
    exporter = makeMockExporter();
    tracer = new LanternTracer({ exporter, serviceName: "test", flushIntervalMs: 100_000 });
  });

  afterEach(async () => { await tracer.shutdown(); });

  it("patches chat.complete and returns original response", async () => {
    const response = {
      id: "cmpl-123",
      choices: [{ message: { role: "assistant", content: "Hello!" }, finishReason: "stop" }],
      model: "mistral-large-latest",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    };
    const mockComplete = vi.fn().mockResolvedValue(response);
    const client = { chat: { complete: mockComplete } };

    const wrapped = wrapMistralClient(client, tracer);
    const result = await wrapped.chat.complete({ model: "mistral-large-latest", messages: [{ role: "user", content: "Hi" }] });

    expect(result.choices[0].message.content).toBe("Hello!");
    await tracer.flush();
    const span = exporter.exported[0][0].spans[0];
    expect(span.inputTokens).toBe(10);
    expect(span.outputTokens).toBe(20);
    expect(span.model).toBe("mistral-large-latest");
  });
});
