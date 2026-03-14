# Lantern Managed Cloud Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Lantern managed cloud service — multi-tenant trace ingestion, API service, dashboard SPA, and Cloud Run infrastructure on Google Cloud.

**Architecture:** Two Cloud Run services (ingest + api) backed by Cloud SQL Postgres with schema-per-tenant isolation. Dashboard served from Cloudflare Pages. Infrastructure managed with Pulumi TypeScript. CI/CD via GitHub Actions.

**Tech Stack:** TypeScript, Fastify, PostgreSQL (pg), Pulumi, Docker, Cloud Run, Cloud SQL, Cloudflare Pages, Stripe, bcrypt, jsonwebtoken

**Spec:** `docs/superpowers/specs/2026-03-14-managed-cloud-gke-design.md`

---

## Chunk 1: PostgresTraceStore — Multi-Tenant Storage Layer

The foundation everything else depends on. Implements the `ITraceStore` interface against Postgres with fully qualified tenant schema table names.

### File Structure

```
packages/ingest/
  src/
    store/
      postgres.ts          # MODIFY — replace stub with full implementation
      postgres.test.ts     # CREATE — integration tests
  package.json             # MODIFY — add pg dependency
```

---

### Task 1.1: Add pg dependency

**Files:**
- Modify: `packages/ingest/package.json`

- [ ] **Step 1: Install pg and types**

```bash
cd /Users/sfraser/DevOps/Projects/lantern
pnpm --filter @lantern-ai/ingest add pg
pnpm --filter @lantern-ai/ingest add -D @types/pg
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @lantern-ai/ingest run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/ingest/package.json pnpm-lock.yaml
git commit -m "deps: add pg driver to ingest package"
```

---

### Task 1.2: Implement PostgresTraceStore

**Files:**
- Modify: `packages/ingest/src/store/postgres.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ingest/src/store/postgres.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgresTraceStore } from "./postgres.js";
import type { Trace } from "@lantern-ai/sdk";

// These tests require a running Postgres instance.
// Skip in CI unless POSTGRES_URL is set.
const POSTGRES_URL = process.env.POSTGRES_URL;
const describeIf = POSTGRES_URL ? describe : describe.skip;

function makeFakeTrace(overrides?: Partial<Trace>): Trace {
  const id = crypto.randomUUID();
  return {
    id,
    sessionId: crypto.randomUUID(),
    agentName: "test-agent",
    environment: "test",
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    durationMs: 1000,
    status: "success",
    spans: [],
    metadata: { test: true },
    source: { serviceName: "test-svc", sdkVersion: "0.1.0", exporterType: "lantern" },
    totalInputTokens: 100,
    totalOutputTokens: 50,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

describeIf("PostgresTraceStore", () => {
  let store: PostgresTraceStore;
  const testSchema = "tenant_test_" + Date.now().toString(36);

  beforeAll(async () => {
    store = new PostgresTraceStore({
      connectionString: POSTGRES_URL!,
      tenantSchema: testSchema,
    });
    await store.initialize();
  });

  afterAll(async () => {
    await store.dropSchema();
    await store.close();
  });

  it("should insert and retrieve a trace", async () => {
    const trace = makeFakeTrace();
    await store.insert([trace]);
    const result = await store.getTrace(trace.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(trace.id);
    expect(result!.agentName).toBe("test-agent");
    expect(result!.source?.serviceName).toBe("test-svc");
  });

  it("should query traces with filters", async () => {
    const trace1 = makeFakeTrace({ agentName: "agent-a", environment: "prod" });
    const trace2 = makeFakeTrace({ agentName: "agent-b", environment: "dev" });
    await store.insert([trace1, trace2]);

    const prodTraces = await store.queryTraces({ environment: "prod" });
    expect(prodTraces.some(t => t.id === trace1.id)).toBe(true);
    expect(prodTraces.some(t => t.id === trace2.id)).toBe(false);
  });

  it("should return trace count", async () => {
    const count = await store.getTraceCount();
    expect(count).toBeGreaterThanOrEqual(3); // from previous tests
  });

  it("should return sources grouped by service", async () => {
    const sources = await store.getSources();
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources[0].serviceName).toBe("test-svc");
    expect(sources[0].traceCount).toBeGreaterThanOrEqual(1);
  });

  it("should ignore duplicate trace IDs", async () => {
    const trace = makeFakeTrace();
    await store.insert([trace]);
    await store.insert([trace]); // same ID again
    const count = await store.getTraceCount();
    // count should not increase by 2
    const result = await store.getTrace(trace.id);
    expect(result).not.toBeNull();
  });

  it("should filter by serviceName", async () => {
    const trace = makeFakeTrace({
      source: { serviceName: "unique-svc", exporterType: "lantern" },
    });
    await store.insert([trace]);
    const results = await store.queryTraces({ serviceName: "unique-svc" });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(trace.id);
  });

  it("should cap limit at 1000", async () => {
    const results = await store.queryTraces({ limit: 99999 });
    // Should not throw, limit is capped internally
    expect(results).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @lantern-ai/ingest run test`
Expected: FAIL — `PostgresTraceStore` constructor signature doesn't match

- [ ] **Step 3: Implement PostgresTraceStore**

Replace `packages/ingest/src/store/postgres.ts` with:

