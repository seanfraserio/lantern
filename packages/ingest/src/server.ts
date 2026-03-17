import Fastify from "fastify";
import compress from "@fastify/compress";
import { randomUUID } from "node:crypto";
import { registerTraceRoutes } from "./routes/traces.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerPromptRoutes } from "./routes/prompts.js";
import { registerObservability, recordMetric } from "./lib/observability.js";
import type { ITraceStore } from "@lantern-ai/sdk";

export interface IngestServerConfig {
  port: number;
  host: string;
  store?: ITraceStore;
  dbPath?: string;
  apiKey?: string;
  databaseUrl?: string;
  multiTenant?: boolean;
}

/**
 * Create a store for the given tenant schema.
 * In multi-tenant mode, each request gets a store scoped to the tenant's schema.
 */
async function createPostgresStore(databaseUrl: string, tenantSchema: string): Promise<ITraceStore> {
  const { PostgresTraceStore } = await import("./store/postgres.js");
  const store = new PostgresTraceStore({ connectionString: databaseUrl, tenantSchema });
  await store.initialize();
  return store;
}

async function resolveDefaultStore(config?: Partial<IngestServerConfig>): Promise<ITraceStore> {
  if (config?.store) return config.store;

  const storeType = process.env.STORE_TYPE ?? "sqlite";
  if (storeType === "postgres" || config?.databaseUrl) {
    const url = config?.databaseUrl ?? process.env.DATABASE_URL ?? "";
    const schema = process.env.TENANT_SCHEMA ?? "public";
    return createPostgresStore(url, schema);
  }

  const { SqliteTraceStore } = await import("./store/sqlite.js");
  return new SqliteTraceStore(config?.dbPath ?? "lantern.db");
}

export async function createServer(config?: Partial<IngestServerConfig>) {
  const port = config?.port ?? parseInt(process.env.PORT ?? "4100", 10);
  const host = config?.host ?? "127.0.0.1";
  const databaseUrl = config?.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const multiTenant = config?.multiTenant ?? process.env.MULTI_TENANT === "true";

  // In single-tenant mode, use a fixed store
  // In multi-tenant mode, store is resolved per-request via TenantResolver
  const defaultStore = await resolveDefaultStore(config);
  const apiKey = config?.apiKey ?? process.env.LANTERN_API_KEY;

  // Prompt store (SQLite-backed, shared across tenants)
  const { PromptStore } = await import("./store/prompt-store.js");
  const Database = (await import("better-sqlite3")).default;
  const promptDbPath = config?.dbPath ?? "lantern.db";
  const promptDb = new Database(promptDbPath);
  promptDb.pragma("journal_mode = WAL");
  const promptStore = new PromptStore(promptDb);
  promptStore.initialize();

  const app = Fastify({
    logger: true,
    bodyLimit: 1_048_576,
    genReqId: (req) => (req.headers["x-request-id"] as string) ?? randomUUID(),
  });

  await app.register(compress, { global: true });

  // Observability: send metrics + logs to Grafana Cloud via OTLP
  registerObservability(app, "lantern-ingest");

  // Security headers + request ID propagation
  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  if (multiTenant && databaseUrl) {
    // ── Multi-tenant mode ──
    // Resolve API key → tenant on every /v1/ request
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: databaseUrl, max: 5 });
    const { TenantResolver } = await import("./middleware/tenant.js");
    const resolver = new TenantResolver(pool);

    // Store cache: reuse PostgresTraceStore instances per tenant
    const storeCache = new Map<string, ITraceStore>();

    // Usage limit cache: { tenantId -> { count, checkedAt } }
    const PLAN_LIMITS: Record<string, number> = {
      free: 10_000,
      team: 1_000_000,
      enterprise: 999_999_999, // effectively unlimited
    };
    const usageCache = new Map<string, { count: number; plan: string; checkedAt: number }>();

    async function checkUsageLimit(tenantId: string): Promise<{ allowed: boolean; plan: string; count: number; limit: number }> {
      const cached = usageCache.get(tenantId);
      // Re-check every 60 seconds
      if (cached && Date.now() - cached.checkedAt < 60_000) {
        const limit = PLAN_LIMITS[cached.plan] ?? PLAN_LIMITS.free;
        return { allowed: cached.count < limit, plan: cached.plan, count: cached.count, limit };
      }

      const month = new Date().toISOString().slice(0, 7);
      const { rows } = await pool.query(
        `SELECT t.plan, COALESCE(u.trace_count, 0)::int AS trace_count
         FROM public.tenants t
         LEFT JOIN public.usage u ON u.tenant_id = t.id AND u.month = $2
         WHERE t.id = $1`,
        [tenantId, month]
      );

      const plan = (rows[0]?.plan as string) ?? "free";
      const count = (rows[0]?.trace_count as number) ?? 0;
      const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

      usageCache.set(tenantId, { count, plan, checkedAt: Date.now() });
      return { allowed: count < limit, plan, count, limit };
    }

    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/v1/")) return;

      const auth = request.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ")) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const key = auth.slice(7);
      const tenant = await resolver.resolve(key);
      if (!tenant) {
        return reply.status(401).send({ error: "Invalid API key" });
      }

      // Check usage limit on POST (trace ingestion)
      if (request.method === "POST") {
        const usage = await checkUsageLimit(tenant.tenantId);
        if (!usage.allowed) {
          recordMetric("trace_limit_exceeded_total", 1, { tenant: tenant.tenantSlug, plan: usage.plan });
          return reply.status(429).send({
            error: "Trace limit exceeded",
            plan: usage.plan,
            used: usage.count,
            limit: usage.limit,
            message: `Your ${usage.plan} plan allows ${usage.limit.toLocaleString()} traces/month. Upgrade at https://openlanternai-dashboard.pages.dev`,
          });
        }
      }

      // Get or create a store for this tenant
      let store = storeCache.get(tenant.tenantSlug);
      if (!store) {
        store = await createPostgresStore(databaseUrl, `tenant_${tenant.tenantSlug}`);
        storeCache.set(tenant.tenantSlug, store);
      }

      // Attach tenant info and store to the request
      (request as unknown as Record<string, unknown>).tenantStore = store;
      (request as unknown as Record<string, unknown>).tenantId = tenant.tenantId;
      (request as unknown as Record<string, unknown>).tenantSlug = tenant.tenantSlug;
    });

    // Register routes with tenant-aware store resolution
    registerTraceRoutes(app, defaultStore, true);
    registerHealthRoutes(app, defaultStore);
    registerDashboardRoutes(app);
    registerPromptRoutes(app, promptStore);
  } else {
    // ── Single-tenant mode (OSS / self-hosted) ──
    if (apiKey) {
      const { timingSafeEqual } = await import("node:crypto");
      app.addHook("onRequest", async (request, reply) => {
        if (!request.url.startsWith("/v1/")) return;
        const auth = request.headers.authorization;
        if (!auth) {
          return reply.status(401).send({ error: "Unauthorized" });
        }
        const expected = `Bearer ${apiKey}`;
        if (auth.length !== expected.length ||
            !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
          return reply.status(401).send({ error: "Unauthorized" });
        }
      });
    }

    registerTraceRoutes(app, defaultStore, false);
    registerHealthRoutes(app, defaultStore);
    registerDashboardRoutes(app, apiKey);
    registerPromptRoutes(app, promptStore);
  }

  await app.listen({ port, host });

  return { app, store: defaultStore };
}
