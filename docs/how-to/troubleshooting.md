# Troubleshooting

Common issues and how to resolve them.

---

## Traces not appearing

**Symptom:** You instrumented your code but see no traces in the dashboard.

**Causes and fixes:**
- **Missing `flush()` or `shutdown()`:** Traces are buffered. Call `await tracer.flush()` or `await tracer.shutdown()` before your process exits.
- **Wrong API key:** Verify `LANTERN_API_KEY` matches a key in your dashboard's API Keys page.
- **Exporter endpoint incorrect:** Check the `endpoint` URL. For self-hosted, it should point to your ingest server (default port 4200).
- **Firewall blocking:** Ensure the ingest endpoint is reachable from your network.

---

## Token counts showing 0

**Symptom:** Spans show 0 input/output tokens.

**Causes and fixes:**
- **Provider doesn't return usage:** Some providers (notably Ollama for certain models) don't include token counts in responses. This is a provider-side limitation.
- **Streaming without usage flag:** For OpenAI streaming, set `stream_options: { include_usage: true }` in your request to get token counts in the final SSE chunk.
- **Proxy-captured traces:** The proxy extracts tokens from the response body. If the upstream doesn't include usage data, tokens will be 0.

---

## Cost estimates incorrect

**Symptom:** The estimated cost doesn't match your provider's billing.

**Causes and fixes:**
- **Unknown model:** Models not in the pricing table fall back to $0.001/$0.002 per 1K tokens. Use `getPricing(model)` to check if your model is recognized.
- **Provider-specific pricing:** Use `getPricing(model, provider)` for provider-scoped lookups (e.g., Groq-hosted Llama pricing differs from Together AI).
- **Stale pricing:** Model prices change. If pricing is significantly off, the pricing table may need updating — contributions welcome.

---

## Integration package install fails

**Symptom:** `npm install @lantern-ai/mistral` or similar fails with peer dependency errors.

**Fix:** Ensure `@lantern-ai/sdk` version >= 0.3.0 is installed. Integration packages declare the SDK as a peer dependency. Run:

```bash
npm install @lantern-ai/sdk@latest @lantern-ai/mistral
```

---

## Python async client not traced

**Symptom:** Using `AsyncAnthropic` or `AsyncOpenAI` but calls aren't traced.

**Fix:** The `wrap_*_client` functions auto-detect sync vs async by checking `asyncio.iscoroutinefunction(client.messages.create)`. If detection fails, verify your client is a proper async client (not a sync client wrapped in `asyncio.to_thread`).

```python
from anthropic import AsyncAnthropic
from lantern_ai import LanternTracer, wrap_anthropic_client

tracer = LanternTracer(...)
client = AsyncAnthropic()
wrap_anthropic_client(client, tracer)  # Auto-detects async

# Use with await
response = await client.messages.create(...)
```

---

## Proxy returns 400 "Could not determine provider"

**Symptom:** Proxy requests fail with a 400 error about unknown provider.

**Fix:** A URL path prefix is required for routing. Use one of:
- `/anthropic/*`
- `/openai/*`
- `/mistral/*`
- `/cohere/*`

Header-only routing via `X-Lantern-Provider` is no longer supported for route selection — the header now only affects the provider label in trace metadata.

```bash
# Correct — uses path prefix for routing
curl -X POST https://proxy.openlanternai.com/openai/v1/chat/completions \
  -H "X-Lantern-Api-Key: $LANTERN_API_KEY" \
  ...

# Wrong — no path prefix, will return 400
curl -X POST https://proxy.openlanternai.com/v1/chat/completions \
  -H "X-Lantern-Provider: openai" \
  ...
```

---

## Spans missing parent-child relationships

**Symptom:** Spans appear as flat siblings instead of a nested tree.

**Causes and fixes:**
- **Framework callback ordering:** Some frameworks fire callbacks out of order. Verify that parent spans haven't been ended before child spans start.
- **Manual spans:** When creating manual spans with `startSpan()`, pass `parentSpanId` to establish the relationship:

```typescript
const parentSpan = tracer.startSpan(traceId, { type: "reasoning_step" });
const childSpan = tracer.startSpan(traceId, {
  type: "llm_call",
  parentSpanId: parentSpan.id,  // Links child to parent
});
```

- **Multiple tracers:** If you create multiple `LanternTracer` instances, spans from different tracers won't share parent-child context. Use a single tracer instance per service.
