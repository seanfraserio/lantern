# Configuration Reference

Environment variables and configuration options for all Lantern services.

---

## Ingest Server

The ingest server receives traces from SDKs and the LLM proxy.

**Source:** `packages/ingest/`

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4100` | TCP port to listen on |
| `DATABASE_URL` | -- | PostgreSQL connection string. Required for Postgres storage. Example: `postgresql://lantern:pass@localhost:5432/lantern` |
| `STORE_TYPE` | `sqlite` | Storage backend: `sqlite` or `postgres`. Ignored if `DATABASE_URL` is set (uses Postgres). |
| `MULTI_TENANT` | `false` | Enable multi-tenant mode. Requires `DATABASE_URL`. When `true`, API keys are resolved via the `api_keys` table and each tenant gets a separate schema. |
| `LANTERN_API_KEY` | -- | Shared API key for single-tenant mode. All `/v1/*` requests must include this as a Bearer token. Ignored in multi-tenant mode. |
| `TENANT_SCHEMA` | `public` | PostgreSQL schema for single-tenant Postgres mode. |

### Programmatic Configuration

```typescript
interface IngestServerConfig {
  port: number;
  host: string;
  store?: ITraceStore;
  dbPath?: string;            // SQLite file path (default: "lantern.db")
  apiKey?: string;
  databaseUrl?: string;
  multiTenant?: boolean;
}
```

### Request Limits

| Limit | Value |
|---|---|
| Body size limit | 1 MB |
| Max traces per POST | 100 |

---

## API Server

The API server handles dashboard authentication, management endpoints,
billing, and all feature APIs.

**Source:** `packages/api/`

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4200` | TCP port to listen on |
| `DATABASE_URL` | -- | **Required.** PostgreSQL connection string |
| `JWT_SECRET` | -- | **Required.** Secret key for HS256 JWT signing |
| `STRIPE_SECRET_KEY` | -- | Stripe secret key. Billing routes are only registered if this is set along with `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET`. |
| `STRIPE_PRICE_ID` | -- | Stripe Price ID for the Team plan subscription |
| `STRIPE_WEBHOOK_SECRET` | -- | Stripe webhook signing secret |
| `APP_URL` | `https://openlanternai-dashboard.pages.dev` | Dashboard URL for Stripe redirect URLs and CORS |
| `RETENTION_SECRET` | -- | Shared secret for the `POST /retention/cleanup` endpoint |

### Programmatic Configuration

```typescript
interface ApiServerConfig {
  port?: number;
  host?: string;
  databaseUrl: string;
  jwtSecret: string;
  poolSize?: number;                    // PostgreSQL pool size (default: 5)
  stripeSecretKey?: string;
  stripePriceId?: string;
  stripeWebhookSecret?: string;
  appUrl?: string;
  additionalJwtSkipPaths?: string[];    // Extra paths to skip JWT auth (e.g. SSO routes)
}
```

### Security Headers

Set automatically on all responses:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'` |

### CORS

Allowed origins:

- `https://app.openlanternai.com`
- `https://dashboard.openlanternai.com`
- `https://openlanternai-dashboard.pages.dev`
- `http://localhost:*` (any port)

---

## Proxy Server

The LLM proxy forwards requests to Anthropic or OpenAI while generating traces.

**Source:** `packages/proxy/`

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4300` | TCP port to listen on |
| `LANTERN_INGEST_URL` | `http://localhost:4100` | Lantern ingest server URL for trace submission |

### Programmatic Configuration

```typescript
interface ProxyConfig {
  port?: number;
  host?: string;
  ingestEndpoint?: string;
}
```

### Request Limits

| Limit | Value |
|---|---|
| Body size limit | 10 MB |

---

## Dashboard

The enterprise dashboard is a single-page application built with Vite.

**Source:** `packages/dashboard/`

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | -- | API server URL for the dashboard to connect to. Baked in at build time. |
| `LANTERN_API_URL` | -- | Used in Docker deployments to configure the backend URL at runtime. |

---

## Docker Compose

The `docker/docker-compose.yml` file defines a complete self-hosted deployment.

### Services

| Service | Port | Description |
|---|---|---|
| `ingest` | 4100 | Trace ingest server |
| `dashboard` | 3000 | Web dashboard |
| `postgres` | 5432 (internal) | PostgreSQL 16 database |

### Required Variables

Set these before running `docker compose up`:

| Variable | Description |
|---|---|
| `POSTGRES_PASSWORD` | **Required.** PostgreSQL password |
| `POSTGRES_USER` | PostgreSQL username (default: `lantern`) |
| `LANTERN_API_KEY` | API key for ingest authentication (optional) |

### Volumes

| Volume | Mount point | Description |
|---|---|---|
| `pgdata` | `/var/lib/postgresql/data` | Persistent PostgreSQL data |

### Example

```bash
cd docker/

# Set required variables
export POSTGRES_PASSWORD=mysecretpassword
export LANTERN_API_KEY=my-api-key

# Start all services
docker compose up -d

# Check health
curl http://localhost:4100/health
curl http://localhost:3000
```

### Docker Compose File

```yaml
version: "3.8"

services:
  ingest:
    build:
      context: ..
      dockerfile: docker/Dockerfile.ingest
    ports:
      - "4100:4100"
    environment:
      - PORT=4100
      - DATABASE_URL=postgresql://${POSTGRES_USER:-lantern}:${POSTGRES_PASSWORD}@postgres:5432/lantern
      - LANTERN_API_KEY=${LANTERN_API_KEY:-}
    depends_on:
      postgres:
        condition: service_healthy

  dashboard:
    build:
      context: ..
      dockerfile: docker/Dockerfile.dashboard
    ports:
      - "3000:3000"
    environment:
      - LANTERN_API_URL=http://ingest:4100
    depends_on:
      - ingest

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: lantern
      POSTGRES_USER: ${POSTGRES_USER:-lantern}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U lantern"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

---

## Cloud Run Deployment

For Google Cloud Run deployments, configure each service as a separate Cloud
Run service:

### Ingest Server

| Setting | Value |
|---|---|
| Container port | `4100` |
| Memory | 512 MiB minimum |
| CPU | 1 vCPU minimum |
| Concurrency | 80 |
| Min instances | 1 (recommended for low latency) |

Environment variables:

```
PORT=4100
DATABASE_URL=postgresql://...
MULTI_TENANT=true
```

### API Server

| Setting | Value |
|---|---|
| Container port | `4200` |
| Memory | 512 MiB minimum |
| CPU | 1 vCPU minimum |
| Concurrency | 80 |

Environment variables:

```
PORT=4200
DATABASE_URL=postgresql://...
JWT_SECRET=<secret>
STRIPE_SECRET_KEY=<key>
STRIPE_PRICE_ID=<price_id>
STRIPE_WEBHOOK_SECRET=<webhook_secret>
APP_URL=https://dashboard.example.com
RETENTION_SECRET=<secret>
```

### Proxy Server

| Setting | Value |
|---|---|
| Container port | `4300` |
| Memory | 256 MiB minimum |
| CPU | 1 vCPU |
| Concurrency | 100 |

Environment variables:

```
PORT=4300
LANTERN_INGEST_URL=https://ingest.example.com
```

---

## Observability

Both the ingest server and API server integrate with Grafana Cloud via OTLP for
metrics and logs. This is configured internally via the `registerObservability`
function and requires no user configuration for self-hosted deployments.

The ingest server identifies itself as `lantern-ingest`, and the API server as
`lantern-api`.
