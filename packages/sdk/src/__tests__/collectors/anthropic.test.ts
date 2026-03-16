import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "../../tracer.js";
import { wrapAnthropicClient } from "../../collectors/anthropic.js";
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

function makeAnthropicResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_123",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello from Claude!" }],
    model: "claude-sonnet-4-5-20251001",
    stop_reason: "end_turn",
    usage: { input_tokens: 50, output_tokens: 25 },
    ...overrides,
  };
}

describe("wrapAnthropicClient", () => {
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

  it("patches messages.create and returns original response", async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeAnthropicResponse());
    const client = { messages: { create: mockCreate } };

    const wrapped = wrapAnthropicClient(client, tracer);
    const response = await wrapped.messages.create({
      model: "claude-sonnet-4-5-20251001",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
    });

    expect(response.content[0].text).toBe("Hello from Claude!");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("captures llm_call span with input messages", async () => {
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const mockCreate = vi.fn().mockResolvedValue(makeAnthropicResponse());
    const client = { messages: { create: mockCreate } };
    const wrapped = wrapAnthropicClient(client, tracer, { traceId: traceObj.id });

    await wrapped.messages.create({
      model: "claude-sonnet-4-5-20251001",
      messages: [{ role: "user", content: "What is 2+2?" }],
      max_tokens: 50,
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const exportedTrace = exporter.exported[0][0];
    expect(exportedTrace.spans.some((s) => s.type === "llm_call")).toBe(true);
    const llmSpan = exportedTrace.spans.find((s) => s.type === "llm_call")!;
    expect(llmSpan.input.messages?.[0].content).toBe("What is 2+2?");
  });

  it("captures output content and tokens on span", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockCreate = vi.fn().mockResolvedValue(makeAnthropicResponse());
    const client = { messages: { create: mockCreate } };
    const wrapped = wrapAnthropicClient(client, tracer, { traceId: traceObj.id });

    await wrapped.messages.create({
      model: "claude-sonnet-4-5-20251001",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 50,
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.output?.content).toBe("Hello from Claude!");
    expect(span.inputTokens).toBe(50);
    expect(span.outputTokens).toBe(25);
  });

  it("creates tool_call child spans for tool_use content blocks", async () => {
    const toolResponse = makeAnthropicResponse({
      content: [
        { type: "text", text: "I'll search for that." },
        { type: "tool_use", id: "tool_1", name: "web_search", input: { query: "Lantern AI" } },
      ],
    });

    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockCreate = vi.fn().mockResolvedValue(toolResponse);
    const client = { messages: { create: mockCreate } };
    const wrapped = wrapAnthropicClient(client, tracer, { traceId: traceObj.id });

    await wrapped.messages.create({
      model: "claude-sonnet-4-5-20251001",
      messages: [{ role: "user", content: "Search for Lantern" }],
      max_tokens: 200,
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;
    const toolSpan = spans.find((s) => s.type === "tool_call");
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.toolName).toBe("web_search");
  });

  it("handles API errors and records error on span", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockCreate = vi.fn().mockRejectedValue(new Error("API rate limit"));
    const client = { messages: { create: mockCreate } };
    const wrapped = wrapAnthropicClient(client, tracer, { traceId: traceObj.id });

    await expect(
      wrapped.messages.create({
        model: "claude-sonnet-4-5-20251001",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 50,
      })
    ).rejects.toThrow("API rate limit");

    tracer.endTrace(traceObj.id, "error");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.error).toBe("API rate limit");
  });

  it("creates its own trace when no traceId provided", async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeAnthropicResponse());
    const client = { messages: { create: mockCreate } };
    const wrapped = wrapAnthropicClient(client, tracer, { agentName: "auto-agent" });

    await wrapped.messages.create({
      model: "claude-sonnet-4-5-20251001",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 50,
    });

    await tracer.flush();
    expect(exporter.exported).toHaveLength(1);
    expect(exporter.exported[0][0].agentName).toBe("auto-agent");
  });

  it("handles array content in messages", async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeAnthropicResponse());
    const client = { messages: { create: mockCreate } };
    const wrapped = wrapAnthropicClient(client, tracer, { agentName: "agent" });

    // Should not throw when message content is an array
    await expect(
      wrapped.messages.create({
        model: "claude-sonnet-4-5-20251001",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello" }] as unknown as string,
          },
        ],
        max_tokens: 100,
      })
    ).resolves.toBeDefined();
  });
});
