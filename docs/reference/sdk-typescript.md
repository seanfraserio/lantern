# TypeScript SDK Reference

Reference for `@lantern-ai/sdk`, the TypeScript SDK for Lantern agent
observability. The SDK provides trace and span management, multiple exporters,
and auto-instrumentation wrappers for Anthropic, OpenAI, and MCP clients.

**Package:** `@lantern-ai/sdk`
**Source:** `packages/sdk/`

---

## LanternTracer

The core tracer class. Manages traces and spans, buffers completed traces, and
exports them via the configured exporter.

### Constructor

```typescript
import { LanternTracer } from "@lantern-ai/sdk";

const tracer = new LanternTracer({
  serviceName: "my-service",
  environment: "production",
  exporter: myExporter,
  batchSize: 50,
  flushIntervalMs: 5000,
});
```

**`TracerConfig` options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `serviceName` | string | `"unknown"` | Logical name of the service producing traces |
| `environment` | string | `"dev"` | Deployment environment |
| `exporter` | `ITraceExporter` | -- | **Required.** The exporter to send traces to |
| `batchSize` | number | `50` | Number of traces to buffer before auto-flushing |
| `flushIntervalMs` | number | `5000` | Milliseconds between periodic background flushes |

The constructor starts a periodic flush timer (unreffed so it does not keep the
process alive).

### Methods

#### `startTrace(opts: StartTraceOpts): Trace`

Start a new trace for an agent execution. Returns the created `Trace` object.

```typescript
const trace = tracer.startTrace({
  agentName: "my-agent",
  agentVersion: "1.0.0",
  sessionId: "custom-session-id",       // optional, auto-generated if omitted
  environment: "production",            // optional, uses tracer default
  metadata: { userId: "user-123" },     // optional
});
```

**`StartTraceOpts`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `agentName` | string | Yes | Name of the agent being traced |
| `agentVersion` | string | No | Version of the agent |
| `sessionId` | string | No | Session UUID; auto-generated if omitted |
| `environment` | string | No | Overrides the tracer-level environment |
| `metadata` | `Record<string, unknown>` | No | Arbitrary key-value metadata |

#### `startSpan(traceId: string, opts: StartSpanOpts): Span`

Start a new span within a trace. Returns the created `Span` object.

```typescript
const span = tracer.startSpan(trace.id, {
  type: "llm_call",
  input: { messages: [{ role: "user", content: "Hello" }] },
  model: "claude-sonnet-4-5-20251001",
  parentSpanId: parentSpan.id,           // optional
  toolName: "search",                    // optional, for tool_call spans
});
```

**`StartSpanOpts`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `SpanType` | Yes | Span type (see Span Types below) |
| `input` | `SpanInput` | Yes | Input payload |
| `parentSpanId` | string | No | Parent span UUID for nesting |
| `model` | string | No | Model identifier (for `llm_call` spans) |
| `toolName` | string | No | Tool name (for `tool_call` spans) |

Throws if `traceId` is not found.

#### `endSpan(spanId: string, output: SpanOutput, opts?: { inputTokens?: number; outputTokens?: number; error?: string }): void`

End an active span with its output. Computes duration and cost estimation,
and adds the completed span to its parent trace.

```typescript
tracer.endSpan(span.id, {
  content: "Hello! How can I help?",
  stopReason: "end_turn",
}, {
  inputTokens: 10,
  outputTokens: 25,
});
```

Throws if `spanId` is not found or already ended.

#### `endTrace(traceId: string, status?: TraceStatus): void`

End a trace with a final status. Computes duration and moves the trace to the
export buffer. If the buffer reaches `batchSize`, an auto-flush is triggered.

```typescript
tracer.endTrace(trace.id, "success");
```

Default status is `"success"`.

#### `getTrace(traceId: string): Trace | undefined`

Get a trace by ID for inspection. Returns `undefined` if not found.

#### `flush(): Promise<void>`

Flush all buffered traces to the exporter immediately. If the export fails,
traces are returned to the buffer.

#### `shutdown(): Promise<void>`

Gracefully shut down the tracer: stop the periodic flush timer, flush remaining
traces, and shut down the exporter.

```typescript
await tracer.shutdown();
```

---

## AgentSpan

Internal builder class for creating and managing spans. Constructed by
`LanternTracer.startSpan()` -- not typically instantiated directly.

