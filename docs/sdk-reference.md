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

### wrapAnthropicClient(client, tracer)

Automatically instruments all `messages.create()` calls on an Anthropic client.

### wrapOpenAIClient(client, tracer)

(Coming soon) Auto-instruments OpenAI chat completions.

### wrapMcpClient(client, tracer)

(Coming soon) Auto-instruments MCP tool calls.

## Exporters

### LanternExporter
Sends traces to a Lantern ingest server via HTTP.

### ConsoleExporter
Prints traces to stdout. Useful for development.

### OtlpExporter
(Coming soon) OpenTelemetry-compatible export.
