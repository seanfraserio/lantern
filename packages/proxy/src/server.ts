/**
 * Fastify server setup for the Lantern LLM Proxy.
 *
 * The proxy sits between an AI agent and the LLM API (Anthropic, OpenAI).
 * It forwards requests transparently, captures request/response data,
 * builds Lantern traces, and sends them to the ingest server.
 */

import Fastify from "fastify";
import { registerProxyRoutes } from "./proxy.js";

export interface ProxyConfig {
  /** Port to listen on (default: 4300, or PORT env var) */
  port?: number;
  /** Host to bind to (default: 127.0.0.1) */
  host?: string;
  /** Lantern ingest endpoint URL (default: http://localhost:4100) */
  ingestEndpoint?: string;
}

export async function createProxyServer(config?: ProxyConfig) {
  const port = config?.port ?? parseInt(process.env.PORT ?? "4300", 10);
  const host = config?.host ?? "127.0.0.1";
  const ingestEndpoint =
    config?.ingestEndpoint ?? process.env.LANTERN_INGEST_URL ?? "http://localhost:4100";

  const app = Fastify({
    logger: true,
    bodyLimit: 10_485_760, // 10MB for large prompts
  });

  // Parse JSON bodies for all content types (some clients may not set Content-Type)
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    try {
      const parsed = JSON.parse(body as string);
      done(null, parsed);
    } catch {
      // If not JSON, pass raw string
      done(null, body);
    }
  });

  // Health check — must be registered before the catch-all proxy route
  app.get("/health", async () => ({
    status: "ok",
    service: "lantern-proxy",
    uptime: process.uptime(),
  }));

  // Register proxy routes (catch-all)
  registerProxyRoutes(app, { ingestEndpoint });

  await app.listen({ port, host });

  return { app, port, host, ingestEndpoint };
}
