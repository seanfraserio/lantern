# How to Use the LLM Proxy

The Lantern LLM Proxy instruments any agent with zero code changes. It sits between your agent and the LLM API, transparently forwarding requests while capturing traces.

---

## How it works

```
Your Agent  ──>  Lantern Proxy  ──>  Anthropic / OpenAI / Mistral / Cohere API
                      │
                      └──>  Lantern Ingest (traces)
```

The proxy strips all `X-Lantern-*` headers before forwarding to the upstream API, so no Lantern metadata leaks to the provider.

---

## Set the base URL

Route traffic through the proxy by changing the base URL your client uses.

**Anthropic:**

```bash
export ANTHROPIC_BASE_URL="https://proxy.openlanternai.com/anthropic"
```

**OpenAI:**

```bash
export OPENAI_BASE_URL="https://proxy.openlanternai.com/openai"
```

**Mistral:**

```bash
export MISTRAL_API_URL="https://proxy.openlanternai.com/mistral"
```

**Cohere:**

```bash
export CO_API_URL="https://proxy.openlanternai.com/cohere"
```

The Anthropic and OpenAI SDKs respect their respective environment variables automatically. For Mistral and Cohere, you may need to set the base URL in the client constructor directly.

---

## Add the Lantern API key header

Every request through the proxy must include your Lantern API key:

```
X-Lantern-Api-Key: ltn_...
```

How you set this depends on your SDK.

**Python (Anthropic):**

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="https://proxy.openlanternai.com/anthropic",
    default_headers={
        "X-Lantern-Api-Key": "ltn_...",
    },
)
```

**Python (OpenAI):**

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://proxy.openlanternai.com/openai/v1",
    default_headers={
        "X-Lantern-Api-Key": "ltn_...",
    },
)
```

**TypeScript (Anthropic):**

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://proxy.openlanternai.com/anthropic",
  defaultHeaders: {
    "X-Lantern-Api-Key": "ltn_...",
  },
});
```

**TypeScript (OpenAI):**

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://proxy.openlanternai.com/openai/v1",
  defaultHeaders: {
    "X-Lantern-Api-Key": "ltn_...",
  },
});
```

**curl:**

```bash
curl -X POST https://proxy.openlanternai.com/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "X-Lantern-Api-Key: $LANTERN_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-5-20251001","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

---

## Set a custom service name

By default, traces are labelled with the provider name. Set a custom service name with the `X-Lantern-Service` header:

```
X-Lantern-Service: my-support-agent
```

Example:

```python
client = Anthropic(
    base_url="https://proxy.openlanternai.com/anthropic",
    default_headers={
        "X-Lantern-Api-Key": "ltn_...",
        "X-Lantern-Service": "my-support-agent",
    },
)
```

This is how the trace appears in the dashboard — use it to distinguish between agents.

---

## Provider routing

The proxy determines which upstream API to call based on the URL path prefix:

| Path prefix | Upstream |
|-------------|----------|
| `/anthropic/*` | `api.anthropic.com` |
| `/openai/*` | `api.openai.com` |
| `/mistral/*` | `api.mistral.ai` |
| `/cohere/*` | `api.cohere.com` |

A path prefix is **required** for routing. Header-only routing has been removed.

### X-Lantern-Provider header

The `X-Lantern-Provider` header is a **metadata-only** override — it sets the provider label in trace metadata but does **not** affect routing. This is useful when routing through `/openai/*` but using an OpenAI-compatible provider like Groq:

```bash
curl -X POST https://proxy.openlanternai.com/openai/v1/chat/completions \
  -H "X-Lantern-Api-Key: $LANTERN_API_KEY" \
  -H "X-Lantern-Provider: groq" \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -d '{"model":"llama-3.1-70b-versatile","messages":[{"role":"user","content":"Hello"}]}'
```

In this example, the request routes through `/openai/*` but the trace is labelled as `groq` in the dashboard.

---

## Streaming support

The proxy handles both streaming and non-streaming requests. For streaming, it pipes the SSE response through to your client in real time while collecting chunks in the background. The trace is built and sent after the stream completes.

No special configuration is needed — set `stream: true` in your request as you normally would.

---

## Works with any framework

Since the proxy operates at the HTTP level, it works with any language or framework:

- **LangChain:** Set the `base_url` on the LLM provider
- **LlamaIndex:** Set the `api_base` parameter
- **CrewAI:** Configure the underlying LLM client's base URL
- **Go, Rust, Java:** Set the API endpoint URL and add the `X-Lantern-Api-Key` header

---

## Self-hosted proxy

If you are self-hosting Lantern, you can run the proxy locally:

```bash
cd packages/proxy
npm install
PORT=4300 LANTERN_INGEST_URL=http://localhost:4100 npm start
```

Then point your clients at `http://localhost:4300/anthropic` or `http://localhost:4300/openai`.

---

## Lantern-specific headers reference

| Header | Required | Description |
|--------|----------|-------------|
| `X-Lantern-Api-Key` | Yes | Your Lantern API key for trace ingestion |
| `X-Lantern-Service` | No | Custom service name for the trace (default: provider name) |
| `X-Lantern-Provider` | No | Provider label override for trace metadata (does not affect routing) |

All `X-Lantern-*` headers are stripped before the request is forwarded to the upstream API.