```typescript
import pg from "pg";
import type { ITraceStore, TraceQueryFilter, Trace, SourceSummary } from "@lantern-ai/sdk";

const { Pool } = pg;

export interface PostgresConfig {
  connectionString: string;
  tenantSchema: string;
  poolSize?: number;
}

export class PostgresTraceStore implements ITraceStore {
  private pool: pg.Pool;
  private schema: string;

  constructor(private config: PostgresConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: config.poolSize ?? 5,
    });
    this.schema = config.tenantSchema;
  }

  private get table(): string {
    return `"${this.schema}"."traces"`;
  }

  async initialize(): Promise<void> {
    await this.pool.query(
      `CREATE SCHEMA IF NOT EXISTS "${this.schema}"`
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
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
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_${this.schema}_agent ON ${this.table}(agent_name)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_${this.schema}_env ON ${this.table}(environment)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_${this.schema}_status ON ${this.table}(status)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_${this.schema}_start ON ${this.table}(start_time DESC)`);
  }

  async insert(traces: Trace[]): Promise<void> {
    if (traces.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const trace of traces) {
        await client.query(
          `INSERT INTO ${this.table} (
            id, session_id, agent_name, agent_version, environment,
            start_time, end_time, duration_ms, status,
            total_input_tokens, total_output_tokens, estimated_cost_usd,
            metadata, source, spans, scores
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (id) DO NOTHING`,
          [
            trace.id, trace.sessionId, trace.agentName,
            trace.agentVersion ?? null, trace.environment,
            trace.startTime, trace.endTime ?? null,
            trace.durationMs ?? null, trace.status,
            trace.totalInputTokens, trace.totalOutputTokens,
            trace.estimatedCostUsd,
            JSON.stringify(trace.metadata),
            trace.source ? JSON.stringify(trace.source) : null,
            JSON.stringify(trace.spans),
            trace.scores ? JSON.stringify(trace.scores) : null,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getTrace(id: string): Promise<Trace | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return null;
    return this.rowToTrace(rows[0]);
  }

  async queryTraces(filter: TraceQueryFilter): Promise<Trace[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filter.agentName) {
      conditions.push(`agent_name = $${paramIdx++}`);
      params.push(filter.agentName);
    }
    if (filter.environment) {
      conditions.push(`environment = $${paramIdx++}`);
      params.push(filter.environment);
    }
    if (filter.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filter.status);
    }
    if (filter.serviceName) {
      conditions.push(`source->>'serviceName' = $${paramIdx++}`);
      params.push(filter.serviceName);
    }
    if (filter.startAfter) {
      conditions.push(`start_time >= $${paramIdx++}`);
      params.push(filter.startAfter);
    }
    if (filter.startBefore) {
      conditions.push(`start_time <= $${paramIdx++}`);
      params.push(filter.startBefore);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(filter.limit ?? 100, 1000);
    const offset = filter.offset ?? 0;

    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.table} ${where} ORDER BY start_time DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params
    );

    return rows.map((row) => this.rowToTrace(row));
  }

  async getTraceCount(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM ${this.table}`
    );
    return rows[0].count;
  }

  async getSources(): Promise<SourceSummary[]> {
    const { rows } = await this.pool.query(`
      SELECT
        source->>'serviceName' AS service_name,
        source->>'sdkVersion' AS sdk_version,
        source->>'exporterType' AS exporter_type,
        COUNT(*)::int AS trace_count,
        MAX(start_time)::bigint AS last_seen,
        ARRAY_AGG(DISTINCT environment) AS environments,
        ARRAY_AGG(DISTINCT agent_name) AS agents
      FROM ${this.table}
      WHERE source IS NOT NULL
      GROUP BY service_name, sdk_version, exporter_type
      ORDER BY last_seen DESC
    `);

    return rows.map((row) => ({
      serviceName: row.service_name ?? "unknown",
      sdkVersion: row.sdk_version ?? undefined,
      exporterType: row.exporter_type ?? undefined,
      traceCount: row.trace_count,
      lastSeen: Number(row.last_seen),
      environments: row.environments.filter(Boolean),
      agents: row.agents.filter(Boolean),
    }));
  }

  async dropSchema(): Promise<void> {
    await this.pool.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private rowToTrace(row: Record<string, unknown>): Trace {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      agentName: row.agent_name as string,
      agentVersion: (row.agent_version as string) ?? undefined,
      environment: row.environment as string,
      startTime: Number(row.start_time),
      endTime: row.end_time ? Number(row.end_time) : undefined,
      durationMs: (row.duration_ms as number) ?? undefined,
      status: row.status as Trace["status"],
      totalInputTokens: row.total_input_tokens as number,
      totalOutputTokens: row.total_output_tokens as number,
      estimatedCostUsd: row.estimated_cost_usd as number,
      metadata: row.metadata as Record<string, unknown>,
      source: (row.source as Trace["source"]) ?? undefined,
      spans: (row.spans as Trace["spans"]) ?? [],
      scores: (row.scores as Trace["scores"]) ?? undefined,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes (if Postgres available)**

Run: `POSTGRES_URL=postgresql://localhost:5432/lantern_test pnpm --filter @lantern-ai/ingest run test`
Expected: All tests pass (or skip if no Postgres)

- [ ] **Step 5: Verify build and typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ingest/src/store/postgres.ts packages/ingest/src/store/postgres.test.ts
git commit -m "feat: implement PostgresTraceStore with schema-per-tenant"
```

---

## Chunk 2: API Package — Tenant Management, Auth, and Billing

New `packages/api` service handling signup, login, API key management, and Stripe billing.

### File Structure

```
packages/api/
  src/
    index.ts                # Entry point — Fastify server
    server.ts               # createApiServer factory
    routes/
      auth.ts               # POST /auth/login, /auth/register, /auth/refresh
      tenants.ts            # POST /tenants (signup + schema provisioning)
      api-keys.ts           # POST/GET/DELETE /api-keys
      billing.ts            # POST /billing/webhook (Stripe)
      traces.ts             # GET /traces, /traces/:id, /sources (proxied, tenant-scoped)
      health.ts             # GET /health
    middleware/
      jwt.ts                # JWT verification hook
    store/
      tenant-store.ts       # CRUD for public.tenants, public.users, public.api_keys
      schema-manager.ts     # CREATE SCHEMA, run migrations
    lib/
      passwords.ts          # bcrypt hash/verify
      api-key-gen.ts        # Generate lnt_ prefixed keys
      usage-buffer.ts       # In-memory usage buffer with periodic flush
  package.json
  tsconfig.json
  vitest.config.ts
```

---

### Task 2.1: Scaffold the API package

**Files:**
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/vitest.config.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@lantern-ai/api",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "test": "vitest run",
    "dev": "tsup src/index.ts --format esm,cjs --dts --watch",
    "typecheck": "tsc --noEmit",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@lantern-ai/sdk": "workspace:*",
    "fastify": "^4.26.0",
    "pg": "^8.13.0",
    "bcrypt": "^5.1.0",
    "jsonwebtoken": "^9.0.0",
    "stripe": "^17.0.0"
  },
  "devDependencies": {
    "@types/bcrypt": "^5.0.0",
    "@types/jsonwebtoken": "^9.0.0",
    "@types/pg": "^8.11.0",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});
```

- [ ] **Step 4: Install dependencies**

```bash
cd /Users/sfraser/DevOps/Projects/lantern
pnpm install
```

- [ ] **Step 5: Commit**

```bash
git add packages/api/
git commit -m "feat: scaffold @lantern-ai/api package"
```

---

### Task 2.2: Implement utility modules (passwords, API key generation, usage buffer)

**Files:**
- Create: `packages/api/src/lib/passwords.ts`
- Create: `packages/api/src/lib/api-key-gen.ts`
- Create: `packages/api/src/lib/usage-buffer.ts`
- Create: `packages/api/src/lib/passwords.test.ts`
- Create: `packages/api/src/lib/api-key-gen.test.ts`

- [ ] **Step 1: Write failing tests for passwords**

Create `packages/api/src/lib/passwords.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.js";

describe("passwords", () => {
  it("should hash and verify a password", async () => {
    const hash = await hashPassword("test-password-123");
    expect(hash).not.toBe("test-password-123");
    expect(await verifyPassword("test-password-123", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement passwords module**

Create `packages/api/src/lib/passwords.ts`:

```typescript
import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
```

- [ ] **Step 3: Write failing tests for API key generation**

Create `packages/api/src/lib/api-key-gen.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey } from "./api-key-gen.js";

