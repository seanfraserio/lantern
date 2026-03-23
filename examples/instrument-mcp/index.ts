/**
 * Example: Instrument MCP tool calls with Lantern.
 */

import { LanternTracer, ConsoleExporter } from "@openlantern-ai/sdk";

const tracer = new LanternTracer({
  serviceName: "mcp-agent",
  environment: "dev",
  exporter: new ConsoleExporter({ verbose: true }),
});

async function demo() {
  const trace = tracer.startTrace({
    agentName: "mcp-demo",
  });

  // Simulate an LLM call that triggers a tool
  const llmSpan = tracer.startSpan(trace.id, {
    type: "llm_call",
    input: { messages: [{ role: "user", content: "Read the file config.json" }] },
    model: "claude-sonnet-4-5-20251001",
  });

  tracer.endSpan(llmSpan.id, {
    content: "I'll read that file for you.",
    toolCalls: [{ name: "filesystem_read", input: { path: "config.json" } }],
    stopReason: "tool_use",
  }, {
    inputTokens: 20,
    outputTokens: 25,
  });

  // Simulate the MCP tool call
  const toolSpan = tracer.startSpan(trace.id, {
    type: "tool_call",
    parentSpanId: llmSpan.id,
    input: { args: { path: "config.json" } },
    toolName: "filesystem_read",
  });

  tracer.endSpan(toolSpan.id, {
    content: '{ "key": "value" }',
  });

  tracer.endTrace(trace.id, "success");

  await tracer.flush();
  await tracer.shutdown();
}

demo().catch(console.error);

export { tracer };
