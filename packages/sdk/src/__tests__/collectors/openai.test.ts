import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "../../tracer.js";
import { wrapOpenAIClient } from "../../collectors/openai.js";
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
        message: { role: "assistant", content: "Hello from GPT!" },
        finish_reason: "stop",
      },
    ],
    model: "gpt-4o",
    usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
    ...overrides,
  };
}

describe("wrapOpenAIClient", () => {
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

  it("patches chat.completions.create and returns original response", async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeOpenAIResponse());
    const client = { chat: { completions: { create: mockCreate } } };

    const wrapped = wrapOpenAIClient(client, tracer);
    const response = await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(response.choices[0].message.content).toBe("Hello from GPT!");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("captures llm_call span with input messages and tokens", async () => {
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const mockCreate = vi.fn().mockResolvedValue(makeOpenAIResponse());
    const client = { chat: { completions: { create: mockCreate } } };
    const wrapped = wrapOpenAIClient(client, tracer, { traceId: traceObj.id });

    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.model).toBe("gpt-4o");
    expect(span.input.messages?.[0].content).toBe("What is the capital of France?");
    expect(span.inputTokens).toBe(30);
    expect(span.outputTokens).toBe(15);
    expect(span.output?.content).toBe("Hello from GPT!");
  });

  it("creates tool_call child spans for tool_calls in response", async () => {
    const toolResponse = makeOpenAIResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city": "Paris"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockCreate = vi.fn().mockResolvedValue(toolResponse);
    const client = { chat: { completions: { create: mockCreate } } };
    const wrapped = wrapOpenAIClient(client, tracer, { traceId: traceObj.id });

    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Weather in Paris?" }],
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;
    const toolSpan = spans.find((s) => s.type === "tool_call");
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.toolName).toBe("get_weather");
  });

  it("handles API errors and records error on span", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockCreate = vi.fn().mockRejectedValue(new Error("OpenAI 429"));
    const client = { chat: { completions: { create: mockCreate } } };
    const wrapped = wrapOpenAIClient(client, tracer, { traceId: traceObj.id });

    await expect(
      wrapped.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      })
    ).rejects.toThrow("OpenAI 429");

    tracer.endTrace(traceObj.id, "error");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.error).toBe("OpenAI 429");
  });

  it("creates its own trace if no traceId provided", async () => {
    const mockCreate = vi.fn().mockResolvedValue(makeOpenAIResponse());
    const client = { chat: { completions: { create: mockCreate } } };
    const wrapped = wrapOpenAIClient(client, tracer, { agentName: "auto-openai" });

    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });

    await tracer.flush();
    expect(exporter.exported).toHaveLength(1);
    expect(exporter.exported[0][0].agentName).toBe("auto-openai");
  });

  it("sets stop reason from finish_reason", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockCreate = vi.fn().mockResolvedValue(makeOpenAIResponse({
      choices: [
        { message: { role: "assistant", content: "Done" }, finish_reason: "length" },
      ],
    }));
    const client = { chat: { completions: { create: mockCreate } } };
    const wrapped = wrapOpenAIClient(client, tracer, { traceId: traceObj.id });

    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.output?.stopReason).toBe("length");
  });
});
