import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "../../tracer.js";
import { wrapOpenAICompatClient } from "../openai-compat.js";
import type { Trace } from "../../types.js";

function makeMockExporter() {
  const exported: Trace[][] = [];
  return {
    exporterType: "mock" as const,
    exported,
    export: vi.fn(async (traces: Trace[]) => { exported.push([...traces]); }),
    shutdown: vi.fn(async () => {}),
  };
}

function makeOpenAIResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-123",
    choices: [
      {
        message: { role: "assistant", content: "Hello from Groq!" },
        finish_reason: "stop",
      },
    ],
    model: "llama-3.1-70b-versatile",
    usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
    ...overrides,
  };
}

describe("wrapOpenAICompatClient", () => {
  let exporter: ReturnType<typeof makeMockExporter>;
  let tracer: LanternTracer;

  beforeEach(() => {
    exporter = makeMockExporter();
    tracer = new LanternTracer({
      exporter,
      serviceName: "test",
      flushIntervalMs: 100_000,
    });
  });

  afterEach(async () => {
    await tracer.shutdown();
  });

  it("patches and returns original response", async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeOpenAIResponse());
    const client = { chat: { completions: { create: mockCreate } } };

    const wrapped = wrapOpenAICompatClient(client, tracer, { provider: "groq" });
    const response = await wrapped.chat.completions.create({
      model: "llama-3.1-70b-versatile",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(response.choices[0].message.content).toBe("Hello from Groq!");
  });

  it("records provider in trace metadata", async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeOpenAIResponse());
    const client = { chat: { completions: { create: mockCreate } } };

    wrapOpenAICompatClient(client, tracer, { provider: "groq" });
    await client.chat.completions.create({
      model: "llama-3.1-70b-versatile",
      messages: [{ role: "user", content: "Hi" }],
    });

    await tracer.flush();
    const trace = exporter.exported[0][0];
    expect(trace.metadata.provider).toBe("groq");
  });

  it("captures token counts from response", async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeOpenAIResponse());
    const client = { chat: { completions: { create: mockCreate } } };

    wrapOpenAICompatClient(client, tracer, { provider: "together" });
    await client.chat.completions.create({
      model: "llama-3.1-70b",
      messages: [{ role: "user", content: "Hello" }],
    });

    await tracer.flush();
    const span = exporter.exported[0][0].spans[0];
    expect(span.inputTokens).toBe(30);
    expect(span.outputTokens).toBe(15);
  });
});
