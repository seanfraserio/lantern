# Lantern Managed Cloud — GKE Architecture Design

**Date:** 2026-03-14
**Status:** Draft
**Author:** Sean Fraser + Claude
**Scope:** Production infrastructure for the Lantern managed cloud service (Team and Enterprise tiers)

---

## 1. Problem Statement

Lantern's OSS version is self-hosted. The Team ($299/mo) and Enterprise (custom) tiers require a managed cloud service where customers send traces to a hosted endpoint and access a hosted dashboard. This service needs to be:

- Multi-tenant with strong data isolation
- Horizontally scalable as customer count and trace volume grow
- Low-cost at early stage (< $100/mo with no customers)
- Operationally simple for a small team to manage

## 2. Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| Cloud provider | Google Cloud (GKE) | Specified requirement |
| GKE mode | Autopilot | Zero node management, pay-per-pod, lowest ops overhead |
| Database | Cloud SQL Postgres 16 | Cheapest managed Postgres, existing store interface, upgrade path to AlloyDB |
| Multi-tenancy | Schema-per-tenant | Better isolation than shared tables, cheaper than DB-per-tenant, good HIPAA path |
| Authentication | API keys (ingest) + JWT (dashboard) | Already have API key auth, minimal new code, add SSO later |
| IaC | Pulumi (TypeScript) | Consistent with codebase language |
| CI/CD | GitHub Actions + Artifact Registry | Extends existing CI workflows |
| Ingress | Google Cloud Ingress (native) | No extra pods, managed TLS, sufficient for current routing needs |

## 3. Architecture

### 3.1 Service Topology

```
Internet
  │
  ├─ ingest.openlanternai.com  →  GKE Ingress → Ingest Service (pods)
  ├─ api.openlanternai.com     →  GKE Ingress → API Service (pods)
  ├─ app.openlanternai.com     →  Cloud Storage + CDN (static SPA)
  │                                      │
  │                               Cloud SQL Postgres 16
  │                               (schema-per-tenant)
  │
  └─ All services connect via Cloud SQL Auth Proxy sidecar
```

Two stateless services running as GKE Autopilot deployments, plus a static dashboard served from Cloud Storage + CDN. Both services connect to one Cloud SQL Postgres instance.

### 3.2 Services

**Ingest Service** (`packages/ingest` — adapted)
- Existing Fastify server with multi-tenant middleware
- Accepts `POST /v1/traces` with Bearer token auth
- Resolves API key to tenant, uses fully qualified table names (`tenant_<slug>.traces`) for all queries
- Horizontally scalable — stateless, any pod handles any tenant
- HPA: 1-10 pods, scale on CPU utilization (target 70%)

**Dashboard** (static assets served from Cloud Storage + CDN)
- The dashboard is a static single-page app (the existing inline HTML or a future React build from `packages/dashboard`)
- Served from a Cloud Storage bucket behind Cloud CDN — no GKE pods needed
- Authenticates users via JWT, makes API calls to `api.openlanternai.com`
- All trace/metrics queries go through the API service, scoped to the authenticated tenant's schema
- Zero compute cost — static hosting only

**API Service** (new package: `packages/api`)
- Tenant lifecycle: signup, onboarding, schema provisioning
- User management: registration, login, JWT issuance
- API key management: create, revoke, list
- Billing: Stripe integration, usage metering, plan enforcement
- HPA: 1-2 pods

### 3.3 Data Model (Schema-per-tenant)

**`public` schema** — shared across all tenants:

```sql
-- Tenant registry
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,           -- used as schema name; validated: /^[a-z0-9-]{3,32}$/
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
```

**`tenant_<slug>` schema** — per-tenant, created on signup:

```sql
-- Same structure as the OSS SQLite store, adapted for Postgres
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
3. Looks up `key_hash` in `public.api_keys`
4. Resolves `tenant_id` and `tenant_slug`, uses fully qualified table names for all queries
5. Cache the key→tenant mapping in-memory (LRU, 5-min TTL) to avoid DB lookup on every request

**Dashboard (human users):**
1. User submits email/password to `POST /api/auth/login`
2. API service verifies password hash (bcrypt)
3. Returns JWT containing `{ sub: userId, tenantId, tenantSlug, role, exp }`
4. Dashboard includes JWT in `Authorization: Bearer` header on all API calls
5. JWT signed with RS256, signing key stored in Secret Manager
6. Token expiry: 24 hours, refresh via `POST /api/auth/refresh`

**API key format:** `lnt_` prefix + 32 random bytes (base62 encoded). Only the hash is stored. The full key is shown once at creation time.

### 3.5 Request Flow (Trace Ingestion)

```
SDK Client
  │
  ├─ POST https://ingest.openlanternai.com/v1/traces
  │   Authorization: Bearer lnt_abc123...
  │   Body: { traces: [...] }
  │
  └─► Ingest Pod
        │
        ├─ 1. Extract Bearer token
        ├─ 2. Hash token, check LRU cache
        │     Cache miss → query public.api_keys
        ├─ 3. Resolve tenant_id → tenant slug
        ├─ 4. INSERT INTO tenant_<slug>.traces (fully qualified)
        ├─ 5. Buffer usage increment in-memory
        │     (flush to public.usage every 30s or 100 traces)
        └─ 6. Return { accepted: N }
