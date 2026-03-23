# Anthropic

Auto-instrument Anthropic Claude API calls with full tracing, token counting, and cost estimation.

## Installation

**TypeScript:**
```bash
npm install @openlantern-ai/sdk @anthropic-ai/sdk
```

**Python:**
```bash
pip install lantern-ai anthropic
```

## Setup

**TypeScript:**
```typescript
import Anthropic from "@anthropic-ai/sdk";
import { LanternTracer, LanternExporter, wrapAnthropicClient } from "@openlantern-ai/sdk";

const tracer = new LanternTracer({
  serviceName: "my-agent",
  exporter: new LanternExporter({
    endpoint: "https://your-lantern-instance.com",
    apiKey: process.env.LANTERN_API_KEY!,
  }),
});

const client = wrapAnthropicClient(new Anthropic(), tracer);
```

**Python:**
```python
import os
from anthropic import Anthropic
from lantern_ai import LanternTracer
from lantern_ai.collectors import wrap_anthropic_client
from lantern_ai.exporters import LanternExporter

tracer = LanternTracer(
    service_name="my-agent",
    exporter=LanternExporter(
        endpoint="https://your-lantern-instance.com",
        api_key=os.environ["LANTERN_API_KEY"],
    ),
)

client = Anthropic()
wrap_anthropic_client(client, tracer)
```

## Usage

**TypeScript:**
```typescript
// All calls are now traced automatically
const response = await client.messages.create({
  model: "claude-sonnet-4-5-20251001",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Explain quantum computing in one paragraph." }],
});

// Tool calls are captured as child spans
const toolResponse = await client.messages.create({
  model: "claude-sonnet-4-5-20251001",
  max_tokens: 1024,
  messages: [{ role: "user", content: "What's the weather in London?" }],
  tools: [{
    name: "get_weather",
    description: "Get weather for a city",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
    },
  }],
});

await tracer.shutdown();
```

**Python:**
```python
# Sync client — all calls traced automatically
response = client.messages.create(
    model="claude-sonnet-4-5-20251001",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Explain quantum computing in one paragraph."}],
)

# Async client works too — wrap_anthropic_client auto-detects sync vs async
from anthropic import AsyncAnthropic

async_client = AsyncAnthropic()
wrap_anthropic_client(async_client, tracer)

response = await async_client.messages.create(
    model="claude-sonnet-4-5-20251001",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)

tracer.shutdown()
```

## What Gets Traced

| Span Type | Created When | Data Captured |
|-----------|-------------|---------------|
| `llm_call` | Each `messages.create()` call | Input messages, output text, model, input/output tokens, estimated cost, stop reason |
| `tool_call` | Each `tool_use` content block in the response | Tool name, tool arguments, parent LLM span |

The wrapper reads token counts directly from `response.usage.input_tokens` and `response.usage.output_tokens`. Content arrays (images, tool results) have their text extracted and concatenated; non-text blocks are serialized as JSON.

## Options

Both the TypeScript and Python wrappers accept optional parameters:

| Option | Type | Description |
|--------|------|-------------|
| `traceId` / `trace_id` | `string` | Attach spans to an existing trace instead of creating a new one per call |
| `agentName` / `agent_name` | `string` | Agent name for auto-created traces (default: `"anthropic-agent"`) |

## Troubleshooting

- **Streaming not traced:** The wrapper instruments the non-streaming `messages.create()` path. For streaming, use the [LLM Proxy](../how-to/use-llm-proxy.md) instead.
- **Content array not captured:** If messages use content arrays (images, tool results), text is extracted and concatenated. Non-text blocks are serialized as JSON.
- **Token counts missing:** Verify your Anthropic API key has usage reporting enabled. The wrapper reads `response.usage.input_tokens` / `output_tokens` directly.
