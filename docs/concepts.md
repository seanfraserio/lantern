# Core Concepts

## Traces

A **trace** represents one complete agent execution — from receiving a user request to producing a final response. Traces contain metadata (agent name, environment, timestamps) and a tree of spans.

## Spans

A **span** represents one step in the agent's reasoning chain. Span types:

- **llm_call** — A model completion request/response
- **tool_call** — An MCP or function tool invocation
- **reasoning_step** — Agent reasoning / chain-of-thought
- **retrieval** — Memory or vector store lookup
- **custom** — Any user-defined step

Spans can be nested (parent/child) to represent tool calls triggered by LLM responses.

## Scorers

**Scorers** evaluate trace quality. Built-in scorers:

- **relevance** — Is the output relevant to the input?
- **toxicity** — Does the output contain harmful content?
- **latency** — How fast was the response?

You can register custom scorers for domain-specific quality checks.

## Baselines

**Baselines** are snapshots of scorer performance over a dataset. When new scores deviate significantly (>2 standard deviations) from a baseline, Lantern flags a quality regression.

## Exporters

Exporters determine where trace data goes:

- **LanternExporter** — HTTP POST to a Lantern ingest server
- **ConsoleExporter** — stdout (development)
- **OtlpExporter** — OpenTelemetry Protocol (interop)
