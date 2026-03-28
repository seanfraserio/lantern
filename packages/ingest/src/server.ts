import Fastify from "fastify";
import compress from "@fastify/compress";
import { randomUUID } from "node:crypto";
import { registerTraceRoutes } from "./routes/traces.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerPromptRoutes } from "./routes/prompts.js";
import { registerObservability, recordMetric } from "./lib/observability.js";
import { loadConfig } from "./config.js";
import type { LanternConfig } from "./config.js";
import type { ITraceStore } from "@openlantern-ai/sdk";
import type { EvalTrigger } from "./triggers/eval-trigger.js";
import type { PubSubTraceConsumer } from "./consumers/pubsub-consumer.js";

export interface IngestServerConfig {
  port: number;
  host: string;
  store?: ITraceStore;
  dbPath?: string;
  apiKey?: string;
  databaseUrl?: string;
  multiTenant?: boolean;
  configPath?: string;
}

/**
 * Create a store for the given tenant schema.
 * In multi-tenant mode, each request gets a store scoped to the tenant's schema.
 */
async function createPostgresStore(databaseUrl: string, tenantSchema: string, poolSize?: number): Promise<ITraceStore> {
  const { PostgresTraceStore } = await import("./store/postgres.js");
  const store = new PostgresTraceStore({ connectionString: databaseUrl, tenantSchema, poolSize });
  await store.initialize();
  return store;
}

async function resolveDefaultStore(
  config?: Partial<IngestServerConfig>,
  yamlCfg?: LanternConfig,
): Promise<ITraceStore> {
  if (config?.store) return config.store;

  const storeType = process.env.STORE_TYPE ?? yamlCfg?.storage.type ?? "sqlite";
  if (storeType === "postgres" || config?.databaseUrl) {
    const url = config?.databaseUrl ?? process.env.DATABASE_URL ?? yamlCfg?.storage.url ?? "";
    const schema = process.env.TENANT_SCHEMA ?? "public";
    return createPostgresStore(url, schema);
  }

  const { SqliteTraceStore } = await import("./store/sqlite.js");
  return new SqliteTraceStore(config?.dbPath ?? yamlCfg?.storage.path ?? "lantern.db");
}

function maskApiKeys(cfg: LanternConfig): LanternConfig {
  if (!cfg.auth?.api_keys?.length) return cfg;
  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      api_keys: cfg.auth.api_keys.map((k) =>
        k.length > 8 ? `${k.slice(0, 4)}****${k.slice(-4)}` : "****"
      ),
    },
  };
}

