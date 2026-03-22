# OpenAI Agents SDK

Trace agent runs, LLM generations, tool calls, and handoffs from the OpenAI Agents SDK (`@openai/agents`) with a dedicated trace processor.

## Installation

```bash
npm install @openlantern-ai/sdk @openlantern-ai/openai-agents @openai/agents
```

The OpenAI Agents integration is a separate package (`@openlantern-ai/openai-agents`) because it depends on `@openai/agents` as a peer dependency.

## Setup

```typescript
import { LanternTracer } from "@openlantern-ai/sdk";
import { createLanternTraceProcessor } from "@openlantern-ai/openai-agents";

const tracer = new LanternTracer({
  apiKey: process.env.LANTERN_API_KEY,
  baseUrl: process.env.LANTERN_BASE_URL,
});

const processor = createLanternTraceProcessor(tracer, {
  agentName: "my-openai-agent", // optional, defaults to agent's own name or "openai-agent"
});
```

## Usage

### Register the trace processor

```typescript
import { Agent, Runner } from "@openai/agents";

const agent = new Agent({
  name: "research-assistant",
  instructions: "You are a helpful research assistant.",
  model: "gpt-4",
});

const runner = new Runner({
  traceProcessors: [processor],
});

const result = await runner.run(agent, "What are the latest AI trends?");
console.log(result.output);
```

### Multi-agent handoffs

The processor traces handoffs between agents as `reasoning_step` spans, preserving the full delegation chain:

```typescript
const triageAgent = new Agent({
  name: "triage",
  instructions: "Route to the appropriate specialist agent.",
  handoffs: [researchAgent, writingAgent],
});

const result = await runner.run(triageAgent, "Write a blog post about AI safety");
// Trace shows: triage → research-agent → writing-agent
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
- Verify the processor is passed in the `traceProcessors` array on the `Runner`, not on the `Agent`.
- Check that `LANTERN_API_KEY` and `LANTERN_BASE_URL` are set correctly.

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