### Properties

| Property | Type | Description |
|---|---|---|
| `id` | string | Span UUID |
| `traceId` | string | Parent trace UUID |

### Methods

#### `end(output: SpanOutput, opts?): Span`

Finalise the span. Sets `endTime`, computes `durationMs`, applies token counts,
and calculates cost estimation based on the model.

#### `toSpan(): Span`

Return a snapshot copy of the underlying `Span` object.

---

## Exporters

All exporters implement the `ITraceExporter` interface:

```typescript
interface ITraceExporter {
  readonly exporterType: string;
  export(traces: Trace[]): Promise<void>;
  shutdown(): Promise<void>;
}
```

### LanternExporter

Exports traces to a Lantern ingest backend via HTTP POST. Supports exponential
backoff retry on 5xx errors and network failures.

```typescript
import { LanternExporter } from "@lantern-ai/sdk";

const exporter = new LanternExporter({
  endpoint: "https://ingest.openlanternai.com",
  apiKey: "ltn_abc123...",
  maxRetries: 3,
  retryBaseDelayMs: 1000,
});
```

**`LanternExporterConfig`:**

| Option | Type | Default | Description |
|---|---|---|---|
| `endpoint` | string | -- | **Required.** Base URL of the ingest server |
| `apiKey` | string | -- | Bearer token for the `Authorization` header |
| `maxRetries` | number | `3` | Number of retries on transient failures |
| `retryBaseDelayMs` | number | `1000` | Base delay in ms for exponential backoff |

**Retry behaviour:**

- Retries on HTTP 5xx responses (exponential backoff: 1s, 2s, 4s, ...)
- Retries on network errors (`TypeError`)
- Throws after all retries are exhausted
- Non-5xx error responses (e.g. 400, 401) are not retried

### ConsoleExporter

Exports traces to stdout. Useful for development and debugging.

```typescript
import { ConsoleExporter } from "@lantern-ai/sdk";

const exporter = new ConsoleExporter({ verbose: true });
```

| Option | Type | Default | Description |
|---|---|---|---|
| `verbose` | boolean | `false` | Print individual span details |

### OtlpExporter

OpenTelemetry-compatible exporter. Converts Lantern traces to OTLP JSON format
and exports via HTTP POST to an OTLP collector.

```typescript
import { OtlpExporter } from "@lantern-ai/sdk";

const exporter = new OtlpExporter({
  endpoint: "https://otlp.example.com",
  headers: { Authorization: "Bearer token" },
});
```

**`OtlpExporterConfig`:**

| Option | Type | Default | Description |
|---|---|---|---|
| `endpoint` | string | -- | **Required.** OTLP collector base URL |
| `headers` | `Record<string, string>` | `{}` | Additional HTTP headers |

**OTLP mapping:**

| Lantern concept | OTLP concept |
|---|---|
| Trace | ResourceSpan |
| `agentName` | `service.name` resource attribute |
| Span | Span (with appropriate kind) |
| `llm_call`, `tool_call`, `retrieval` | CLIENT kind (3) |
| `reasoning_step`, `custom` | INTERNAL kind (1) |
| Span error | Status code ERROR (2) |
| Completed span | Status code OK (1) |

---

## Auto-instrumentation Wrappers

### wrapAnthropicClient(client, tracer, opts?)

Monkey-patches an Anthropic client's `messages.create()` method to
automatically create `llm_call` spans with full input, output, and token data.

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { LanternTracer, LanternExporter, wrapAnthropicClient } from "@lantern-ai/sdk";

const tracer = new LanternTracer({ ... });
const client = wrapAnthropicClient(new Anthropic(), tracer);

