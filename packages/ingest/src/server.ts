import Fastify from "fastify";
import compress from "@fastify/compress";
import { randomUUID } from "node:crypto";
import { registerTraceRoutes } from "./routes/traces.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerPromptRoutes } from "./routes/prompts.js";
import { registerObservability, recordMetric } from "./lib/observability.js";
import { instrumentPool } from "./lib/timed-pool.js";
import { registerSecurityHeaders } from "@freelancer/shared-utils/security-headers";
import { loadConfig } from "./config.js";
import type { LanternConfig } from "./config.js";
import type { ITraceStore } from "@openlantern-ai/sdk";
import type { EvalTrigger } from "./triggers/eval-trigger.js";
import type { PubSubTraceConsumer } from "./consumers/pubsub-consumer.js";

export interface ListenOptions {
  port: number;
  host: string;
}

export interface IngestServerConfig {
  port: number;
  host: string;
  store?: ITraceStore;
  dbPath?: string;
  apiKey?: string;
  databaseUrl?: string;
  multiTenant?: boolean;
  configPath?: string;
  /**
   * Explicit opt-in for unauthenticated single-tenant binds on a non-localhost
   * interface. Default false. Localhost development does not need this flag.
   * Set LANTERN_ALLOW_INSECURE=true only for isolated development.
   */
  allowInsecure?: boolean;
  /**
   * Optional listen seam. Production uses app.listen. Tests inject this so
   * startup policy can be asserted without binding a socket.
   */
  listen?: (options: ListenOptions) => Promise<void>;
  /**
   * Optional tenant-store factory. Production creates a Postgres store.
   * Tests inject this so request leases can be asserted without a database.
   */
  createTenantStore?: (tenantSlug: string) => Promise<ITraceStore & ClosableStore>;
  /**
   * Optional tenant lookup. Production uses TenantResolver against Postgres.
   * Tests inject this so multi-tenant request leases need no database.
   */
  resolveTenant?: (apiKey: string) => Promise<{ tenantId: string; tenantSlug: string } | null>;
  /** Optional usage-query pool. Production uses the multi-tenant pg pool. */
  usagePool?: UsageQueryPool;
  /** Optional store cache. Production allocates a 100-entry cache. */
  storeCache?: StoreCache<ITraceStore & ClosableStore>;
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

/**
 * Plan ceilings used by the multi-tenant ingest gate. These are compared
 * against public.usage.trace_count, which this package only reads.
 */
export const PLAN_LIMITS: Record<string, number> = {
  free: 10_000,
  starter: 100_000, // legacy
  team: 1_000_000,
  team_plus: 5_000_000,
  enterprise: 999_999_999, // effectively unlimited
};

export const USAGE_CACHE_TTL_MS = 60_000;

export interface UsageCacheEntry {
  count: number;
  plan: string;
  checkedAt: number;
}

export interface UsageLimitDecision {
  allowed: boolean;
  plan: string;
  count: number;
  limit: number;
}

export interface ClosableStore {
  close?: () => Promise<void> | void;
}

export interface CachedStoreEntry<T> {
  key: string;
  store: T;
  lastAccess: number;
  refs: number;
}

/** A hold on one exact cached store, not merely its tenant key. */
export interface StoreLease<T> {
  readonly store: T;
  release(): Promise<void>;
}

/**
 * LRU store cache that will not close a store while a request still holds it.
 * Each acquire returns a lease bound to that entry. Eviction removes the live
 * cache entry immediately, but close is deferred until that entry's own leases
 * reach zero. A later insert of the same key cannot steal those leases, and
 * an unresolved generation is never overwritten by a newer eviction.
 */
export class StoreCache<T extends ClosableStore> {
  private entries = new Map<string, CachedStoreEntry<T>>();
  private deferred = new Set<CachedStoreEntry<T>>();
  private inflight = new Map<string, Promise<T>>();

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.entries.size;
  }

