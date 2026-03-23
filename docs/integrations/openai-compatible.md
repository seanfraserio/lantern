# OpenAI-Compatible Providers

Trace any provider that uses the OpenAI API format with a single collector. One wrapper covers Groq, Together AI, Fireworks, DeepSeek, Perplexity, Ollama, OpenRouter, xAI (Grok), Cerebras, and Novita AI.

## Installation

```bash
npm install @openlantern-ai/sdk openai
```

## Setup

```typescript
import OpenAI from "openai";
import { LanternTracer, LanternExporter, wrapOpenAICompatClient } from "@openlantern-ai/sdk";

const tracer = new LanternTracer({
  serviceName: "my-agent",
  exporter: new LanternExporter({
    endpoint: "https://your-lantern-instance.com",
    apiKey: process.env.LANTERN_API_KEY!,
  }),
});

// Point the OpenAI SDK at your provider's base URL
const client = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: process.env.GROQ_API_KEY,
});

// Wrap with the provider label — this is required
const traced = wrapOpenAICompatClient(client, tracer, { provider: "groq" });
```

## Supported Providers

| Provider | Base URL | Provider Label |
|----------|----------|---------------|
| Groq | `https://api.groq.com/openai/v1` | `"groq"` |
| Together AI | `https://api.together.xyz/v1` | `"together"` |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | `"fireworks"` |
| DeepSeek | `https://api.deepseek.com` | `"deepseek"` |
| Perplexity | `https://api.perplexity.ai` | `"perplexity"` |
| Ollama | `http://localhost:11434/v1` | `"ollama"` |
| OpenRouter | `https://openrouter.ai/api/v1` | `"openrouter"` |
| xAI (Grok) | `https://api.x.ai/v1` | `"xai"` |
| Cerebras | `https://api.cerebras.ai/v1` | `"cerebras"` |
| Novita AI | `https://api.novita.ai/v1/openai` | `"novita"` |

Any provider that implements the OpenAI `chat.completions.create()` response format works — these are just the ones we've tested.

## Usage

```typescript
const response = await traced.chat.completions.create({
  model: "llama-3.1-70b-versatile",
  messages: [{ role: "user", content: "Hello!" }],
});

await tracer.shutdown();
```

## What Gets Traced

| Span Type | Created When | Data Captured |
|-----------|-------------|---------------|
| `llm_call` | Each `chat.completions.create()` call | Input messages, output text, model, prompt/completion tokens, estimated cost, finish reason |
| `tool_call` | Each tool call in the response | Tool name, arguments (from `function.arguments`), parent LLM span |

The `provider` label is stored in `Trace.metadata.provider`, so you can filter traces by provider in the dashboard.

## Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `provider` | `string` | **Yes** | Provider label stored in trace metadata (e.g., `"groq"`, `"together"`) |
| `traceId` | `string` | No | Attach spans to an existing trace instead of creating a new one per call |
| `agentName` | `string` | No | Agent name for auto-created traces (default: `"{provider}-agent"`) |

## Troubleshooting

- **Wrong provider shown in dashboard:** Make sure you pass the `provider` option to `wrapOpenAICompatClient`. Without it, traces show as generic.
- **Cost estimates incorrect:** Some providers use custom model IDs not in the pricing table. Check `getPricing(model, provider)` — unknown models fall back to default pricing.
- **Ollama token counts are 0:** Ollama's OpenAI-compatible endpoint may not return usage data for all models. This is a provider-side limitation.
- **Provider not listed above:** Any OpenAI-compatible API works. Set `baseURL` on the OpenAI client and choose a descriptive `provider` label.