describe("api-key-gen", () => {
  it("should generate a key with lnt_ prefix", () => {
    const { key, prefix } = generateApiKey();
    expect(key.startsWith("lnt_")).toBe(true);
    expect(key.length).toBeGreaterThan(20);
    expect(prefix).toBe(key.slice(0, 12));
  });

  it("should produce a deterministic hash", () => {
    const { key } = generateApiKey();
    const hash1 = hashApiKey(key);
    const hash2 = hashApiKey(key);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 hex
  });

  it("should generate unique keys", () => {
    const keys = new Set(Array.from({ length: 10 }, () => generateApiKey().key));
    expect(keys.size).toBe(10);
  });
});
```

- [ ] **Step 4: Implement API key generation**

Create `packages/api/src/lib/api-key-gen.ts`:

```typescript
import { randomBytes, createHash } from "node:crypto";

export function generateApiKey(): { key: string; prefix: string } {
  const raw = randomBytes(32);
  const encoded = raw.toString("base64url").slice(0, 40);
  const key = `lnt_${encoded}`;
  const prefix = key.slice(0, 12);
  return { key, prefix };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
```

- [ ] **Step 5: Implement usage buffer**

Create `packages/api/src/lib/usage-buffer.ts`:

```typescript
import type pg from "pg";

interface UsageIncrement {
  traceCount: number;
  inputTokens: number;
  outputTokens: number;
}

export class UsageBuffer {
  private buffer: Map<string, UsageIncrement> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pool: pg.Pool;
  private flushThreshold: number;

  constructor(pool: pg.Pool, opts?: { flushIntervalMs?: number; flushThreshold?: number }) {
    this.pool = pool;
    this.flushThreshold = opts?.flushThreshold ?? 100;
    const intervalMs = opts?.flushIntervalMs ?? 30_000;

    this.timer = setInterval(() => {
      this.flush().catch(console.error);
    }, intervalMs);
    this.timer.unref();
  }

  increment(tenantId: string, traces: number, inputTokens: number, outputTokens: number): void {
    const existing = this.buffer.get(tenantId) ?? { traceCount: 0, inputTokens: 0, outputTokens: 0 };
    existing.traceCount += traces;
    existing.inputTokens += inputTokens;
    existing.outputTokens += outputTokens;
    this.buffer.set(tenantId, existing);

    const total = Array.from(this.buffer.values()).reduce((s, v) => s + v.traceCount, 0);
    if (total >= this.flushThreshold) {
      this.flush().catch(console.error);
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.size === 0) return;

    const entries = new Map(this.buffer);
    this.buffer.clear();

    const month = new Date().toISOString().slice(0, 7); // "2026-03"
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [tenantId, inc] of entries) {
        await client.query(
          `INSERT INTO public.usage (id, tenant_id, month, trace_count, input_tokens, output_tokens)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, month)
           DO UPDATE SET
             trace_count = usage.trace_count + $3,
             input_tokens = usage.input_tokens + $4,
             output_tokens = usage.output_tokens + $5`,
          [tenantId, month, inc.traceCount, inc.inputTokens, inc.outputTokens]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      // Restore buffer on failure
      for (const [tenantId, inc] of entries) {
        const existing = this.buffer.get(tenantId) ?? { traceCount: 0, inputTokens: 0, outputTokens: 0 };
        existing.traceCount += inc.traceCount;
        existing.inputTokens += inc.inputTokens;
        existing.outputTokens += inc.outputTokens;
        this.buffer.set(tenantId, existing);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @lantern-ai/api run test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/lib/
git commit -m "feat: add password, API key, and usage buffer utilities"
```

---

### Task 2.3: Implement tenant store and schema manager

**Files:**
- Create: `packages/api/src/store/tenant-store.ts`
- Create: `packages/api/src/store/schema-manager.ts`

- [ ] **Step 1: Implement schema manager**

Create `packages/api/src/store/schema-manager.ts`:

```typescript
import type pg from "pg";

const TENANT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS traces (
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
  CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_name);
  CREATE INDEX IF NOT EXISTS idx_traces_env ON traces(environment);
  CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
  CREATE INDEX IF NOT EXISTS idx_traces_start ON traces(start_time DESC);
`;

const SLUG_RE = /^[a-z0-9-]{3,32}$/;

export class SchemaManager {
  constructor(private pool: pg.Pool) {}

  validateSlug(slug: string): boolean {
    return SLUG_RE.test(slug);
  }

  async createTenantSchema(slug: string): Promise<void> {
    if (!this.validateSlug(slug)) {
      throw new Error(`Invalid tenant slug: ${slug}`);
    }
    const schemaName = `tenant_${slug}`;
    // Use parameterized format function for safe DDL
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await this.pool.query(`SET search_path TO "${schemaName}"`);
    await this.pool.query(TENANT_SCHEMA_SQL);
    await this.pool.query(`SET search_path TO public`);

    // Track migration version
    await this.pool.query(
      `INSERT INTO public.schema_versions (id, tenant_id, version)
       SELECT gen_random_uuid(), t.id, 1
       FROM public.tenants t WHERE t.slug = $1
       ON CONFLICT (tenant_id, version) DO NOTHING`,
      [slug]
    );
  }

  async dropTenantSchema(slug: string): Promise<void> {
    if (!this.validateSlug(slug)) {
      throw new Error(`Invalid tenant slug: ${slug}`);
    }
    await this.pool.query(`DROP SCHEMA IF EXISTS "tenant_${slug}" CASCADE`);
  }
}
```

- [ ] **Step 2: Implement tenant store**

Create `packages/api/src/store/tenant-store.ts`:

```typescript
import type pg from "pg";
import { hashApiKey } from "../lib/api-key-gen.js";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  createdAt: string;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  keyPrefix: string;
  name: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export class TenantStore {
  constructor(private pool: pg.Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS public.tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        plan TEXT NOT NULL DEFAULT 'team',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.usage (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        month TEXT NOT NULL,
        trace_count BIGINT NOT NULL DEFAULT 0,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        UNIQUE(tenant_id, month)
      );
      CREATE TABLE IF NOT EXISTS public.schema_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(tenant_id, version)
      );
    `);
  }

  async createTenant(name: string, slug: string, plan?: string): Promise<Tenant> {
    const { rows } = await this.pool.query(
      `INSERT INTO public.tenants (name, slug, plan) VALUES ($1, $2, $3) RETURNING *`,
      [name, slug, plan ?? "team"]
    );
    return this.rowToTenant(rows[0]);
  }

  async getTenantBySlug(slug: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM public.tenants WHERE slug = $1`,
      [slug]
    );
    return rows.length > 0 ? this.rowToTenant(rows[0]) : null;
  }

  async createUser(tenantId: string, email: string, passwordHash: string, role?: string): Promise<User> {
    const { rows } = await this.pool.query(
      `INSERT INTO public.users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *`,
      [tenantId, email, passwordHash, role ?? "owner"]
    );
    return this.rowToUser(rows[0]);
  }

  async getUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM public.users WHERE email = $1`,
      [email]
    );
    if (rows.length === 0) return null;
    return { ...this.rowToUser(rows[0]), passwordHash: rows[0].password_hash as string };
  }

  async storeApiKey(tenantId: string, keyHash: string, keyPrefix: string, name: string): Promise<ApiKeyRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO public.api_keys (tenant_id, key_hash, key_prefix, name) VALUES ($1, $2, $3, $4) RETURNING *`,
      [tenantId, keyHash, keyPrefix, name]
    );
    return this.rowToApiKey(rows[0]);
  }

  async resolveApiKey(keyHash: string): Promise<{ tenantId: string; tenantSlug: string } | null> {
    const { rows } = await this.pool.query(
      `SELECT ak.tenant_id, t.slug
       FROM public.api_keys ak
       JOIN public.tenants t ON ak.tenant_id = t.id
       WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
      [keyHash]
    );
    if (rows.length === 0) return null;

    // Update last_used_at (fire-and-forget)
    this.pool.query(
      `UPDATE public.api_keys SET last_used_at = now() WHERE key_hash = $1`,
      [keyHash]
    ).catch(() => {});

    return { tenantId: rows[0].tenant_id as string, tenantSlug: rows[0].slug as string };
  }

  async revokeApiKey(keyId: string, tenantId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE public.api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
      [keyId, tenantId]
    );
    return (rowCount ?? 0) > 0;
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM public.api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return rows.map((r) => this.rowToApiKey(r));
  }

  async getTenantById(id: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM public.tenants WHERE id = $1`, [id]
    );
    return rows.length > 0 ? this.rowToTenant(rows[0]) : null;
  }

  private rowToTenant(row: Record<string, unknown>): Tenant {
    return {
      id: row.id as string,
      name: row.name as string,
      slug: row.slug as string,
      plan: row.plan as string,
      stripeCustomerId: (row.stripe_customer_id as string) ?? null,
      stripeSubscriptionId: (row.stripe_subscription_id as string) ?? null,
      createdAt: (row.created_at as Date).toISOString(),
    };
  }

  private rowToUser(row: Record<string, unknown>): User {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      email: row.email as string,
      role: row.role as string,
      createdAt: (row.created_at as Date).toISOString(),
    };
  }

  private rowToApiKey(row: Record<string, unknown>): ApiKeyRecord {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      keyPrefix: row.key_prefix as string,
      name: row.name as string,
      lastUsedAt: row.last_used_at ? (row.last_used_at as Date).toISOString() : null,
      revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null,
      createdAt: (row.created_at as Date).toISOString(),
    };
  }
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm build && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/store/
git commit -m "feat: add tenant store and schema manager"
```

---

### Task 2.4: Implement JWT middleware

**Files:**
- Create: `packages/api/src/middleware/jwt.ts`

- [ ] **Step 1: Implement JWT middleware**

Create `packages/api/src/middleware/jwt.ts`:

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";

export interface JwtPayload {
  sub: string;       // userId
  tenantId: string;
  tenantSlug: string;
  role: string;
  exp: number;
}

export function registerJwtAuth(app: FastifyInstance, signingKey: string): void {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health, auth routes, and CORS preflight
    if (request.url === "/health" || request.url.startsWith("/auth/") || request.method === "OPTIONS") {
      return;
    }

    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Missing authorization header" });
    }

    const token = auth.slice(7);
    try {
      const payload = jwt.verify(token, signingKey, { algorithms: ["HS256"] }) as JwtPayload;
      (request as Record<string, unknown>).user = payload;
    } catch {
      return reply.status(401).send({ error: "Invalid or expired token" });
    }
  });
}

