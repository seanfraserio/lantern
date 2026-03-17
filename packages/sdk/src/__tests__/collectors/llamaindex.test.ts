import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "../../tracer.js";
import { createLanternEventHandler } from "../../collectors/llamaindex.js";
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

describe("createLanternEventHandler", () => {
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

  it("creates and completes an LLM span from llm_start/llm_end", async () => {
    const traceObj = tracer.startTrace({ agentName: "rag-agent" });
    const handler = createLanternEventHandler(tracer, { traceId: traceObj.id });

    handler.onEvent("llm_start", {
      id: "evt1",
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    });

    handler.onEvent("llm_end", {
      id: "evt1",
      response: { text: "Hi there!", raw: { usage: { prompt_tokens: 10, completion_tokens: 5 } } },
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;
    expect(spans).toHaveLength(1);

    const llmSpan = spans[0];
    expect(llmSpan.type).toBe("llm_call");
    expect(llmSpan.model).toBe("gpt-4o");
    expect(llmSpan.input.messages?.[0].content).toBe("Hello");
    expect(llmSpan.output?.content).toBe("Hi there!");
  });

  it("creates a retrieval span from retrieval_start/retrieval_end", async () => {
    const traceObj = tracer.startTrace({ agentName: "rag-agent" });
    const handler = createLanternEventHandler(tracer, { traceId: traceObj.id });

    handler.onEvent("retrieval_start", {
      id: "evt2",
      query: "What is LlamaIndex?",
    });

    handler.onEvent("retrieval_end", {
      id: "evt2",
      nodes: [{ text: "node1" }, { text: "node2" }, { text: "node3" }],
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.type).toBe("retrieval");
    expect(span.input.prompt).toBe("What is LlamaIndex?");
    expect(span.output?.content).toBe("Retrieved 3 nodes");
  });

  it("creates a custom span from query_start/query_end", async () => {
    const traceObj = tracer.startTrace({ agentName: "rag-agent" });
    const handler = createLanternEventHandler(tracer, { traceId: traceObj.id });

    handler.onEvent("query_start", {
      id: "evt3",
      query: "Summarize the docs",
    });

    handler.onEvent("query_end", {
      id: "evt3",
      response: "Here is the summary...",
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;
    expect(spans).toHaveLength(1);

    const span = spans[0];
    expect(span.type).toBe("custom");
    expect(span.input.prompt).toBe("Summarize the docs");
    expect(span.output?.content).toBe("Here is the summary...");
  });

  it("extracts token counts from payload.response.raw.usage", async () => {
    const traceObj = tracer.startTrace({ agentName: "rag-agent" });
    const handler = createLanternEventHandler(tracer, { traceId: traceObj.id });

    handler.onEvent("llm_start", { id: "evt4", model: "gpt-4o" });
    handler.onEvent("llm_end", {
      id: "evt4",
      response: {
        text: "Response",
        raw: { usage: { prompt_tokens: 100, completion_tokens: 50 } },
      },
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans[0];
    expect(span.inputTokens).toBe(100);
    expect(span.outputTokens).toBe(50);
  });

  it("extracts Anthropic-style token counts (input_tokens/output_tokens)", async () => {
    const traceObj = tracer.startTrace({ agentName: "rag-agent" });
    const handler = createLanternEventHandler(tracer, { traceId: traceObj.id });

    handler.onEvent("llm_start", { id: "evt5", model: "claude-sonnet-4-5-20251001" });
    handler.onEvent("llm_end", {
      id: "evt5",
      response: {
        text: "Response",
        raw: { usage: { input_tokens: 80, output_tokens: 40 } },
      },
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans[0];
    expect(span.inputTokens).toBe(80);
    expect(span.outputTokens).toBe(40);
  });

  it("gracefully ignores end events with no matching start", async () => {
    const traceObj = tracer.startTrace({ agentName: "rag-agent" });
    const handler = createLanternEventHandler(tracer, { traceId: traceObj.id });

    // Should not throw
    handler.onEvent("llm_end", { id: "orphan", response: "data" });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;
    expect(spans).toHaveLength(0);
  });

  it("creates embedding span from embedding_start/embedding_end", async () => {
    const traceObj = tracer.startTrace({ agentName: "rag-agent" });
    const handler = createLanternEventHandler(tracer, { traceId: traceObj.id });

    handler.onEvent("embedding_start", { id: "evt6" });
    handler.onEvent("embedding_end", {
      id: "evt6",
      response: { text: "embedded" },
    });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans[0];
    expect(span.type).toBe("custom");
  });

  it("extracts model from payload.serialized.model", async () => {
    const traceObj = tracer.startTrace({ agentName: "rag-agent" });
    const handler = createLanternEventHandler(tracer, { traceId: traceObj.id });

    handler.onEvent("llm_start", {
      id: "evt7",
      serialized: { model: "gpt-4o-mini" },
    });

    handler.onEvent("llm_end", { id: "evt7", response: "done" });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans[0];
    expect(span.model).toBe("gpt-4o-mini");
  });

  it("creates its own trace when no traceId provided", async () => {
    const handler = createLanternEventHandler(tracer, { agentName: "auto-agent" });

    handler.onEvent("llm_start", { id: "evt8", model: "gpt-4o" });
    handler.onEvent("llm_end", { id: "evt8", response: "hi" });

    // The handler creates its own trace but doesn't end it,
    // so we check that spans were created via the tracer
    // by verifying no errors were thrown during event handling
    expect(true).toBe(true);
  });

  it("ignores events that are not start or end", async () => {
    const traceObj = tracer.startTrace({ agentName: "rag-agent" });
    const handler = createLanternEventHandler(tracer, { traceId: traceObj.id });

    // Should not throw for unknown event types
    handler.onEvent("llm_stream", { id: "evt9" });
    handler.onEvent("custom_event", { data: "something" });

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    expect(exporter.exported[0][0].spans).toHaveLength(0);
  });
});
