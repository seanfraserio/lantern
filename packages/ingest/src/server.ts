import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { SqliteTraceStore } from "./store/sqlite.js";
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
}

export async function createServer(config?: Partial<IngestServerConfig>) {
  const port = config?.port ?? parseInt(process.env.PORT ?? "4100", 10);
  const host = config?.host ?? "127.0.0.1";

  const store = config?.store ?? new SqliteTraceStore(config?.dbPath ?? "lantern.db");
  const apiKey = config?.apiKey ?? process.env.LANTERN_API_KEY;

  const app = Fastify({
    logger: true,
  });

  // Security headers
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-XSS-Protection", "1; mode=block");
  });

  // API key auth for /v1/ routes
  if (apiKey) {
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

  // Register routes
  registerDashboardRoutes(app);
  registerTraceRoutes(app, store);
  registerHealthRoutes(app, store);

  // Start server
  await app.listen({ port, host });

  return { app, store };
}

// Run directly
const isMain = process.argv[1] &&
    new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isMain) {
  createServer().catch((err) => {
    console.error("Failed to start Lantern ingest server:", err);
    process.exit(1);
  });
}
