# Tracing Model

How Lantern represents agent execution as traces and spans, and why the model
is designed the way it is.

---

## What is a Trace?

A **trace** represents one complete agent execution -- from the moment the agent
receives a task to the moment it produces a final result (or fails). A single
user request that triggers an agent creates one trace.

A trace carries:

- **Identity** -- a UUID and a session ID (for grouping related executions).
- **Agent metadata** -- the agent's name, version, and environment.
- **Timing** -- when it started, when it ended, how long it took.
- **Status** -- `running`, `success`, or `error`.
- **Spans** -- the individual steps the agent performed (see below).
- **Aggregate metrics** -- total input/output tokens and estimated cost.
- **Source** -- which service and SDK version produced the trace.
- **Metadata** -- arbitrary key-value pairs for custom context.

A trace is the unit of observability in Lantern. Scorecards, regressions, cost
analysis, and SLA monitoring all operate at the trace level.

---

## What is a Span?

A **span** represents one step in the agent's reasoning process. If a trace is
the full story, a span is a single chapter.

Every span has:

- A **type** that categorises what kind of step it is.
- An **input** -- what was provided to the step.
- An **output** -- what the step produced.
- **Timing** -- start time, end time, and duration.
- An optional **model** (for LLM calls) or **tool name** (for tool calls).
- Optional **token counts** and **cost estimation**.
- An optional **parent span ID** for nesting.

---

## Span Types

Lantern defines five span types. Each represents a different category of agent
activity:

### `llm_call`

An invocation of a large language model. This is the most common span type.

**When to use:** Every time the agent sends a prompt to an LLM and receives a
response.

**Typical fields:**
- `model` -- the model identifier (e.g. `claude-sonnet-4-5-20251001`, `gpt-4o`)
- `input.messages` -- the conversation messages sent to the model
- `output.content` -- the text response
- `output.toolCalls` -- any tool use blocks in the response
- `output.stopReason` -- why the model stopped (`end_turn`, `tool_use`, etc.)
- `inputTokens`, `outputTokens` -- token usage
- `estimatedCostUsd` -- cost computed from model pricing

### `tool_call`

An invocation of an external tool or function.

**When to use:** When the agent calls a tool (database query, API call, file
operation, MCP tool, etc.).

**Typical fields:**
- `toolName` -- the name of the tool
- `input.args` -- the arguments passed to the tool
- `output.content` -- the tool's result
- `toolResult` -- raw tool result data
- `error` -- error message if the tool call failed

### `retrieval`

A retrieval step (e.g. RAG, vector database search, document lookup).

**When to use:** When the agent searches for information to ground its
response. This is semantically distinct from a tool call because it represents
information gathering rather than action taking.

**Typical fields:**
- `input.prompt` -- the search query
- `output.content` -- the retrieved content

### `reasoning_step`

An internal reasoning step -- chain-of-thought, planning, or intermediate
processing.

**When to use:** When you want to capture the agent's internal deliberation
that happens between LLM calls. This could be a planning step, a decision
point, or an intermediate transformation.

**Typical fields:**
- `input.prompt` -- the reasoning context
- `output.content` -- the reasoning result

### `custom`

A catch-all for steps that don't fit the other categories.

**When to use:** For domain-specific operations, custom processing steps, or
anything else that is part of the agent's execution but is not an LLM call,
tool call, retrieval, or reasoning step.

---

## Parent-Child Relationships

Spans can be nested using the `parentSpanId` field. This creates a tree
structure that represents the reasoning chain:

```
Trace: "Answer user question"
  |
  +-- llm_call: "Initial reasoning" (root span)
  |     |
  |     +-- tool_call: "search" (child of LLM call)
  |     |
  |     +-- tool_call: "read_file" (child of LLM call)
  |
  +-- llm_call: "Generate response with context" (root span)
```

Parent-child relationships are useful for understanding which LLM call
triggered which tool calls. The auto-instrumentation wrappers create these
relationships automatically -- when an LLM response includes tool use blocks,
child `tool_call` spans are created with `parentSpanId` set to the LLM call
span.

You can nest spans to arbitrary depth, though in practice most agent
architectures are two to three levels deep.

---

## Auto-instrumentation

The SDKs provide wrapper functions that automatically capture spans without
requiring manual instrumentation:

### How it works

