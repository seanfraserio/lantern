import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternTracer } from "../../tracer.js";
import { createLanternCallbackHandler } from "../../collectors/langchain.js";
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

describe("createLanternCallbackHandler", () => {
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

  it("handleLLMStart creates an llm_call span", async () => {
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const handler = createLanternCallbackHandler(tracer, { traceId: traceObj.id });

    await handler.handleLLMStart!(
      { id: ["langchain", "chat_models", "ChatOpenAI"], kwargs: { model_name: "gpt-4o" } },
      ["What is 2+2?"],
      "run-1",
      undefined
    );

    // End the span so it appears in the trace
    await handler.handleLLMEnd!(
      { generations: [[{ text: "4" }]], llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5 } } },
      "run-1"
    );

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;
    const llmSpan = spans.find((s) => s.type === "llm_call");
    expect(llmSpan).toBeDefined();
    expect(llmSpan?.input.prompt).toBe("What is 2+2?");
    expect(llmSpan?.model).toBe("gpt-4o");
  });

  it("handleLLMEnd ends the span with output and tokens", async () => {
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const handler = createLanternCallbackHandler(tracer, { traceId: traceObj.id });

    await handler.handleLLMStart!(
      { id: ["ChatOpenAI"], kwargs: {} },
      ["Hello"],
      "run-2",
      undefined
    );

    await handler.handleLLMEnd!(
      {
        generations: [[{ text: "Hi there!" }]],
        llmOutput: { tokenUsage: { promptTokens: 20, completionTokens: 10 } },
      },
      "run-2"
    );

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.output?.content).toBe("Hi there!");
    expect(span.inputTokens).toBe(20);
    expect(span.outputTokens).toBe(10);
  });

  it("handleToolStart creates a child tool span", async () => {
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const handler = createLanternCallbackHandler(tracer, { traceId: traceObj.id });

    // Start an LLM span first
    await handler.handleLLMStart!(
      { id: ["ChatOpenAI"], kwargs: {} },
      ["Search for something"],
      "llm-run",
      undefined
    );

    // Start a tool span as child of the LLM
    await handler.handleToolStart!(
      { name: "web_search" },
      "Lantern AI",
      "tool-run",
      "llm-run"
    );

    await handler.handleToolEnd!("Search results here", "tool-run");
    await handler.handleLLMEnd!(
      { generations: [[{ text: "Done" }]], llmOutput: {} },
      "llm-run"
    );

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;
    const toolSpan = spans.find((s) => s.type === "tool_call");
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.toolName).toBe("web_search");
    expect(toolSpan?.output?.content).toBe("Search results here");

    // Verify parent relationship
    const llmSpan = spans.find((s) => s.type === "llm_call")!;
    expect(toolSpan?.parentSpanId).toBe(llmSpan.id);
  });

  it("handleLLMError ends span with error", async () => {
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const handler = createLanternCallbackHandler(tracer, { traceId: traceObj.id });

    await handler.handleLLMStart!(
      { id: ["ChatOpenAI"], kwargs: {} },
      ["Hello"],
      "run-err",
      undefined
    );

    await handler.handleLLMError!(new Error("Rate limit exceeded"), "run-err");

    tracer.endTrace(traceObj.id, "error");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "llm_call")!;
    expect(span.error).toBe("Rate limit exceeded");
  });

  it("handleChainStart/End creates and completes custom spans", async () => {
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const handler = createLanternCallbackHandler(tracer, { traceId: traceObj.id });

    await handler.handleChainStart!(
      { id: ["langchain", "chains", "LLMChain"] },
      { input: "test input" },
      "chain-run",
      undefined
    );

    await handler.handleChainEnd!({ output: "chain result" }, "chain-run");

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;
    const chainSpan = spans.find((s) => s.type === "custom");
    expect(chainSpan).toBeDefined();
    expect(chainSpan?.output?.content).toContain("chain result");
  });

  it("handleRetrieverStart/End creates retrieval spans", async () => {
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const handler = createLanternCallbackHandler(tracer, { traceId: traceObj.id });

    await handler.handleRetrieverStart!(
      { id: ["langchain", "retrievers", "VectorStore"] },
      "What is Lantern?",
      "retriever-run",
      undefined
    );

    await handler.handleRetrieverEnd!(
      [{ pageContent: "doc1" }, { pageContent: "doc2" }, { pageContent: "doc3" }],
      "retriever-run"
    );

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;
    const retrievalSpan = spans.find((s) => s.type === "retrieval");
    expect(retrievalSpan).toBeDefined();
    expect(retrievalSpan?.input.prompt).toBe("What is Lantern?");
    expect(retrievalSpan?.output?.content).toBe("Retrieved 3 document(s)");
  });

  it("full chain: LLM → tool → LLM produces correct span hierarchy", async () => {
    const traceObj = tracer.startTrace({ agentName: "agent-executor" });
    const handler = createLanternCallbackHandler(tracer, { traceId: traceObj.id });

    // Chain starts
    await handler.handleChainStart!(
      { id: ["AgentExecutor"] },
      { input: "Find info about Lantern" },
      "chain-1",
      undefined
    );

    // First LLM call (decides to use tool)
    await handler.handleLLMStart!(
      { id: ["ChatOpenAI"], kwargs: { model_name: "gpt-4o" } },
      ["Find info about Lantern"],
      "llm-1",
      "chain-1"
    );
    await handler.handleLLMEnd!(
      { generations: [[{ text: "I'll search for that." }]], llmOutput: { tokenUsage: { promptTokens: 30, completionTokens: 15 } } },
      "llm-1"
    );

    // Tool call
    await handler.handleToolStart!(
      { name: "web_search" },
      "Lantern AI observability",
      "tool-1",
      "llm-1"
    );
    await handler.handleToolEnd!("Lantern is an AI observability platform.", "tool-1");

    // Second LLM call (summarizes tool output)
    await handler.handleLLMStart!(
      { id: ["ChatOpenAI"], kwargs: { model_name: "gpt-4o" } },
      ["Summarize: Lantern is an AI observability platform."],
      "llm-2",
      "chain-1"
    );
    await handler.handleLLMEnd!(
      { generations: [[{ text: "Lantern provides AI observability." }]], llmOutput: { tokenUsage: { promptTokens: 40, completionTokens: 20 } } },
      "llm-2"
    );

    // Chain ends
    await handler.handleChainEnd!({ output: "Lantern provides AI observability." }, "chain-1");

    tracer.endTrace(traceObj.id, "success");
    await tracer.flush();

    const spans = exporter.exported[0][0].spans;

    // 4 spans: 1 chain + 2 llm + 1 tool
    expect(spans).toHaveLength(4);

    const chainSpan = spans.find((s) => s.type === "custom")!;
    const llmSpans = spans.filter((s) => s.type === "llm_call");
    const toolSpan = spans.find((s) => s.type === "tool_call")!;

    expect(llmSpans).toHaveLength(2);

    // Both LLM spans should be children of the chain
    expect(llmSpans[0].parentSpanId).toBe(chainSpan.id);
    expect(llmSpans[1].parentSpanId).toBe(chainSpan.id);

    // Tool span should be child of first LLM span
    expect(toolSpan.parentSpanId).toBe(llmSpans[0].id);

    // Token counts should be correct
    expect(llmSpans[0].inputTokens).toBe(30);
    expect(llmSpans[0].outputTokens).toBe(15);
    expect(llmSpans[1].inputTokens).toBe(40);
    expect(llmSpans[1].outputTokens).toBe(20);
  });

  it("creates its own trace when no traceId provided", async () => {
    const handler = createLanternCallbackHandler(tracer, { agentName: "auto-agent" });

    await handler.handleLLMStart!(
      { id: ["ChatOpenAI"], kwargs: {} },
      ["Hello"],
      "auto-run",
      undefined
    );

    await handler.handleLLMEnd!(
      { generations: [[{ text: "Hi" }]], llmOutput: {} },
      "auto-run"
    );

    // The handler should auto-end the trace when all spans complete
    await tracer.flush();

    expect(exporter.exported).toHaveLength(1);
    expect(exporter.exported[0][0].agentName).toBe("auto-agent");
  });

  it("handleToolError ends tool span with error", async () => {
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const handler = createLanternCallbackHandler(tracer, { traceId: traceObj.id });

    await handler.handleToolStart!(
      { name: "failing_tool" },
      "some input",
      "tool-err",
      undefined
    );

    await handler.handleToolError!(new Error("Tool execution failed"), "tool-err");

    tracer.endTrace(traceObj.id, "error");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "tool_call")!;
    expect(span.error).toBe("Tool execution failed");
    expect(span.toolName).toBe("failing_tool");
  });

  it("handleChainError ends chain span with error", async () => {
    const traceObj = tracer.startTrace({ agentName: "test-agent" });
    const handler = createLanternCallbackHandler(tracer, { traceId: traceObj.id });

    await handler.handleChainStart!(
      { id: ["LLMChain"] },
      { input: "test" },
      "chain-err",
      undefined
    );

    await handler.handleChainError!(new Error("Chain failed"), "chain-err");

    tracer.endTrace(traceObj.id, "error");
    await tracer.flush();

    const span = exporter.exported[0][0].spans.find((s) => s.type === "custom")!;
    expect(span.error).toBe("Chain failed");
  });
});
