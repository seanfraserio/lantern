# Mistral

Auto-instrument Mistral AI API calls with full tracing, token counting, and cost estimation.

## Installation

```bash
npm install @openlantern-ai/mistral @mistralai/mistralai
```

`@openlantern-ai/mistral` has a peer dependency on `@openlantern-ai/sdk` — install it if you haven't already:

```bash
npm install @openlantern-ai/sdk
```

## Setup

```typescript
import { Mistral } from "@mistralai/mistralai";
import { LanternTracer, LanternExporter } from "@openlantern-ai/sdk";
import { wrapMistralClient } from "@openlantern-ai/mistral";

const tracer = new LanternTracer({
  serviceName: "my-agent",
  exporter: new LanternExporter({
    endpoint: "https://your-lantern-instance.com",
    apiKey: process.env.LANTERN_API_KEY!,
  }),
});

const client = wrapMistralClient(new Mistral({ apiKey: process.env.MISTRAL_API_KEY! }), tracer);
```

## Usage

```typescript
// All calls are now traced automatically
const response = await client.chat.complete({
  model: "mistral-large-latest",
  messages: [{ role: "user", content: "Explain quantum computing in one paragraph." }],
});

// Tool calls are captured as child spans
const toolResponse = await client.chat.complete({
  model: "mistral-large-latest",
  messages: [{ role: "user", content: "What's the weather in London?" }],
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    },
  }],
});

await tracer.shutdown();
```

## What Gets Traced

| Span Type | Created When | Data Captured |
|-----------|-------------|---------------|
| `llm_call` | Each `chat.complete()` call | Input messages, output text, model, prompt/completion tokens, estimated cost, finish reason |
| `tool_call` | Each tool call in the response | Tool name, arguments (from `function.arguments`), parent LLM span |

Token counts are read from Mistral's camelCase response fields: `response.usage.promptTokens` and `response.usage.completionTokens`. The finish reason comes from `choice.finishReason` (also camelCase).

## Options

| Option | Type | Description |
|--------|------|-------------|
| `traceId` | `string` | Attach spans to an existing trace instead of creating a new one per call |
| `agentName` | `string` | Agent name for auto-created traces (default: `"mistral-agent"`) |

## Troubleshooting

- **Method is `chat.complete()`, not `chat.completions.create()`:** Mistral's SDK uses a different method name than OpenAI. The wrapper instruments `client.chat.complete()`.
- **Token field names are camelCase:** Unlike OpenAI (`prompt_tokens`), Mistral uses `promptTokens` and `completionTokens`. The wrapper handles this automatically.
- **Streaming not traced:** The wrapper instruments the non-streaming `chat.complete()` path. For streaming, use the [LLM Proxy](../how-to/use-llm-proxy.md) instead.
