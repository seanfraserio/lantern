# Integrations

Lantern integrates with 28 LLM providers and agent frameworks. Choose the integration that matches your stack.

## LLM Providers

| Provider | Language | Package | Method |
|----------|----------|---------|--------|
| [Anthropic](./anthropic.md) | TS, Python | `@lantern-ai/sdk` | SDK wrapper |
| [OpenAI](./openai.md) | TS, Python | `@lantern-ai/sdk` | SDK wrapper |
| [Google Gemini](./google.md) | TS | `@lantern-ai/sdk` | SDK wrapper |
| [Mistral](./mistral.md) | TS | `@lantern-ai/mistral` | SDK wrapper |
| [Cohere](./cohere.md) | TS | `@lantern-ai/cohere` | SDK wrapper |
| [AWS Bedrock](./bedrock.md) | TS | `@lantern-ai/bedrock` | SDK wrapper |
| [Groq, Together, Fireworks, DeepSeek, Perplexity, Ollama, OpenRouter, xAI, Cerebras, Novita](./openai-compatible.md) | TS | `@lantern-ai/sdk` | OpenAI-compatible |

## Agent Frameworks

| Framework | Language | Package | Method |
|-----------|----------|---------|--------|
| [LangChain](./langchain.md) | TS | `@lantern-ai/sdk` | Callback handler |
| [LlamaIndex](./llamaindex.md) | TS | `@lantern-ai/sdk` | Event handler |
| [Vercel AI SDK](./vercel-ai.md) | TS | `@lantern-ai/sdk` | Function wrapper |
| [OpenAI Agents SDK](./openai-agents.md) | TS | `@lantern-ai/openai-agents` | Trace processor |
| [Mastra](./mastra.md) | TS | `@lantern-ai/mastra` | Telemetry hook |
| [CrewAI](./crewai.md) | Python | `lantern-ai[crewai]` | Lifecycle handler |
| [Pydantic AI](./pydantic-ai.md) | Python | `lantern-ai[pydantic-ai]` | Lifecycle handler |
| [AutoGen](./autogen.md) | Python | `lantern-ai[autogen]` | Message hooks |
| [Haystack](./haystack.md) | Python | `lantern-ai[haystack]` | Pipeline callbacks |
| [DSPy](./dspy.md) | Python | `lantern-ai[dspy]` | Module tracing |
| [Smolagents](./smolagents.md) | Python | `lantern-ai[smolagents]` | Step callbacks |

## Other

| Integration | Language | Package | Method |
|-------------|----------|---------|--------|
| [MCP](./mcp.md) | TS | `@lantern-ai/sdk` | Tool call wrapper |

## Using the LLM Proxy

For zero-code instrumentation of any provider, see the [LLM Proxy guide](../how-to/use-llm-proxy.md). The proxy supports Anthropic, OpenAI, Mistral, and Cohere routes, plus an `X-Lantern-Provider` header for labeling any OpenAI-compatible provider.
