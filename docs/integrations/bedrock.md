# AWS Bedrock

Auto-instrument AWS Bedrock API calls with full tracing, token counting, and cost estimation. The wrapper instruments `client.send()` and selectively traces `ConverseCommand` and `InvokeModelCommand` calls.

## Installation

```bash
npm install @openlantern-ai/bedrock @aws-sdk/client-bedrock-runtime
```

`@openlantern-ai/bedrock` has a peer dependency on `@openlantern-ai/sdk` — install it if you haven't already:

```bash
npm install @openlantern-ai/sdk
```

## Setup

```typescript
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { LanternTracer, LanternExporter } from "@openlantern-ai/sdk";
import { wrapBedrockClient } from "@openlantern-ai/bedrock";

const tracer = new LanternTracer({
  serviceName: "my-agent",
  exporter: new LanternExporter({
    endpoint: "https://your-lantern-instance.com",
    apiKey: process.env.LANTERN_API_KEY!,
  }),
});

const client = wrapBedrockClient(
  new BedrockRuntimeClient({ region: "us-east-1" }),
  tracer,
);
```

## Usage

```typescript
// ConverseCommand calls are traced automatically
const response = await client.send(
  new ConverseCommand({
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages: [
      {
        role: "user",
        content: [{ text: "Explain quantum computing in one paragraph." }],
      },
    ],
  }),
);

// InvokeModelCommand calls are also traced
import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const invokeResponse = await client.send(
  new InvokeModelCommand({
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    body: JSON.stringify({
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 256,
    }),
  }),
);

await tracer.shutdown();
```

## What Gets Traced

| Span Type | Created When | Data Captured |
|-----------|-------------|---------------|
| `llm_call` | Each `send(ConverseCommand)` call | Input messages (normalized from Bedrock format), output text, model ID, input/output tokens, estimated cost, stop reason |
| `llm_call` | Each `send(InvokeModelCommand)` call | Input messages, output text, model ID, input/output tokens |

Non-LLM commands (e.g., `ListFoundationModelsCommand`) pass through the wrapper without being traced.

### How it works

The wrapper inspects the command constructor name:
- Commands starting with `Converse` are traced — tokens come from `response.usage.inputTokens` / `outputTokens`
- Commands starting with `InvokeModel` are traced — tokens are extracted from the response body
- All other commands pass through to the original `send()` unchanged

Input messages are normalized from Bedrock's `messages[].content[].text` format into Lantern's standard `{role, content}` structure.

## Options

| Option | Type | Description |
|--------|------|-------------|
| `traceId` | `string` | Attach spans to an existing trace instead of creating a new one per call |
| `agentName` | `string` | Agent name for auto-created traces (default: `"bedrock-agent"`) |

## Troubleshooting

- **Non-LLM commands not traced:** This is intentional. Only `Converse*` and `InvokeModel*` commands produce spans. Other Bedrock operations (listing models, etc.) pass through unwrapped.
- **Model ID shows "unknown":** Ensure you pass `modelId` in the command input. The wrapper reads `input.modelId` from the command.
- **Token counts are 0:** For `ConverseCommand`, tokens come from `response.usage`. For `InvokeModelCommand`, token reporting depends on the underlying model's response format.
- **AWS credentials:** The wrapper doesn't handle authentication — configure your `BedrockRuntimeClient` with proper AWS credentials (env vars, IAM role, or SSO profile).
