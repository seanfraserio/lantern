# OpenAI

Auto-instrument OpenAI API calls with full tracing, token counting, and cost estimation.

## Installation

**TypeScript:**
```bash
npm install @openlantern-ai/sdk openai
```

**Python:**
```bash
pip install lantern-ai openai
```

## Setup

**TypeScript:**
```typescript
import OpenAI from "openai";
import { LanternTracer, LanternExporter, wrapOpenAIClient } from "@openlantern-ai/sdk";

const tracer = new LanternTracer({
  serviceName: "my-agent",
  exporter: new LanternExporter({
    endpoint: "https://your-lantern-instance.com",
    apiKey: process.env.LANTERN_API_KEY!,
  }),
});

const client = wrapOpenAIClient(new OpenAI(), tracer);
```

**Python:**
```python
import os
from openai import OpenAI
from lantern_ai import LanternTracer
from lantern_ai.collectors import wrap_openai_client
from lantern_ai.exporters import LanternExporter

tracer = LanternTracer(
    service_name="my-agent",
    exporter=LanternExporter(
        endpoint="https://your-lantern-instance.com",
        api_key=os.environ["LANTERN_API_KEY"],
    ),
)

client = OpenAI()
wrap_openai_client(client, tracer)
```

## Usage

**TypeScript:**
```typescript
// All calls are now traced automatically
const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Explain quantum computing in one paragraph." }],
});

// Tool calls are captured as child spans
const toolResponse = await client.chat.completions.create({
  model: "gpt-4o",
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

**Python:**
```python
# Sync client — all calls traced automatically
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Explain quantum computing in one paragraph."}],
)

# Async client works too — wrap_openai_client auto-detects sync vs async
from openai import AsyncOpenAI

async_client = AsyncOpenAI()
wrap_openai_client(async_client, tracer)

response = await async_client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)

tracer.shutdown()
```

## What Gets Traced

| Span Type | Created When | Data Captured |
|-----------|-------------|---------------|
| `llm_call` | Each `chat.completions.create()` call | Input messages, output text, model, prompt/completion tokens, estimated cost, finish reason |
| `tool_call` | Each tool call in the response | Tool name, arguments (from `function.arguments`), parent LLM span |

The wrapper reads token counts from `response.usage.prompt_tokens` and `response.usage.completion_tokens`. Only the first choice (`choices[0]`) is captured in the span output.

## Options

Both the TypeScript and Python wrappers accept optional parameters:

| Option | Type | Description |
|--------|------|-------------|
| `traceId` / `trace_id` | `string` | Attach spans to an existing trace instead of creating a new one per call |
| `agentName` / `agent_name` | `string` | Agent name for auto-created traces (default: `"openai-agent"`) |

## Troubleshooting

- **Streaming not traced:** The wrapper instruments the non-streaming `chat.completions.create()` path. For streaming, use the [LLM Proxy](../how-to/use-llm-proxy.md) instead.
- **Only first choice captured:** If you use `n > 1`, only `choices[0]` is recorded in the span. Additional choices are still returned in the response.
- **Token counts missing:** Some fine-tuned or preview models may not return usage data. The wrapper reads `response.usage.prompt_tokens` / `completion_tokens` directly.
