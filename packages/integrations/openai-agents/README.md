# OpenAI Agents callback adapter

Install `@openlantern-ai/openai-agents` alongside `@openlantern-ai/sdk`.

`createLanternTraceProcessor(tracer)` returns structural `onTraceStart`,
`onSpanStart`, `onSpanEnd`, and `onTraceEnd` callbacks. Neither its JavaScript
nor its public declarations import `@openai/agents`. Consequently that
framework is not a runtime dependency or peer requirement of this package.
Install it separately when your application actually uses it. The Lantern
SDK remains a required peer.

The application must translate framework events into the adapter's normalized
shape: trace events contain `traceId` and optional `name`; span events contain
`spanId`, `traceId`, and optional `type`, `model`, `input`, `output`, `usage`
(`inputTokens`/`outputTokens`), and `toolName`. This is not a claim that the
returned object directly implements every release of the framework's native
processor interface; applications own any required bridge.

Run `pnpm test:dependency-contracts` from the workspace root for packed ESM/CJS
and declaration contract checks without framework installations. Existing
Vitest tests exercise the callbacks with the real Lantern SDK.