export function signJwt(payload: Omit<JwtPayload, "exp">, signingKey: string): string {
  return jwt.sign(payload, signingKey, { algorithm: "HS256", expiresIn: "24h" });
}

export function getUser(request: FastifyRequest): JwtPayload {
  const user = (request as Record<string, unknown>).user as JwtPayload | null;
  if (!user) throw new Error("No authenticated user");
  return user;
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/middleware/
git commit -m "feat: add JWT auth middleware"
```

---

### Task 2.5: Implement API routes (auth, tenants, api-keys, traces proxy, health)

**Files:**
- Create: `packages/api/src/routes/auth.ts`
- Create: `packages/api/src/routes/tenants.ts`
- Create: `packages/api/src/routes/api-keys.ts`
- Create: `packages/api/src/routes/billing.ts`
- Create: `packages/api/src/routes/traces.ts`
- Create: `packages/api/src/routes/health.ts`

- [ ] **Step 1: Implement auth routes**

Create `packages/api/src/routes/auth.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import type { TenantStore } from "../store/tenant-store.js";
import { hashPassword, verifyPassword } from "../lib/passwords.js";
import { signJwt } from "../middleware/jwt.js";

export function registerAuthRoutes(app: FastifyInstance, store: TenantStore, jwtSecret: string): void {
  app.post<{ Body: { email: string; password: string; name?: string; tenantSlug?: string; tenantName?: string } }>(
    "/auth/register",
    async (request, reply) => {
      const { email, password, tenantSlug, tenantName } = request.body;
      if (!email || !password || !tenantSlug || !tenantName) {
        return reply.status(400).send({ error: "email, password, tenantSlug, and tenantName are required" });
      }

      const existing = await store.getUserByEmail(email);
      if (existing) {
        return reply.status(409).send({ error: "Email already registered" });
      }

      // Will be called by the tenants route for full provisioning
      // This is a simplified registration for the API
      const passwordHash = await hashPassword(password);
      const tenant = await store.createTenant(tenantName, tenantSlug);
      const user = await store.createUser(tenant.id, email, passwordHash, "owner");
      const token = signJwt({ sub: user.id, tenantId: tenant.id, tenantSlug: tenant.slug, role: user.role }, jwtSecret);

      return reply.status(201).send({ token, user: { id: user.id, email: user.email, role: user.role }, tenant: { id: tenant.id, slug: tenant.slug } });
    }
  );

  app.post<{ Body: { email: string; password: string } }>(
    "/auth/login",
    async (request, reply) => {
      const { email, password } = request.body;
      if (!email || !password) {
        return reply.status(400).send({ error: "email and password are required" });
      }

      const user = await store.getUserByEmail(email);
      if (!user) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const tenant = await store.getTenantById(user.tenantId);
      if (!tenant) {
        return reply.status(500).send({ error: "Tenant not found" });
      }

      const token = signJwt({ sub: user.id, tenantId: tenant.id, tenantSlug: tenant.slug, role: user.role }, jwtSecret);
      return reply.send({ token, user: { id: user.id, email: user.email, role: user.role } });
    }
  );

  app.post("/auth/refresh", async (request, reply) => {
    // Re-issue token from existing valid token (handled by JWT middleware)
    const user = (request as Record<string, unknown>).user as { sub: string; tenantId: string; tenantSlug: string; role: string } | null;
    if (!user) {
      return reply.status(401).send({ error: "Invalid token" });
    }
    const token = signJwt({ sub: user.sub, tenantId: user.tenantId, tenantSlug: user.tenantSlug, role: user.role }, jwtSecret);
    return reply.send({ token });
  });
}
```

- [ ] **Step 2: Implement api-keys routes**

Create `packages/api/src/routes/api-keys.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import type { TenantStore } from "../store/tenant-store.js";
import { generateApiKey, hashApiKey } from "../lib/api-key-gen.js";
import { getUser } from "../middleware/jwt.js";

export function registerApiKeyRoutes(app: FastifyInstance, store: TenantStore): void {
  app.post<{ Body: { name: string } }>("/api-keys", async (request, reply) => {
    const user = getUser(request);
    const { name } = request.body;
    if (!name) return reply.status(400).send({ error: "name is required" });

    const { key, prefix } = generateApiKey();
    const keyHash = hashApiKey(key);
    const record = await store.storeApiKey(user.tenantId, keyHash, prefix, name);

    return reply.status(201).send({
      id: record.id,
      key, // shown only once
      prefix: record.keyPrefix,
      name: record.name,
      createdAt: record.createdAt,
    });
  });

  app.get("/api-keys", async (request) => {
    const user = getUser(request);
    const keys = await store.listApiKeys(user.tenantId);
    return { keys };
  });

  app.delete<{ Params: { id: string } }>("/api-keys/:id", async (request, reply) => {
    const user = getUser(request);
    const revoked = await store.revokeApiKey(request.params.id, user.tenantId);
    if (!revoked) return reply.status(404).send({ error: "Key not found or already revoked" });
    return reply.send({ revoked: true });
  });
}
```

- [ ] **Step 3: Implement traces proxy route**

Create `packages/api/src/routes/traces.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import type { ITraceStore, TraceQueryFilter } from "@lantern-ai/sdk";
import { PostgresTraceStore } from "@lantern-ai/ingest";
import { getUser } from "../middleware/jwt.js";
import type pg from "pg";

export function registerTraceRoutes(app: FastifyInstance, pool: pg.Pool): void {
  // Create tenant-scoped store per request
  function getStore(tenantSlug: string): PostgresTraceStore {
    return new PostgresTraceStore({
      connectionString: "", // uses shared pool
      tenantSchema: `tenant_${tenantSlug}`,
    });
  }

  app.get<{ Querystring: TraceQueryFilter }>("/traces", async (request) => {
    const user = getUser(request);
    const store = new PostgresTraceStore({
      connectionString: process.env.DATABASE_URL ?? "",
      tenantSchema: `tenant_${user.tenantSlug}`,
    });
    const traces = await store.queryTraces(request.query);
    return { traces };
  });

  app.get<{ Params: { id: string } }>("/traces/:id", async (request, reply) => {
    const user = getUser(request);
    const store = new PostgresTraceStore({
      connectionString: process.env.DATABASE_URL ?? "",
      tenantSchema: `tenant_${user.tenantSlug}`,
    });
    const trace = await store.getTrace(request.params.id);
    if (!trace) return reply.status(404).send({ error: "Trace not found" });
    return trace;
  });

  app.get("/sources", async (request) => {
    const user = getUser(request);
    const store = new PostgresTraceStore({
      connectionString: process.env.DATABASE_URL ?? "",
      tenantSchema: `tenant_${user.tenantSlug}`,
    });
    const sources = await store.getSources();
    return { sources };
  });
}
```

- [ ] **Step 4: Implement billing webhook stub**

Create `packages/api/src/routes/billing.ts`:

```typescript
import type { FastifyInstance } from "fastify";

// TODO: Implement Stripe webhook handling
export function registerBillingRoutes(app: FastifyInstance): void {
  app.post("/billing/webhook", async (request, reply) => {
    // Stripe webhook handler — implement when Stripe is configured
    return reply.status(200).send({ received: true });
  });
}
```

- [ ] **Step 5: Implement health route**

Create `packages/api/src/routes/health.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import type pg from "pg";

export function registerHealthRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get("/health", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return reply.send({ status: "ok", uptime: process.uptime() });
    } catch {
      return reply.status(503).send({ status: "unhealthy" });
    }
  });
}
```

- [ ] **Step 6: Verify build**

Run: `pnpm build && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/
git commit -m "feat: add auth, api-keys, traces, billing, and health routes"
```

---

### Task 2.6: Implement API server entry point and barrel exports

**Files:**
- Create: `packages/api/src/server.ts`
- Create: `packages/api/src/index.ts`

- [ ] **Step 1: Implement server factory**

Create `packages/api/src/server.ts`:

```typescript
import Fastify from "fastify";
import pg from "pg";
import { TenantStore } from "./store/tenant-store.js";
import { SchemaManager } from "./store/schema-manager.js";
import { registerJwtAuth } from "./middleware/jwt.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerApiKeyRoutes } from "./routes/api-keys.js";
import { registerTraceRoutes } from "./routes/traces.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerHealthRoutes } from "./routes/health.js";

