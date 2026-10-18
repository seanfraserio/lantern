# Mastra

Trace Mastra agent LLM calls, tool executions, and workflow steps using a telemetry hook that reads OpenTelemetry-style span attributes.

## Installation

```bash
npm install @openlantern-ai/sdk @openlantern-ai/mastra
```

This package provides normalized telemetry callbacks and requires only the Lantern
SDK as a peer. It does not import or install the Mastra CLI/deployer. Install your
application's framework separately and translate its telemetry into the event
shape below. Direct registration with a particular Mastra release is not verified.

## Setup

```typescript
import { LanternTracer, ConsoleExporter } from "@openlantern-ai/sdk";
import { createLanternMastraHook } from "@openlantern-ai/mastra";

const tracer = new LanternTracer({
  exporter: new ConsoleExporter(),
});

const hook = createLanternMastraHook(tracer, {
  agentName: "my-mastra-agent", // optional, defaults to "mastra-agent"
});
```

## Usage

### Manual span lifecycle

For custom workflows where you need explicit control:

```typescript
// The hook auto-creates a trace on the first span
hook.onSpanStart({
  spanId: "custom-1",
  name: "my-custom-step",
  attributes: { "gen_ai.prompt": "Process this data" },
});

hook.onSpanEnd({
  spanId: "custom-1",
  attributes: { "gen_ai.completion": "Data processed successfully" },
});

hook.finish(); // End the trace
```

## What Gets Traced

| Mastra Event | Lantern Span Type | Captured Data |
|--------------|-------------------|---------------|
| Spans with `llm` or `generate` in name | `llm_call` | Model (`gen_ai.request.model`), prompt, completion, token usage |
| Spans with `tool` in name | `tool_call` | Tool name (`tool.name`), input/output |
| Other spans | `custom` | Span name, attributes |

### Span type inference

The hook infers the Lantern span type from the Mastra span name:
- Names containing `"llm"` or `"generate"` → `llm_call`
- Names containing `"tool"` → `tool_call`
- Everything else → `custom`

### OpenTelemetry attributes

Mastra emits spans with OpenTelemetry semantic conventions. The hook extracts:
- `gen_ai.request.model` or `model` → model name
- `gen_ai.prompt` → input prompt
- `gen_ai.completion` → output content
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` → token counts
- `tool.name` → tool name

## Troubleshooting

**No spans appearing**
- Verify your application bridge calls `onSpanStart` and `onSpanEnd` with normalized events.
- Configure the tracer's exporter for your destination; a console exporter does not send to an ingest service.

**Trace never ends**
- You must call `hook.finish()` explicitly when the agent interaction is complete. The hook does not auto-detect when all spans are done.

**Wrong span types**
- Span type is inferred from the span name. If your custom Mastra components use unexpected names, spans may be classified as `custom` instead of `llm_call` or `tool_call`.

## API Reference

```typescript
function createLanternMastraHook(
  tracer: LanternTracer,
  opts?: {
    agentName?: string;
  }
): {
  onSpanStart(event: MastraSpanEvent): void;
  onSpanEnd(event: MastraSpanEvent): void;
  finish(): void;
};
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `tracer` | `LanternTracer` | A configured Lantern tracer instance |
| `opts.agentName` | `string` | Optional — name shown in dashboard (default: `"mastra-agent"`) |
