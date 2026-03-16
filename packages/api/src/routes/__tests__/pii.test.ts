import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerJwtAuth, signJwt } from "../../middleware/jwt.js";
import type pg from "pg";

// Note: pii.ts uses Function('return import("@lantern-ai/enterprise")')() to
// load PII detection. This bypasses vi.mock since it's evaluated at runtime.
// Tests verify validation, auth, and graceful degradation when enterprise
// features are unavailable (returns 501).

const JWT_SECRET = "test-jwt-secret-32chars-for-hs256";
const USER = { sub: "u1", tenantId: "t1", tenantSlug: "acme", role: "owner" };

function authHeaders(payload = USER) {
  return { authorization: `Bearer ${signJwt(payload, JWT_SECRET)}` };
}

function makeMockPool(): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as pg.Pool;
}

async function buildApp(pool: pg.Pool) {
  const { registerPiiRoutes } = await import("../pii.js");
  const app = Fastify({ logger: false });
  registerJwtAuth(app, JWT_SECRET);
  registerPiiRoutes(app, pool);
  await app.ready();
  return app;
}

describe("POST /pii/scan", () => {
  it("returns 400 when text is missing", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/pii/scan",
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/text/i);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/pii/scan",
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 501 when enterprise package is unavailable", async () => {
    // PII detection requires @lantern-ai/enterprise which is a separate workspace package
    // loaded via Function() dynamic import (bypasses vi.mock). Without it, returns 501.
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/pii/scan",
      headers: authHeaders(),
      payload: { text: "Contact user@example.com for details" },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toMatch(/not available/i);
  });
});

describe("POST /pii/redact", () => {
  it("returns 400 when text is missing", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/pii/redact",
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/text/i);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/pii/redact",
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 501 when enterprise package is unavailable", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/pii/redact",
      headers: authHeaders(),
      payload: { text: "Hello user@example.com" },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toMatch(/not available/i);
  });
});

describe("POST /pii/scan-trace/:id", () => {
  it("returns 404 when trace not found", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/pii/scan-trace/nonexistent",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "POST", url: "/pii/scan-trace/trace-1" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 501 or 500 when trace found but enterprise is unavailable", async () => {
    // Trace found in DB, but PII detector can't load → error response
    const pool = makeMockPool();
    const spans = [{ id: "s1", type: "llm_call", input: { messages: [{ content: "hi" }] } }];
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ spans, metadata: {} }],
      rowCount: 1,
    });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/pii/scan-trace/trace-1",
      headers: authHeaders(),
    });

    // 501 if error message contains "not available", 500 otherwise
    expect([500, 501]).toContain(res.statusCode);
  });
});
