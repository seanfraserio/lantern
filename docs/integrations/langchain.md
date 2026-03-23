# LangChain

Trace LangChain LLM calls, tool invocations, chain executions, and retriever queries with a single callback handler.

## Installation

```bash
npm install @openlantern-ai/sdk langchain @langchain/core
```

No additional integration package is needed — the LangChain collector is included in `@openlantern-ai/sdk`.

## Setup

```typescript
import { LanternTracer, createLanternCallbackHandler } from "@openlantern-ai/sdk";

const tracer = new LanternTracer({
  apiKey: process.env.LANTERN_API_KEY,
  baseUrl: process.env.LANTERN_BASE_URL,
});

const handler = createLanternCallbackHandler(tracer, {
  agentName: "my-langchain-agent", // optional, defaults to "langchain-agent"
});
```

## Usage

### Pass as callbacks to any LangChain component

```typescript
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  modelName: "gpt-4",
  callbacks: [handler],
});

const response = await model.invoke("Explain quantum computing");
```

### Use with chains

```typescript
import { RetrievalQAChain } from "langchain/chains";

const chain = RetrievalQAChain.fromLLM(model, retriever, {
  callbacks: [handler],
});

const result = await chain.invoke({ query: "What is Lantern?" });
```

### Use with an existing trace

If you already have an active trace (e.g., from a parent request), pass its ID to avoid creating a new one:

```typescript
const handler = createLanternCallbackHandler(tracer, {
  traceId: existingTraceId,
  agentName: "sub-chain",
});
```

## What Gets Traced

| LangChain Event | Lantern Span Type | Captured Data |
|-----------------|-------------------|---------------|
| `handleLLMStart` / `handleLLMEnd` | `llm_call` | Model name, prompt text, response text, token usage |
| `handleToolStart` / `handleToolEnd` | `tool_call` | Tool name, input arguments, output |
| `handleChainStart` / `handleChainEnd` | `custom` | Chain inputs and outputs |
| `handleRetrieverStart` / `handleRetrieverEnd` | `retrieval` | Query text, document count |
| Any `*Error` handler | Sets error on span | Error message |

The handler automatically manages trace lifecycle — if no `traceId` is provided, it creates a trace on the first event and ends it when all active spans complete.

### Span hierarchy

Parent-child relationships are preserved. When LangChain reports a `parentRunId`, the corresponding Lantern span is nested under the parent span, giving you a full execution tree in the dashboard.

## Troubleshooting

**Spans not appearing**
- Verify the handler is passed in the `callbacks` array, not as a single object.
- Check that `LANTERN_API_KEY` and `LANTERN_BASE_URL` are set correctly.

**Missing token counts**
- Token usage depends on the LLM provider returning `tokenUsage` in its response. Not all providers include this data.

**Duplicate traces**
- If you pass the handler to multiple components in the same request, each will create its own trace unless you provide a shared `traceId`.

## API Reference

```typescript
function createLanternCallbackHandler(
  tracer: LanternTracer,
  opts?: {
    traceId?: string;
    agentName?: string;
  }
): LangChainCallbackHandler;
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `tracer` | `LanternTracer` | A configured Lantern tracer instance |
| `opts.traceId` | `string` | Optional — attach spans to an existing trace |
| `opts.agentName` | `string` | Optional — name shown in dashboard (default: `"langchain-agent"`) |