export async function createServer(config?: Partial<IngestServerConfig>) {
  // Load YAML config (falls back to defaults when no file exists)
  const yamlConfig = loadConfig(config?.configPath);

  const port = config?.port ?? parseInt(process.env.PORT ?? String(yamlConfig.server.port), 10);
  const host = config?.host ?? yamlConfig.server.host;
  const databaseUrl = config?.databaseUrl ?? process.env.DATABASE_URL ?? yamlConfig.storage.url ?? "";
  const multiTenant = config?.multiTenant ?? process.env.MULTI_TENANT === "true";

  console.log("[lantern] Loaded config:", JSON.stringify(maskApiKeys(yamlConfig), null, 2));

  // In single-tenant mode, use a fixed store
  // In multi-tenant mode, store is resolved per-request via TenantResolver
  const defaultStore = await resolveDefaultStore(config, yamlConfig);
  const apiKey = config?.apiKey ?? process.env.LANTERN_API_KEY;

  // Prompt store (SQLite-backed, shared across tenants)
  const { PromptStore } = await import("./store/prompt-store.js");
  const Database = (await import("better-sqlite3")).default;
  // Use /tmp/ for prompt DB on Cloud Run (ephemeral filesystem), configurable via env var
  const promptDbPath = process.env.PROMPT_DB_PATH ?? config?.dbPath ?? "/tmp/lantern-prompts.db";
  const promptDb = new Database(promptDbPath);
  promptDb.pragma("journal_mode = WAL");
  const promptStore = new PromptStore(promptDb);
  promptStore.initialize();

  const app = Fastify({
    logger: { level: yamlConfig.server.log_level },
    bodyLimit: 1_048_576,
    genReqId: (req) => {
      const raw = req.headers["x-request-id"];
      const id = typeof raw === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(raw) ? raw : undefined;
      return id ?? randomUUID();
    },
  });

  await app.register(compress as any, { global: true });

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
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  });

  // ── Optional: Cloud Tasks evaluation trigger ──
  let evalTrigger: EvalTrigger | undefined;
  const evalConfig = yamlConfig.evaluation?.cloud_tasks;
  if (evalConfig?.enabled) {
    const { EvalTrigger: EvalTriggerImpl } = await import("./triggers/eval-trigger.js");
    evalTrigger = new EvalTriggerImpl({
      projectId: evalConfig.project_id,
      location: evalConfig.location,
      queue: evalConfig.queue,
      workerUrl: evalConfig.worker_url,
    });
    console.log(`[lantern] Cloud Tasks eval trigger configured (queue: ${evalConfig.queue})`);
  }

  // ── Optional: Pub/Sub trace consumer ──
  let pubsubConsumer: PubSubTraceConsumer | undefined;
  const pubsubConfig = yamlConfig.ingestion?.pubsub;
  if (pubsubConfig?.enabled && pubsubConfig?.subscription_name) {
    const { PubSubTraceConsumer: PubSubConsumerImpl } = await import("./consumers/pubsub-consumer.js");
    pubsubConsumer = new PubSubConsumerImpl({
      store: defaultStore,
      subscriptionName: pubsubConfig.subscription_name,
      projectId: pubsubConfig.project_id,
      onInsert: evalTrigger
        ? (traces) => {
            const jobs = traces
              .filter((t) => t.status === "success")
              .map((t) => ({ traceId: t.id, agentName: t.agentName }));
            if (jobs.length > 0) {
              evalTrigger!.enqueue(jobs).catch(console.error);
            }
          }
        : undefined,
    });
    pubsubConsumer.start();
    console.log(`[lantern] Pub/Sub consumer started on ${pubsubConfig.subscription_name}`);
  }

  if (multiTenant && databaseUrl) {
    // ── Multi-tenant mode ──
    // Resolve API key → tenant on every /v1/ request
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: databaseUrl, max: 15 });
    const { TenantResolver } = await import("./middleware/tenant.js");
    const resolver = new TenantResolver(pool);

    // Store cache: reuse PostgresTraceStore instances per tenant (max 100, LRU eviction)
    const STORE_CACHE_MAX = 100;
    const storeCache = new Map<string, ITraceStore>();
    const storeCacheLastAccess = new Map<string, number>();

    // Usage limit cache: { tenantId -> { count, checkedAt } }
    const PLAN_LIMITS: Record<string, number> = {
      free: 10_000,
      starter: 100_000, // legacy
      team: 1_000_000,
      team_plus: 5_000_000,
      enterprise: 999_999_999, // effectively unlimited
    };
    const usageCache = new Map<string, { count: number; plan: string; checkedAt: number }>();

    const checkUsageLimit = async (tenantId: string): Promise<{ allowed: boolean; plan: string; count: number; limit: number }> => {
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
    };

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
      if (store) {
        // Update last access time for LRU tracking
        storeCacheLastAccess.set(tenant.tenantSlug, Date.now());
      } else {
        // Evict least recently used entry if cache is full
        if (storeCache.size >= STORE_CACHE_MAX) {
          let lruKey: string | null = null;
          let lruTime = Infinity;
          for (const [key, accessTime] of storeCacheLastAccess) {
            if (accessTime < lruTime) {
              lruTime = accessTime;
              lruKey = key;
            }
          }
          if (lruKey) {
            const evicted = storeCache.get(lruKey);
            storeCache.delete(lruKey);
            storeCacheLastAccess.delete(lruKey);
            if (evicted && "close" in evicted && typeof (evicted as { close: () => Promise<void> }).close === "function") {
              (evicted as { close: () => Promise<void> }).close().catch(() => {});
            }
          }
        }
        store = await createPostgresStore(databaseUrl, `tenant_${tenant.tenantSlug}`, 3);
        storeCache.set(tenant.tenantSlug, store);
        storeCacheLastAccess.set(tenant.tenantSlug, Date.now());
      }

      // Attach tenant info and store to the request
      (request as unknown as Record<string, unknown>).tenantStore = store;
      (request as unknown as Record<string, unknown>).tenantId = tenant.tenantId;
      (request as unknown as Record<string, unknown>).tenantSlug = tenant.tenantSlug;
    });

    // Register routes with tenant-aware store resolution
    registerTraceRoutes(app, defaultStore, true, evalTrigger);
    registerHealthRoutes(app, defaultStore);
    registerDashboardRoutes(app);
    registerPromptRoutes(app, promptStore);
  } else {
    // ── Single-tenant mode (OSS / self-hosted) ──
    if (!apiKey) {
      console.warn(
        "[lantern] WARNING: No API key configured. The ingest server is running without authentication. " +
        "Set LANTERN_API_KEY or configure auth.api_keys in lantern.yaml to secure the API."
      );
    }
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

    registerTraceRoutes(app, defaultStore, false, evalTrigger);
    registerHealthRoutes(app, defaultStore);
    registerDashboardRoutes(app, apiKey);
    registerPromptRoutes(app, promptStore);
  }

  // Graceful shutdown for Pub/Sub consumer
  if (pubsubConsumer) {
    app.addHook("onClose", async () => {
      await pubsubConsumer?.shutdown();
    });
  }

  await app.listen({ port, host });

  return { app, store: defaultStore };
}
