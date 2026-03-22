# LlamaIndex

Trace LlamaIndex LLM calls, retrieval queries, embeddings, and custom events through a lightweight event handler.

## Installation

```bash
npm install @lantern-ai/sdk llamaindex
```

No additional integration package is needed — the LlamaIndex collector is included in `@lantern-ai/sdk`.

## Setup

```typescript
import { LanternTracer, createLanternEventHandler } from "@lantern-ai/sdk";

const tracer = new LanternTracer({
  apiKey: process.env.LANTERN_API_KEY,
  baseUrl: process.env.LANTERN_BASE_URL,
});

const handler = createLanternEventHandler(tracer, {
  agentName: "my-rag-agent", // optional, defaults to "llamaindex-agent"
});
```

## Usage

### Register with LlamaIndex Settings

```typescript
import { Settings } from "llamaindex";

Settings.callbackManager.addHandler(handler);
```

All subsequent LlamaIndex operations (queries, retrievals, LLM calls) are now automatically traced.

### Use with an existing trace

```typescript
const handler = createLanternEventHandler(tracer, {
  traceId: existingTraceId,
  agentName: "sub-query",
});
```

### Query example

```typescript
import { VectorStoreIndex } from "llamaindex";

const index = await VectorStoreIndex.fromDocuments(documents);
const queryEngine = index.asQueryEngine();

const response = await queryEngine.query("What is Lantern?");
// Spans for retrieval + LLM call are automatically created
```

## What Gets Traced

| LlamaIndex Event | Lantern Span Type | Captured Data |
|------------------|-------------------|---------------|
| `llm_start` / `llm_end` | `llm_call` | Model name, messages, response text, token usage |
| `retrieval_start` / `retrieval_end` | `retrieval` | Query text, node count |
| `query_start` / `query_end` | `custom` | Query text, response |
| `embedding_start` / `embedding_end` | `custom` | Embedding request/response |

The handler matches `_start` and `_end` events by event ID, so spans are properly paired even when operations interleave.

### Token extraction

Token usage is extracted from the LLM response's `raw.usage` object. Both OpenAI-style (`prompt_tokens` / `completion_tokens`) and Anthropic-style (`input_tokens` / `output_tokens`) field names are supported.

## Troubleshooting

**No spans appearing**
- Make sure the handler is registered via `Settings.callbackManager.addHandler(handler)` before executing queries.
- Verify that `LANTERN_API_KEY` and `LANTERN_BASE_URL` are set correctly.

**Missing token counts**
- Token usage requires the underlying LLM provider to return a `usage` object in its raw response.

**Events not pairing correctly**
- The handler uses the `id` or `eventId` field from the event payload. If your custom LlamaIndex component doesn't emit these fields, spans may not pair and the `_end` event will be silently ignored.

## API Reference

```typescript
function createLanternEventHandler(
  tracer: LanternTracer,
  opts?: {
    traceId?: string;
    agentName?: string;
  }
): LlamaIndexCallbackHandler;
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `tracer` | `LanternTracer` | A configured Lantern tracer instance |
| `opts.traceId` | `string` | Optional — attach spans to an existing trace |
| `opts.agentName` | `string` | Optional — name shown in dashboard (default: `"llamaindex-agent"`) |
