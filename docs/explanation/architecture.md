# Architecture

How Lantern works under the hood: the components, how data flows between them,
and the key design decisions that shape the platform.

---

## System Overview

Lantern is an agent observability platform composed of five main components:

```
                    +-----------+
                    | Dashboard |
                    |  (Vite)   |
                    +-----+-----+
                          |
                          | JWT auth
                          v
+--------+          +-----+------+         +------------+
|  SDK   | -------> |   Ingest   | ------> | PostgreSQL |
| (TS/Py)|  traces  |   Server   |  store  |            |
+--------+          +------------+         +-----+------+
                          ^                      |
+--------+                |                      | query
|  LLM   | ---- traces --+                      v
| Proxy  |                                 +-----+------+
+--------+                                 | API Server |
                                           +------------+
```

1. **SDKs** (TypeScript and Python) instrument agent code and export traces.
2. **LLM Proxy** sits between agents and upstream LLM APIs, generating traces transparently.
3. **Ingest server** receives traces via `POST /v1/traces` and stores them in PostgreSQL.
4. **API server** provides management endpoints: authentication, scorecards, regressions, costs, billing, and more.
5. **Dashboard** is a single-page application that communicates with the API server.

Each component is independently deployable. A minimal self-hosted installation
needs only the ingest server and SQLite -- no PostgreSQL, no API server, no
dashboard.

---

## Data Flow

A trace's journey through the system:

### 1. Trace creation

The SDK creates a `Trace` object when `startTrace()` is called. Each trace
gets a UUID, a session ID, and initial metadata. As the agent executes, spans
are added to the trace -- one per LLM call, tool invocation, retrieval step,
or reasoning step.

### 2. Buffering and batching

Completed traces are buffered in memory. The SDK's `LanternTracer` holds traces
in a buffer and exports them either when the buffer reaches `batchSize` (default
50) or when the periodic flush timer fires (default every 5 seconds).

This batching strategy reduces HTTP overhead. A single POST request can carry up
to 100 traces.

### 3. Ingest

The `LanternExporter` sends traces to `POST /v1/traces` on the ingest server.
The exporter includes the API key as a Bearer token. In multi-tenant mode, the
ingest server resolves the API key to a tenant, checks usage limits, and
routes the traces to the correct PostgreSQL schema.

### 4. Storage

Traces are stored in PostgreSQL as rows in a `traces` table. The `spans` field
is stored as JSONB, keeping the full span tree alongside the trace. This
denormalised design makes it simple to query traces without joins, at the cost
of larger row sizes.

### 5. Query and display

The API server queries traces from the tenant's PostgreSQL schema and serves
them to the dashboard. The dashboard uses JWT authentication, so it never sees
API keys.

---

## Multi-tenancy Model

Lantern uses **schema-per-tenant isolation** in PostgreSQL. Each tenant gets
a dedicated PostgreSQL schema named `tenant_<slug>`, where `<slug>` is the
tenant's URL-safe identifier (e.g. `tenant_acme`).

### Why schema-per-tenant?

There are three common approaches to multi-tenancy in PostgreSQL:

1. **Row-level isolation** -- all tenants share tables, filtered by a `tenant_id` column.
2. **Schema-per-tenant** -- each tenant has its own schema with identical tables.
3. **Database-per-tenant** -- each tenant has a separate database.

Lantern chose schema-per-tenant for several reasons:

- **Strong isolation without operational complexity.** Schema-level separation
  provides meaningful isolation -- a query against one tenant's data cannot
  accidentally access another tenant's traces. This is stronger than row-level
  isolation, where a missing `WHERE` clause could leak data.

- **Simple backup and migration.** A single PostgreSQL cluster hosts all
  tenants. Backups, schema migrations, and connection pooling operate at the
  cluster level rather than per-database.

- **Performance.** Each tenant's `traces` table has its own indexes. High-volume
  tenants do not degrade query performance for others. Row-level isolation
  would require composite indexes including `tenant_id` on every query.

