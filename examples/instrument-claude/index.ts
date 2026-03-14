/**
 * Example: Instrument Anthropic SDK calls with Lantern.
 *
 * This example shows how to add full observability to your
 * Claude-powered agent with just 3 lines of setup code.
 */

// import Anthropic from "@anthropic-ai/sdk";
import { LanternTracer, ConsoleExporter, wrapAnthropicClient } from "@lantern-ai/sdk";

// 1. Create a tracer with a console exporter (for dev)
const tracer = new LanternTracer({
  serviceName: "my-agent",
  environment: "dev",
  exporter: new ConsoleExporter({ verbose: true }),
});

// 2. Wrap your Anthropic client (uncomment when using real SDK)
// const anthropic = wrapAnthropicClient(new Anthropic(), tracer);
// All calls to anthropic.messages.create() are now traced automatically

// 3. Use the client as normal — traces are captured in the background
// const response = await anthropic.messages.create({
//   model: "claude-sonnet-4-5-20251001",
//   max_tokens: 1024,
//   messages: [{ role: "user", content: "Hello!" }],
// });

// Demo: manual trace for illustration
async function demo() {
  const trace = tracer.startTrace({
    agentName: "demo-agent",
    environment: "dev",
  });

  const span = tracer.startSpan(trace.id, {
    type: "llm_call",
    input: { messages: [{ role: "user", content: "Hello, how are you?" }] },
    model: "claude-sonnet-4-5-20251001",
  });

  // Simulate LLM response
  tracer.endSpan(span.id, {
    content: "I'm doing well, thank you for asking!",
    stopReason: "end_turn",
  }, {
    inputTokens: 12,
    outputTokens: 15,
  });

  tracer.endTrace(trace.id, "success");

  await tracer.flush();
  await tracer.shutdown();
}

demo().catch(console.error);

// Re-export for type checking
export { tracer, wrapAnthropicClient };
