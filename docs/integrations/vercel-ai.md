# Vercel AI SDK

Trace `generateText()` and `streamText()` calls from the Vercel AI SDK with zero-config function wrappers.

## Installation

```bash
npm install @lantern-ai/sdk ai
```

No additional integration package is needed — the Vercel AI collectors are included in `@lantern-ai/sdk`.

## Setup

```typescript
import { generateText, streamText } from "ai";
import { LanternTracer, wrapGenerateText, wrapStreamText } from "@lantern-ai/sdk";

const tracer = new LanternTracer({
  apiKey: process.env.LANTERN_API_KEY,
  baseUrl: process.env.LANTERN_BASE_URL,
});

const tracedGenerateText = wrapGenerateText(generateText, tracer, {
  agentName: "my-agent", // optional, defaults to "vercel-ai-agent"
});

const tracedStreamText = wrapStreamText(streamText, tracer, {
  agentName: "my-agent",
});
```

## Usage

### Generate text

```typescript
import { openai } from "@ai-sdk/openai";

const result = await tracedGenerateText({
  model: openai("gpt-4"),
  prompt: "Explain quantum computing in one paragraph",
});

console.log(result.text);
```

### Stream text

```typescript
import { openai } from "@ai-sdk/openai";

const result = tracedStreamText({
  model: openai("gpt-4"),
  prompt: "Write a haiku about observability",
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
// Span is automatically closed when the stream ends
```

### Tool calls

When `generateText` returns tool calls, each tool is traced as a child `tool_call` span under the parent `llm_call` span:

```typescript
const result = await tracedGenerateText({
  model: openai("gpt-4"),
  prompt: "What's the weather in London?",
  tools: {
    getWeather: {
      description: "Get current weather for a city",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => `Sunny, 22°C in ${city}`,
    },
  },
});
```

### Use with an existing trace

```typescript
const tracedGenerateText = wrapGenerateText(generateText, tracer, {
  traceId: existingTraceId,
});
```

## What Gets Traced

| Operation | Lantern Span Type | Captured Data |
|-----------|-------------------|---------------|
| `generateText()` | `llm_call` | Model ID, messages/prompt, response text, token usage, finish reason |
| `streamText()` | `llm_call` | Model ID, messages/prompt, accumulated text, token usage (when stream completes) |
| Tool calls (from `generateText`) | `tool_call` | Tool name, arguments, result |

### How streaming works

The `wrapStreamText` wrapper returns the original stream result with a transparent proxy on `textStream`. As you consume chunks, they are accumulated internally. When the stream completes, the full text, token usage, and finish reason are recorded on the span.

### Model name extraction

The model name is extracted from the Vercel AI SDK model object. It checks `modelId`, `modelName`, or falls back to the string representation. This works with all provider packages (`@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.).

## Troubleshooting

**Stream span never closes**
- The span closes when the `textStream` async iterator finishes. If you stop consuming the stream early (e.g., via `break`), the span may remain open. Always consume the full stream or handle cleanup explicitly.

**Missing token usage on streams**
- Token usage for streams comes from `result.usage`, which is a Promise that resolves after the stream completes. If the provider doesn't support streaming usage, these fields will be undefined.

**Tool call spans missing**
- Tool call child spans are only created for `generateText()`. `streamText()` does not currently produce tool call spans — tool results arrive asynchronously during streaming.

## API Reference

### wrapGenerateText

```typescript
function wrapGenerateText(
  generateTextFn: (params: VercelGenerateTextParams) => Promise<VercelGenerateTextResult>,
  tracer: LanternTracer,
  opts?: {
    traceId?: string;
    agentName?: string;
  }
): typeof generateTextFn;
```

### wrapStreamText

```typescript
function wrapStreamText(
  streamTextFn: Function,
  tracer: LanternTracer,
  opts?: {
    traceId?: string;
    agentName?: string;
  }
): Function;
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `generateTextFn` / `streamTextFn` | `Function` | The original Vercel AI SDK function to wrap |
| `tracer` | `LanternTracer` | A configured Lantern tracer instance |
| `opts.traceId` | `string` | Optional — attach spans to an existing trace |
| `opts.agentName` | `string` | Optional — name shown in dashboard (default: `"vercel-ai-agent"`) |