- **Compliance-friendly.** Schema isolation makes it straightforward to
  demonstrate data separation for SOC 2 and GDPR audits.

The trade-off is that schema creation and migration must be applied per-tenant.
The `SchemaManager` handles this automatically when a new tenant registers.

### Shared tables

Some data lives in the `public` schema and is shared across tenants:

| Table | Purpose |
|---|---|
| `tenants` | Tenant records (id, slug, plan, Stripe customer ID) |
| `users` | User accounts with password hashes |
| `api_keys` | API key hashes with tenant association |
| `usage` | Monthly trace and token usage per tenant |
| `sla_targets` | SLA targets per tenant and agent |
| `regression_events` | Historical regression detections |
| `cost_budgets` | Monthly cost budgets per agent |
| `teams` | Team definitions |
| `team_members` | Team membership |
| `team_scopes` | Agent scope restrictions per team |

---

## API Key Authentication

API keys are used to authenticate trace ingestion requests. The authentication
flow works as follows:

1. When a key is created (via `POST /api-keys` or during registration), a
   random key is generated with the prefix `ltn_`. The key is shown to the
   user once.

2. The key is hashed with SHA-256 before storage. Only the hash and a short
   prefix (for display purposes) are persisted. The raw key is never stored.

3. When a request arrives at the ingest server with `Authorization: Bearer ltn_...`,
   the key is hashed with SHA-256 and looked up in the `api_keys` table.

4. If a match is found, the request is associated with the key's tenant. The
   tenant's schema is used for trace storage.

This approach mirrors how GitHub and Stripe handle API keys: the key is a
bearer credential that can be rotated and revoked without affecting other keys.

---

## JWT Authentication

The dashboard uses JWT tokens for session management:

1. A user authenticates via `POST /auth/login` with email and password.
2. The password is verified against a bcrypt hash stored in the `users` table.
3. A JWT token is signed with HS256 using the `JWT_SECRET` and returned.
4. The token contains `sub` (user ID), `tenantId`, `tenantSlug`, and `role`.
5. The token expires after 24 hours and can be refreshed via `POST /token/refresh`.
6. Every authenticated API request includes the token as `Authorization: Bearer <jwt>`.
7. The JWT middleware validates the signature and expiry, then attaches the
   decoded payload to the request.

Routes that skip JWT validation:

- `/health` -- public health check
- `/auth/*` -- pre-authentication routes
- `/billing/webhook` -- Stripe signature verification
- `/retention/policy` -- public policy listing
- `/retention/cleanup` -- uses shared secret
- `OPTIONS` requests -- CORS preflight

---

## OSS and Enterprise

Lantern has an open-source core and an enterprise package:

### Open-source core

The following packages are open source:

- `@openlantern-ai/sdk` -- TypeScript SDK
- `@openlantern-ai/ingest` -- Ingest server
- `@openlantern-ai/proxy` -- LLM Proxy
- `lantern-ai` -- Python SDK

The OSS core provides trace ingestion, storage (SQLite or PostgreSQL), querying,
scorecards, regressions, and cost analysis. It can be self-hosted with Docker
Compose.

### Enterprise package

The `@openlantern-ai/enterprise` package provides:

- **PII detection and redaction** -- `PiiDetector` class for scanning text
- **Compliance exports** -- `ComplianceExporter` for SOC 2, HIPAA, and GDPR reports
- **Alert channels** -- `AlertManager` supporting Slack, PagerDuty, webhook, and email
- **Team management** -- `TeamManager` for RBAC with agent scope restrictions
- **Managed cloud** -- `ManagedService` for hosted deployments

Enterprise features are loaded dynamically via `import("@openlantern-ai/enterprise")`.
When the package is not installed, enterprise endpoints return `501 Not Available`.
This means the API server's route structure is always the same -- the enterprise
package simply enables the implementations behind those routes.

### Dashboard

The dashboard is a separate deployable (Cloudflare Pages for the managed
service, or Docker for self-hosted). It communicates exclusively with the API
server and does not access the ingest server directly.
