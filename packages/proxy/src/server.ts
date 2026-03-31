/**
 * Fastify server setup for the Lantern LLM Proxy.
 *
 * The proxy sits between an AI agent and the LLM API (Anthropic, OpenAI).
 * It forwards requests transparently, captures request/response data,
 * builds Lantern traces, and sends them to the ingest server.
 */

import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { registerProxyRoutes } from "./proxy.js";
import { registerSecurityHeaders } from "@freelancer/shared-utils/security-headers";

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
  const proxyApiKey = process.env.LANTERN_PROXY_API_KEY;

  const app = Fastify({
    logger: true,
    bodyLimit: 10_485_760, // 10MB for large prompts
  });

  // Security headers
  await registerSecurityHeaders(app, {
    hsts: process.env.NODE_ENV === "production",
    csp: "default-src 'none'",
  });

  // Content-type validation: only accept application/json for non-GET requests
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      return;
    }
    const ct = request.headers["content-type"];
    if (ct && !ct.startsWith("application/json")) {
      return reply.status(415).send({ error: "Unsupported Media Type. Only application/json is accepted." });
    }
  });

  // API key authentication (if LANTERN_PROXY_API_KEY is set)
  if (proxyApiKey) {
    app.addHook("onRequest", async (request, reply) => {
      // Skip auth for health endpoint
      if (request.url === "/health") return;

      const auth = request.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ")) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      const token = auth.slice(7);
      const expected = proxyApiKey;
      if (
        token.length !== expected.length ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
      ) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    });
  }

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
  }));

  // Register proxy routes (catch-all)
  registerProxyRoutes(app, { ingestEndpoint });

  await app.listen({ port, host });

  return { app, port, host, ingestEndpoint };
}
