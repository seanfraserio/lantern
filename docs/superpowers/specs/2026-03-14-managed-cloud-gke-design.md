# Lantern Managed Cloud — Architecture Design

**Date:** 2026-03-14
**Status:** Draft
**Author:** Sean Fraser + Claude
**Scope:** Production infrastructure for the Lantern managed cloud service (Team and Enterprise tiers)

---

## 1. Problem Statement

Lantern's OSS version is self-hosted. The Team ($299/mo) and Enterprise (custom) tiers require a managed cloud service where customers send traces to a hosted endpoint and access a hosted dashboard. This service needs to be:

- Multi-tenant with strong data isolation
- Horizontally scalable as customer count and trace volume grow
- Near-zero cost at early stage (< $15/mo with no customers)
- Operationally simple for a small team to manage

## 2. Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| Cloud provider | Google Cloud | Specified requirement |
| Compute | Cloud Run | Scales to zero, no idle cost, no cluster management |
| Database | Cloud SQL Postgres 16 (db-f1-micro) | Cheapest managed Postgres, existing store interface, upgrade path to AlloyDB |
| Multi-tenancy | Schema-per-tenant | Better isolation than shared tables, cheaper than DB-per-tenant, good HIPAA path |
| Authentication | API keys (ingest) + JWT (dashboard) | Already have API key auth, minimal new code, add SSO later |
| Dashboard hosting | Cloudflare Pages | Already using it for project websites, free, global CDN |
| IaC | Pulumi (TypeScript) | Consistent with codebase language |
| CI/CD | GitHub Actions + Artifact Registry | Extends existing CI workflows |

## 3. Architecture

### 3.1 Service Topology

```
Internet
  |
  |-- ingest.openlanternai.com --> Cloud Run: Ingest Service
  |-- api.openlanternai.com    --> Cloud Run: API Service
  |-- app.openlanternai.com    --> Cloudflare Pages: Dashboard SPA
  |
  |   Both Cloud Run services connect to:
  |-- Cloud SQL Postgres 16 (via Cloud SQL Connector)
  |   (schema-per-tenant)
```

Two stateless Cloud Run services plus a static dashboard on Cloudflare Pages. Both services connect to one Cloud SQL Postgres instance via the Cloud SQL Node.js connector (no sidecar needed on Cloud Run).

### 3.2 Services

**Ingest Service** (`packages/ingest` -- adapted for multi-tenancy)
- Existing Fastify server with tenant resolution middleware
- Accepts `POST /v1/traces` with Bearer token auth
- Resolves API key to tenant, uses fully qualified table names (`tenant_<slug>.traces`)
- Scales to zero when idle, auto-scales on concurrent requests
- Cloud Run config: min 0, max 10 instances, 256MB RAM, 1 vCPU

**API Service** (new package: `packages/api`)
- Tenant lifecycle: signup, onboarding, schema provisioning
- User management: registration, login, JWT issuance
- API key management: create, revoke, list
- Billing: Stripe integration, usage metering, plan enforcement
- Cloud Run config: min 0, max 5 instances, 256MB RAM, 1 vCPU

**Dashboard** (Cloudflare Pages)
- Static single-page app (extracted from existing inline HTML or future React build)
- Served from Cloudflare Pages -- already used for project websites
- Authenticates via JWT, makes API calls to `api.openlanternai.com`
- Zero compute cost, global CDN, automatic deploys from git

### 3.3 Data Model (Schema-per-tenant)

**`public` schema** -- shared across all tenants:

```sql
-- Tenant registry
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,           -- schema name; validated: /^[a-z0-9-]{3,32}$/
  plan TEXT NOT NULL DEFAULT 'team',   -- 'team' | 'enterprise'
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users (dashboard access)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys (ingest auth)
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  key_hash TEXT NOT NULL,              -- SHA-256 hash of the key
  key_prefix TEXT NOT NULL,            -- first 8 chars for identification
  name TEXT NOT NULL,                  -- human-readable label
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,             -- null = active, set = revoked
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usage tracking (for billing)
CREATE TABLE usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  month TEXT NOT NULL,                 -- '2026-03'
  trace_count BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  UNIQUE(tenant_id, month)
);

-- Schema migration tracking
CREATE TABLE schema_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  version INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, version)
);
```

**`tenant_<slug>` schema** -- per-tenant, created on signup:

