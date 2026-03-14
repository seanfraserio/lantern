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
}

export async function createServer(config?: Partial<IngestServerConfig>) {
  const port = config?.port ?? parseInt(process.env.PORT ?? "4100", 10);
  const host = config?.host ?? "0.0.0.0";

  const store = config?.store ?? new SqliteTraceStore(config?.dbPath ?? "lantern.db");

  const app = Fastify({
    logger: true,
  });

  // Register routes
  registerDashboardRoutes(app);
  registerTraceRoutes(app, store);
  registerHealthRoutes(app, store);

  // Start server
  await app.listen({ port, host });

  return { app, store };
}

// Run directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  createServer().catch((err) => {
    console.error("Failed to start Lantern ingest server:", err);
    process.exit(1);
  });
}
