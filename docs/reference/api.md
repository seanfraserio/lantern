# API Server Reference

Complete reference for the Lantern API server. The API server handles dashboard
authentication, trace querying, scorecards, regressions, cost analysis, team
management, billing, and all other management endpoints.

**Base URL:** `http://localhost:4200` (default) or as configured via `PORT`.

---

## Authentication

The API server uses two authentication mechanisms:

- **JWT Bearer tokens** for dashboard users (all endpoints except those listed below).
- **Shared secret** for the retention cleanup endpoint.

Endpoints that skip JWT authentication:

| Path pattern | Reason |
|---|---|
| `/health` | Public health check |
| `/auth/*` | Pre-authentication routes |
| `/billing/webhook` | Stripe webhook (verified by signature) |
| `/retention/policy` | Public policy listing |
| `/retention/cleanup` | Uses shared secret, not JWT |
| `OPTIONS` requests | CORS preflight |

JWT tokens are HS256-signed, expire after 24 hours, and contain the following
claims:

```typescript
interface JwtPayload {
  sub: string;        // user ID
  tenantId: string;   // tenant UUID
  tenantSlug: string; // tenant slug (3-32 chars, lowercase alphanumeric/hyphens)
  role: string;       // "owner" | "admin" | "member"
  exp: number;        // expiry timestamp
}
```

All authenticated endpoints require the header:

```
Authorization: Bearer <jwt-token>
```

---

## Authentication Endpoints

### POST /auth/register

Create a new tenant, user, database schema, and initial API key.

**Authentication:** None (public).

**Rate limit:** 5 requests per minute per IP.

**Request body:**

```json
{
  "email": "user@example.com",
  "password": "SecurePass1",
  "tenantSlug": "my-org",
  "tenantName": "My Organisation"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | string | Yes | Must be unique |
| `password` | string | Yes | Min 8 chars, must contain lowercase, uppercase, and digit |
| `tenantSlug` | string | Yes | 3-32 chars, lowercase alphanumeric and hyphens |
| `tenantName` | string | Yes | Display name for the tenant |

**Response (201):**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "apiKey": "ltn_abc123...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "role": "owner"
  },
  "tenant": {
    "id": "uuid",
    "slug": "my-org"
  }
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "email, password, tenantSlug, and tenantName are required" }` | Missing fields |
| 400 | `{ "error": "Password must be at least 8 characters" }` | Weak password |
| 400 | `{ "error": "Slug must be 3-32 chars, lowercase alphanumeric and hyphens" }` | Invalid slug |
| 409 | `{ "error": "Registration failed -- email or slug already in use" }` | Duplicate email or slug |
| 429 | `{ "error": "Too many requests. Try again later." }` | Rate limited |

**Example:**

```bash
curl -X POST http://localhost:4200/auth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "admin@example.com",
    "password": "SecurePass1",
    "tenantSlug": "acme",
    "tenantName": "Acme Corp"
  }'
```

---

### POST /auth/login

Authenticate an existing user and receive a JWT token.

**Authentication:** None (public).

**Rate limit:** 10 requests per minute per IP.

**Request body:**

```json
{
  "email": "user@example.com",
  "password": "SecurePass1"
}
```

**Response (200):**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "role": "owner"
  }
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "email and password are required" }` | Missing fields |
| 401 | `{ "error": "Invalid credentials" }` | Wrong email or password |
| 429 | `{ "error": "Too many requests. Try again later." }` | Rate limited |

**Example:**

```bash
curl -X POST http://localhost:4200/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email": "admin@example.com", "password": "SecurePass1"}'
```

---

### POST /token/refresh

Refresh an existing JWT token. Returns a new token with a fresh 24-hour expiry.

**Authentication:** JWT (validates the current token).

**Request body:** None.

**Response (200):**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 401 | `{ "error": "Invalid token" }` | No valid JWT on request |

**Example:**

```bash
curl -X POST http://localhost:4200/token/refresh \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIs...'
```

---

## Traces

### GET /traces

Query traces for the authenticated tenant.

**Authentication:** JWT.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `agentName` | string | -- | Filter by agent name |
| `environment` | string | -- | Filter by environment |
| `status` | string | -- | Filter by status (`success`, `error`, `running`) |
| `serviceName` | string | -- | Filter by source service name |
| `startAfter` | number | -- | Unix timestamp (ms) lower bound |
| `startBefore` | number | -- | Unix timestamp (ms) upper bound |
| `limit` | number | -- | Maximum number of traces to return |
| `offset` | number | -- | Pagination offset |

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
      "source": { "serviceName": "my-service", "sdkVersion": "0.1.0" },
      "totalInputTokens": 150,
      "totalOutputTokens": 200,
      "estimatedCostUsd": 0.003
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:4200/traces?agentName=my-agent&limit=10 \
  -H 'Authorization: Bearer <token>'
```

