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
  registerAuthRoutes(app, tenantStore, schemaManager, config.jwtSecret);
  registerApiKeyRoutes(app, tenantStore);
  registerTraceRoutes(app, config.databaseUrl);
  registerBillingRoutes(app);

  await app.listen({ port, host });

  return { app, pool, tenantStore, schemaManager };
}
