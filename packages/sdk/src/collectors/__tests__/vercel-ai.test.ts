import { describe, it, expect, vi, beforeEach } from "vitest";
import { wrapGenerateText, wrapStreamText } from "../vercel-ai.js";
import { LanternTracer } from "../../tracer.js";
import type { ITraceExporter } from "../../types.js";

const noopExporter: ITraceExporter = {
  exporterType: "noop",
  export: async () => {},
  shutdown: async () => {},
};

function createTracer() {
  return new LanternTracer({
    serviceName: "test",
    exporter: noopExporter,
    flushIntervalMs: 60_000, // Don't auto-flush during tests
  });
}

function mockGenerateText(response: any) {
  return vi.fn().mockResolvedValue(response);
}

const baseResponse = {
  text: "Hello, world!",
  usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  finishReason: "stop",
};

describe("wrapGenerateText", () => {
  let tracer: LanternTracer;

  beforeEach(() => {
    tracer = createTracer();
  });

  it("creates span with correct input from messages", async () => {
    const fn = mockGenerateText(baseResponse);
    const wrapped = wrapGenerateText(fn, tracer);

    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const wrappedWithTrace = wrapGenerateText(fn, tracer, { traceId: traceObj.id });

    await wrappedWithTrace({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hi" }],
    });

    const trace = tracer.getTrace(traceObj.id);
    expect(trace).toBeDefined();
    expect(trace!.spans).toHaveLength(1);

    const span = trace!.spans[0];
    expect(span.type).toBe("llm_call");
    expect(span.input.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(span.output?.content).toBe("Hello, world!");
  });

  it("creates span with correct input from prompt string", async () => {
    const fn = mockGenerateText(baseResponse);
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const wrapped = wrapGenerateText(fn, tracer, { traceId: traceObj.id });

    await wrapped({
      model: "gpt-4",
      prompt: "Hello there",
      system: "You are helpful",
    });

    const trace = tracer.getTrace(traceObj.id);
    const span = trace!.spans[0];
    expect(span.input.messages).toEqual([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello there" },
    ]);
  });

  it("extracts token counts from usage", async () => {
    const fn = mockGenerateText(baseResponse);
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const wrapped = wrapGenerateText(fn, tracer, { traceId: traceObj.id });

    await wrapped({ model: "gpt-4", prompt: "Hi" });

    const trace = tracer.getTrace(traceObj.id);
    const span = trace!.spans[0];
    expect(span.inputTokens).toBe(10);
    expect(span.outputTokens).toBe(20);
  });

  it("creates child spans for tool calls", async () => {
    const fn = mockGenerateText({
      ...baseResponse,
      toolCalls: [
        { toolName: "get_weather", args: { city: "NYC" } },
        { toolName: "get_time", args: { timezone: "EST" } },
      ],
      toolResults: [
        { toolName: "get_weather", result: { temp: 72 } },
        { toolName: "get_time", result: { time: "3:00 PM" } },
      ],
    });

    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const wrapped = wrapGenerateText(fn, tracer, { traceId: traceObj.id });

    await wrapped({ model: "gpt-4", prompt: "Weather in NYC?" });

    const trace = tracer.getTrace(traceObj.id);
    // 1 llm_call + 2 tool_call spans
    expect(trace!.spans).toHaveLength(3);

    const toolSpans = trace!.spans.filter((s) => s.type === "tool_call");
    expect(toolSpans).toHaveLength(2);
    expect(toolSpans[0].toolName).toBe("get_weather");
    expect(toolSpans[0].input.args).toEqual({ city: "NYC" });
    expect(toolSpans[0].parentSpanId).toBe(trace!.spans[0].id);
    expect(toolSpans[1].toolName).toBe("get_time");
  });

  it("preserves original error on failure", async () => {
    const error = new Error("API rate limit exceeded");
    const fn = vi.fn().mockRejectedValue(error);
    const wrapped = wrapGenerateText(fn, tracer);

    await expect(wrapped({ model: "gpt-4", prompt: "Hi" })).rejects.toThrow(
      "API rate limit exceeded"
    );
  });

  it("records error in span on failure", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Timeout"));
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const wrapped = wrapGenerateText(fn, tracer, { traceId: traceObj.id });

    await expect(wrapped({ model: "gpt-4", prompt: "Hi" })).rejects.toThrow();

    const trace = tracer.getTrace(traceObj.id);
    const span = trace!.spans[0];
    expect(span.error).toBe("Timeout");
  });

  it("extracts model name from string", async () => {
    const fn = mockGenerateText(baseResponse);
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const wrapped = wrapGenerateText(fn, tracer, { traceId: traceObj.id });

    await wrapped({ model: "gpt-4o", prompt: "Hi" });

    const trace = tracer.getTrace(traceObj.id);
    expect(trace!.spans[0].model).toBe("gpt-4o");
  });

  it("extracts model name from object with modelId", async () => {
    const fn = mockGenerateText(baseResponse);
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const wrapped = wrapGenerateText(fn, tracer, { traceId: traceObj.id });

    await wrapped({ model: { modelId: "claude-sonnet-4-20250514" }, prompt: "Hi" });

    const trace = tracer.getTrace(traceObj.id);
    expect(trace!.spans[0].model).toBe("claude-sonnet-4-20250514");
  });

  it("creates own trace when no traceId provided", async () => {
    const fn = mockGenerateText(baseResponse);
    const wrapped = wrapGenerateText(fn, tracer, { agentName: "my-agent" });

    await wrapped({ model: "gpt-4", prompt: "Hi" });

    // Trace was created and ended (moved to buffer), so getTrace returns undefined
    // This verifies the trace lifecycle completed without error
    expect(fn).toHaveBeenCalledOnce();
  });

  it("passes through all params to original function", async () => {
    const fn = mockGenerateText(baseResponse);
    const wrapped = wrapGenerateText(fn, tracer);

    const params = {
      model: "gpt-4",
      prompt: "Hi",
      maxTokens: 100,
      temperature: 0.5,
      tools: { weather: { description: "Get weather" } },
    };

    await wrapped(params);
    expect(fn).toHaveBeenCalledWith(params);
  });
});