```sql
CREATE TABLE traces (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  agent_name TEXT NOT NULL,
  agent_version TEXT,
  environment TEXT NOT NULL,
  start_time BIGINT NOT NULL,
  end_time BIGINT,
  duration_ms INTEGER,
  status TEXT NOT NULL,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  source JSONB,
  spans JSONB NOT NULL DEFAULT '[]',
  scores JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_traces_agent ON traces(agent_name);
CREATE INDEX idx_traces_env ON traces(environment);
CREATE INDEX idx_traces_status ON traces(status);
CREATE INDEX idx_traces_start ON traces(start_time DESC);
```

### 3.4 Authentication

**Ingest (machine-to-machine):**
1. Client sends `Authorization: Bearer lnt_<key>` header
2. Ingest service hashes the key with SHA-256
3. Looks up `key_hash` in `public.api_keys` (WHERE `revoked_at IS NULL`)
4. Resolves `tenant_id` and `tenant_slug`, uses fully qualified table names for all queries
5. Cache the key-to-tenant mapping in-memory (LRU, 5-min TTL) to avoid DB lookup on every request

**Dashboard (human users):**
1. User submits email/password to `POST /api/auth/login`
2. API service verifies password hash (bcrypt)
3. Returns JWT containing `{ sub: userId, tenantId, tenantSlug, role, exp }`
4. Dashboard includes JWT in `Authorization: Bearer` header on all API calls
5. JWT signed with RS256, signing key stored in Secret Manager
6. Token expiry: 24 hours, refresh via `POST /api/auth/refresh`

**API key format:** `lnt_` prefix + 32 random bytes (base62 encoded). Only the hash is stored. The full key is shown once at creation time.

**Note on Cloud Run and LRU cache:** Cloud Run instances may be stopped and restarted. The LRU cache is per-instance and ephemeral -- cache misses just hit the database. This is acceptable since the cache is a performance optimization, not a correctness requirement.

### 3.5 Request Flow (Trace Ingestion)

```
SDK Client
  |
  |-- POST https://ingest.openlanternai.com/v1/traces
  |   Authorization: Bearer lnt_abc123...
  |   Body: { traces: [...] }
  |
  --> Cloud Run Instance
        |
        |-- 1. Extract Bearer token
        |-- 2. Hash token, check LRU cache
        |     Cache miss: query public.api_keys WHERE revoked_at IS NULL
        |-- 3. Resolve tenant_id and tenant slug
        |-- 4. INSERT INTO tenant_<slug>.traces (fully qualified)
        |-- 5. Buffer usage increment in-memory
        |     (flush to public.usage every 30s or 100 traces)
        +-- 6. Return { accepted: N }
```

**Note on usage buffering with Cloud Run:** Cloud Run instances can be shut down between requests. The usage buffer flushes on a timer (30s) and also flushes synchronously when the buffer reaches 100 traces. On instance shutdown, any un-flushed increments (< 100 traces) may be lost. This is acceptable for usage metering -- Stripe billing reconciles monthly, and the variance is negligible.

### 3.6 Tenant Provisioning Flow

```
New Customer Signup
  |
  |-- 1. POST /api/tenants: validate slug (/^[a-z0-9-]{3,32}$/), create record
  |-- 2. CREATE SCHEMA using quote_ident('tenant_' || slug) -- safe DDL
  |-- 3. Run migrations in the new schema (create traces table + indexes)
  |-- 4. Create owner user in public.users
  |-- 5. Generate first API key, return to user (shown once)
  |-- 6. Create Stripe customer + subscription
  +-- 7. Return JWT + API key
```

## 4. Infrastructure

### 4.1 Cloud Run Services

- **Region:** us-central1 (cheapest, low latency for US customers)
- **Ingest Service:**
  - Min instances: 0 (scales to zero)
  - Max instances: 10
  - Memory: 256MB
  - CPU: 1 vCPU
  - Concurrency: 80 requests per instance
  - Timeout: 60s
  - CPU allocation: request-based (CPU only allocated during request processing)
- **API Service:**
  - Min instances: 0
  - Max instances: 5
  - Memory: 256MB
  - CPU: 1 vCPU
  - Concurrency: 80
  - Timeout: 60s
  - CPU allocation: request-based
- **Health checks:** Cloud Run performs automatic health checks. Services must respond to requests within the timeout.
- **Custom domains:** Managed via Cloud Run domain mappings with Google-managed TLS certificates.

### 4.2 Cloud SQL