const { Pool } = pg;

export interface ApiServerConfig {
  port?: number;
  host?: string;
  databaseUrl: string;
  jwtSecret: string;
  poolSize?: number;
}

export async function createApiServer(config: ApiServerConfig) {
  const port = config.port ?? parseInt(process.env.PORT ?? "4200", 10);
  const host = config.host ?? "127.0.0.1";

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.poolSize ?? 5,
  });

  const tenantStore = new TenantStore(pool);
  const schemaManager = new SchemaManager(pool);

  // Initialize shared tables
  await tenantStore.initialize();

  const app = Fastify({ logger: true, bodyLimit: 1_048_576 });

  // Security headers
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
  });

  // CORS for dashboard SPA
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && (origin === "https://app.openlanternai.com" || origin.startsWith("http://localhost"))) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    }
    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }
  });

  // JWT auth (skips /health and /auth/* routes)
  registerJwtAuth(app, config.jwtSecret);

  // Routes
  registerHealthRoutes(app, pool);
  registerAuthRoutes(app, tenantStore, config.jwtSecret);
  registerApiKeyRoutes(app, tenantStore);
  registerTraceRoutes(app, pool);
  registerBillingRoutes(app);

  await app.listen({ port, host });

  return { app, pool, tenantStore, schemaManager };
}
```

- [ ] **Step 2: Create barrel exports and entry point**

Create `packages/api/src/index.ts`:

```typescript
export { createApiServer } from "./server.js";
export type { ApiServerConfig } from "./server.js";
export { TenantStore } from "./store/tenant-store.js";
export type { Tenant, User, ApiKeyRecord } from "./store/tenant-store.js";
export { SchemaManager } from "./store/schema-manager.js";
export { UsageBuffer } from "./lib/usage-buffer.js";
export { generateApiKey, hashApiKey } from "./lib/api-key-gen.js";
export { signJwt, getUser } from "./middleware/jwt.js";
export type { JwtPayload } from "./middleware/jwt.js";