The wrapper functions (e.g. `wrapAnthropicClient`) use monkey-patching to
intercept API calls. When you wrap an Anthropic client, the SDK:

1. Replaces `client.messages.create()` with a wrapped version.
2. Before the API call, creates an `llm_call` span with the input messages and model.
3. Calls the original `create()` method.
4. After the response, ends the span with the output content, token usage, and stop reason.
5. For tool use responses, creates child `tool_call` spans.
6. If an error occurs, records it on the span and marks the trace as `error`.

The wrapped client returns the original response unchanged. Existing code
continues to work without modification.

### Trace lifecycle with auto-instrumentation

If you provide a `traceId` option, spans are added to an existing trace. This
is useful when a single agent execution makes multiple LLM calls:

```typescript
const trace = tracer.startTrace({ agentName: "my-agent" });
const client = wrapAnthropicClient(anthropic, tracer, { traceId: trace.id });

await client.messages.create({ ... }); // Span 1
await client.messages.create({ ... }); // Span 2

tracer.endTrace(trace.id, "success");
```

If you omit `traceId`, each API call creates and completes its own trace. This
is simpler but produces one trace per LLM call rather than one trace per agent
execution.

---

## Token Counting and Cost Estimation

Lantern tracks token usage at the span level and aggregates it to the trace
level.

### How tokens are captured

- **Anthropic SDK wrapper:** Reads `response.usage.input_tokens` and `response.usage.output_tokens`.
- **OpenAI SDK wrapper:** Reads `response.usage.prompt_tokens` and `response.usage.completion_tokens`.
- **Manual spans:** Token counts are passed to `endSpan()` or `set_tokens()`.

### How cost is estimated

When a span has a model, input tokens, and output tokens, the SDK computes an
estimated cost using a built-in pricing table:

```
cost = (inputTokens / 1000) * inputPrice + (outputTokens / 1000) * outputPrice
```

The pricing table includes current rates for common models (Claude Sonnet,
Claude Haiku, Claude Opus, GPT-4o, GPT-4o Mini). Unknown models use a
conservative default rate.

Cost estimation is approximate. It does not account for:

- Prompt caching discounts
- Batch API discounts
- Custom pricing agreements
- Image or audio tokens
- Model version differences within a family

For precise billing, use your LLM provider's usage dashboard. Lantern's cost
estimation is designed for trend analysis, budget alerts, and comparative
cost-per-agent reporting.

### Aggregation

Trace-level totals are computed by summing across all spans:

```
trace.totalInputTokens = sum(span.inputTokens for span in trace.spans)
trace.totalOutputTokens = sum(span.outputTokens for span in trace.spans)
trace.estimatedCostUsd = sum(span.estimatedCostUsd for span in trace.spans)
```

---

## Comparison with OpenTelemetry

Lantern's tracing model is influenced by OpenTelemetry but differs in several
important ways:

| Aspect | OpenTelemetry | Lantern |
|---|---|---|
| **Purpose** | General distributed tracing | Agent-specific observability |
| **Span types** | Generic (CLIENT, SERVER, INTERNAL, etc.) | Domain-specific (`llm_call`, `tool_call`, etc.) |
| **Token tracking** | Not built-in (requires custom attributes) | First-class `inputTokens`, `outputTokens` fields |
| **Cost estimation** | Not built-in | Automatic based on model pricing |
| **Input/output** | Attributes (key-value) | Structured `SpanInput` and `SpanOutput` types |
| **Storage** | Requires collector + backend (Jaeger, Tempo, etc.) | Built-in PostgreSQL/SQLite storage |

### Interoperability

Lantern includes an `OtlpExporter` that converts traces to OTLP format. This
allows Lantern traces to be sent to any OpenTelemetry-compatible backend (Jaeger,
Grafana Tempo, Honeycomb, etc.) alongside your existing infrastructure traces.

The OTLP mapping preserves the essential structure:

- Each Lantern trace becomes an OTLP ResourceSpan.
- `agentName` maps to the `service.name` resource attribute.
- `llm_call`, `tool_call`, and `retrieval` spans map to CLIENT kind.
- `reasoning_step` and `custom` spans map to INTERNAL kind.
- Model, token, and cost data are exported as span attributes.

This means you can use Lantern's agent-specific SDK for instrumentation while
routing data to your existing observability stack.
