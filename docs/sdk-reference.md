# SDK Reference

## LanternTracer

The core tracer class.

### Constructor

```typescript
new LanternTracer(config: TracerConfig)
```

- `serviceName` — Name of your service/agent
- `environment` — Current environment (dev/staging/production)
- `exporter` — Where to send traces (LanternExporter, ConsoleExporter, or OtlpExporter)
- `batchSize` — Number of traces to buffer before flushing (default: 50)
- `flushIntervalMs` — Flush interval in milliseconds (default: 5000)

### Methods

- `startTrace(opts)` — Start a new trace
- `startSpan(traceId, opts)` — Start a span within a trace
- `endSpan(spanId, output, opts?)` — End a span with output
- `endTrace(traceId, status)` — End a trace
- `flush()` — Flush buffered traces to the exporter
- `shutdown()` — Flush and shutdown the tracer

## Auto-instrumentation

### Core SDK (`@lantern-ai/sdk`)

These collectors ship with the core SDK — no extra packages needed.

#### wrapAnthropicClient(client, tracer, opts?)

Instruments all `messages.create()` calls on an Anthropic client. See [Anthropic integration](./integrations/anthropic.md).

#### wrapOpenAIClient(client, tracer, opts?)

Instruments all `chat.completions.create()` calls on an OpenAI client. See [OpenAI integration](./integrations/openai.md).

#### wrapOpenAICompatClient(client, tracer, opts)

Instruments any OpenAI-compatible provider (Groq, Together, Fireworks, DeepSeek, Perplexity, Ollama, OpenRouter, xAI, Cerebras, Novita). Requires a `provider` label in `opts`. See [OpenAI-compatible integration](./integrations/openai-compatible.md).

#### wrapGoogleGenerativeModel(model, tracer, opts?)

Instruments `model.generateContent()` calls on a Google Generative AI model. See [Google integration](./integrations/google.md).

#### wrapMcpClient(client, tracer, opts?)

Instruments `callTool()` calls on an MCP client. See [MCP integration](./integrations/mcp.md).

#### createLanternCallbackHandler(tracer, opts?)

Returns a LangChain callback handler that traces LLM and chain calls. See [LangChain integration](./integrations/langchain.md).

#### createLanternEventHandler(tracer, opts?)

Returns a LlamaIndex event handler that traces queries and retrievals. See [LlamaIndex integration](./integrations/llamaindex.md).

#### wrapGenerateText(fn, tracer, opts?) / wrapStreamText(fn, tracer, opts?)

Wraps Vercel AI SDK functions to trace text generation and streaming. See [Vercel AI integration](./integrations/vercel-ai.md).

### Integration Packages

These collectors live in separate packages with peer dependencies on their respective SDKs.

#### wrapMistralClient(client, tracer, opts?)

From `@lantern-ai/mistral`. Instruments `client.chat.complete()`. See [Mistral integration](./integrations/mistral.md).

#### wrapCohereClient(client, tracer, opts?)

From `@lantern-ai/cohere`. Instruments `client.chat()` and `client.generate()`. See [Cohere integration](./integrations/cohere.md).

#### wrapBedrockClient(client, tracer, opts?)

From `@lantern-ai/bedrock`. Instruments `client.send()` for ConverseCommand and InvokeModelCommand. See [Bedrock integration](./integrations/bedrock.md).

#### createLanternTraceProcessor(tracer, opts?)

From `@lantern-ai/openai-agents`. Returns a trace processor for the OpenAI Agents SDK. See [OpenAI Agents integration](./integrations/openai-agents.md).

#### createLanternMastraHook(tracer, opts?)

From `@lantern-ai/mastra`. Returns a telemetry hook for Mastra. See [Mastra integration](./integrations/mastra.md).

### Shared Utilities

These helpers are used internally by collectors and are available for building custom integrations.

#### normalizeTokens(raw)

Normalizes any provider's token usage fields to `{ inputTokens, outputTokens }`. Handles OpenAI (`prompt_tokens`/`completion_tokens`), Anthropic (`input_tokens`/`output_tokens`), Mistral (camelCase), and Bedrock formats.

#### getPricing(model, provider?)

Returns `{ inputPer1k, outputPer1k }` pricing in USD for a given model. Pass `provider` for provider-specific pricing (e.g., Groq-hosted Llama vs Together-hosted Llama).

#### normalizeMessages(messages)

Converts any provider's message format to a standard `{ role: string, content: string }[]` array. Handles Anthropic content blocks, OpenAI multi-part content, and plain strings.

#### wrapWithTrace(opts: WrapOpts, fn)

Lifecycle wrapper for building custom collectors. Handles trace/span creation, token extraction, cost calculation, and error handling. All built-in collectors use this internally.

#### WrapOpts (type)

Options interface for `wrapWithTrace`:

| Field | Type | Description |
|-------|------|-------------|
| `spanType` | string | Span type (`"llm_call"`, `"tool_call"`, etc.) |
| `model` | string or function | Model identifier or extractor function |
| `provider` | string | Provider label for cost lookups |
| `buildInput` | function | Extracts span input from call arguments |
| `extractTokens` | function | Extracts token counts from the response |
| `extractOutput` | function | Extracts span output from the response |

## Exporters

### LanternExporter
Sends traces to a Lantern ingest server via HTTP.

### ConsoleExporter
Prints traces to stdout. Useful for development.

### OtlpExporter
OpenTelemetry Protocol-compatible export for interop with existing observability stacks.