  acquire(key: string, now: number = Date.now()): T | undefined {
    return this.acquireLease(key, now)?.store;
  }

  acquireLease(key: string, now: number = Date.now()): StoreLease<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastAccess = now;
    entry.refs += 1;
    return this.leaseFor(entry);
  }

  /**
   * Insert a new store, evicting the least-recently-used cached entry when full.
   * The returned lease is already acquired (refs = 1) for the caller and is
   * bound to this store identity. An idle evicted store is closed immediately.
   * A store with in-flight leases stays open until those leases release.
   * If the key is already live, the supplied store is unused and closed.
   */
  async insert(key: string, store: T, now: number = Date.now()): Promise<StoreLease<T>> {
    const existing = this.entries.get(key);
    if (existing) {
      return this.holdExisting(existing, store, now);
    }
    // An idle store's asynchronous close yields to other inserts. Recheck the
    // live capacity after every eviction rather than exceeding the configured bound.
    while (this.entries.size >= this.maxSize) {
      await this.evictLeastRecentlyUsed();
      const installed = this.entries.get(key);
      if (installed) return this.holdExisting(installed, store, now);
    }
    const raced = this.entries.get(key);
    if (raced) {
      return this.holdExisting(raced, store, now);
    }
    const entry: CachedStoreEntry<T> = { key, store, lastAccess: now, refs: 1 };
    this.entries.set(key, entry);
    return this.leaseFor(entry);
  }

  /**
   * One creation per key while a first miss is in flight. Callers share that
   * promise and each receive their own lease. A store that loses the install
   * race is closed instead of cached.
   */
  getOrCreate(
    key: string,
    create: () => Promise<T>,
    now: number = Date.now(),
  ): Promise<StoreLease<T>> {
    const live = this.acquireLease(key, now);
    if (live) return Promise.resolve(live);
    const pending = this.inflight.get(key);
    if (pending) {
      return pending.then((store) => this.insert(key, store, now));
    }
    const created = (async () => {
      const live = this.acquireLease(key, now);
      if (live) return live.store;
      return create();
    })();
    this.inflight.set(key, created);
    // Observe both outcomes here. A detached finally on the raw promise
    // becomes an unhandled rejection when create() fails, and a late waiter
    // may attach only after the caller's rejection handler has already run.
    void created.then(
      () => {
        this.clearInflight(key, created);
      },
      () => {
        this.clearInflight(key, created);
      },
    );
    return created.then((store) => this.insert(key, store, now));
  }

  /**
   * Release one hold previously taken by string key. Prefer lease.release(),
   * which cannot select a newer generation of the same key.
   */
  async release(key: string): Promise<void> {
    const live = this.entries.get(key);
    if (live && live.refs > 0) {
      await this.releaseEntry(live);
      return;
    }
    const evicted = [...this.deferred].find((entry) => entry.key === key && entry.refs > 0);
    if (!evicted) return;
    await this.releaseEntry(evicted);
  }

  private holdExisting(
    entry: CachedStoreEntry<T>,
    store: T,
    now: number,
  ): Promise<StoreLease<T>> {
    entry.lastAccess = now;
    entry.refs += 1;
    if (entry.store !== store) {
      return this.closeUnused(store, entry.store).then(() => this.leaseFor(entry));
    }
    return Promise.resolve(this.leaseFor(entry));
  }

  private clearInflight(key: string, created: Promise<T>): void {
    if (this.inflight.get(key) === created) this.inflight.delete(key);
  }

  private leaseFor(entry: CachedStoreEntry<T>): StoreLease<T> {
    let released = false;
    return {
      store: entry.store,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseEntry(entry);
      },
    };
  }

  private async releaseEntry(entry: CachedStoreEntry<T>): Promise<void> {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (this.entries.get(entry.key) === entry) return;
    if (!this.deferred.has(entry)) return;
    this.deferred.delete(entry);
    await entry.store.close?.();
  }

  private async closeUnused(unused: T, kept: T): Promise<void> {
    if (unused === kept) return;
    await unused.close?.();
  }

  private async evictLeastRecentlyUsed(): Promise<void> {
    let lruKey: string | null = null;
    let lruTime = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastAccess < lruTime) {
        lruTime = entry.lastAccess;
        lruKey = key;
      }
    }
    if (!lruKey) return;
    const evicted = this.entries.get(lruKey);
    this.entries.delete(lruKey);
    if (!evicted) return;
    if (evicted.refs > 0) {
      this.deferred.add(evicted);
      return;
    }
    await evicted.store.close?.();
  }
}

