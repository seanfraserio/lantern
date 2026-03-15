# LLM Proxy Reference

Reference for the Lantern LLM Proxy server. The proxy sits between an AI agent
and the upstream LLM API (Anthropic or OpenAI), forwarding requests
transparently while capturing request and response data, building traces, and
sending them to the Lantern ingest server.

**Package:** `@lantern-ai/proxy`
**Source:** `packages/proxy/`
**Default port:** `4300`

---

## Supported Providers

| Provider | Upstream base URL |
|---|---|
| Anthropic | `https://api.anthropic.com` |
| OpenAI | `https://api.openai.com` |

---

## URL Routing

The proxy determines the target LLM provider using one of two mechanisms:

### Path-based routing (preferred)

Prefix your request path with the provider name. The prefix is stripped before
forwarding to the upstream API.

| Proxy path | Upstream URL |
|---|---|
| `/anthropic/v1/messages` | `https://api.anthropic.com/v1/messages` |
| `/openai/v1/chat/completions` | `https://api.openai.com/v1/chat/completions` |

### Header-based routing

Set the `X-Lantern-Provider` header to `anthropic` or `openai`. The request
path is forwarded as-is to the corresponding upstream API.

```
X-Lantern-Provider: anthropic
```

If neither a path prefix nor the header is present, the proxy returns `400`:

```json
{
  "error": "Could not determine LLM provider. Use path prefix (/anthropic/ or /openai/) or X-Lantern-Provider header."
}
```

---

## Headers

### Required headers

| Header | Description |
|---|---|
| `Authorization` | Your upstream API key (e.g. `Bearer sk-ant-...`). Forwarded to the upstream provider. |

### Lantern-specific headers

These headers are consumed by the proxy and **not forwarded** to the upstream
API. All `X-Lantern-*` headers are stripped before the upstream request.

| Header | Required | Description |
|---|---|---|
| `X-Lantern-Api-Key` | No | Lantern API key for trace ingestion. If provided, traces are authenticated against the ingest server. |
| `X-Lantern-Service` | No | Service name attached to the generated trace's `source.serviceName` field. |
| `X-Lantern-Provider` | No | Provider override for header-based routing (`anthropic` or `openai`). |

### Stripped headers

The following headers are stripped from upstream requests:

- All `X-Lantern-*` headers
- `Host` (replaced with upstream host)
- `Connection` (hop-by-hop)
- `Transfer-Encoding` (hop-by-hop)
- `Content-Length` (re-calculated)

---

## Streaming Behaviour

The proxy handles both streaming and non-streaming requests:

### Non-streaming requests

1. Forward the request to the upstream API.
2. Buffer the complete response.
3. Parse the response to extract model, tokens, and output content.
4. Build a trace and send it to the ingest server (fire-and-forget).
5. Return the response to the client.

### Streaming requests (SSE)

Detected when the request body contains `"stream": true`.

1. Forward the request to the upstream API.
2. Pipe the SSE response through to the client in real time.
3. Collect SSE data chunks in the background.
4. After the stream ends, parse the accumulated chunks.
5. Build a trace and send it to the ingest server (fire-and-forget).

The client receives the streaming response with no additional latency. Trace
building happens asynchronously after the stream completes.

### Error tracing

Failed upstream requests (non-2xx status) are also traced. The trace includes
the HTTP status code and the first 500 characters of the error response body.

---

## Trace Generation

For each proxied request, the proxy generates a single trace containing one
`llm_call` span. The trace includes:

| Field | Source |
|---|---|
| `agentName` | `"llm-proxy"` |
| `model` | Parsed from the response (or request if not in response) |
| `input` | Input messages extracted from the request body |
| `output` | Output content extracted from the response |
| `inputTokens` | Usage data from the response |
| `outputTokens` | Usage data from the response |
| `durationMs` | Wall-clock time from request start to response completion |
| `stopReason` | Stop/finish reason from the response |
| `source.serviceName` | Value of `X-Lantern-Service` header |
| `error` | Error message for failed requests |

Traces are sent to the ingest server via fire-and-forget HTTP POST. Failures
to send traces are logged but do not affect the client response.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4300` | Port to listen on |
| `LANTERN_INGEST_URL` | `http://localhost:4100` | Lantern ingest server URL |

---

## Health Check

### GET /health

Returns the proxy server status.

**Authentication:** None.

**Response (200):**

```json
{
  "status": "ok",
  "service": "lantern-proxy",
  "uptime": 3600.5
}
```

**Example:**

```bash
curl http://localhost:4300/health
```

---

## Request Limits

| Limit | Value |
|---|---|
| Maximum request body size | 10 MB (`10_485_760` bytes) |

---

## Docker Deployment

The proxy can be deployed as a standalone Docker container. Point your AI agent
at the proxy URL instead of the upstream API URL.

```bash
docker run -p 4300:4300 \
  -e LANTERN_INGEST_URL=https://ingest.openlanternai.com \
  lantern-proxy
```

**Agent configuration example (Anthropic):**

```python
import anthropic

# Instead of the default base URL, point to the proxy
client = anthropic.Anthropic(
    api_key="sk-ant-...",
    base_url="http://localhost:4300/anthropic",
)
```

**Agent configuration example (OpenAI):**

```python
import openai

client = openai.OpenAI(
    api_key="sk-...",
    base_url="http://localhost:4300/openai",
)
```

---

## Usage Example

A complete curl example proxying an Anthropic request:

```bash
curl -X POST http://localhost:4300/anthropic/v1/messages \
  -H 'x-api-key: sk-ant-...' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'Content-Type: application/json' \
  -H 'X-Lantern-Api-Key: ltn_abc123...' \
  -H 'X-Lantern-Service: my-service' \
  -d '{
    "model": "claude-sonnet-4-5-20251001",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

The response is identical to what the Anthropic API would return directly. A
trace is generated and sent to the ingest server in the background.
