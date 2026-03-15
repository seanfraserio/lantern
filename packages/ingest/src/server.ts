import Fastify from "fastify";
import { registerTraceRoutes } from "./routes/traces.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
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

  const app = Fastify({
    logger: true,
    bodyLimit: 1_048_576,
  });

  // Security headers
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
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
  }

  await app.listen({ port, host });

  return { app, store: defaultStore };
}
