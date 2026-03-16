import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerJwtAuth, signJwt } from "../../middleware/jwt.js";
import type pg from "pg";

// Mock the enterprise package
vi.mock("@lantern-ai/enterprise", () => ({
  ComplianceExporter: vi.fn().mockImplementation(() => ({
    export: vi.fn().mockResolvedValue({
      framework: "soc2",
      generatedAt: new Date().toISOString(),
      summary: { totalEvents: 10 },
    }),
  })),
}));

const JWT_SECRET = "test-jwt-secret-32chars-for-hs256";
const OWNER = { sub: "u1", tenantId: "t1", tenantSlug: "acme", role: "owner" };
const MEMBER = { ...OWNER, role: "member" };

function authHeaders(payload = OWNER) {
  return { authorization: `Bearer ${signJwt(payload, JWT_SECRET)}` };
}

function makeMockPool(): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as pg.Pool;
}

async function buildApp(pool: pg.Pool) {
  const { registerComplianceRoutes } = await import("../compliance.js");
  const app = Fastify({ logger: false });
  registerJwtAuth(app, JWT_SECRET);
  registerComplianceRoutes(app, pool);
  await app.ready();
  return app;
}

describe("GET /compliance/frameworks", () => {
  it("returns list of available frameworks (no auth required)", async () => {
    const app = await buildApp(makeMockPool());
    // Note: /compliance/frameworks requires auth since it's not in the skip list
    const res = await app.inject({
      method: "GET",
      url: "/compliance/frameworks",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.frameworks).toBeDefined();
    const ids = body.frameworks.map((f: { id: string }) => f.id);
    expect(ids).toContain("soc2");
    expect(ids).toContain("hipaa");
    expect(ids).toContain("gdpr");
  });
});

describe("POST /compliance/export", () => {
  it("exports compliance report for owner", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/compliance/export",
      headers: authHeaders(),
      payload: { framework: "soc2", startDate: "2026-01-01", endDate: "2026-03-01" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("framework");
  });

  it("returns 400 when required fields are missing", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/compliance/export",
      headers: authHeaders(),
      payload: { framework: "soc2" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/required/i);
  });

  it("returns 403 for member role", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/compliance/export",
      headers: authHeaders(MEMBER),
      payload: { framework: "soc2", startDate: "2026-01-01", endDate: "2026-03-01" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/compliance/export",
      payload: { framework: "soc2", startDate: "2026-01-01", endDate: "2026-03-01" },
    });
    expect(res.statusCode).toBe(401);
  });
});
