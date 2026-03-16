import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerScorecardRoutes } from "../scorecards.js";
import { registerJwtAuth, signJwt } from "../../middleware/jwt.js";
import type pg from "pg";

const JWT_SECRET = "test-jwt-secret-32chars-for-hs256";
const USER = { sub: "u1", tenantId: "t1", tenantSlug: "acme", role: "owner" };

function authHeaders(payload = USER) {
  return { authorization: `Bearer ${signJwt(payload, JWT_SECRET)}` };
}

function makeMockPool(defaultRows: unknown[] = []): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: defaultRows, rowCount: defaultRows.length }),
  } as unknown as pg.Pool;
}

async function buildApp(pool: pg.Pool) {
  const app = Fastify({ logger: false });
  registerJwtAuth(app, JWT_SECRET);
  registerScorecardRoutes(app, pool);
  await app.ready();
  return app;
}

describe("GET /scorecards", () => {
  it("returns scorecards list with period defaulting to 30", async () => {
    const scorecardRow = {
      agent_name: "my-agent",
      total_traces: 100,
      success_rate: 95.5,
      error_rate: 4.5,
      avg_latency_ms: 350.0,
      p50_latency_ms: 300.0,
      p95_latency_ms: 700.0,
      p99_latency_ms: 950.0,
      avg_cost_per_trace: 0.001,
      total_cost: 0.1,
    };

    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [scorecardRow], rowCount: 1 })  // current period
      .mockResolvedValueOnce({ rows: [{ agent_name: "my-agent", success_rate: 93.0 }], rowCount: 1 });  // previous period

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/scorecards",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.period).toBe(30);
    expect(body.scorecards).toHaveLength(1);
    expect(body.scorecards[0].agentName).toBe("my-agent");
    expect(body.scorecards[0].successRate).toBe(95.5);
    expect(body.scorecards[0].qualityTrend).toBe("improving");
  });

  it("accepts valid period query param (7, 30, 90)", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/scorecards?period=7",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().period).toBe(7);
  });

  it("falls back to period=30 for invalid period", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/scorecards?period=999",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().period).toBe(30);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({ method: "GET", url: "/scorecards" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /scorecards/:agentName", () => {
  it("returns scorecard for specific agent", async () => {
    const summaryRow = {
      total_traces: 50,
      success_rate: 98.0,
      error_rate: 2.0,
      avg_latency_ms: 250.0,
      p50_latency_ms: 200.0,
      p95_latency_ms: 500.0,
      p99_latency_ms: 800.0,
      avg_cost_per_trace: 0.002,
      total_cost: 0.1,
    };

    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;
    queryMock
      .mockResolvedValueOnce({ rows: [summaryRow], rowCount: 1 })  // summary
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // daily breakdown

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/scorecards/my-agent",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentName).toBe("my-agent");
    expect(body.summary.successRate).toBe(98.0);
    expect(body.daily).toEqual([]);
  });

  it("returns 404 when no traces found for agent", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ total_traces: 0 }],
      rowCount: 1,
    });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/scorecards/no-such-agent",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /scorecards/sla", () => {
  it("creates an SLA target and returns 201", async () => {
    const slaRow = {
      id: "sla-1",
      tenant_id: "t1",
      agent_name: "my-agent",
      min_success_rate: 95,
      max_p95_latency_ms: 1000,
      max_cost_per_trace: null,
      created_at: new Date(),
    };

    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [slaRow], rowCount: 1 });

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "POST",
      url: "/scorecards/sla",
      headers: authHeaders(),
      payload: { agentName: "my-agent", minSuccessRate: 95, maxP95LatencyMs: 1000 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.slaTarget.agentName).toBe("my-agent");
    expect(body.slaTarget.minSuccessRate).toBe(95);
  });

  it("returns 400 when agentName is missing", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/scorecards/sla",
      headers: authHeaders(),
      payload: { minSuccessRate: 95 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/agentName/i);
  });

  it("returns 400 when no SLA values are provided", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/scorecards/sla",
      headers: authHeaders(),
      payload: { agentName: "my-agent" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least one/i);
  });

  it("returns 401 when no auth header", async () => {
    const app = await buildApp(makeMockPool());
    const res = await app.inject({
      method: "POST",
      url: "/scorecards/sla",
      payload: { agentName: "my-agent", minSuccessRate: 95 },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /scorecards/sla/violations", () => {
  it("returns empty violations when no SLA targets are configured", async () => {
    const pool = makeMockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });  // no SLA targets

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/scorecards/sla/violations",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().violations).toEqual([]);
  });

  it("detects violations when thresholds are exceeded", async () => {
    const pool = makeMockPool();
    const queryMock = pool.query as ReturnType<typeof vi.fn>;

    const slaTarget = {
      id: "sla-1",
      tenant_id: "t1",
      agent_name: "my-agent",
      min_success_rate: 99,   // require 99% success
      max_p95_latency_ms: 500,
      max_cost_per_trace: 0.001,
      created_at: new Date(),
    };

    const metrics = {
      agent_name: "my-agent",
      success_rate: 90,    // below 99%
      p95_latency_ms: 1200,  // above 500ms
      avg_cost_per_trace: 0.005,  // above 0.001
    };

    queryMock
      .mockResolvedValueOnce({ rows: [slaTarget], rowCount: 1 })  // SLA targets
      .mockResolvedValueOnce({ rows: [metrics], rowCount: 1 });   // current metrics

    const app = await buildApp(pool);
    const res = await app.inject({
      method: "GET",
      url: "/scorecards/sla/violations",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.violations).toHaveLength(1);
    expect(body.violations[0].agentName).toBe("my-agent");
    expect(body.violations[0].violations.length).toBeGreaterThan(0);
  });
});