- **Instance:** db-f1-micro (shared core, 614MB RAM)
- **Storage:** 10GB SSD, auto-grow enabled
- **Connectivity:** Cloud SQL Node.js Connector (`@google-cloud/cloud-sql-connector`) -- no VPC or Auth Proxy sidecar needed. The connector handles IAM auth and encrypted connections automatically.
- **Backups:** Daily automated, 7-day retention
- **Flags:** `max_connections=50` (sufficient for Cloud Run with pooling)
- **Connection pooling:** Application-side using `pg` Pool. Ingest: pool size 5, API: pool size 5. Cloud Run's scale-to-zero means connections are released when instances shut down.
- **Upgrade path:** db-g1-small ($25/mo) when connection count or memory pressure increases

### 4.3 Networking

- **Cloud Run domain mappings** with Google-managed TLS for `ingest.openlanternai.com` and `api.openlanternai.com`
- **Cloudflare Pages** for `app.openlanternai.com` (dashboard SPA)
- **Cloud DNS:** Not needed if domain DNS is managed by Cloudflare (already the case). CNAME records from Cloudflare point to Cloud Run endpoints.
- **CORS:** Both Cloud Run services set `Access-Control-Allow-Origin: https://app.openlanternai.com` since the dashboard SPA makes cross-origin API calls.
- **No load balancer needed** -- Cloud Run provides built-in load balancing and TLS termination.

### 4.4 Secrets

Stored in Google Secret Manager, accessed by Cloud Run services via IAM:

| Secret | Used by |
|---|---|
| `db-connection-name` | All services (Cloud SQL instance connection name) |
| `jwt-signing-key` | API |
| `stripe-api-key` | API |
| `stripe-webhook-secret` | API |

Cloud Run services access secrets via the `--set-secrets` flag or Pulumi configuration. No Kubernetes secrets management needed.

### 4.5 Pulumi IaC

```
infra/
|-- index.ts              # Main Pulumi program
|-- cloud-run.ts          # Cloud Run services (ingest + api)
|-- database.ts           # Cloud SQL instance
|-- registry.ts           # Artifact Registry repo
|-- secrets.ts            # Secret Manager secrets
|-- iam.ts                # Service accounts + IAM bindings
|-- Pulumi.yaml
|-- Pulumi.prod.yaml
+-- Pulumi.staging.yaml
```

All written in TypeScript using `@pulumi/gcp`. No `@pulumi/kubernetes` needed -- no Kubernetes cluster to manage.

### 4.6 CI/CD Pipeline

Extends the existing `.github/workflows/ci.yml`:

**On push to `main`:**
1. `pnpm install` -> `pnpm typecheck` -> `pnpm build` -> `pnpm test`
2. Build Docker images (multi-stage) for ingest, api
3. Push to Artifact Registry (`us-central1-docker.pkg.dev/<project>/lantern/`)
4. Tag images with git SHA

**On tag `v*`:**
1. Run full CI
2. Deploy to staging via `pulumi up --stack staging`
3. Run smoke tests against staging endpoints
4. Manual approval gate (GitHub Environment protection rules)
5. Deploy to production via `pulumi up --stack prod`
6. Deploy dashboard SPA to Cloudflare Pages (via wrangler or git-triggered)

**Docker images:**

```dockerfile
# Shared base for all services
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ packages/
RUN pnpm install --frozen-lockfile --prod
RUN pnpm build

# Ingest service
FROM node:20-alpine AS ingest
WORKDIR /app
COPY --from=base /app/packages/ingest/dist ./dist
COPY --from=base /app/node_modules ./node_modules
ENV PORT=8080
CMD ["node", "dist/index.js"]
```

Note: Cloud Run requires the service to listen on the `PORT` environment variable (default 8080).

## 5. Codebase Changes Required

### 5.1 New Package: `packages/api`

Tenant management, auth, and billing service. Fastify-based, same patterns as the ingest package.

Key modules:
- `routes/auth.ts` -- login, register, refresh, logout
- `routes/tenants.ts` -- CRUD, schema provisioning
- `routes/api-keys.ts` -- create, revoke, list
- `routes/billing.ts` -- Stripe webhook handler, usage sync
- `routes/traces.ts` -- proxy trace queries scoped to tenant schema (for dashboard)
- `middleware/jwt.ts` -- JWT verification middleware
- `store/postgres.ts` -- shared Postgres connection pool via Cloud SQL Connector

### 5.2 Modify: `packages/ingest`

