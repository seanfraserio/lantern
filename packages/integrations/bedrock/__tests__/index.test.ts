import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "@openlantern-ai/sdk";
import type { Trace } from "@openlantern-ai/sdk";
import { wrapBedrockClient } from "../src/index.js";

function makeMockExporter() {
  const exported: Trace[][] = [];
  return {
    exporterType: "mock" as const, exported,
    export: vi.fn(async (traces: Trace[]) => { exported.push([...traces]); }),
    shutdown: vi.fn(async () => {}),
  };
}

describe("wrapBedrockClient", () => {
  let exporter: ReturnType<typeof makeMockExporter>;
  let tracer: LanternTracer;
  beforeEach(() => { exporter = makeMockExporter(); tracer = new LanternTracer({ exporter, serviceName: "test", flushIntervalMs: 100_000 }); });
  afterEach(async () => { await tracer.shutdown(); });

  it("wraps send() for ConverseCommand and captures tokens", async () => {
    const converseResponse = {
      output: { message: { role: "assistant", content: [{ text: "Hello from Bedrock!" }] } },
      usage: { inputTokens: 15, outputTokens: 25 },
      stopReason: "end_turn",
      $metadata: { httpStatusCode: 200 },
    };
    const mockSend = vi.fn().mockResolvedValue(converseResponse);
    const client = { send: mockSend };

    // Mock command with constructor name
    const command = { constructor: { name: "ConverseCommand" }, input: { modelId: "anthropic.claude-3-haiku", messages: [{ role: "user", content: [{ text: "Hi" }] }] } };

    const wrapped = wrapBedrockClient(client, tracer);
    const result = await wrapped.send(command);

    expect(result.output.message.content[0].text).toBe("Hello from Bedrock!");
    await tracer.flush();
    const span = exporter.exported[0][0].spans[0];
    expect(span.inputTokens).toBe(15);
    expect(span.outputTokens).toBe(25);
  });
});