---

### GET /traces/:id

Retrieve a single trace by ID.

**Authentication:** JWT.

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `id` | string | Trace UUID |

**Response (200):** A single `Trace` object (same schema as above).

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 404 | `{ "error": "Trace not found" }` | No trace with given ID |

**Example:**

```bash
curl http://localhost:4200/traces/550e8400-e29b-41d4-a716-446655440000 \
  -H 'Authorization: Bearer <token>'
```

---

### GET /sources

List connected data sources (grouped by service name, SDK version, and exporter type).

**Authentication:** JWT.

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
curl http://localhost:4200/sources \
  -H 'Authorization: Bearer <token>'
```

---

## Scorecards

### GET /scorecards

Retrieve scorecards for all agents, with aggregate quality metrics.

**Authentication:** JWT.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `period` | number | 30 | Lookback period in days. Valid values: `7`, `30`, `90`. |
| `environment` | string | -- | Filter by environment |

**Response (200):**

```json
{
  "period": 30,
  "scorecards": [
    {
      "agentName": "my-agent",
      "totalTraces": 1200,
      "successRate": 98.5,
      "errorRate": 1.5,
      "avgLatencyMs": 1250.75,
      "p50LatencyMs": 900,
      "p95LatencyMs": 3200,
      "p99LatencyMs": 5100,
      "avgCostPerTrace": 0.004500,
      "totalCost": 5.400000,
      "qualityTrend": "improving"
    }
  ]
}
```

The `qualityTrend` field compares the current period's success rate against the
previous period of equal length. Values: `"improving"` (>1% increase),
`"declining"` (>1% decrease), or `"stable"`.

**Example:**

```bash
curl 'http://localhost:4200/scorecards?period=7' \
  -H 'Authorization: Bearer <token>'
