# Mastra callback adapter

Install `@openlantern-ai/mastra` alongside `@openlantern-ai/sdk`.

`createLanternMastraHook(tracer)` returns structural `onSpanStart`,
`onSpanEnd`, and `finish` callbacks. This package does not import Mastra
at runtime or in its declarations. The `mastra` CLI/deployer is not a
runtime dependency or peer requirement and is not installed by this adapter.
Install any framework tooling separately if your application actually uses it.

The application must translate its telemetry into the callback event shape
(`spanId`, optional `name`, `parentSpanId`, and `attributes`) and invoke
`finish()` at the end of the run. No compatibility with every Mastra release
or direct registration with a particular framework telemetry API is implied.
The Lantern SDK remains a required peer.

From the workspace root, run `pnpm test:dependency-contracts` to build and
pack both structural callback adapters, verify their public declarations,
and exercise their ESM/CJS artifacts outside the workspace without framework
installations. The existing Vitest suite additionally checks tracing using
the real Lantern SDK.