describe("wrapStreamText", () => {
  let tracer: LanternTracer;

  beforeEach(() => {
    tracer = createTracer();
  });

  function mockStreamText(chunks: string[], usage?: any, finishReason?: string) {
    return vi.fn().mockReturnValue({
      textStream: {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
      },
      usage: Promise.resolve(usage ?? { promptTokens: 5, completionTokens: 15, totalTokens: 20 }),
      finishReason: Promise.resolve(finishReason ?? "stop"),
    });
  }

  it("streams text chunks through unchanged", async () => {
    const fn = mockStreamText(["Hello", ", ", "world", "!"]);
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const wrapped = wrapStreamText(fn, tracer, { traceId: traceObj.id });

    const result = wrapped({ model: "gpt-4", prompt: "Hi" });
    const chunks: string[] = [];

    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hello", ", ", "world", "!"]);
  });

  it("records accumulated text in span after stream completes", async () => {
    const fn = mockStreamText(["Hello", " world"]);
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const wrapped = wrapStreamText(fn, tracer, { traceId: traceObj.id });

    const result = wrapped({ model: "gpt-4", prompt: "Hi" });

    // Consume the stream
    for await (const _ of result.textStream) {
      // drain
    }

    const trace = tracer.getTrace(traceObj.id);
    const span = trace!.spans[0];
    expect(span.output?.content).toBe("Hello world");
  });

  it("extracts usage from stream result", async () => {
    const fn = mockStreamText(["Hi"], { promptTokens: 8, completionTokens: 12, totalTokens: 20 });
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const wrapped = wrapStreamText(fn, tracer, { traceId: traceObj.id });

    const result = wrapped({ model: "gpt-4", prompt: "Hi" });
    for await (const _ of result.textStream) {}

    const trace = tracer.getTrace(traceObj.id);
    const span = trace!.spans[0];
    expect(span.inputTokens).toBe(8);
    expect(span.outputTokens).toBe(12);
  });

  it("records error when stream fails", async () => {
    const fn = vi.fn().mockReturnValue({
      textStream: {
        async *[Symbol.asyncIterator]() {
          yield "partial";
          throw new Error("Stream interrupted");
        },
      },
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 0, totalTokens: 5 }),
      finishReason: Promise.resolve("error"),
    });

    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const wrapped = wrapStreamText(fn, tracer, { traceId: traceObj.id });

    const result = wrapped({ model: "gpt-4", prompt: "Hi" });
    const chunks: string[] = [];

    await expect(async () => {
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
      }
    }).rejects.toThrow("Stream interrupted");

    expect(chunks).toEqual(["partial"]);

    const trace = tracer.getTrace(traceObj.id);
    const span = trace!.spans[0];
    expect(span.error).toBe("Stream interrupted");
  });
});