```

---

### GET /scorecards/:agentName

Retrieve a detailed scorecard for a single agent, including a daily breakdown.

**Authentication:** JWT.

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `agentName` | string | Agent name |

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `period` | number | 30 | Lookback period in days (`7`, `30`, `90`) |
| `environment` | string | -- | Filter by environment |

**Response (200):**

```json
{
  "agentName": "my-agent",
  "period": 30,
  "summary": {
    "totalTraces": 1200,
    "successRate": 98.5,
    "errorRate": 1.5,
    "avgLatencyMs": 1250.75,
    "p50LatencyMs": 900,
    "p95LatencyMs": 3200,
    "p99LatencyMs": 5100,
    "avgCostPerTrace": 0.004500,
    "totalCost": 5.400000
  },
  "daily": [
    {
      "date": "2025-01-15",
      "totalTraces": 40,
      "successRate": 97.5,
      "errorRate": 2.5,
      "avgLatencyMs": 1300,
      "p50LatencyMs": 950,
      "p95LatencyMs": 3400,
      "p99LatencyMs": 5300,
      "avgCostPerTrace": 0.004800,
      "totalCost": 0.192000
    }
  ]
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 404 | `{ "error": "No traces found for this agent in the given period" }` | No data |

**Example:**

```bash
curl 'http://localhost:4200/scorecards/my-agent?period=7' \
  -H 'Authorization: Bearer <token>'
```

---

### POST /scorecards/sla

Set or update an SLA target for an agent. Uses upsert semantics -- if an SLA
target already exists for the given agent, the provided values are merged.

**Authentication:** JWT.

**Request body:**

```json
{
  "agentName": "my-agent",
  "minSuccessRate": 99.0,
  "maxP95LatencyMs": 5000,
  "maxCostPerTrace": 0.01
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `agentName` | string | Yes | Agent name |
| `minSuccessRate` | number | No | Minimum success rate percentage |
| `maxP95LatencyMs` | number | No | Maximum P95 latency in milliseconds |
| `maxCostPerTrace` | number | No | Maximum average cost per trace in USD |

At least one of `minSuccessRate`, `maxP95LatencyMs`, or `maxCostPerTrace` must
be provided.

**Response (201):**

```json
{
  "slaTarget": {
    "id": "uuid",
    "tenantId": "uuid",
    "agentName": "my-agent",
    "minSuccessRate": 99.0,
    "maxP95LatencyMs": 5000,
    "maxCostPerTrace": 0.01,
    "createdAt": "2025-01-15T10:30:00.000Z"
  }
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "agentName is required" }` | Missing agent name |
| 400 | `{ "error": "At least one SLA target is required" }` | No targets provided |

**Example:**

```bash
curl -X POST http://localhost:4200/scorecards/sla \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"agentName": "my-agent", "minSuccessRate": 99.0}'
```

---

### GET /scorecards/sla/violations

Check all configured SLA targets against current metrics and return any
violations.

**Authentication:** JWT.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `period` | number | 30 | Lookback period in days (`7`, `30`, `90`) |
| `environment` | string | -- | Filter by environment |

**Response (200):**

```json
{
  "period": 30,
  "violations": [
    {
      "agentName": "my-agent",
      "sla": {
        "id": "uuid",
        "tenantId": "uuid",
        "agentName": "my-agent",
        "minSuccessRate": 99.0,
        "maxP95LatencyMs": 5000,
        "maxCostPerTrace": 0.01,
        "createdAt": "2025-01-15T10:30:00.000Z"
      },
      "current": {
        "successRate": 97.5,
        "p95LatencyMs": 6200,
        "avgCostPerTrace": 0.008
      },
      "violations": [
        "Success rate 97.5% is below minimum 99%",
        "P95 latency 6200ms exceeds maximum 5000ms"
      ]
    }
  ]
}
```

If no SLA targets are configured, returns `{ "violations": [], "message": "No SLA targets configured" }`.

**Example:**

```bash
curl 'http://localhost:4200/scorecards/sla/violations?period=7' \
  -H 'Authorization: Bearer <token>'
```

---

## Regressions

### GET /regressions/check

Analyse all agents for behavioural regressions by comparing the last 24 hours
against the preceding 7-day baseline. A regression is flagged when any metric
deviates by more than 20%.

**Authentication:** JWT.

**Tracked metrics:**

- `avg_response_length` -- average LLM response text length
- `avg_token_count` -- average total tokens per trace
- `error_rate` -- proportion of traces with `status: "error"`
- `avg_latency_ms` -- average trace duration
- `tool_call_ratio` -- proportion of spans that are tool calls

Detected regressions are persisted to the `regression_events` table for
historical tracking.

**Response (200):**

```json
{
  "checkedAt": "2025-01-15T10:30:00.000Z",
  "agentCount": 3,
  "regressionsFound": 1,
  "agents": [
    {
      "agentName": "my-agent",
      "baselineMetrics": {
        "avgResponseLength": 500,
        "avgTokenCount": 1200,
        "errorRate": 0.02,
        "avgLatencyMs": 1500,
        "toolCallRatio": 0.3,
        "traceCount": 200
      },
      "currentMetrics": {
        "avgResponseLength": 650,
        "avgTokenCount": 1600,
        "errorRate": 0.08,
        "avgLatencyMs": 2100,
        "toolCallRatio": 0.35,
        "traceCount": 30
      },
      "regressions": [
        {
          "metric": "error_rate",
          "baselineValue": 0.02,
          "currentValue": 0.08,
          "changePercent": 300.0
        }
      ],
      "hasRegression": true
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:4200/regressions/check \
  -H 'Authorization: Bearer <token>'
```

---

### GET /regressions/history

List previously detected regression events.

**Authentication:** JWT.

**Query parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 50 | Max results (capped at 200) |
| `offset` | number | 0 | Pagination offset |
| `agentName` | string | -- | Filter by agent name |

**Response (200):**

```json
{
  "events": [
    {
      "id": "uuid",
      "agent_name": "my-agent",
      "metric": "error_rate",
      "baseline_value": 0.02,
      "current_value": 0.08,
      "change_percent": 300.0,
      "detected_at": "2025-01-15T10:30:00.000Z"
    }
  ],
  "total": 15,
  "limit": 50,
  "offset": 0
}
```

**Example:**

```bash
curl 'http://localhost:4200/regressions/history?agentName=my-agent&limit=10' \
  -H 'Authorization: Bearer <token>'
```

---

### POST /regressions/baseline/:agentName

Manually snapshot a baseline for an agent using the last 7 days of trace data.
This does not persist the baseline -- it returns the computed metrics for
inspection.

**Authentication:** JWT.

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `agentName` | string | Agent name |

**Response (200):**

```json
{
  "agentName": "my-agent",
  "snapshotAt": "2025-01-15T10:30:00.000Z",
  "traceCount": 200,
  "windowDays": 7,
  "baseline": {
    "avgResponseLength": 500,
    "avgTokenCount": 1200,
    "errorRate": 0.02,
    "avgLatencyMs": 1500,
    "toolCallRatio": 0.3,
    "traceCount": 200
  }
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 404 | `{ "error": "No traces found for agent \"x\" in the last 7 days" }` | No data |

**Example:**

```bash
curl -X POST http://localhost:4200/regressions/baseline/my-agent \
  -H 'Authorization: Bearer <token>'
```

---

## Costs

### GET /costs/breakdown

Cost breakdown by agent, model, and day for the current calendar month.

**Authentication:** JWT.

**Response (200):**

```json
{
  "perAgent": [
    {
      "agentName": "my-agent",
      "totalCost": 12.50,
      "traceCount": 2500,
      "avgCostPerTrace": 0.005,
      "topModel": "claude-sonnet-4-5-20251001"
    }
  ],
  "perModel": [
    {
      "model": "claude-sonnet-4-5-20251001",
      "totalCost": 10.00,
      "totalTokens": 500000
    }
  ],
  "daily": [
    {
      "date": "2025-01-15",
      "cost": 0.85,
      "traceCount": 170
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:4200/costs/breakdown \
  -H 'Authorization: Bearer <token>'
```

---

### GET /costs/forecast

Project end-of-month cost based on daily average spend so far.

**Authentication:** JWT.

**Response (200):**

```json
{
  "currentMonthSpend": 8.50,
  "dailyAverage": 0.57,
  "daysElapsed": 15,
  "daysRemaining": 16,
  "projectedMonthlyTotal": 17.62,
  "lastMonthSpend": 14.30,
  "monthOverMonthChange": 23.2,
  "perAgent": [
    {
      "agentName": "my-agent",
      "currentSpend": 6.00,
      "dailyAverage": 0.40,
      "projectedTotal": 12.40
    }
  ]
}
```

The `monthOverMonthChange` field is a percentage; `null` if last month had zero
spend.

**Example:**

```bash
curl http://localhost:4200/costs/forecast \
  -H 'Authorization: Bearer <token>'
```

---

### POST /costs/budget

Set a monthly budget for an agent. Uses upsert semantics -- overwrites any
existing budget for the same agent.

**Authentication:** JWT.

**Request body:**

```json
{
  "agentName": "my-agent",
  "monthlyBudget": 50.00
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `agentName` | string | Yes | Non-empty |
| `monthlyBudget` | number | Yes | Must be positive |

**Response (200):**

```json
{
  "success": true,
  "agentName": "my-agent",
  "monthlyBudget": 50.00
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "agentName is required" }` | Missing or invalid |
| 400 | `{ "error": "monthlyBudget must be a positive number" }` | Invalid budget |

**Example:**

```bash
curl -X POST http://localhost:4200/costs/budget \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"agentName": "my-agent", "monthlyBudget": 50}'
```

---

### GET /costs/budget/alerts

Check which agents are projected to exceed their monthly budget. Returns alerts
only for agents whose projected spend exceeds the configured budget.

**Authentication:** JWT.

**Response (200):**

```json
{
  "alerts": [
    {
      "agentName": "my-agent",
      "budget": 50.00,
      "currentSpend": 35.00,
      "projectedSpend": 72.00,
      "percentOfBudget": 144,
      "recommendation": "Consider switching from Claude Sonnet to Claude Haiku to save ~73% on input costs."
    }
  ]
}
```

The `recommendation` field suggests a cheaper model when one is available.

**Example:**

```bash
curl http://localhost:4200/costs/budget/alerts \
  -H 'Authorization: Bearer <token>'
```

---

## API Keys

### GET /api-keys

List all API keys for the authenticated tenant. Keys are returned with their
prefix, name, and creation date -- never the full key value.

**Authentication:** JWT.

**Response (200):**

```json
{
  "keys": [
    {
      "id": "uuid",
      "keyPrefix": "ltn_abc1",
      "name": "Default",
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:4200/api-keys \
  -H 'Authorization: Bearer <token>'
```

---

### POST /api-keys

Create a new API key. The full key is returned only once in the response -- it
cannot be retrieved later.

**Authentication:** JWT.

**Request body:**

```json
{
  "name": "CI Pipeline"
}
```

**Response (201):**

```json
{
  "id": "uuid",
  "key": "ltn_abc123def456...",
  "prefix": "ltn_abc1",
  "name": "CI Pipeline",
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "name is required" }` | Missing name |

**Example:**

```bash
curl -X POST http://localhost:4200/api-keys \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"name": "CI Pipeline"}'
```

---

### DELETE /api-keys/:id

Revoke an API key. The key is permanently invalidated and cannot be recovered.

**Authentication:** JWT.

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `id` | string | API key UUID |

**Response (200):**

```json
{
  "revoked": true
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 404 | `{ "error": "Key not found or already revoked" }` | Key does not exist or already revoked |

**Example:**

```bash
curl -X DELETE http://localhost:4200/api-keys/550e8400-e29b-41d4-a716-446655440000 \
  -H 'Authorization: Bearer <token>'
```

---

## Teams

### GET /teams

List all teams for the authenticated tenant.

**Authentication:** JWT.

**Response (200):**

```json
{
  "teams": [
    {
      "id": "uuid",
      "name": "Backend Team",
      "created_at": "2025-01-15T10:30:00.000Z"
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:4200/teams \
  -H 'Authorization: Bearer <token>'
```

---

### GET /teams/:id

Get team details including members and agent scope.

**Authentication:** JWT.

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `id` | string | Team UUID |

**Response (200):**

```json
{
  "id": "uuid",
  "name": "Backend Team",
  "created_at": "2025-01-15T10:30:00.000Z",
  "members": ["alice@example.com", "bob@example.com"],
  "agentScope": ["agent-a", "agent-b"]
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 404 | `{ "error": "Team not found" }` | Team does not exist or belongs to another tenant |

**Example:**

```bash
curl http://localhost:4200/teams/550e8400-e29b-41d4-a716-446655440000 \
  -H 'Authorization: Bearer <token>'
```

---

### POST /teams

Create a new team.

**Authentication:** JWT. Requires `owner` or `admin` role.

**Request body:**

```json
{
  "name": "Backend Team",
  "members": ["alice@example.com", "bob@example.com"]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Team name |
| `members` | string[] | No | List of member email addresses |

**Response (201):** The created team object.

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "name is required" }` | Missing name |
| 403 | `{ "error": "Only owners and admins can create teams" }` | Insufficient role |
| 501 | `{ "error": "Team management not available" }` | Enterprise package not installed |

**Example:**

```bash
curl -X POST http://localhost:4200/teams \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"name": "Backend Team", "members": ["alice@example.com"]}'
```

---

### PUT /teams/:id/scope

Set agent scope for a team, restricting which agents the team can access.

**Authentication:** JWT. Requires `owner` or `admin` role.

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `id` | string | Team UUID |

**Request body:**

```json
{
  "agentNames": ["agent-a", "agent-b"]
}
```

**Response (200):**

```json
{
  "updated": true
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "agentNames array is required" }` | Missing or invalid |
| 403 | `{ "error": "Only owners and admins can set team scope" }` | Insufficient role |
| 501 | `{ "error": "Team management not available" }` | Enterprise package not installed |

**Example:**

```bash
curl -X PUT http://localhost:4200/teams/550e8400-e29b-41d4-a716-446655440000/scope \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"agentNames": ["agent-a", "agent-b"]}'
```

---

## PII

PII endpoints require the `@lantern-ai/enterprise` package. They return
`501 Not Available` when the enterprise package is not installed.

### POST /pii/scan

Scan text for personally identifiable information.

**Authentication:** JWT.

**Request body:**

```json
{
  "text": "Contact John Smith at john@example.com or 555-0123."
}
```

**Response (200):**

```json
{
  "detections": [
    { "type": "person_name", "value": "John Smith", "start": 8, "end": 18 },
    { "type": "email", "value": "john@example.com", "start": 22, "end": 38 }
  ]
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "text is required" }` | Missing text |
| 501 | `{ "error": "PII detection not available" }` | Enterprise package not installed |

**Example:**

```bash
curl -X POST http://localhost:4200/pii/scan \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"text": "Contact john@example.com"}'
```

---

### POST /pii/redact

Redact PII from text, replacing detected entities with placeholders.

**Authentication:** JWT.

**Request body:**

```json
{
  "text": "Contact john@example.com"
}
```

**Response (200):**

```json
{
  "redacted": "Contact [EMAIL_REDACTED]"
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "text is required" }` | Missing text |
| 501 | `{ "error": "PII detection not available" }` | Enterprise package not installed |

**Example:**

```bash
curl -X POST http://localhost:4200/pii/redact \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"text": "Contact john@example.com"}'
```

---

### POST /pii/scan-trace/:id

Scan all spans within a trace for PII. Examines input messages and output
content across all spans.

**Authentication:** JWT.

**Path parameters:**

| Parameter | Type | Description |
|---|---|---|
| `id` | string | Trace UUID |

**Response (200):**

```json
{
  "traceId": "uuid",
  "piiFound": true,
  "detections": [
    {
      "spanId": "uuid",
      "field": "input",
      "detections": [
        { "type": "email", "value": "john@example.com", "start": 10, "end": 26 }
      ]
    }
  ]
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 404 | `{ "error": "Trace not found" }` | No trace with given ID |
| 501 | `{ "error": "PII detection not available" }` | Enterprise package not installed |

**Example:**

```bash
curl -X POST http://localhost:4200/pii/scan-trace/550e8400-e29b-41d4-a716-446655440000 \
  -H 'Authorization: Bearer <token>'
```

---

## Compliance

Compliance endpoints require the `@lantern-ai/enterprise` package.

### GET /compliance/frameworks

List available compliance frameworks.

**Authentication:** JWT.

**Response (200):**

```json
{
  "frameworks": [
    { "id": "soc2", "name": "SOC 2 Type II", "description": "Access control and change management audit" },
    { "id": "hipaa", "name": "HIPAA", "description": "Healthcare data access and processing audit" },
    { "id": "gdpr", "name": "GDPR", "description": "Data processing and inventory audit" }
  ]
}
```

**Example:**

```bash
curl http://localhost:4200/compliance/frameworks \
  -H 'Authorization: Bearer <token>'
```

---

### POST /compliance/export

Generate a compliance report for a given framework and date range.

**Authentication:** JWT. Requires `owner` or `admin` role.

**Request body:**

```json
{
  "framework": "soc2",
  "startDate": "2025-01-01",
  "endDate": "2025-01-31"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `framework` | string | Yes | `"soc2"`, `"hipaa"`, or `"gdpr"` |
| `startDate` | string | Yes | ISO date string |
| `endDate` | string | Yes | ISO date string |

**Response (200):** The generated compliance report object (structure depends on
framework).

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "framework, startDate, and endDate are required" }` | Missing fields |
| 403 | `{ "error": "Only owners and admins can export compliance reports" }` | Insufficient role |
| 501 | `{ "error": "Compliance export not available" }` | Enterprise package not installed |

**Example:**

```bash
curl -X POST http://localhost:4200/compliance/export \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"framework": "soc2", "startDate": "2025-01-01", "endDate": "2025-01-31"}'
```

---

## Billing

Billing routes require Stripe configuration (`STRIPE_SECRET_KEY`,
`STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`). If these environment variables
are not set, the billing routes are not registered.

### POST /billing/checkout

Create a Stripe Checkout session for subscribing to the Team plan.

**Authentication:** JWT.

**Request body:** None.

**Response (200):**

```json
{
  "url": "https://checkout.stripe.com/c/pay/cs_test_..."
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 404 | `{ "error": "Tenant not found" }` | Tenant record missing |

**Example:**

```bash
curl -X POST http://localhost:4200/billing/checkout \
  -H 'Authorization: Bearer <token>'
```

---

### GET /billing/status

Get the current billing status, subscription details, and usage against plan
limits.

**Authentication:** JWT.

**Response (200):**

```json
{
  "plan": "team",
  "subscription": {
    "status": "active",
    "currentPeriodEnd": "2025-02-15T00:00:00.000Z",
    "cancelAtPeriodEnd": false
  },
  "usage": {
    "traceCount": 15000,
    "inputTokens": 5000000,
    "outputTokens": 2000000
  },
  "limits": {
    "tracesPerMonth": 1000000,
    "used": 15000,
    "remaining": 985000,
    "percentUsed": 2
  }
}
```

Plan limits:

| Plan | Traces per month |
|---|---|
| `free` | 10,000 |
| `team` | 1,000,000 |
| `enterprise` | Effectively unlimited |

**Example:**

```bash
curl http://localhost:4200/billing/status \
  -H 'Authorization: Bearer <token>'
```

---

### POST /billing/portal

Create a Stripe Customer Portal session for managing subscriptions.

**Authentication:** JWT.

**Request body:** None.

**Response (200):**

```json
{
  "url": "https://billing.stripe.com/p/session/..."
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "No billing account. Subscribe first." }` | No Stripe customer |

**Example:**

```bash
curl -X POST http://localhost:4200/billing/portal \
  -H 'Authorization: Bearer <token>'
```

---

### POST /billing/webhook

Stripe webhook endpoint. Processes subscription lifecycle events.

**Authentication:** Stripe webhook signature verification (via
`stripe-signature` header). JWT is **not** required.

**Handled event types:**

| Event | Action |
|---|---|
| `checkout.session.completed` | Set tenant plan to `team`, store subscription ID |
| `customer.subscription.deleted` | Revert tenant plan to `free` |
| `customer.subscription.updated` | Update plan based on subscription status |

**Response (200):**

```json
{
  "received": true
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 400 | `{ "error": "Missing stripe-signature header" }` | No signature |
| 400 | `{ "error": "Invalid webhook signature" }` | Signature mismatch |

---

## Retention

### GET /retention/policy

List trace retention policies by plan tier.

**Authentication:** None (public).

**Response (200):**

```json
{
  "policies": [
    { "plan": "free", "retentionDays": 7 },
    { "plan": "team", "retentionDays": 90 },
    { "plan": "enterprise", "retentionDays": 365 }
  ]
}
```

**Example:**

```bash
curl http://localhost:4200/retention/policy
```

---

### POST /retention/cleanup

Run the retention cleanup job. Deletes traces older than the retention period
for each tenant based on their plan.

**Authentication:** Shared secret via `Authorization: Bearer <RETENTION_SECRET>`.
This endpoint is designed to be called by Cloud Scheduler or cron, not by
dashboard users.

**Request body:** None.

**Response (200):**

```json
{
  "cleaned": 2,
  "details": [
    { "tenant": "acme", "plan": "free", "deleted": 150 },
    { "tenant": "beta", "plan": "team", "deleted": 30 }
  ],
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

**Error responses:**

| Status | Body | Condition |
|---|---|---|
| 401 | `{ "error": "Unauthorized" }` | Missing or invalid secret |
| 503 | `{ "error": "Retention cleanup is not configured" }` | `RETENTION_SECRET` not set |

**Example:**

```bash
curl -X POST http://localhost:4200/retention/cleanup \
  -H 'Authorization: Bearer my-retention-secret'
```

---

## Health

### GET /health

Health check endpoint. Verifies database connectivity.

**Authentication:** None (public).

**Response (200):**

```json
{
  "status": "ok",
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
curl http://localhost:4200/health
```

---

## Security Headers

All responses include the following security headers:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'` |

## CORS

The API server allows cross-origin requests from:

- `https://app.openlanternai.com`
- `https://dashboard.openlanternai.com`
- `https://openlanternai-dashboard.pages.dev`
- `http://localhost:*` (any port, for local development)

Preflight `OPTIONS` requests are handled automatically and return `204 No Content`.