```

### 3.6 Tenant Provisioning Flow

```
New Customer Signup
  │
  ├─ 1. POST /api/tenants → validate slug (/^[a-z0-9-]{3,32}$/), create record
  ├─ 2. CREATE SCHEMA using quote_ident('tenant_' || slug) — safe DDL
  ├─ 3. Run migrations in the new schema (create traces table + indexes)
  ├─ 4. Create owner user in public.users
  ├─ 5. Generate first API key, return to user (shown once)
  ├─ 6. Create Stripe customer + subscription
  └─ 7. Return JWT + API key
```

## 4. Infrastructure

### 4.1 GKE Autopilot Cluster

- **Region:** us-central1 (cheapest, low latency for US customers)
- **Namespaces:** `lantern-prod`, `lantern-staging`
- **Resource requests per pod:**
  - Ingest: 0.25 vCPU, 512MB RAM + Cloud SQL Auth Proxy sidecar (0.1 vCPU, 64MB)
  - API: 0.25 vCPU, 256MB RAM + Cloud SQL Auth Proxy sidecar (0.1 vCPU, 64MB)
- **HPA configuration:**
  - Ingest: min 1, max 10, target CPU 70%
  - API: min 1, max 2, target CPU 70%
- **Health probes (all services):**
  - Liveness: `GET /health` (HTTP 200), period 15s, failure threshold 3
  - Readiness: `GET /health` (checks DB connectivity), period 10s, failure threshold 2
  - Startup: `GET /health`, period 5s, failure threshold 6 (30s max startup)

### 4.2 Cloud SQL

- **Instance:** db-f1-micro (shared core, 614MB RAM)
- **Storage:** 10GB SSD, auto-grow enabled
- **Connectivity:** Private IP (VPC peering with GKE)
- **Backups:** Daily automated, 7-day retention
- **Flags:** `max_connections=50` (sufficient for 2-3 services with pooling)
- **Shared buffers:** Use Cloud SQL default (let GCP manage for f1-micro)
- **Connection strategy:** Cloud SQL Auth Proxy as a sidecar container in each deployment (Google-recommended pattern for GKE). Application-side pool sizes: ingest 10, API 5 per pod.
- **Upgrade path:** db-g1-small ($25/mo) when connection count or memory pressure increases

### 4.3 Networking

- **Google Cloud Ingress** with Google-managed TLS certificates
- **2 host rules:** `ingest.openlanternai.com`, `api.openlanternai.com` (dashboard is Cloud Storage + CDN)
- **Cloud DNS:** Managed zone for `openlanternai.com`, A records for ingest/api to Ingress IP, CNAME for app to CDN
- **CORS:** API and Ingest services must set `Access-Control-Allow-Origin: https://app.openlanternai.com` since the dashboard SPA makes cross-origin requests
- **No Traefik** — native Ingress sufficient at this stage

### 4.4 Secrets

Stored in Google Secret Manager, mounted as Kubernetes secrets:

| Secret | Used by |
|---|---|
| `db-connection-string` | All services |
| `jwt-signing-key` | API, Dashboard |
| `stripe-api-key` | API |
| `stripe-webhook-secret` | API |

### 4.5 Pulumi IaC

```
infra/
├── index.ts              # Main Pulumi program
├── cluster.ts            # GKE Autopilot cluster
├── database.ts           # Cloud SQL instance + databases
├── registry.ts           # Artifact Registry repo
├── dns.ts                # Cloud DNS zone + records
├── secrets.ts            # Secret Manager secrets
├── iam.ts                # Service accounts + IAM bindings
├── storage.ts            # Cloud Storage bucket + CDN for dashboard SPA
├── k8s/
│   ├── namespaces.ts     # prod + staging namespaces
│   ├── ingest.ts         # Deployment, Service, HPA + Cloud SQL Auth Proxy sidecar
│   ├── api.ts            # Deployment, Service, HPA + Cloud SQL Auth Proxy sidecar
│   └── ingress.ts        # Ingress with TLS + host rules (ingest + api only)
├── Pulumi.yaml
├── Pulumi.prod.yaml
└── Pulumi.staging.yaml
```

All written in TypeScript using `@pulumi/gcp` and `@pulumi/kubernetes`.

### 4.6 CI/CD Pipeline

Extends the existing `.github/workflows/ci.yml`:

**On push to `main`:**
1. `pnpm install` → `pnpm typecheck` → `pnpm build` → `pnpm test`
2. Build Docker images (multi-stage) for ingest, dashboard, api
3. Push to Artifact Registry (`us-central1-docker.pkg.dev/<project>/lantern/`)
4. Tag images with git SHA

