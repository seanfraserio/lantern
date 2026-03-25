# Ingest API Reference

Complete reference for the Lantern trace ingest server. The ingest server
receives traces from SDKs and the LLM proxy, stores them in PostgreSQL (or
SQLite for single-tenant mode), and provides query endpoints.

**Base URL:** `http://localhost:4100` (default) or as configured via `PORT`.

---

## Authentication

Authentication depends on the deployment mode:

### Single-tenant mode

If `LANTERN_API_KEY` is set, all `/v1/*` requests must include:

```
Authorization: Bearer <LANTERN_API_KEY>
```

The key is compared using `crypto.timingSafeEqual` to prevent timing attacks.

If `LANTERN_API_KEY` is not set, `/v1/*` endpoints are unauthenticated.

### Multi-tenant mode

When `MULTI_TENANT=true` and `DATABASE_URL` is configured, the ingest server
resolves API keys via the `api_keys` table in the public schema. The key is
hashed with SHA-256 and looked up against stored hashes.

```
Authorization: Bearer ltn_abc123def456...
```

Each request is scoped to the tenant that owns the API key. A per-tenant
PostgreSQL schema (`tenant_<slug>`) is used for trace storage.

---

## Rate Limits and Plan Limits

In multi-tenant mode, trace ingestion is subject to per-tenant monthly limits
based on the tenant's plan:

| Plan | Traces per month |
|---|---|
| `free` | 10,000 |
| `team` | 1,000,000 |
| `enterprise` | 999,999,999 (effectively unlimited) |

Usage is checked from the `public.usage` table, cached for 60 seconds per
tenant. When the limit is exceeded, POST requests receive a `429` response:

```json
{
  "error": "Trace limit exceeded",
  "plan": "free",
  "used": 10000,
  "limit": 10000,
  "message": "Your free plan allows 10,000 traces/month. Upgrade at https://openlanternai-dashboard.pages.dev"
}
```

GET requests (queries) are not subject to trace limits.

---

## Endpoints

### POST /v1/traces

Ingest a batch of traces.

**Authentication:** API key (see above).

**Request body:**

```json
{
  "traces": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "sessionId": "660e8400-e29b-41d4-a716-446655440000",
      "agentName": "my-agent",
      "agentVersion": "1.0.0",
      "environment": "production",
      "startTime": 1700000000000,
      "endTime": 1700000005000,
      "durationMs": 5000,
      "status": "success",
      "spans": [],
      "metadata": {},
      "source": {
        "serviceName": "my-service",
        "sdkVersion": "0.1.0",
        "exporterType": "lantern"
      },
      "totalInputTokens": 150,
      "totalOutputTokens": 200,
      "estimatedCostUsd": 0.003
    }
  ]
}
```

**Validation rules:**

| Field | Rule |
|---|---|
| `traces` | Non-empty array, required |
| `traces` length | Maximum 100 traces per request |
| `id` | Valid UUID format (`[0-9a-f]{8}-[0-9a-f]{4}-...`) |
| `sessionId` | Valid UUID format |
| `agentName` | String, 1--255 characters |
| `environment` | String, 1--64 characters |
| `status` | One of `"success"`, `"error"`, `"running"` |
| `startTime` | Finite number |

**Response (200):**

```json
{
  "accepted": 5
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "accepted": 0, "errors": ["..."] }` | Validation failure |
| 400 | `{ "accepted": 0, "errors": ["Maximum 100 traces per request"] }` | Batch too large |
| 401 | `{ "error": "Unauthorized" }` | Missing or invalid API key |
| 429 | `{ "error": "Trace limit exceeded", ... }` | Monthly plan limit reached |
| 500 | `{ "accepted": 0, "errors": ["Internal server error"] }` | Storage failure |

**Example:**

```bash
curl -X POST http://localhost:4100/v1/traces \
  -H 'Authorization: Bearer ltn_abc123...' \
  -H 'Content-Type: application/json' \
  -d '{
    "traces": [{
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "sessionId": "660e8400-e29b-41d4-a716-446655440000",
      "agentName": "my-agent",
      "environment": "production",
      "startTime": 1700000000000,
      "status": "success",
      "spans": [],
      "metadata": {},
      "totalInputTokens": 0,
      "totalOutputTokens": 0,
      "estimatedCostUsd": 0
    }]
  }'
```

---

### GET /v1/traces

