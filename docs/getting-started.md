# Getting Started with Lantern

Lantern gives you full visibility into your AI agents in production.

## Prerequisites

- Node.js 20+
- pnpm 8+

## Install the SDK

```bash
npm install @lantern-ai/sdk
```

## Instrument your agent

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { LanternTracer, LanternExporter, wrapAnthropicClient } from "@lantern-ai/sdk";

const tracer = new LanternTracer({
  serviceName: "my-agent",
  environment: "production",
  exporter: new LanternExporter({
    endpoint: "http://localhost:4100",
  }),
});

const anthropic = wrapAnthropicClient(new Anthropic(), tracer);

// All API calls are now automatically traced
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-5-20251001",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});

await tracer.shutdown();
```

## Run the ingest server

```bash
docker compose -f docker/docker-compose.dev.yml up
```

## View traces

Open http://localhost:3000 in your browser.

## Next steps

- [SDK Reference](./sdk-reference.md)
- [Self-Hosting Guide](./self-hosting.md)
- [Core Concepts](./concepts.md)
