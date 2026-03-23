# Google Gemini

Auto-instrument Google Generative AI (Gemini) calls with full tracing, token counting, and cost estimation.

## Installation

```bash
npm install @openlantern-ai/sdk @google/generative-ai
```

## Setup

```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";
import { LanternTracer, LanternExporter, wrapGoogleGenerativeModel } from "@openlantern-ai/sdk";

const tracer = new LanternTracer({
  serviceName: "my-agent",
  exporter: new LanternExporter({
    endpoint: "https://your-lantern-instance.com",
    apiKey: process.env.LANTERN_API_KEY!,
  }),
});

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
const model = wrapGoogleGenerativeModel(
  genAI.getGenerativeModel({ model: "gemini-pro" }),
  tracer,
  { modelName: "gemini-pro" },
);
```

## Usage

```typescript
// All generateContent() calls are now traced automatically
const result = await model.generateContent({
  contents: [{ role: "user", parts: [{ text: "Explain quantum computing." }] }],
});

const text = result.response.text();

// Function calls are captured as child spans
const functionModel = wrapGoogleGenerativeModel(
  genAI.getGenerativeModel({
    model: "gemini-pro",
    tools: [{
      functionDeclarations: [{
        name: "get_weather",
        description: "Get weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      }],
    }],
  }),
  tracer,
  { modelName: "gemini-pro" },
);

const fcResult = await functionModel.generateContent({
  contents: [{ role: "user", parts: [{ text: "What's the weather in London?" }] }],
});

await tracer.shutdown();
```

## What Gets Traced

| Span Type | Created When | Data Captured |
|-----------|-------------|---------------|
| `llm_call` | Each `generateContent()` call | Input messages (from `contents`), output text, model name, prompt/candidate tokens, estimated cost, finish reason |
| `tool_call` | Each function call in `response.functionCalls()` | Function name, arguments, parent LLM span |

The wrapper reads token counts from `response.usageMetadata.promptTokenCount` and `response.usageMetadata.candidatesTokenCount`. Input messages are normalized from Google's `contents[].parts[].text` format into Lantern's standard `{role, content}` structure.

## Options

| Option | Type | Description |
|--------|------|-------------|
| `traceId` | `string` | Attach spans to an existing trace instead of creating a new one per call |
| `agentName` | `string` | Agent name for auto-created traces (default: `"google-agent"`) |
| `modelName` | `string` | Model name to record in spans (the Google SDK doesn't expose the model name on responses, so pass it explicitly) |

## Troubleshooting

- **Model name missing in spans:** The Google Generative AI SDK doesn't include the model name in responses. Pass `modelName` in the options to record it.
- **Function calls not captured:** `response.functionCalls()` may throw if there are no function calls — this is handled gracefully. Ensure your model is configured with `tools` to enable function calling.
- **Token counts missing:** Verify your API key has Gemini API access. The wrapper reads `response.usageMetadata` — older SDK versions may not include this field.