export interface UsageQueryPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Decide whether a tenant may ingest, using a 60-second cache of public.usage.
 *
 * This is an approximate gate, not an atomic reservation:
 * - the cached count is not incremented when a batch is accepted
 * - concurrent requests inside the TTL all see the same snapshot
 * - this package does not write public.usage; an external worker must
 *
 * Callers must not treat `allowed: true` as a hard per-batch quota hold.
 */
export async function checkApproximateUsageLimit(
  pool: UsageQueryPool,
  usageCache: Map<string, UsageCacheEntry>,
  tenantId: string,
  now: number = Date.now(),
): Promise<UsageLimitDecision> {
  const cached = usageCache.get(tenantId);
  if (cached && now - cached.checkedAt < USAGE_CACHE_TTL_MS) {
    const limit = PLAN_LIMITS[cached.plan] ?? PLAN_LIMITS.free;
    return { allowed: cached.count < limit, plan: cached.plan, count: cached.count, limit };
  }

  const month = new Date(now).toISOString().slice(0, 7);
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

  usageCache.set(tenantId, { count, plan, checkedAt: now });
  return { allowed: count < limit, plan, count, limit };
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

function insecureDevOptIn(config?: Partial<IngestServerConfig>): boolean {
  if (config?.allowInsecure === true) return true;
  return process.env.LANTERN_ALLOW_INSECURE === "true";
}

/**
 * Single-tenant servers must not expose an unauthenticated API on a
 * non-localhost interface. Rejection happens before stores, pools, or the
 * HTTP listener are allocated. Multi-tenant mode authenticates every /v1/
 * request with a tenant API key and is not subject to this check.
 */
export function assertSingleTenantBindAllowed(
  host: string,
  apiKey: string | undefined,
  opts?: { allowInsecure?: boolean; multiTenant?: boolean; databaseUrl?: string },
): void {
  if (opts?.multiTenant) {
    if (opts.databaseUrl) return;
    const message =
      "[lantern] *** SECURITY ERROR ***: multi-tenant mode requires a database URL. " +
      "Without one, tenant API keys are not checked and the server would start unauthenticated. " +
      "Set DATABASE_URL or storage.url before binding.";
    console.error(message);
    throw new Error(message);
  }
  if (apiKey) return;
  if (isLocalHost(host)) return;
  if (opts?.allowInsecure) {
    console.warn(
      "[lantern] WARNING: LANTERN_ALLOW_INSECURE is set. Starting without an API key on " +
      host + ". Do not use this outside an isolated development network."
    );
    return;
  }
  const message =
    "[lantern] *** SECURITY ERROR ***: No API key configured and server is binding to " + host + ". " +
    "The ingest API is accessible without authentication on a non-localhost interface. " +
    "This is dangerous in production. Set LANTERN_API_KEY or configure auth.api_keys in lantern.yaml, " +
    "or bind to localhost (host: 127.0.0.1) to restrict access. " +
    "Set LANTERN_ALLOW_INSECURE=true only for isolated development.";
  console.error(message);
  throw new Error(message);
}

export async function createServer(config?: Partial<IngestServerConfig>) {
  // Load YAML config (falls back to defaults when no file exists)
  const yamlConfig = loadConfig(config?.configPath);

  const port = config?.port ?? parseInt(process.env.PORT ?? String(yamlConfig.server.port), 10);
  const host = config?.host ?? process.env.HOST ?? yamlConfig.server.host;
  const databaseUrl = config?.databaseUrl ?? process.env.DATABASE_URL ?? yamlConfig.storage.url ?? "";
  const multiTenant = config?.multiTenant ?? process.env.MULTI_TENANT === "true";
  // Compose can export an empty key; treat that environment value as unset.
  // Explicit configuration still takes precedence, including an empty string.
  const apiKey = config?.apiKey ?? (process.env.LANTERN_API_KEY || yamlConfig.auth?.api_keys?.find((k) => k.length > 0));

  // Fail closed before allocating stores, prompt DBs, or a listening socket.
  assertSingleTenantBindAllowed(host, apiKey, {
    allowInsecure: insecureDevOptIn(config),
    multiTenant,
    databaseUrl,
  });

  console.log("[lantern] Loaded config:", JSON.stringify(maskApiKeys(yamlConfig), null, 2));

  // In single-tenant mode, use a fixed store
  // In multi-tenant mode, store is resolved per-request via TenantResolver
  const defaultStore = await resolveDefaultStore(config, yamlConfig);

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
  await registerSecurityHeaders(app, {
    csp: "default-src 'none'",
    permissionsPolicy: "camera=(), microphone=(), geolocation=()",
    hsts: true,
    requestId: true,
  });

  // ── CSRF: Origin validation for state-changing methods ──
  // Defense-in-depth: reject requests where Origin IS present but doesn't match
  // allowed origins. Requests without an Origin header (server-to-server SDK calls)
  // are allowed through — they rely on Bearer token auth instead.
  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS ?? process.env.APP_URL ?? "";
  const allowedOrigins = new Set(
    allowedOriginsEnv.split(",").map((o) => o.trim()).filter(Boolean)
  );
  if (allowedOrigins.size > 0) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
        return;
      }
      const origin = request.headers.origin;
      if (!origin) {
        // No Origin header — server-to-server call (SDK, curl, etc.). Allow through.
        return;
      }
      if (!allowedOrigins.has(origin)) {
        return reply.status(403).send({ error: "Origin not allowed" });
      }
    });
  }

  // ── Optional: Cloud Tasks evaluation trigger ──
  // Supports both YAML config and environment variables
  let evalTrigger: EvalTrigger | undefined;
  const evalEnabled = yamlConfig.evaluation?.cloud_tasks?.enabled || process.env.EVAL_CLOUD_TASKS_ENABLED === "true";
  if (evalEnabled) {
    const evalCfg = yamlConfig.evaluation?.cloud_tasks;
    const { EvalTrigger: EvalTriggerImpl } = await import("./triggers/eval-trigger.js");
    evalTrigger = new EvalTriggerImpl({
      projectId: evalCfg?.project_id ?? process.env.GCP_PROJECT_ID ?? "",
      location: evalCfg?.location ?? process.env.EVAL_CLOUD_TASKS_LOCATION ?? "us-central1",
      queue: evalCfg?.queue ?? process.env.EVAL_CLOUD_TASKS_QUEUE ?? "lantern-evals",
      workerUrl: evalCfg?.worker_url ?? process.env.EVAL_WORKER_URL ?? "",
    });
    console.log(`[lantern] Cloud Tasks eval trigger configured`);
  }

  // ── Optional: Pub/Sub trace consumer ──
  // Supports both YAML config and environment variables
  let pubsubConsumer: PubSubTraceConsumer | undefined;
  const pubsubEnabled = yamlConfig.ingestion?.pubsub?.enabled || process.env.PUBSUB_ENABLED === "true";
  const pubsubSubscription = yamlConfig.ingestion?.pubsub?.subscription_name ?? process.env.PUBSUB_SUBSCRIPTION;
  if (pubsubEnabled && pubsubSubscription) {
    const pubsubProjectId = yamlConfig.ingestion?.pubsub?.project_id ?? process.env.PUBSUB_PROJECT_ID ?? process.env.GCP_PROJECT_ID;
    const { PubSubTraceConsumer: PubSubConsumerImpl } = await import("./consumers/pubsub-consumer.js");
    pubsubConsumer = new PubSubConsumerImpl({
      store: defaultStore,
      subscriptionName: pubsubSubscription,
      projectId: pubsubProjectId,
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
    console.log(`[lantern] Pub/Sub consumer started on ${pubsubSubscription}`);
  }

  if (multiTenant && (databaseUrl || config?.resolveTenant)) {
    // ── Multi-tenant mode ──
    // Resolve API key → tenant on every /v1/ request
    const pool = config?.usagePool ?? (databaseUrl
      ? instrumentPool(new (await import("pg")).default.Pool({ connectionString: databaseUrl, max: 15 }))
      : undefined);
    const resolver = config?.resolveTenant
      ? { resolve: config.resolveTenant }
      : new (await import("./middleware/tenant.js")).TenantResolver(
          pool as ConstructorParameters<typeof import("./middleware/tenant.js").TenantResolver>[0],
        );

    // Store cache: reuse PostgresTraceStore instances per tenant (max 100, LRU eviction).
    // In-flight requests hold a ref so eviction cannot close a pool still in use.
    const STORE_CACHE_MAX = 100;
    const storeCache = config?.storeCache ?? new StoreCache<ITraceStore & ClosableStore>(STORE_CACHE_MAX);

    // Usage limit cache: { tenantId -> { count, checkedAt } }
    // Approximate only. public.usage is not incremented by this process, and
    // accepted batches are not reserved against the cached count.
    const usageCache = new Map<string, UsageCacheEntry>();

    const checkUsageLimit = (tenantId: string) =>
      pool
        ? checkApproximateUsageLimit(pool, usageCache, tenantId)
        : Promise.resolve({ allowed: true, plan: "free", count: 0, limit: PLAN_LIMITS.free });

    app.addHook("onResponse", async (request) => {
      const release = (request as unknown as Record<string, unknown>).releaseTenantStore;
      if (typeof release === "function") release();
    });

    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/v1/")) return;
      // Pub/Sub push endpoint uses GCP OIDC auth at Cloud Run level, not Lantern API keys
      if (request.url.startsWith("/v1/pubsub")) return;

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

      // Get or create a store for this tenant. The lease is bound to the exact
      // entry acquired for this request and is released once on finish or close.
      const lease = await storeCache.getOrCreate(tenant.tenantSlug, () =>
        config?.createTenantStore
          ? config.createTenantStore(tenant.tenantSlug)
          : createPostgresStore(databaseUrl, `tenant_${tenant.tenantSlug}`, 3),
      );
      let released = false;
      const releaseStore = () => {
        if (released) return;
        released = true;
        lease.release().catch(() => {});
      };
      // Release only when the response is done or the connection dies before
      // a response can finish. IncomingMessage "close" is not that signal:
      // Node emits it when the request body completes, while the handler may
      // still be writing through the leased store. onResponse covers inject(),
      // which does not emit the socket events. The flag makes these once-only.
      reply.raw.once("finish", releaseStore);
      reply.raw.once("close", releaseStore);
      reply.raw.once("error", releaseStore);
      request.raw.once("aborted", releaseStore);
      (request as unknown as Record<string, unknown>).releaseTenantStore = releaseStore;

      // Attach tenant info and store to the request
      (request as unknown as Record<string, unknown>).tenantStore = lease.store;
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

  if (config?.listen) {
    await config.listen({ port, host });
  } else {
    await app.listen({ port, host });
  }

  return { app, store: defaultStore };
}
