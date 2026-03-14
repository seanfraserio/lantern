import type { LanternTracer } from "../tracer.js";

// TODO: Implement OpenAI SDK auto-instrumentation
// Similar pattern to anthropic.ts — wrap client.chat.completions.create()

interface OpenAIClient {
  chat: {
    completions: {
      create: (...args: unknown[]) => Promise<unknown>;
    };
  };
}

/**
 * Wrap an OpenAI client to automatically trace all chat.completions.create() calls.
 */
export function wrapOpenAIClient<T extends OpenAIClient>(
  client: T,
  _tracer: LanternTracer
): T {
  // TODO: Implement OpenAI auto-instrumentation
  // Should intercept client.chat.completions.create() calls
  // and create llm_call spans with input/output/token data
  console.warn("[lantern] OpenAI auto-instrumentation not yet implemented");
  return client;
}