Query traces with optional filters.

**Authentication:** API key.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `agentName` | string | Filter by agent name |
| `environment` | string | Filter by environment |
| `status` | string | Filter by status (`success`, `error`, `running`) |
| `serviceName` | string | Filter by source service name |
| `startAfter` | number | Unix timestamp (ms) lower bound |
| `startBefore` | number | Unix timestamp (ms) upper bound |
| `limit` | number | Maximum results |
| `offset` | number | Pagination offset |

**Response (200):**

```json
{
  "traces": [
    {
      "id": "uuid",
      "sessionId": "uuid",
      "agentName": "my-agent",
      "environment": "production",
      "startTime": 1700000000000,
      "endTime": 1700000005000,
      "durationMs": 5000,
      "status": "success",
      "spans": [],
      "metadata": {},
      "totalInputTokens": 150,
      "totalOutputTokens": 200,
      "estimatedCostUsd": 0.003
    }
  ]
}
```

**Example:**

```bash
curl 'http://localhost:4100/v1/traces?agentName=my-agent&limit=10' \
  -H 'Authorization: Bearer ltn_abc123...'
```

---

### GET /v1/traces/:id

Retrieve a single trace by ID.

**Authentication:** API key.

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `id` | string | Trace UUID |

**Response (200):** A single `Trace` object.

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "Invalid trace ID format" }` | ID is not a valid UUID |
| 404 | `{ "error": "Trace not found" }` | No trace with given ID |

**Example:**

```bash
curl http://localhost:4100/v1/traces/550e8400-e29b-41d4-a716-446655440000 \
  -H 'Authorization: Bearer ltn_abc123...'
```

---

### GET /v1/sources

List connected data sources, summarised by service name, SDK version, and
exporter type.

**Authentication:** API key.

**Response (200):**

```json
{
  "sources": [
    {
      "serviceName": "my-service",
      "sdkVersion": "0.1.0",
      "exporterType": "lantern",
      "traceCount": 1500,
      "lastSeen": 1700000000000,
      "environments": ["production", "staging"],
      "agents": ["agent-a", "agent-b"]
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:4100/v1/sources \
  -H 'Authorization: Bearer ltn_abc123...'
```

---

### GET /health

Health check endpoint. Verifies storage backend connectivity and returns the
current trace count.

**Authentication:** None (public).

**Response (200):**

```json
{
  "status": "ok",
  "traceCount": 15000,
  "uptime": 3600.5
}
```

**Response (503):**

```json
{
  "status": "unhealthy"
}
```

**Example:**

```bash
curl http://localhost:4100/health
```

---

## Trace Schema Reference

The complete `Trace` type accepted by the ingest endpoint:

```typescript
interface Trace {
  id: string;                          // UUID
  sessionId: string;                   // UUID
  agentName: string;                   // 1-255 chars
  agentVersion?: string;
  environment: string;                 // 1-64 chars
  startTime: number;                   // Unix timestamp in milliseconds
  endTime?: number;
  durationMs?: number;
  status: "running" | "success" | "error";
  spans: Span[];
  metadata: Record<string, unknown>;
  source?: TraceSource;
  scores?: EvalScore[];
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
}

interface Span {
  id: string;                          // UUID
  traceId: string;                     // UUID
  parentSpanId?: string;               // UUID
  type: "llm_call" | "tool_call" | "reasoning_step" | "retrieval" | "custom";
  startTime: number;
  endTime?: number;
  durationMs?: number;
  input: SpanInput;
  output?: SpanOutput;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  toolName?: string;
  toolResult?: unknown;
  error?: string;
}

interface SpanInput {
  messages?: Array<{ role: string; content: string }>;
  prompt?: string;
  args?: unknown;
}

interface SpanOutput {
  content?: string;
  toolCalls?: unknown[];
  stopReason?: string;
}

interface TraceSource {
  serviceName: string;
  sdkVersion?: string;
  exporterType?: string;
}

interface EvalScore {
  scorer: string;
  score: number;
  label?: string;
  reasoning?: string;
}
```

---

## Security Headers

All responses include:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

---

## Request Limits

| Limit | Value |
|---|---|
| Maximum request body size | 1 MB (`1_048_576` bytes) |
| Maximum traces per POST request | 100 |
| Maximum `agentName` length | 255 characters |
| Maximum `environment` length | 64 characters |
