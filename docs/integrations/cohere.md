# Cohere

Auto-instrument Cohere API calls with full tracing, token counting, and cost estimation. The wrapper instruments both `chat()` and `generate()` methods.

## Installation

```bash
npm install @openlantern-ai/cohere cohere-ai
```

`@openlantern-ai/cohere` has a peer dependency on `@openlantern-ai/sdk` — install it if you haven't already:

```bash
npm install @openlantern-ai/sdk
```

## Setup

```typescript
import { CohereClient } from "cohere-ai";
import { LanternTracer, LanternExporter } from "@openlantern-ai/sdk";
import { wrapCohereClient } from "@openlantern-ai/cohere";

const tracer = new LanternTracer({
  serviceName: "my-agent",
  exporter: new LanternExporter({
    endpoint: "https://your-lantern-instance.com",
    apiKey: process.env.LANTERN_API_KEY!,
  }),
});

const client = wrapCohereClient(new CohereClient({ token: process.env.COHERE_API_KEY! }), tracer);
```

## Usage

```typescript
// chat() is traced automatically
const chatResponse = await client.chat({
  model: "command-r",
  message: "Explain quantum computing in one paragraph.",
});

// generate() is also traced
const generateResponse = await client.generate({
  model: "command-r",
  prompt: "Write a haiku about observability.",
});

await tracer.shutdown();
```

## What Gets Traced

| Span Type | Created When | Data Captured |
|-----------|-------------|---------------|
| `llm_call` | Each `chat()` call | Input message, output text (`response.text`), model, billed input/output tokens, finish reason |
| `llm_call` | Each `generate()` call | Input prompt, first generation text, model, billed input/output tokens |

Token counts are read from `response.meta.billedUnits.inputTokens` and `response.meta.billedUnits.outputTokens`. For `chat()`, the input is captured as a single user message from `params.message`. For `generate()`, the input is captured from `params.prompt`.

## Options

| Option | Type | Description |
|--------|------|-------------|
| `traceId` | `string` | Attach spans to an existing trace instead of creating a new one per call |
| `agentName` | `string` | Agent name for auto-created traces (default: `"cohere-agent"`) |

## Troubleshooting

- **Both `chat()` and `generate()` are instrumented:** The wrapper patches both methods. If you only use one, the other is still wrapped but won't produce spans unless called.
- **Token counts show 0:** Cohere returns billed units in `meta.billedUnits`. If this field is missing (e.g., in testing), tokens default to `0`.
- **Only first generation captured:** For `generate()`, only `response.generations[0].text` is recorded in the span output.
- **Default model is `command-r`:** If `params.model` is not provided, the span records the model as `"command-r"`.
