# Lantern — Agent Observability & Tracing

Full-stack visibility into AI agent behavior. The Datadog for AI agents.

## The Problem

AI agents make opaque decisions across multiple reasoning steps, tool calls, and model invocations. When an agent produces a bad output, there's no way to trace why. When costs spike, there's no attribution. When quality drifts, nobody notices until users complain. Lantern captures every step of agent reasoning, scores quality continuously, and attributes costs to the token level.

## Install

```bash
npm install @openlantern-ai/sdk
```

## Quickstart

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { LanternTracer, ConsoleExporter, wrapAnthropicClient } from "@openlantern-ai/sdk";

// 1. Create tracer
const tracer = new LanternTracer({
  serviceName: "my-agent",
  exporter: new ConsoleExporter(),
});

// 2. Wrap your AI client
const client = wrapAnthropicClient(new Anthropic(), tracer);

// 3. Use as normal — all calls are traced
const res = await client.messages.create({
  model: "claude-sonnet-4-5-20251001",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});

await tracer.shutdown();
```

## Live Demo

Try the interactive dashboard locally — no API keys required:

```bash
git clone https://github.com/your-org/lantern.git
cd lantern
pnpm install
pnpm demo
```

This starts an ingest server on `http://localhost:4100`, seeds it with realistic agent traces from multiple services, and opens the dashboard in your browser. Explore:

- **Traces** — Click through agent reasoning chains with full input/output visibility
- **Metrics** — Cost attribution by agent and source, token usage, trace timelines
- **Sources** — See which services are sending traces, their SDK versions, and connected agents

## Supported Integrations

### LLM Providers

| Provider | Language | Method |
|----------|----------|--------|
| Anthropic | TS, Python | SDK wrapper (`wrapAnthropicClient`) |
| OpenAI | TS, Python | SDK wrapper (`wrapOpenAIClient`) |
| Google Gemini | TS | SDK wrapper (`wrapGoogleGenerativeModel`) |
| Mistral | TS | SDK wrapper (`wrapMistralClient`) |
| Cohere | TS | SDK wrapper (`wrapCohereClient`) |
| AWS Bedrock | TS | SDK wrapper (`wrapBedrockClient`) |
| Groq | TS | OpenAI-compatible (`wrapOpenAICompatClient`) |
| Together AI | TS | OpenAI-compatible (`wrapOpenAICompatClient`) |
| Fireworks AI | TS | OpenAI-compatible (`wrapOpenAICompatClient`) |
| DeepSeek | TS | OpenAI-compatible (`wrapOpenAICompatClient`) |
| Perplexity | TS | OpenAI-compatible (`wrapOpenAICompatClient`) |
| Ollama | TS | OpenAI-compatible (`wrapOpenAICompatClient`) |
| OpenRouter | TS | OpenAI-compatible (`wrapOpenAICompatClient`) |
| xAI (Grok) | TS | OpenAI-compatible (`wrapOpenAICompatClient`) |
| Cerebras | TS | OpenAI-compatible (`wrapOpenAICompatClient`) |
| Novita AI | TS | OpenAI-compatible (`wrapOpenAICompatClient`) |

### Frameworks & Agent SDKs

| Framework | Language | Method |
|-----------|----------|--------|
| LangChain | TS | Callback handler (`createLanternCallbackHandler`) |
| LlamaIndex | TS | Event handler (`createLanternEventHandler`) |
| Vercel AI SDK | TS | Function wrapper (`wrapGenerateText` / `wrapStreamText`) |
| OpenAI Agents SDK | TS | Trace processor (`createLanternTraceProcessor`) |
| Mastra | TS | Telemetry hook (`createLanternMastraHook`) |
| MCP | TS | Tool call wrapper (`wrapMcpClient`) |
| CrewAI | Python | Lifecycle handler (`create_lantern_crewai_handler`) |
| Pydantic AI | Python | Lifecycle handler (`create_lantern_pydantic_handler`) |
| AutoGen | Python | Message hooks (`create_lantern_autogen_handler`) |
| Haystack | Python | Pipeline callbacks (`create_lantern_haystack_handler`) |
| DSPy | Python | Module tracing (`create_lantern_dspy_handler`) |
| Smolagents | Python | Step callbacks (`create_lantern_smolagents_handler`) |

See [docs/integrations/overview.md](docs/integrations/overview.md) for detailed per-integration documentation.

## Core Concepts

- **Traces** — One complete agent execution, from user request to final response.
- **Spans** — Individual reasoning steps: LLM calls, tool invocations, retrieval, custom steps.
- **Scorers** — Automated quality checks: relevance, toxicity, latency, or your own custom scorer.
- **Baselines** — Score snapshots for regression detection. Get alerted when quality drops.
- **Cost attribution** — Token-level cost tracking by model, agent, and workflow.

## OSS vs Enterprise

| Feature | OSS (MIT) | Enterprise (BUSL-1.1) |
|---|---|---|
| Full trace capture (SDK) | ✓ | ✓ |
| SQLite + Postgres storage | ✓ | ✓ |
| Dashboard (traces, metrics) | ✓ | ✓ |
| Latency + cost scorers | ✓ | ✓ |
| Custom eval scorers | ✓ | ✓ |
| Self-hosted deployment | ✓ | ✓ |
| PII detection in traces | — | ✓ |
| SOC2/HIPAA audit export | — | ✓ |
| Slack/PD/webhook alerts | — | ✓ |
| Team-scoped RBAC | — | ✓ |
| Managed cloud ingest | — | ✓ |

## Self-Hosting

```bash
docker compose -f docker/docker-compose.yml up -d
```

See [docs/self-hosting.md](docs/self-hosting.md) for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Run `pnpm build && pnpm test && pnpm typecheck` before submitting a PR
4. Open a pull request against `main`

See [ARCHITECTURE.md](ARCHITECTURE.md) for architecture and conventions.

## License

MIT — see [LICENSE](LICENSE). Enterprise features are licensed under BUSL-1.1.
