import Fastify from "fastify";
import compress from "@fastify/compress";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { TenantStore } from "./store/tenant-store.js";
import { SchemaManager } from "./store/schema-manager.js";
import { registerJwtAuth } from "./middleware/jwt.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerApiKeyRoutes } from "./routes/api-keys.js";
import { registerTraceRoutes } from "./routes/traces.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerRetentionRoutes } from "./routes/retention.js";
import { registerPiiRoutes } from "./routes/pii.js";
import { registerTeamRoutes } from "./routes/teams.js";
import { registerComplianceRoutes } from "./routes/compliance.js";
import { registerScorecardRoutes, initSlaTargetsTable } from "./routes/scorecards.js";
import { registerRegressionRoutes } from "./routes/regressions.js";
import { registerCostRoutes } from "./routes/costs.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerObservability } from "./lib/observability.js";

const { Pool } = pg;

export interface ApiServerConfig {
  port?: number;
  host?: string;
  databaseUrl: string;
  jwtSecret: string;
  poolSize?: number;
  stripeSecretKey?: string;
  stripePriceId?: string;
  stripeWebhookSecret?: string;
  appUrl?: string;
  /** Additional URL paths/prefixes to skip JWT auth (e.g. ["/sso/login/", "/sso/callback"]) */
  additionalJwtSkipPaths?: string[];
}

/**
 * Build the Fastify app with all core routes registered, but do NOT call app.listen().
 * Use this when you want to add additional routes before starting the server (e.g. enterprise extensions).
 */
export async function buildApiServer(config: ApiServerConfig) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.poolSize ?? 5,
  });

  const tenantStore = new TenantStore(pool);
  const schemaManager = new SchemaManager(pool);

  await tenantStore.initialize();
  await initSlaTargetsTable(pool);

  const app = Fastify({
    logger: true,
    bodyLimit: 1_048_576,
    genReqId: (req) => (req.headers["x-request-id"] as string) ?? randomUUID(),
  });

  await app.register(compress, { global: true });

  // Observability: send metrics + logs to Grafana Cloud via OTLP
  registerObservability(app, "lantern-api");

  // Store raw body for Stripe webhook signature verification
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      (req as unknown as Record<string, unknown>).rawBody = body;
      try {
        done(null, JSON.parse(body.toString()));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // Security headers + request ID propagation
  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  // CORS for dashboard SPA
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    const allowedOrigins = [
      "https://app.openlanternai.com",
      "https://dashboard.openlanternai.com",
      "https://openlanternai-dashboard.pages.dev",
    ];
    const isLocalhost = origin !== undefined && /^http:\/\/localhost(:\d+)?$/.test(origin);
    const isPagesPreview = origin !== undefined && /^https:\/\/[a-z0-9]+\.openlanternai-dashboard\.pages\.dev$/.test(origin);
    if (origin && (allowedOrigins.includes(origin) || isLocalhost || isPagesPreview)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    }
    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }
  });

  // JWT auth (skips /health and /auth/* routes)
  registerJwtAuth(app, config.jwtSecret, config.additionalJwtSkipPaths);

  // Routes
  registerHealthRoutes(app, pool);
  registerAuthRoutes(app, tenantStore, schemaManager, config.jwtSecret);
  registerApiKeyRoutes(app, tenantStore);
  registerTraceRoutes(app, config.databaseUrl);
  const stripeKey = config.stripeSecretKey ?? process.env.STRIPE_SECRET_KEY;
  const priceId = config.stripePriceId ?? process.env.STRIPE_PRICE_ID;
  const stripeWebhookSecret = config.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
  const appUrl = config.appUrl ?? process.env.APP_URL ?? "https://openlanternai-dashboard.pages.dev";
  if (stripeKey && priceId && stripeWebhookSecret) {
    registerBillingRoutes(app, pool, { stripeSecretKey: stripeKey, stripePriceId: priceId, stripeWebhookSecret, appUrl });
  }
  registerRetentionRoutes(app, pool);
  registerPiiRoutes(app, pool);
  registerTeamRoutes(app, pool);
  registerComplianceRoutes(app, pool);
  registerScorecardRoutes(app, pool);
  registerRegressionRoutes(app, pool);
  registerCostRoutes(app, pool);

  return { app, pool, tenantStore, schemaManager };
}

/**
 * Build and start the API server (backwards compatible).
 */
export async function createApiServer(config: ApiServerConfig) {
  const port = config.port ?? parseInt(process.env.PORT ?? "4200", 10);
  const host = config.host ?? "127.0.0.1";

  const result = await buildApiServer(config);
  await result.app.listen({ port, host });

  return result;
}
