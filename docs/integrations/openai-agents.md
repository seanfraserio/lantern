# OpenAI Agents SDK

Trace normalized agent runs, LLM generations, tool calls, and handoffs using callbacks that your application connects to its framework.

## Installation

```bash
npm install @openlantern-ai/sdk @openlantern-ai/openai-agents
```

This package exposes normalized trace/span callbacks. Only the Lantern SDK is a
required peer; neither its runtime nor its declarations import `@openai/agents`.
Install the framework separately when your application uses it. The application
must bridge framework events to this adapter's structural event contract; direct
native processor registration is not verified across framework versions.

## Setup

```typescript
import { LanternTracer, ConsoleExporter } from "@openlantern-ai/sdk";
import { createLanternTraceProcessor } from "@openlantern-ai/openai-agents";

const tracer = new LanternTracer({
  exporter: new ConsoleExporter(),
});

const processor = createLanternTraceProcessor(tracer, {
  agentName: "my-openai-agent", // optional, defaults to agent's own name or "openai-agent"
});
```

## Usage

### Forward normalized events

```typescript
processor.onTraceStart({ traceId: "run-1", name: "research-assistant" });
processor.onSpanStart({
  traceId: "run-1", spanId: "generation-1", type: "generation",
  model: "your-model", input: "Summarize the supplied document",
});
processor.onSpanEnd({
  traceId: "run-1", spanId: "generation-1", output: "A summary",
  usage: { inputTokens: 100, outputTokens: 20 },
});
processor.onTraceEnd({ traceId: "run-1" });
```

### Multi-agent handoffs

Normalized handoff events become `reasoning_step` spans. The adapter does not infer native framework delegation relationships:

```typescript
processor.onTraceStart({ traceId: "run-2", name: "triage" });
processor.onSpanStart({
  traceId: "run-2", spanId: "handoff-1", type: "handoff",
  input: { from: "triage", to: "research" },
});
processor.onSpanEnd({ traceId: "run-2", spanId: "handoff-1", output: "delegated" });
processor.onTraceEnd({ traceId: "run-2" });
```

## What Gets Traced

| OpenAI Agents Event | Lantern Span Type | Captured Data |
|---------------------|-------------------|---------------|
| `onTraceStart` / `onTraceEnd` | Trace | Agent name, provider metadata |
| Generation spans (`type: "generation"`) | `llm_call` | Model, input prompt, output, token usage |
| Tool spans (`type: "tool"`) | `tool_call` | Tool name, arguments, result |
| Handoff spans (`type: "handoff"`) | `reasoning_step` | Handoff source and target |
| Other span types | `custom` | Input/output as JSON |

### Trace and span mapping

The processor maintains a mapping between OpenAI Agents trace/span IDs and Lantern trace/span IDs. Each OpenAI Agents trace becomes a Lantern trace, and each span within it maps 1:1 to a Lantern span.

## Troubleshooting

**No traces appearing**
- Verify your application bridge emits `onTraceStart` before span callbacks and ends the same trace ID.
- Configure an exporter that sends to your intended destination.

**Missing token usage**
- Token usage is read from the `data.usage` object on span end events. If the agent run doesn't include usage data, these fields default to `0`.

**Handoff spans not showing**
- Handoff spans appear as `reasoning_step` type. Filter by this type in the dashboard if they seem missing.

## API Reference

```typescript
function createLanternTraceProcessor(
  tracer: LanternTracer,
  opts?: {
    agentName?: string;
  }
): {
  onTraceStart(data: AgentTraceData): void;
  onSpanStart(data: AgentSpanData): void;
  onSpanEnd(data: AgentSpanData): void;
  onTraceEnd(data: AgentTraceData): void;
};
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `tracer` | `LanternTracer` | A configured Lantern tracer instance |
| `opts.agentName` | `string` | Optional — fallback name if agent doesn't provide one (default: `"openai-agent"`) |
