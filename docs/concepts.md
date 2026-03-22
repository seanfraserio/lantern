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

## Auto-instrumentation

Lantern auto-instruments LLM calls and agent framework steps so you don't need to create spans manually.

**SDK wrappers** — For direct LLM clients, wrap the client once and all calls are traced:
- `wrapAnthropicClient` / `wrapOpenAIClient` for first-party SDKs
- `wrapOpenAICompatClient` for any OpenAI-compatible provider (Groq, Together, Fireworks, DeepSeek, and more) — pass a `provider` label for correct cost attribution
- `wrapGoogleGenerativeModel`, `wrapMistralClient`, `wrapCohereClient`, `wrapBedrockClient` for provider-specific SDKs

**Framework callbacks** — For agent frameworks, Lantern provides callback/event handlers that plug into the framework's lifecycle:
- `createLanternCallbackHandler` for LangChain (pass as `callbacks`)
- `createLanternEventHandler` for LlamaIndex (register via `Settings.callbackManager`)
- Framework-specific handlers for CrewAI, Pydantic AI, AutoGen, Haystack, DSPy, and Smolagents (Python)

See the [SDK Reference](./sdk-reference.md) for the full list of collectors and the [Integrations](./integrations/overview.md) directory for per-integration guides.

## Exporters

Exporters determine where trace data goes:

- **LanternExporter** — HTTP POST to a Lantern ingest server
- **ConsoleExporter** — stdout (development)
- **OtlpExporter** — OpenTelemetry Protocol (interop)
