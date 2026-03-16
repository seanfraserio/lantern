import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerJwtAuth, signJwt } from "../../middleware/jwt.js";
import type pg from "pg";

// Mock the enterprise package (dynamic import within pii.ts)
vi.mock("@lantern-ai/enterprise", () => ({
  PiiDetector: vi.fn().mockImplementation(() => ({
    scan: vi.fn().mockReturnValue([{ type: "EMAIL", value: "user@example.com" }]),
    redact: vi.fn().mockReturnValue("Hello [REDACTED]"),
  })),
}));

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
  it("scans text for PII", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/pii/scan",
      headers: authHeaders(),
      payload: { text: "Contact user@example.com for details" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().detections).toBeDefined();
  });

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
});

describe("POST /pii/redact", () => {
  it("redacts PII from text", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/pii/redact",
      headers: authHeaders(),
      payload: { text: "Hello user@example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().redacted).toBeDefined();
  });

  it("returns 400 when text is missing", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/pii/redact",
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /pii/scan-trace/:id", () => {
  it("scans trace spans for PII", async () => {
    const pool = makeMockPool();
    const spans = [
      {
        id: "span-1",
        type: "llm_call",
        input: { messages: [{ content: "Contact user@example.com" }] },
        output: { content: "OK I'll email them" },
      },
    ];
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

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.traceId).toBe("trace-1");
    expect(body).toHaveProperty("piiFound");
    expect(body).toHaveProperty("detections");
  });

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
});
