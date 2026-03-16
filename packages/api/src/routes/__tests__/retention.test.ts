import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { registerRetentionRoutes } from "../retention.js";
import type pg from "pg";

function makeMockPool(): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as pg.Pool;
}

async function buildApp(pool: pg.Pool) {
  const app = Fastify({ logger: false });
  registerRetentionRoutes(app, pool);
  await app.ready();
  return app;
}

describe("GET /retention/policy", () => {
  it("returns retention policies without auth", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "GET", url: "/retention/policy" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.policies).toBeDefined();
    expect(Array.isArray(body.policies)).toBe(true);

    const plans = body.policies.map((p: { plan: string }) => p.plan);
    expect(plans).toContain("free");
    expect(plans).toContain("team");
    expect(plans).toContain("enterprise");

    const free = body.policies.find((p: { plan: string }) => p.plan === "free");
    expect(free.retentionDays).toBe(7);

    const team = body.policies.find((p: { plan: string }) => p.plan === "team");
    expect(team.retentionDays).toBe(90);
  });
});

describe("POST /retention/cleanup", () => {
  beforeEach(() => {
    process.env.RETENTION_SECRET = "test-cleanup-secret";
  });

  afterEach(() => {
    delete process.env.RETENTION_SECRET;
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "POST", url: "/retention/cleanup" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when wrong secret", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/retention/cleanup",
      headers: { authorization: "Bearer wrong-secret" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("runs cleanup with correct secret and returns results", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: "t1", slug: "acme", plan: "team" }],
        rowCount: 1,
      })  // get tenants
      .mockResolvedValueOnce({ rows: [{ "1": 1 }], rowCount: 1 })  // schema check
      .mockResolvedValueOnce({ rows: [], rowCount: 5 });  // delete old traces

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/retention/cleanup",
      headers: { authorization: "Bearer test-cleanup-secret" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("cleaned");
    expect(body).toHaveProperty("details");
    expect(body).toHaveProperty("timestamp");
  });

  it("returns 503 when RETENTION_SECRET is not configured", async () => {
    delete process.env.RETENTION_SECRET;
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/retention/cleanup",
      headers: { authorization: "Bearer any-secret" },
    });
    expect(res.statusCode).toBe(503);
  });
});
