import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "../../tracer.js";
import { wrapGoogleGenerativeModel } from "../../collectors/google.js";
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

function makeGoogleResponse(overrides: {
  text?: string;
  candidates?: Array<{
    content: { role: string; parts: Array<{ text: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
} = {}) {
  const text = overrides.text ?? "Hello from Gemini!";
  return {
    response: {
      text: () => text,
      candidates: overrides.candidates ?? [
        {
          content: { role: "model", parts: [{ text }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: overrides.usageMetadata ?? {
        promptTokenCount: 40,
        candidatesTokenCount: 20,
        totalTokenCount: 60,
      },
      functionCalls: overrides.functionCalls
        ? () => overrides.functionCalls!
        : () => [],
    },
  };
}

describe("wrapGoogleGenerativeModel", () => {
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

  it("patches generateContent and returns original response", async () => {
    const mockGenerateContent = vi.fn().mockResolvedValue(makeGoogleResponse());
    const model = { generateContent: mockGenerateContent };

    const wrapped = wrapGoogleGenerativeModel(model, tracer);
    const result = await wrapped.generateContent({
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    });

    expect(result.response.text()).toBe("Hello from Gemini!");
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it("captures llm_call span with correct input messages", async () => {
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const mockGenerateContent = vi.fn().mockResolvedValue(makeGoogleResponse());
    const model = { generateContent: mockGenerateContent };
    const wrapped = wrapGoogleGenerativeModel(model, tracer, { traceId: traceObj.id });

    await wrapped.generateContent({
      contents: [{ role: "user", parts: [{ text: "What is 2+2?" }] }],
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const exportedTrace = exporter.exported[0][0];
    expect(exportedTrace.spans.some((s) => s.type === "llm_call")).toBe(true);
    const llmSpan = exportedTrace.spans.find((s) => s.type === "llm_call")!;
    expect(llmSpan.input.messages?.[0].content).toBe("What is 2+2?");
    expect(llmSpan.input.messages?.[0].role).toBe("user");
  });

  it("extracts response text into span output", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockGenerateContent = vi.fn().mockResolvedValue(
      makeGoogleResponse({ text: "The answer is 4." })
    );
    const model = { generateContent: mockGenerateContent };
    const wrapped = wrapGoogleGenerativeModel(model, tracer, { traceId: traceObj.id });

    await wrapped.generateContent({
      contents: [{ role: "user", parts: [{ text: "What is 2+2?" }] }],
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.output?.content).toBe("The answer is 4.");
  });

  it("captures token counts from usageMetadata", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockGenerateContent = vi.fn().mockResolvedValue(
      makeGoogleResponse({
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          totalTokenCount: 150,
        },
      })
    );
    const model = { generateContent: mockGenerateContent };
    const wrapped = wrapGoogleGenerativeModel(model, tracer, { traceId: traceObj.id });

    await wrapped.generateContent({
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.inputTokens).toBe(100);
    expect(span.outputTokens).toBe(50);
  });

  it("creates tool_call child spans for function calls", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockGenerateContent = vi.fn().mockResolvedValue(
      makeGoogleResponse({
        functionCalls: [
          { name: "get_weather", args: { city: "Paris" } },
          { name: "get_time", args: { timezone: "CET" } },
        ],
      })
    );
    const model = { generateContent: mockGenerateContent };
    const wrapped = wrapGoogleGenerativeModel(model, tracer, { traceId: traceObj.id });

    await wrapped.generateContent({
      contents: [{ role: "user", parts: [{ text: "Weather and time in Paris?" }] }],
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;
    const toolSpans = spans.filter((s) => s.type === "tool_call");
    expect(toolSpans).toHaveLength(2);
    expect(toolSpans[0].toolName).toBe("get_weather");
    expect(toolSpans[1].toolName).toBe("get_time");

    // Tool call spans should be children of the llm_call span
    const llmSpan = spans.find((s) => s.type === "llm_call")!;
    expect(toolSpans[0].parentSpanId).toBe(llmSpan.id);
    expect(toolSpans[1].parentSpanId).toBe(llmSpan.id);
  });

  it("handles API errors and records error on span", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockGenerateContent = vi.fn().mockRejectedValue(new Error("Google API quota exceeded"));
    const model = { generateContent: mockGenerateContent };
    const wrapped = wrapGoogleGenerativeModel(model, tracer, { traceId: traceObj.id });

    await expect(
      wrapped.generateContent({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      })
    ).rejects.toThrow("Google API quota exceeded");

    tracer.endTrace(traceObj.id, "error");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.error).toBe("Google API quota exceeded");
  });

  it("creates its own trace when no traceId provided", async () => {
    const mockGenerateContent = vi.fn().mockResolvedValue(makeGoogleResponse());
    const model = { generateContent: mockGenerateContent };
    const wrapped = wrapGoogleGenerativeModel(model, tracer, { agentName: "auto-google" });

    await wrapped.generateContent({
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    });

    await tracer.flush();
    expect(exporter.exported).toHaveLength(1);
    expect(exporter.exported[0][0].agentName).toBe("auto-google");
  });

  it("works with provided traceId and does not end the trace", async () => {
    const traceObj = tracer.startTrace({ agentName: "managed-agent" });
    const mockGenerateContent = vi.fn().mockResolvedValue(makeGoogleResponse());
    const model = { generateContent: mockGenerateContent };
    const wrapped = wrapGoogleGenerativeModel(model, tracer, { traceId: traceObj.id });

    await wrapped.generateContent({
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    });

    // Trace should still be accessible (not yet ended by the wrapper)
    const trace = tracer.getTrace(traceObj.id);
    expect(trace).toBeDefined();
    expect(trace?.status).toBe("running");

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const exportedTrace = exporter.exported[0][0];
    expect(exportedTrace.agentName).toBe("managed-agent");
  });

  it("sets stop reason from candidate finishReason", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockGenerateContent = vi.fn().mockResolvedValue(
      makeGoogleResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "..." }] },
            finishReason: "MAX_TOKENS",
          },
        ],
      })
    );
    const model = { generateContent: mockGenerateContent };
    const wrapped = wrapGoogleGenerativeModel(model, tracer, { traceId: traceObj.id });

    await wrapped.generateContent({
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.output?.stopReason).toBe("MAX_TOKENS");
  });

  it("passes modelName to span when provided", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockGenerateContent = vi.fn().mockResolvedValue(makeGoogleResponse());
    const model = { generateContent: mockGenerateContent };
    const wrapped = wrapGoogleGenerativeModel(model, tracer, {
      traceId: traceObj.id,
      modelName: "gemini-pro",
    });

    await wrapped.generateContent({
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.model).toBe("gemini-pro");
  });

  it("handles multi-part messages by joining text", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent" });
    const mockGenerateContent = vi.fn().mockResolvedValue(makeGoogleResponse());
    const model = { generateContent: mockGenerateContent };
    const wrapped = wrapGoogleGenerativeModel(model, tracer, { traceId: traceObj.id });

    await wrapped.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: "Hello " }, { text: "world" }],
        },
      ],
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.input.messages?.[0].content).toBe("Hello world");
  });
});
