# Lantern — Agent Observability & Tracing

Lantern gives full visibility into agent behavior in production. It traces reasoning chains (not just function calls), tracks quality metrics over time, attributes token costs per workflow, and flags PII flowing through prompts. Self-hosted (OSS) or managed cloud (enterprise).

## Package Map

- `packages/sdk` — `@lantern-ai/sdk`: Core tracing SDK with LanternTracer, spans, collectors (Anthropic/OpenAI/MCP auto-instrumentation), and exporters.
- `packages/ingest` — `@lantern-ai/ingest`: Fastify HTTP server for trace ingestion. POST /v1/traces endpoint with SQLite/Postgres storage.
- `packages/evaluator` — `@lantern-ai/evaluator`: Quality scoring framework with built-in scorers (relevance, toxicity, latency) and baseline regression detection.
- `packages/dashboard` — `@lantern-ai/dashboard`: React web UI for viewing traces, metrics, cost breakdowns, and quality alerts.
- `packages/enterprise` — `@lantern-ai/enterprise`: BUSL-1.1 licensed features (PII detection, SOC2/HIPAA audit export, alerting, team RBAC, managed cloud).

## Key Architectural Decisions

- **Span model**: Every agent action is a Span (llm_call, tool_call, reasoning_step, retrieval, custom). Spans can nest via parentSpanId, forming a tree that represents the full reasoning chain. This is richer than OpenTelemetry's flat span model.
- **Auto-instrumentation via wrapping**: `wrapAnthropicClient(client, tracer)` intercepts API calls at the SDK level — zero config for the user. No monkey-patching, no AST transforms.
- **Exporter abstraction**: The ITraceExporter interface decouples trace capture from delivery. Ship to Lantern, console, or OTLP without changing instrumentation code.
- **Cost estimation at the span level**: Each span carries estimatedCostUsd based on model pricing tables. Aggregated up to the trace level.
- **SQLite for OSS, Postgres for production**: SQLite with WAL mode handles moderate throughput out of the box. Postgres store is the upgrade path.
- **Evaluator is decoupled**: The evaluator package runs separately from ingest — you can evaluate traces offline, in CI, or on a schedule.

## OSS / Enterprise Boundary

OSS (MIT) covers the full trace capture pipeline: SDK instrumentation, ingest server, storage, dashboard, and evaluation framework. Enterprise (BUSL-1.1) adds features required by regulated or large-scale environments: PII detection in traces, SOC2/HIPAA audit export, Slack/PagerDuty alerting, team-scoped RBAC, and managed cloud hosting. The line is drawn at features that require organizational infrastructure or compliance guarantees.

## Contribution Conventions

- New auto-instrumentation collectors go in `packages/sdk/src/collectors/<provider>.ts` and are re-exported from `packages/sdk/src/index.ts`.
- New evaluation scorers go in `packages/evaluator/src/scorers/<name>.ts` and are re-exported from `packages/evaluator/src/index.ts`.
- New exporters go in `packages/sdk/src/exporters/<name>.ts`.
- Dashboard components go in `packages/dashboard/src/components/` with corresponding page integrations in `packages/dashboard/src/pages/`.
- All shared types belong in `packages/sdk/src/types.ts`.
- Tests are co-located as `*.test.ts` next to the file they test.

## Before Committing

```bash
pnpm build && pnpm test && pnpm typecheck
```