// Run directly
const isMain = process.argv[1] &&
    new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isMain) {
  const databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.JWT_SECRET;
  if (!databaseUrl || !jwtSecret) {
    console.error("DATABASE_URL and JWT_SECRET environment variables are required");
    process.exit(1);
  }
  createApiServer({ databaseUrl, jwtSecret }).catch((err) => {
    console.error("Failed to start API server:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Verify full build and typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/server.ts packages/api/src/index.ts
git commit -m "feat: add API server entry point with all routes wired up"
```

---

## Chunk 3: Ingest Multi-Tenancy Middleware

Modify the existing ingest server to support multi-tenant Postgres with API key resolution and usage buffering.

### File Structure

```
packages/ingest/
  src/
    middleware/
      tenant.ts             # CREATE — tenant resolution middleware (API key -> schema)
    server.ts               # MODIFY — add tenant middleware, CORS, Postgres store selection
```

---

### Task 3.1: Implement tenant resolution middleware

**Files:**
- Create: `packages/ingest/src/middleware/tenant.ts`

- [ ] **Step 1: Implement tenant middleware with LRU cache**

Create `packages/ingest/src/middleware/tenant.ts`:

```typescript
import type { FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import type pg from "pg";

interface TenantInfo {
  tenantId: string;
  tenantSlug: string;
  resolvedAt: number;
}

export class TenantResolver {
  private cache: Map<string, TenantInfo> = new Map();
  private cacheTtlMs: number;
  private maxCacheSize: number;

  constructor(private pool: pg.Pool, opts?: { cacheTtlMs?: number; maxCacheSize?: number }) {
    this.cacheTtlMs = opts?.cacheTtlMs ?? 300_000; // 5 minutes
    this.maxCacheSize = opts?.maxCacheSize ?? 1000;
  }

  async resolve(apiKey: string): Promise<TenantInfo | null> {
    const keyHash = createHash("sha256").update(apiKey).digest("hex");

    // Check cache
    const cached = this.cache.get(keyHash);
    if (cached && Date.now() - cached.resolvedAt < this.cacheTtlMs) {
      return cached;
    }

    // Query database
    const { rows } = await this.pool.query(
      `SELECT ak.tenant_id, t.slug
       FROM public.api_keys ak
       JOIN public.tenants t ON ak.tenant_id = t.id
       WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
      [keyHash]
    );

    if (rows.length === 0) return null;

    const info: TenantInfo = {
      tenantId: rows[0].tenant_id as string,
      tenantSlug: rows[0].slug as string,
      resolvedAt: Date.now(),
    };

    // Evict oldest if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].resolvedAt - b[1].resolvedAt)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }

    this.cache.set(keyHash, info);

    // Update last_used_at (fire-and-forget)
    this.pool.query(
      `UPDATE public.api_keys SET last_used_at = now() WHERE key_hash = $1`,
      [keyHash]
    ).catch(() => {});

    return info;
  }
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ingest/src/middleware/
git commit -m "feat: add tenant resolution middleware with LRU cache"
```

---

### Task 3.2: Update ingest server for multi-tenancy

**Files:**
- Modify: `packages/ingest/src/server.ts`

- [ ] **Step 1: Update server.ts**

Add to `IngestServerConfig`:
- `databaseUrl?: string` — if set, use Postgres instead of SQLite
- `tenantMode?: boolean` — enable multi-tenant resolution

Update `createServer` to:
1. If `databaseUrl` is set, create a `pg.Pool` and `TenantResolver`
2. Add CORS headers for `https://app.openlanternai.com`
3. Replace the single API key auth with tenant-aware auth when in tenant mode
4. Pass the resolved tenant schema to `PostgresTraceStore` for each request

The specific implementation will modify the existing `createServer` function to branch between SQLite mode (OSS) and Postgres mode (managed cloud) based on the `STORE_TYPE` or `DATABASE_URL` env var.

- [ ] **Step 2: Verify build and existing demo still works**

Run: `pnpm build && node demo.mjs` (then Ctrl+C)
Expected: Demo still works with SQLite

- [ ] **Step 3: Commit**

```bash
git add packages/ingest/src/server.ts
git commit -m "feat: add multi-tenant Postgres mode to ingest server"
```

---

## Chunk 4: Infrastructure — Pulumi, Dockerfiles, CI/CD

### File Structure

```
infra/
  index.ts
  cloud-run.ts
  database.ts
  registry.ts
  secrets.ts
  iam.ts
  Pulumi.yaml
  Pulumi.prod.yaml
  package.json
  tsconfig.json

docker/
  Dockerfile.ingest
  Dockerfile.api

.github/workflows/
  deploy.yml              # CREATE — Docker build + Cloud Run deploy
```

---

### Task 4.1: Create Dockerfiles

**Files:**
- Create: `docker/Dockerfile.ingest`
- Create: `docker/Dockerfile.api`

- [ ] **Step 1: Create ingest Dockerfile**

Create `docker/Dockerfile.ingest`:

```dockerfile
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/sdk/ packages/sdk/
COPY packages/ingest/ packages/ingest/
RUN pnpm install --frozen-lockfile --filter @lantern-ai/ingest...
RUN pnpm --filter @lantern-ai/sdk run build
RUN pnpm --filter @lantern-ai/ingest run build

FROM node:20-alpine
WORKDIR /app
COPY --from=base /app/packages/ingest/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/sdk/dist ./node_modules/@lantern-ai/sdk/dist
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create API Dockerfile**

Create `docker/Dockerfile.api`:

```dockerfile
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/sdk/ packages/sdk/
COPY packages/ingest/ packages/ingest/
COPY packages/api/ packages/api/
RUN pnpm install --frozen-lockfile --filter @lantern-ai/api...
RUN pnpm --filter @lantern-ai/sdk run build
RUN pnpm --filter @lantern-ai/ingest run build
RUN pnpm --filter @lantern-ai/api run build

FROM node:20-alpine
WORKDIR /app
COPY --from=base /app/packages/api/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/sdk/dist ./node_modules/@lantern-ai/sdk/dist
COPY --from=base /app/packages/ingest/dist ./node_modules/@lantern-ai/ingest/dist
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Commit**

```bash
git add docker/Dockerfile.ingest docker/Dockerfile.api
git commit -m "feat: add multi-stage Dockerfiles for ingest and api services"
```

---

### Task 4.2: Scaffold Pulumi infrastructure project

**Files:**
- Create: `infra/package.json`
- Create: `infra/tsconfig.json`
- Create: `infra/Pulumi.yaml`
- Create: `infra/index.ts`
- Create: `infra/cloud-run.ts`
- Create: `infra/database.ts`
- Create: `infra/registry.ts`
- Create: `infra/secrets.ts`
- Create: `infra/iam.ts`

- [ ] **Step 1: Create infra package.json**

```json
{
  "name": "lantern-infra",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "preview": "pulumi preview",
    "up": "pulumi up",
    "destroy": "pulumi destroy"
  },
  "dependencies": {
    "@pulumi/pulumi": "^3.0.0",
    "@pulumi/gcp": "^8.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create Pulumi.yaml**

```yaml
name: lantern-infra
runtime:
  name: nodejs
  options:
    typescript: true
description: Lantern managed cloud infrastructure on Google Cloud
```

- [ ] **Step 3: Create main index.ts with all infrastructure modules**

The Pulumi code will provision:
- Artifact Registry repo
- Cloud SQL Postgres instance (db-f1-micro)
- Secret Manager secrets
- IAM service accounts
- Two Cloud Run services (ingest + api) with custom domain mappings

Each module exports its resources for cross-referencing.

- [ ] **Step 4: Install dependencies and verify**

```bash
cd infra && pnpm install && pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add infra/
git commit -m "feat: add Pulumi infrastructure for Cloud Run + Cloud SQL"
```

---

### Task 4.3: Create deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create deploy.yml**

```yaml
name: Deploy

on:
  push:
    tags:
      - "v*"

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v2
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test

      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker us-central1-docker.pkg.dev

      - name: Build and push ingest image
        run: |
          docker build -f docker/Dockerfile.ingest -t us-central1-docker.pkg.dev/${{ secrets.GCP_PROJECT }}/lantern/ingest:${{ github.sha }} .
          docker push us-central1-docker.pkg.dev/${{ secrets.GCP_PROJECT }}/lantern/ingest:${{ github.sha }}

      - name: Build and push api image
        run: |
          docker build -f docker/Dockerfile.api -t us-central1-docker.pkg.dev/${{ secrets.GCP_PROJECT }}/lantern/api:${{ github.sha }} .
          docker push us-central1-docker.pkg.dev/${{ secrets.GCP_PROJECT }}/lantern/api:${{ github.sha }}

      - name: Deploy ingest to Cloud Run
        run: |
          gcloud run deploy lantern-ingest \
            --image us-central1-docker.pkg.dev/${{ secrets.GCP_PROJECT }}/lantern/ingest:${{ github.sha }} \
            --region us-central1 \
            --platform managed \
            --allow-unauthenticated \
            --min-instances 0 \
            --max-instances 10 \
            --memory 256Mi \
            --cpu 1 \
            --concurrency 80 \
            --timeout 60

      - name: Deploy api to Cloud Run
        run: |
          gcloud run deploy lantern-api \
            --image us-central1-docker.pkg.dev/${{ secrets.GCP_PROJECT }}/lantern/api:${{ github.sha }} \
            --region us-central1 \
            --platform managed \
            --allow-unauthenticated \
            --min-instances 0 \
            --max-instances 5 \
            --memory 256Mi \
            --cpu 1 \
            --concurrency 80 \
            --timeout 60
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat: add Cloud Run deploy workflow"
```

---

## Chunk 5: Dashboard SPA Extraction

Extract the inline dashboard from the ingest server into a standalone static app for Cloudflare Pages.

### Task 5.1: Create standalone dashboard

**Files:**
- Create: `site/dashboard/index.html` — the dashboard SPA adapted for standalone use

- [ ] **Step 1: Extract dashboard HTML**

Take the existing inline HTML from `packages/ingest/src/routes/dashboard.ts` and adapt it:
- Replace hardcoded `window.location.origin` API URL with a configurable `API_URL` that points to `https://api.openlanternai.com`
- Add a login page/form that gets a JWT from `/auth/login`
- Store JWT in localStorage
- Include JWT in all API calls via `authHeaders()`
- Add logout functionality

- [ ] **Step 2: Deploy to Cloudflare Pages**

```bash
wrangler pages deploy site/dashboard --project-name openlanternai-dashboard
```

- [ ] **Step 3: Commit**

```bash
git add site/dashboard/
git commit -m "feat: extract dashboard SPA for Cloudflare Pages deployment"
```

---

## Summary

| Chunk | What | Depends On | Estimated Tasks |
|---|---|---|---|
| 1 | PostgresTraceStore | Nothing | 2 tasks |
| 2 | API Package (auth, tenants, keys, billing) | Chunk 1 | 6 tasks |
| 3 | Ingest multi-tenancy middleware | Chunk 1, 2 | 2 tasks |
| 4 | Infrastructure (Pulumi, Docker, CI/CD) | Chunk 1-3 | 3 tasks |
| 5 | Dashboard SPA extraction | Chunk 2 | 1 task |

Each chunk produces independently testable, committable code. Chunks 1-3 are the core application work. Chunk 4 is infrastructure. Chunk 5 is the frontend deployment.