// All client.messages.create() calls are now traced
const response = await client.messages.create({
  model: "claude-sonnet-4-5-20251001",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `client` | Anthropic client | The client instance to wrap |
| `tracer` | `LanternTracer` | Tracer to record spans on |
| `opts.traceId` | string | Existing trace to add spans to; creates new trace if omitted |
| `opts.agentName` | string | Agent name for auto-created traces (default `"anthropic-agent"`) |

**What it captures:**

- Input messages (flattened to `{ role, content }`)
- Text output content
- Tool use blocks (as child `tool_call` spans)
- Stop reason
- Token usage (`input_tokens`, `output_tokens`)
- Errors (span and trace marked as error)

Returns the same client instance (mutated in place).

---

### wrapOpenAIClient(client, tracer, opts?)

Monkey-patches an OpenAI client's `chat.completions.create()` method to
automatically create `llm_call` spans.

```typescript
import OpenAI from "openai";
import { LanternTracer, LanternExporter, wrapOpenAIClient } from "@lantern-ai/sdk";

const tracer = new LanternTracer({ ... });
const client = wrapOpenAIClient(new OpenAI(), tracer);

// All client.chat.completions.create() calls are now traced
const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `client` | OpenAI client | The client instance to wrap |
| `tracer` | `LanternTracer` | Tracer to record spans on |
| `opts.traceId` | string | Existing trace to add spans to |
| `opts.agentName` | string | Agent name for auto-created traces (default `"openai-agent"`) |

**What it captures:**

- Input messages
- First choice text content
- Tool calls (as child `tool_call` spans)
- Finish reason
- Token usage (`prompt_tokens`, `completion_tokens`)
- Errors

Returns the same client instance (mutated in place).

---

### wrapMcpClient(client, tracer, opts?)

Monkey-patches an MCP client's `callTool()` method to automatically create
`tool_call` spans.

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LanternTracer, wrapMcpClient } from "@lantern-ai/sdk";

const tracer = new LanternTracer({ ... });
const mcpClient = wrapMcpClient(new Client(...), tracer);

// All mcpClient.callTool() calls are now traced
const result = await mcpClient.callTool({
  name: "search",
  arguments: { query: "example" },
});
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `client` | MCP Client | The client instance to wrap |
| `tracer` | `LanternTracer` | Tracer to record spans on |
| `opts.traceId` | string | Existing trace to add spans to |
| `opts.agentName` | string | Agent name for auto-created traces (default `"mcp-agent"`) |

**What it captures:**

- Tool name
- Input arguments
- Result text content
- Error flag (`isError`)

Returns the same client instance (mutated in place).

---

## Type Definitions

### Trace

```typescript
interface Trace {
  id: string;
  sessionId: string;
  agentName: string;
  agentVersion?: string;
  environment: string;
  startTime: number;            // Unix timestamp in milliseconds
  endTime?: number;
  durationMs?: number;
  status: TraceStatus;
  spans: Span[];
  metadata: Record<string, unknown>;
  source?: TraceSource;
  scores?: EvalScore[];
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
}

type TraceStatus = "running" | "success" | "error";
```

### Span

```typescript
interface Span {
  id: string;
  traceId: string;
  parentSpanId?: string;
  type: SpanType;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  input: SpanInput;
  output?: SpanOutput;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  toolName?: string;
  toolResult?: unknown;
  error?: string;
}

type SpanType =
  | "llm_call"
  | "tool_call"
  | "reasoning_step"
  | "retrieval"
  | "custom";
```

### SpanInput

```typescript
interface SpanInput {
  messages?: Array<{ role: string; content: string }>;
  prompt?: string;
  args?: unknown;
}
```

### SpanOutput

```typescript
interface SpanOutput {
  content?: string;
  toolCalls?: unknown[];
  stopReason?: string;
}
```

### TraceSource

```typescript
interface TraceSource {
  serviceName: string;
  sdkVersion?: string;
  exporterType?: string;
}
```

### EvalScore

```typescript
interface EvalScore {
  scorer: string;
  score: number;
  label?: string;
  detail?: string;
}
```

### TraceQueryFilter

```typescript
interface TraceQueryFilter {
  agentName?: string;
  environment?: string;
  status?: TraceStatus;
  serviceName?: string;
  startAfter?: number;
  startBefore?: number;
  limit?: number;
  offset?: number;
}
```

---

## Cost Estimation

The SDK estimates costs based on model name and token counts. Prices are in USD
per 1,000 tokens:

| Model | Input | Output |
|---|---|---|
| `claude-sonnet-4-5-20251001` | $0.003 | $0.015 |
| `claude-haiku-4-5-20251001` | $0.0008 | $0.004 |
| `claude-opus-4-5-20251001` | $0.015 | $0.075 |
| `gpt-4o` | $0.005 | $0.015 |
| `gpt-4o-mini` | $0.00015 | $0.0006 |
| Unknown model (default) | $0.001 | $0.002 |

Cost estimation is computed automatically when a span has both `inputTokens`,
`outputTokens`, and a `model` set.