**On tag `v*`:**
1. Run full CI
2. Deploy to `lantern-staging` via `pulumi up --stack staging` (updates image tag in deployment spec)
3. Run smoke tests against staging
4. Manual approval gate (GitHub Environment protection rules)
5. Deploy to `lantern-prod` via `pulumi up --stack prod`
6. Upload dashboard static assets to Cloud Storage bucket

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
COPY --from=base /app/packages/ingest/dist /app/dist
COPY --from=base /app/node_modules /app/node_modules
CMD ["node", "dist/index.js"]
```

## 5. Codebase Changes Required

### 5.1 New Package: `packages/api`

Tenant management, auth, and billing service. Fastify-based, same patterns as the ingest package.

Key modules:
- `routes/auth.ts` — login, register, refresh, logout
- `routes/tenants.ts` — CRUD, schema provisioning
- `routes/api-keys.ts` — create, revoke, list
- `routes/billing.ts` — Stripe webhook handler, usage sync
- `middleware/jwt.ts` — JWT verification middleware
- `store/postgres.ts` — shared Postgres connection pool

### 5.2 Modify: `packages/ingest`

- Implement `PostgresTraceStore` (currently a stub) using fully qualified table names (`tenant_<slug>.traces`)
- Add tenant resolution middleware (API key → slug lookup, with LRU cache, 5-min TTL)
- Add buffered usage tracking (flush to `public.usage` every 30s or 100 traces)
- Add connection pooling (use `pg` with pool, size 10 per pod)
- Add CORS middleware: allow origin `https://app.openlanternai.com`
- Keep SQLite store for OSS self-hosted mode (feature flag via `STORE_TYPE` env var)
- Revoked key check: filter `WHERE revoked_at IS NULL` in key lookup; cache TTL handles delay (5 min max)

### 5.3 Dashboard: Static SPA on Cloud Storage

- Extract the dashboard into a standalone static build (HTML/CSS/JS)
- Served from Cloud Storage bucket behind Cloud CDN
- Authenticates via JWT, calls `api.openlanternai.com` for all data
- No GKE pods needed — eliminates a deployment entirely
- For OSS self-hosted mode, the existing inline dashboard in the ingest server remains unchanged

### 5.4 Schema Migrations

- Tenant schema creation uses `quote_ident()` for safe DDL
- Migrations tracked in a `public.schema_versions` table (`tenant_id`, `version`, `applied_at`)
- On deploy, a migration runner iterates all tenant schemas and applies pending migrations
- Migrations are idempotent (use `IF NOT EXISTS` / `IF EXISTS` guards)

### 5.5 New: `infra/` directory

Pulumi TypeScript project for all GCP infrastructure.

### 5.6 New: Dockerfiles

One per service (ingest, api), multi-stage builds from the monorepo root. Use `pnpm --filter` to create minimal images per service.

### 5.7 Modify: `.github/workflows/`

- New `deploy.yml` workflow for image build + GKE deployment
- Add staging and production environments with protection rules

## 6. What This Design Does NOT Include

Deferred to future iterations:

- **SSO / SAML** — add when an enterprise customer requires it
- **Rate limiting** — add `@fastify/rate-limit` per tenant when abuse becomes a concern
- **Read replicas** — add Cloud SQL read replica when query load warrants it
- **Multi-region** — single region (us-central1) for now
- **Trace retention policies** — enforce per-plan retention limits later
- **PII detection pipeline** — enterprise feature, runs as a separate worker when implemented
- **Alerting infrastructure** — webhook/Slack delivery service, separate from core ingest
- **Monitoring / observability** — GKE built-in monitoring sufficient initially; add Prometheus/Grafana later

## 7. Estimated Monthly OpEx

Early stage, minimal traffic, no paying customers yet:

| Resource | Spec | Monthly |
|---|---|---|
| GKE Autopilot | ~2-3 pods (ingest + api + sidecars) | $25-40 |
| Cloud SQL Postgres | db-f1-micro, 10GB SSD | $9 |
| Cloud SQL storage growth | 10-50GB | $2-5 |
| Cloud Storage + CDN | Dashboard static assets, <1GB | $1 |
| Artifact Registry | ~2GB container images | $1 |
| Cloud Load Balancer | 1 LB, 2 forwarding rules | $15 |
| Cloud DNS | 1 zone | $0.50 |
| Secret Manager | 4 secrets | $0.50 |
| Network egress | <10GB | $1 |
| **Total** | | **$55-75** |

**Break-even: 1 Team customer ($299/mo).**

**Scale triggers:**
- Cloud SQL → db-g1-small at ~50 concurrent connections (+$16/mo)
- Ingest pods scale to 5+ at ~1M traces/day (+$25/mo per pod)
- Add read replica at ~5M traces/day (+$25/mo)

## 8. Migration Path

As the service grows, the architecture supports these upgrades without redesign:

1. **db-f1-micro → db-g1-small → db-custom** — vertical scaling, zero app changes
2. **Cloud SQL → AlloyDB** — Postgres-compatible, swap connection string
3. **Autopilot → Standard** — cost optimization at scale, swap cluster config in Pulumi
4. **Single region → multi-region** — add clusters + Cloud SQL replicas, DNS-based routing
5. **Schema-per-tenant → database-per-tenant** — for customers needing full isolation
6. **Google Ingress → Traefik** — when you need advanced middleware (rate limiting, circuit breaking)