- Implement `PostgresTraceStore` (currently a stub) using fully qualified table names (`tenant_<slug>.traces`)
- Add tenant resolution middleware (API key -> slug lookup, with LRU cache, 5-min TTL)
- Add buffered usage tracking (flush to `public.usage` every 30s or 100 traces)
- Add connection pooling via `pg` Pool (size 5 per instance) with Cloud SQL Connector
- Add CORS middleware: allow origin `https://app.openlanternai.com`
- Keep SQLite store for OSS self-hosted mode (feature flag via `STORE_TYPE` env var)
- Revoked key check: filter `WHERE revoked_at IS NULL` in key lookup
- Listen on `process.env.PORT` (Cloud Run requirement)

### 5.3 Dashboard: Cloudflare Pages

- Extract the dashboard into a standalone static build (HTML/CSS/JS)
- Deploy to Cloudflare Pages at `app.openlanternai.com`
- Authenticates via JWT, calls `api.openlanternai.com` for all data
- For OSS self-hosted mode, the existing inline dashboard in the ingest server remains unchanged

### 5.4 Schema Migrations

- Tenant schema creation uses `quote_ident()` for safe DDL
- Migrations tracked in `public.schema_versions` table (`tenant_id`, `version`, `applied_at`)
- On deploy, a migration runner iterates all tenant schemas and applies pending migrations
- Migrations are idempotent (use `IF NOT EXISTS` / `IF EXISTS` guards)
- Migration runner can be invoked as a Cloud Run job or a one-off command in CI

### 5.5 New: `infra/` directory

Pulumi TypeScript project for all GCP infrastructure. No Kubernetes manifests needed.

### 5.6 New: Dockerfiles

One per service (ingest, api), multi-stage builds from the monorepo root. Use `pnpm --filter` to create minimal images.

### 5.7 Modify: `.github/workflows/`

- New `deploy.yml` workflow for image build + Cloud Run deployment via Pulumi
- Add staging and production environments with protection rules
- Add Cloudflare Pages deploy step for dashboard

## 6. What This Design Does NOT Include

Deferred to future iterations:

- **SSO / SAML** -- add when an enterprise customer requires it
- **Rate limiting** -- add per-tenant rate limiting when abuse becomes a concern
- **Read replicas** -- add Cloud SQL read replica when query load warrants it
- **Multi-region** -- single region (us-central1) for now
- **Trace retention policies** -- enforce per-plan retention limits later
- **PII detection pipeline** -- enterprise feature, runs as a Cloud Run job when implemented
- **Alerting infrastructure** -- webhook/Slack delivery as a Cloud Run job
- **Monitoring / observability** -- Cloud Run built-in metrics and Cloud Logging sufficient initially

## 7. Estimated Monthly OpEx

Early stage, minimal traffic, no paying customers yet:

| Resource | Spec | Monthly |
|---|---|---|
| Cloud Run (ingest) | Scales to zero, pay per request | $0-2 |
| Cloud Run (api) | Scales to zero, pay per request | $0-1 |
| Cloud SQL Postgres | db-f1-micro, 10GB SSD | $9 |
| Cloud SQL storage growth | 10-50GB | $2-5 |
| Cloudflare Pages | Dashboard SPA (free tier) | $0 |
| Artifact Registry | ~2GB container images | $1 |
| Secret Manager | 4 secrets | $0.50 |
| Network egress | <10GB | $1 |
| **Total** | | **$13-20** |

**With zero traffic: ~$13/mo** (Cloud SQL is the only fixed cost besides Secret Manager).

**Break-even: 1 Team customer ($299/mo) covers infrastructure 15x over.**

**Scale triggers:**
- Cloud SQL -> db-g1-small at ~50 concurrent connections (+$16/mo)
- Cloud Run costs grow linearly with request volume (~$0.40 per million requests)
- Add Cloud SQL read replica at ~5M traces/day (+$25/mo)

## 8. Migration Path

As the service grows, the architecture supports these upgrades without redesign:

1. **db-f1-micro -> db-g1-small -> db-custom** -- vertical scaling, zero app changes
2. **Cloud SQL -> AlloyDB** -- Postgres-compatible, swap connection config
3. **Cloud Run -> GKE** -- when you need long-running processes, cron jobs, or complex networking. Containerized services move directly to GKE with minimal changes.
4. **Single region -> multi-region** -- add Cloud Run services in new regions, Cloud SQL replicas, DNS-based routing
5. **Schema-per-tenant -> database-per-tenant** -- for customers needing full isolation
6. **Cloudflare Pages -> dedicated frontend** -- if the dashboard needs SSR or dynamic features
